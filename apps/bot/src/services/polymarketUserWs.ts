import WebSocket from 'ws';
import { createLogger } from '../logger';
import { getOutboundWsProxyAgent, getWebSocketConstructorForProxy } from '../proxiedWebSocket';
import { resolvePolymarketTradingCredentials } from './polymarketTrading';
import {
  applyPolymarketUserTradeFromWs,
  syncRiskPositionsFromRestTrades,
} from './riskService';
import { syncRiskPolymarketBookSubscriptions } from './riskPolymarketSubscriptions';

const log = createLogger('polymarketUserWs');

const WS_USER = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const PING_INTERVAL_MS = 10_000;
const RECONNECT_MS = 4_000;
const REST_SYNC_MS = 45_000;
const BOOK_SUB_SYNC_MS = 12_000;
const WS_STALE_MS = 75_000;

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let restTimer: ReturnType<typeof setInterval> | null = null;
let bookSubTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
let lastMessageAt: Date | null = null;
let restSyncLastAt: Date | null = null;
/** Last non-OK situation for dashboard (cleared on successful `open`). */
let lastUserWsIssue: string | null = null;

function fmtErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function getPolymarketUserWsMeta(): {
  connected: boolean;
  connecting: boolean;
  lastMessageAt: string | null;
  restTradesSyncLastAt: string | null;
  lastIssue: string | null;
} {
  const r = ws?.readyState;
  return {
    connected: r === WebSocket.OPEN,
    connecting: r === WebSocket.CONNECTING,
    lastMessageAt: lastMessageAt?.toISOString() ?? null,
    restTradesSyncLastAt: restSyncLastAt?.toISOString() ?? null,
    lastIssue: lastUserWsIssue,
  };
}

function touchMessage(): void {
  lastMessageAt = new Date();
}

function scheduleUserWsReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectUserWs();
  }, RECONNECT_MS);
}

/** Close current socket and reconnect (e.g. after proxy change). */
export function hardResetPolymarketUserWs(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  const s = ws;
  ws = null;
  if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) {
    try {
      s.close();
    } catch {
      // ignore
    }
  }
  lastUserWsIssue = 'reconnect_after_proxy_change';
  void connectUserWs();
}

async function sendSubscription(socket: WebSocket): Promise<void> {
  const creds = await resolvePolymarketTradingCredentials();
  const payload = {
    auth: {
      apiKey: creds.apiKey,
      secret: creds.secret,
      passphrase: creds.passphrase,
    },
    type: 'user',
    markets: [] as string[],
    assets_ids: [] as string[],
    initial_dump: true,
  };
  socket.send(JSON.stringify(payload));
}

async function connectUserWs(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    await resolvePolymarketTradingCredentials();
  } catch (err) {
    lastUserWsIssue = `no_trading_credentials:${fmtErr(err)}`;
    log.warn({ err }, 'polymarket user ws: no trading credentials, skip');
    scheduleUserWsReconnect();
    return;
  }

  const Ws = getWebSocketConstructorForProxy();
  const socket = new Ws(WS_USER);
  ws = socket;

  socket.on('open', () => {
    lastUserWsIssue = null;
    log.info({ viaProxy: Boolean(getOutboundWsProxyAgent()) }, 'polymarket user ws connected');
    touchMessage();
    sendSubscription(socket).catch((err) => {
      lastUserWsIssue = `subscribe_send_failed:${fmtErr(err)}`;
      log.error({ err }, 'user ws subscribe send failed');
    });
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send('PING');
        } catch {
          // ignore
        }
      }
    }, PING_INTERVAL_MS);
  });

  socket.on('message', (raw: WebSocket.RawData) => {
    touchMessage();
    const text = raw.toString();
    if (text === 'PONG' || text === 'pong') return;
    void (async () => {
      try {
        const data = JSON.parse(text) as unknown;
        const batch = Array.isArray(data) ? data : [data];
        for (const item of batch) {
          await applyPolymarketUserTradeFromWs(item);
        }
        await syncRiskPolymarketBookSubscriptions();
      } catch (err) {
        log.warn({ err, preview: text.slice(0, 200) }, 'user ws message handling failed');
      }
    })();
  });

  socket.on('error', (err: unknown) => {
    lastUserWsIssue = `ws_error:${fmtErr(err)}`;
    log.warn({ err }, 'polymarket user ws error');
  });

  socket.on('close', (code: number, reason: Buffer) => {
    const why = reason?.length ? reason.toString() : '';
    lastUserWsIssue = why ? `closed:${code}:${why.slice(0, 120)}` : `closed:${code}`;
    log.warn({ code, why: why.slice(0, 200) }, 'polymarket user ws closed');
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (ws === socket) ws = null;
    scheduleUserWsReconnect();
  });
}

async function maybeRestSync(): Promise<void> {
  const meta = getPolymarketUserWsMeta();
  const stale =
    !meta.connected ||
    (meta.lastMessageAt != null &&
      Date.now() - new Date(meta.lastMessageAt).getTime() > WS_STALE_MS);
  if (!stale) return;
  try {
    await resolvePolymarketTradingCredentials();
    await syncRiskPositionsFromRestTrades();
    restSyncLastAt = new Date();
    log.info('risk: REST trade sync (user ws stale or down)');
  } catch (err) {
    log.warn({ err }, 'risk: REST trade sync failed');
  }
}

export function startPolymarketUserWsService(): void {
  if (started) return;
  started = true;
  void connectUserWs();

  restTimer = setInterval(() => {
    void maybeRestSync();
  }, REST_SYNC_MS);

  bookSubTimer = setInterval(() => {
    void syncRiskPolymarketBookSubscriptions().catch((err) =>
      log.warn({ err }, 'risk poly book sub sync failed'),
    );
  }, BOOK_SUB_SYNC_MS);

  void syncRiskPolymarketBookSubscriptions().catch(() => {});
}
