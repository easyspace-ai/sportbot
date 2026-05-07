import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '../logger';
import { oddsCache, type BestOddsEntry } from '../services/oddsCache';

const log = createLogger('relay');
import { polymarketBookCache, type BookLevel as PolyBookLevel } from '../services/polymarketBookCache';
import { polymarketOddsCache, type PolyOddsBroadcast } from '../services/polymarketOddsCache';
import {
  subscribeToPolyBook,
  unsubscribeFromPolyBook,
  subscribeToPolyBestOdds,
  unsubscribeFromPolyBestOdds,
} from '../services/polymarketWs';
import {
  fixtureStateCache,
  type FixtureState,
  isTerminalStatus,
} from '../services/fixtureStateCache';
import { marketEvents } from '../services/marketEvents';
import { getOverlaidMarkets, type OverlaidMarket } from '../services/marketGroups';

interface ClientMessage {
  type:
    | 'subscribePolyBook'
    | 'unsubscribePolyBook'
    | 'subscribePolyOdds'
    | 'unsubscribePolyOdds';
  tokenId?: string;
  tokenIds?: string[];
}

interface PolyBookBroadcast {
  tokenId: string;
  levels: PolyBookLevel[];
}

export function startWsRelay(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    const polyBookSubs = new Set<string>();
    const polyOddsSubs = new Set<string>();

    try {
      ws.send(JSON.stringify({ type: 'snapshot', data: oddsCache.getSnapshot() }));
      ws.send(
        JSON.stringify({
          type: 'fixtureSnapshot',
          data: fixtureStateCache.getSnapshot().filter((s) => !isTerminalStatus(s.status)),
        }),
      );
    } catch (err) {
      log.error({ err }, 'failed to send snapshot');
      return;
    }

    void (async () => {
      try {
        const markets = await getOverlaidMarkets();
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'marketsSnapshot', data: markets }));
      } catch (err) {
        log.error({ err }, 'failed to send markets snapshot');
      }
    })();

    const onOddsUpdate = (entry: BestOddsEntry) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      log.trace({ marketHash: entry.marketHash, isMakerOne: entry.isMakerBettingOutcomeOne, takerOdds: entry.takerOdds }, 'broadcast');
      try {
        ws.send(JSON.stringify({ type: 'update', data: entry }));
      } catch (err) {
        log.error({ err }, 'broadcast error');
        cleanup();
      }
    };

    const onPolyBookUpdate = (payload: PolyBookBroadcast) => {
      if (!polyBookSubs.has(payload.tokenId)) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'polyBookUpdate', ...payload }));
      } catch (err) {
        log.error({ err, tokenId: payload.tokenId }, 'poly book broadcast error');
        cleanup();
      }
    };

    function sendPolySnapshot(tokenId: string) {
      const levels = polymarketBookCache.getLevels(tokenId);
      if (levels.length === 0) return;
      try {
        ws.send(JSON.stringify({ type: 'polyBookSnapshot', tokenId, levels }));
      } catch {
        // ignore
      }
    }

    const onPolyOddsUpdate = (payload: PolyOddsBroadcast) => {
      if (!polyOddsSubs.has(payload.tokenId)) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'polyOddsUpdate', ...payload }));
      } catch (err) {
        log.error({ err, tokenId: payload.tokenId }, 'poly odds broadcast error');
        cleanup();
      }
    };

    function sendPolyOddsSnapshot(tokenIds: string[]) {
      const entries: PolyOddsBroadcast[] = [];
      for (const id of tokenIds) {
        const taker = polymarketOddsCache.getTakerOdds(id);
        const raw = polymarketOddsCache.get(id);
        if (typeof taker === 'number' && raw) {
          entries.push({ tokenId: id, takerOdds: taker, updatedAt: raw.updatedAt });
        }
      }
      try {
        ws.send(JSON.stringify({ type: 'polyOddsSnapshot', data: entries }));
      } catch {
        // ignore
      }
    }

    const onFixtureUpdate = (state: FixtureState) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        if (isTerminalStatus(state.status)) {
          ws.send(JSON.stringify({ type: 'fixtureRemove', sxEventId: state.sxEventId }));
        } else {
          ws.send(JSON.stringify({ type: 'fixtureUpdate', data: state }));
        }
      } catch (err) {
        log.error({ err, sxEventId: state.sxEventId }, 'fixture broadcast error');
        cleanup();
      }
    };

    const onMarketUpsert = (market: OverlaidMarket) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'marketUpsert', data: market }));
      } catch (err) {
        log.error({ err, marketId: market.id }, 'marketUpsert broadcast error');
        cleanup();
      }
    };

    const onMarketRemoved = (payload: { id: string }) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'marketRemoved', id: payload.id }));
      } catch (err) {
        log.error({ err, marketId: payload.id }, 'marketRemoved broadcast error');
        cleanup();
      }
    };

    oddsCache.on('update', onOddsUpdate);
    polymarketBookCache.on('polyBookUpdate', onPolyBookUpdate);
    polymarketOddsCache.on('polyOddsUpdate', onPolyOddsUpdate);
    fixtureStateCache.on('update', onFixtureUpdate);
    marketEvents.on('upsert', onMarketUpsert);
    marketEvents.on('removed', onMarketRemoved);

    function cleanup() {
      oddsCache.off('update', onOddsUpdate);
      polymarketBookCache.off('polyBookUpdate', onPolyBookUpdate);
      polymarketOddsCache.off('polyOddsUpdate', onPolyOddsUpdate);
      fixtureStateCache.off('update', onFixtureUpdate);
      marketEvents.off('upsert', onMarketUpsert);
      marketEvents.off('removed', onMarketRemoved);
      for (const tokenId of polyBookSubs) {
        unsubscribeFromPolyBook(tokenId);
      }
      polyBookSubs.clear();
      for (const tokenId of polyOddsSubs) {
        unsubscribeFromPolyBestOdds(tokenId);
      }
      polyOddsSubs.clear();
    }

    ws.on('message', (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (!msg) return;

      if (msg.type === 'subscribePolyBook' && typeof msg.tokenId === 'string') {
        if (polyBookSubs.has(msg.tokenId)) {
          sendPolySnapshot(msg.tokenId);
          return;
        }
        polyBookSubs.add(msg.tokenId);
        subscribeToPolyBook(msg.tokenId);
        sendPolySnapshot(msg.tokenId);
      } else if (msg.type === 'unsubscribePolyBook' && typeof msg.tokenId === 'string') {
        if (polyBookSubs.delete(msg.tokenId)) {
          unsubscribeFromPolyBook(msg.tokenId);
        }
      } else if (msg.type === 'subscribePolyOdds' && Array.isArray(msg.tokenIds)) {
        const valid: string[] = [];
        for (const id of msg.tokenIds) {
          if (typeof id !== 'string' || !id) continue;
          valid.push(id);
          if (polyOddsSubs.has(id)) continue;
          polyOddsSubs.add(id);
          subscribeToPolyBestOdds(id);
        }
        sendPolyOddsSnapshot(valid);
      } else if (msg.type === 'unsubscribePolyOdds' && Array.isArray(msg.tokenIds)) {
        for (const id of msg.tokenIds) {
          if (typeof id !== 'string' || !id) continue;
          if (polyOddsSubs.delete(id)) {
            unsubscribeFromPolyBestOdds(id);
          }
        }
      }
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  log.info('WebSocket relay listening at /ws');
}
