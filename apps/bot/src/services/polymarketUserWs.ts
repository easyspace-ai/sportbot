import { createConnection } from 'node:net';
import { ClobUserClient, type ClobTradeEvent, type ClobOrderEvent } from 'polymarket-websocket-client';
import { createLogger } from '../logger';
import { getEffectiveHttpPlatformProxyUrl, httpPlatformProxyLogFields } from '../effectiveBotSettings';
import { resolvePolymarketTradingCredentials } from './polymarketTrading';
import { applyPolymarketUserTradeFromWs, syncRiskPositionsFromRestTrades } from './riskService';
import { syncRiskPolymarketBookSubscriptions } from './riskPolymarketSubscriptions';
import { prisma } from '../db';

const log = createLogger('polymarketUserWs');

const POLYMARKET_WS_HEADERS: Record<string, string> = {
  'Origin': 'https://polymarket.com',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

const REST_SYNC_MS = 45_000;
const BOOK_SUB_SYNC_MS = 12_000;
const WS_STALE_MS = 75_000;
const PROXY_TCP_PROBE_MS = 10_000;
const RECONNECT_AFTER_PROXY_DEAD_MS = 30_000;

let client: ClobUserClient | null = null;
let started = false;
let restTimer: ReturnType<typeof setInterval> | null = null;
let bookSubTimer: ReturnType<typeof setInterval> | null = null;
let lastMessageAt: Date | null = null;
let restSyncLastAt: Date | null = null;
let lastUserWsIssue: string | null = null;

export function getPolymarketUserWsMeta(): {
  connected: boolean;
  connecting: boolean;
  lastMessageAt: string | null;
  restTradesSyncLastAt: string | null;
  lastIssue: string | null;
  outboundProxyConfigured: boolean;
} {
  return {
    connected: client?.isConnected ?? false,
    connecting: client?.connectionState === 'connecting',
    lastMessageAt: lastMessageAt?.toISOString() ?? null,
    restTradesSyncLastAt: restSyncLastAt?.toISOString() ?? null,
    lastIssue: lastUserWsIssue,
    outboundProxyConfigured: Boolean(getEffectiveHttpPlatformProxyUrl()),
  };
}

function proxyTagZh(): string {
  return getEffectiveHttpPlatformProxyUrl() ? '代理:开' : '代理:关';
}

function defaultProxyPort(u: URL): number {
  if (u.port) return Number(u.port);
  if (u.protocol === 'https:') return 443;
  return 80;
}

async function isProxyHostReachable(proxyUrl: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(proxyUrl);
  } catch {
    return false;
  }
  const host = u.hostname;
  const port = defaultProxyPort(u);
  if (!host || !Number.isFinite(port) || port <= 0) return false;

  return await new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const socket = createConnection({ host, port }, () => {
      socket.destroy();
      done(true);
    });
    socket.setTimeout(PROXY_TCP_PROBE_MS);
    socket.once('timeout', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => {
      socket.destroy();
      done(false);
    });
  });
}

export function hardResetPolymarketUserWs(): void {
  lastUserWsIssue = 'reconnect_after_proxy_change';
  if (client) {
    client.disconnect();
    client = null;
  }
  void connectUserWs();
}

async function connectUserWs(): Promise<void> {
  if (client && (client.isConnected || client.connectionState === 'connecting')) return;

  let creds: { apiKey: string; secret: string; passphrase: string };
  try {
    creds = await resolvePolymarketTradingCredentials();
  } catch (err) {
    lastUserWsIssue = `no_trading_credentials:${String(err)}`;
    log.warn({ err }, 'polymarket user ws: no trading credentials, skip');
    scheduleUserWsReconnect();
    return;
  }

  const proxyUrl = getEffectiveHttpPlatformProxyUrl();
  if (proxyUrl) {
    const alive = await isProxyHostReachable(proxyUrl);
    if (!alive) {
      lastUserWsIssue = `proxy_unreachable [${proxyTagZh()}]`;
      log.error(
        { ...httpPlatformProxyLogFields(), url: 'wss://ws-subscriptions-clob.polymarket.com/ws/user' },
        'polymarket user ws: outbound proxy TCP unreachable, delaying reconnect',
      );
      scheduleUserWsReconnect(RECONNECT_AFTER_PROXY_DEAD_MS);
      return;
    }
  }

  const viaProxy = Boolean(proxyUrl);
  log.info(
    { ...httpPlatformProxyLogFields(), viaProxy },
    'polymarket user ws connecting',
  );

  
  client = new ClobUserClient(
    { apiKey: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase },
    {
      proxyUrl: proxyUrl ?? undefined,
      connectionTimeout: 30000,
      heartbeatInterval: 10000,
      headers: POLYMARKET_WS_HEADERS,
    },
  );

  client.onTrade((event: ClobTradeEvent) => {
    lastMessageAt = new Date();
    void (async () => {
      try {
        await applyPolymarketUserTradeFromWs(event);
        await syncRiskPolymarketBookSubscriptions();
      } catch (err) {
        log.warn({ err }, 'trade event handling failed');
      }
    })();
  });

  client.onOrder((event: ClobOrderEvent) => {
    lastMessageAt = new Date();
    void (async () => {
      try {
        await applyPolymarketUserTradeFromWs(event);
        await syncRiskPolymarketBookSubscriptions();
      } catch (err) {
        log.warn({ err }, 'order event handling failed');
      }
    })();
  });

  client.on('stateChange', ({ state }) => {
    if (state === 'connected') {
      lastUserWsIssue = null;
      log.info('polymarket user ws connected');
    } else if (state === 'disconnected') {
      log.info({ viaProxy }, 'polymarket user ws disconnected');
    }
  });

  client.on('error', (err) => {
    lastUserWsIssue = `ws_error:${String(err)} [${proxyTagZh()}]`;
    log.warn({ err, ...httpPlatformProxyLogFields(), viaProxy }, 'polymarket user ws error');
  });

  client.on('disconnected', ({ code, reason }) => {
    lastUserWsIssue = `closed:${code}:${String(reason).slice(0, 120)} [${proxyTagZh()}]`;
    log.warn({ code, reason: String(reason).slice(0, 200) }, 'polymarket user ws closed');
    scheduleUserWsReconnect();
  });

  client.connect().catch((err) => {
    lastUserWsIssue = `connect_failed:${String(err)} [${proxyTagZh()}]`;
    log.warn({ err }, 'polymarket user ws connect failed');
  });
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleUserWsReconnect(delayMs: number = 4000): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectUserWs();
  }, delayMs);
}

async function maybeRestSync(): Promise<void> {
  const meta = getPolymarketUserWsMeta();
  const stale =
    !meta.connected ||
    (meta.lastMessageAt != null && Date.now() - new Date(meta.lastMessageAt).getTime() > WS_STALE_MS);
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