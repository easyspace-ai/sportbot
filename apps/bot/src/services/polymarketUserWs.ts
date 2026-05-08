import { createConnection } from 'node:net';
import WebSocket from 'ws';
import { createLogger } from '../logger';
import { getEffectiveHttpPlatformProxyUrl } from '../effectiveBotSettings';
import { getWebSocketConstructorForProxy, wsHandshakeTimeoutMs } from '../proxiedWebSocket';
import { resolvePolymarketTradingCredentials } from './polymarketTrading';
import {
  applyPolymarketUserTradeFromWs,
  syncRiskPositionsFromRestTrades,
} from './riskService';
import { syncRiskPolymarketBookSubscriptions } from './riskPolymarketSubscriptions';

const log = createLogger('polymarketUserWs');

const WS_USER = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const PING_INTERVAL_MS = 10_000;
/** RFC6455 ping frames — helps HTTP proxies that drop idle CONNECT tunnels. */
const WS_NATIVE_PING_INTERVAL_MS = 20_000;
const RECONNECT_MS = 4_000;
/** When outbound proxy TCP probe fails, avoid tight reconnect + log spam. */
const RECONNECT_AFTER_PROXY_DEAD_MS = 30_000;
/** Proxy host TCP probe — allow slow links; capped below typical WS handshake budget. */
const PROXY_TCP_PROBE_MS = 10_000;
const REST_SYNC_MS = 45_000;
const BOOK_SUB_SYNC_MS = 12_000;
const WS_STALE_MS = 75_000;

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let keepAlivePingTimer: ReturnType<typeof setInterval> | null = null;
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
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return String(err);
}

/** `protocol//host:port` only — never logs proxy userinfo. */
function proxyOriginForLog(): string | undefined {
  const raw = getEffectiveHttpPlatformProxyUrl();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid_proxy_url)';
  }
}

function userWsProxyLogFields(): {
  outboundProxyConfigured: boolean;
  outboundProxyOrigin: string | undefined;
} {
  return {
    outboundProxyConfigured: Boolean(getEffectiveHttpPlatformProxyUrl()),
    outboundProxyOrigin: proxyOriginForLog(),
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

/**
 * TCP reachability of the HTTP(S) proxy host:port only (not CONNECT to Polymarket).
 * Used to tell "proxy down / misconfigured" from "proxy OK but WSS path failed".
 */
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

export function getPolymarketUserWsMeta(): {
  connected: boolean;
  connecting: boolean;
  lastMessageAt: string | null;
  restTradesSyncLastAt: string | null;
  lastIssue: string | null;
  /** True when `HTTP_PLATFORM_PROXY_URL` or BotConfig `httpPlatformProxyUrl` is set (WSS uses CONNECT). */
  outboundProxyConfigured: boolean;
} {
  const r = ws?.readyState;
  return {
    connected: r === WebSocket.OPEN,
    connecting: r === WebSocket.CONNECTING,
    lastMessageAt: lastMessageAt?.toISOString() ?? null,
    restTradesSyncLastAt: restSyncLastAt?.toISOString() ?? null,
    lastIssue: lastUserWsIssue,
    outboundProxyConfigured: Boolean(getEffectiveHttpPlatformProxyUrl()),
  };
}

function touchMessage(): void {
  lastMessageAt = new Date();
}

function scheduleUserWsReconnect(delayMs: number = RECONNECT_MS): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectUserWs();
  }, delayMs);
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
  if (keepAlivePingTimer) {
    clearInterval(keepAlivePingTimer);
    keepAlivePingTimer = null;
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

  const proxyUrl = getEffectiveHttpPlatformProxyUrl();
  if (proxyUrl) {
    const alive = await isProxyHostReachable(proxyUrl);
    if (!alive) {
      lastUserWsIssue = `proxy_unreachable [${proxyTagZh()}]`;
      log.error(
        { ...userWsProxyLogFields(), url: WS_USER },
        'polymarket user ws: outbound proxy TCP unreachable, delaying reconnect',
      );
      scheduleUserWsReconnect(RECONNECT_AFTER_PROXY_DEAD_MS);
      return;
    }
  }

  const Ws = getWebSocketConstructorForProxy();
  const viaProxy = Ws !== WebSocket;
  log.info(
    { ...userWsProxyLogFields(), viaProxy, url: WS_USER },
    'polymarket user ws connecting',
  );

  const handshakeTimeout = wsHandshakeTimeoutMs();
  const socket =
    Ws === WebSocket
      ? new WebSocket(WS_USER, { handshakeTimeout })
      : new Ws(WS_USER, { handshakeTimeout });
  ws = socket;

  socket.on('open', () => {
    lastUserWsIssue = null;
    log.info(
      { ...userWsProxyLogFields(), viaProxy, url: WS_USER },
      'polymarket user ws connected',
    );
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

    if (keepAlivePingTimer) clearInterval(keepAlivePingTimer);
    keepAlivePingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.ping();
        } catch {
          // ignore
        }
      }
    }, WS_NATIVE_PING_INTERVAL_MS);
  });

  socket.on('pong', () => {
    touchMessage();
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
    const msg = fmtErr(err);
    lastUserWsIssue = `ws_error:${msg} [${proxyTagZh()}]`;
    log.warn(
      { err, ...userWsProxyLogFields(), viaProxy, url: WS_USER },
      'polymarket user ws error',
    );
  });

  socket.on('close', (code: number, reason: Buffer) => {
    const why = reason?.length ? reason.toString() : '';
    const base = why ? `closed:${code}:${why.slice(0, 120)}` : `closed:${code}`;
    lastUserWsIssue = `${base} [${proxyTagZh()}]`;
    log.warn(
      { code, why: why.slice(0, 200), ...userWsProxyLogFields(), viaProxy, url: WS_USER },
      'polymarket user ws closed',
    );
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (keepAlivePingTimer) {
      clearInterval(keepAlivePingTimer);
      keepAlivePingTimer = null;
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
