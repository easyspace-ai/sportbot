import { ClobMarketClient, type ClobBookEvent, type ClobPriceChangeEvent } from 'polymarket-websocket-client';
import { polymarketBookCache, type ClobLevel, type PriceChange } from './polymarketBookCache';
import { polymarketOddsCache } from './polymarketOddsCache';
import { emitMarketRemoved } from './marketEvents';
import { createLogger } from '../logger';
import { platformFetch } from '../platformFetch';
import { getEffectiveHttpPlatformProxyUrl } from '../effectiveBotSettings';

const log = createLogger('polymarketWs');

const CLOB_API = 'https://clob.polymarket.com';

const POLYMARKET_WS_HEADERS: Record<string, string> = {
  'Origin': 'https://polymarket.com',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

const UNSUBSCRIBE_GRACE_MS = 10_000;
const BOOK_SEED_CONCURRENCY = 6;
const ODDS_SEED_CONCURRENCY = 6;
const SEED_TIMEOUT_MS = 5_000;

interface SubState {
  depthRefCount: number;
  bestOddsRefCount: number;
  pendingTeardown: ReturnType<typeof setTimeout> | null;
}

const subs = new Map<string, SubState>();

let client: ClobMarketClient | null = null;
let started = false;

function totalRef(s: SubState): number {
  return s.depthRefCount + s.bestOddsRefCount;
}

function getActiveTokenIds(): string[] {
  return Array.from(subs.keys()).filter((id) => {
    const s = subs.get(id);
    return !!s && totalRef(s) > 0;
  });
}

const seedInflight = new Map<string, Promise<void>>();

interface SeedQueue {
  limit: number;
  active: number;
  pending: Array<() => void>;
}

const bookQueue: SeedQueue = { limit: BOOK_SEED_CONCURRENCY, active: 0, pending: [] };
const oddsQueue: SeedQueue = { limit: ODDS_SEED_CONCURRENCY, active: 0, pending: [] };

function runOn(q: SeedQueue, job: () => Promise<void>): void {
  if (q.active < q.limit) {
    q.active += 1;
    job().finally(() => {
      q.active -= 1;
      const next = q.pending.shift();
      if (next) next();
    });
  } else {
    q.pending.push(() => runOn(q, job));
  }
}

async function fetchWithTimeout(url: string): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SEED_TIMEOUT_MS);
  try {
    return await platformFetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function seedBook(tokenId: string): Promise<void> {
  const key = `book:${tokenId}`;
  const existing = seedInflight.get(key);
  if (existing) return existing;
  const promise = new Promise<void>((resolve) => {
    runOn(bookQueue, async () => {
      try {
        const res = await fetchWithTimeout(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`);
        if (!res || !res.ok) return;
        const body = (await res.json()) as { bids?: ClobLevel[]; asks?: ClobLevel[] };
        polymarketBookCache.replaceBook(tokenId, body.bids ?? [], body.asks ?? [], Date.now());
      } catch {
        // silent
      } finally {
        seedInflight.delete(key);
        resolve();
      }
    });
  });
  seedInflight.set(key, promise);
  return promise;
}

async function seedBestOdds(tokenId: string): Promise<void> {
  const key = `odds:${tokenId}`;
  const existing = seedInflight.get(key);
  if (existing) return existing;
  const promise = new Promise<void>((resolve) => {
    runOn(oddsQueue, async () => {
      try {
        const res = await fetchWithTimeout(`${CLOB_API}/price?token_id=${encodeURIComponent(tokenId)}&side=SELL`);
        if (!res || !res.ok) return;
        const body = (await res.json()) as { price?: string | number };
        const raw = typeof body.price === 'string' ? parseFloat(body.price) : body.price;
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return;
        if (polymarketOddsCache.get(tokenId)) return;
        polymarketOddsCache.set(tokenId, raw, 0, Date.now());
      } catch {
        // silent
      } finally {
        seedInflight.delete(key);
        resolve();
      }
    });
  });
  seedInflight.set(key, promise);
  return promise;
}

export function warmPolyBook(tokenId: string): Promise<void> {
  if (polymarketBookCache.hasToken(tokenId)) return Promise.resolve();
  return seedBook(tokenId);
}

function mirrorTopOfBookToOddsCache(tokenId: string): void {
  const top = polymarketBookCache.getTopOfBook(tokenId);
  if (!top || top.bestAsk === undefined) return;
  polymarketOddsCache.set(tokenId, top.bestAsk, top.bestBid ?? 0, Date.now());
}

function handleBookEvent(event: ClobBookEvent): void {
  if (!event.asset_id) return;
  const state = subs.get(event.asset_id);
  if (!state || totalRef(state) === 0) return;
  const ts = parseInt(event.timestamp, 10) || Date.now();
  polymarketBookCache.replaceBook(
    event.asset_id,
    (event.bids ?? []).map((b) => ({ price: b.price, size: b.size })),
    (event.asks ?? []).map((a) => ({ price: a.price, size: a.size })),
    ts,
  );
  mirrorTopOfBookToOddsCache(event.asset_id);
}

function handlePriceChangeEvent(event: ClobPriceChangeEvent): void {
  if (!event.price_changes) return;
  for (const change of event.price_changes) {
    const assetId = change.asset_id;
    if (!assetId) continue;
    const state = subs.get(assetId);
    if (!state || totalRef(state) === 0) continue;
    const ts = parseInt(event.timestamp, 10) || Date.now();
    const priceChanges: PriceChange[] = event.price_changes.map((c) => ({
      price: c.price,
      size: c.size,
      side: c.side,
      hash: c.hash,
      best_bid: c.best_bid,
      best_ask: c.best_ask,
    }));
    polymarketBookCache.applyPriceChange(assetId, priceChanges, ts);
    mirrorTopOfBookToOddsCache(assetId);
  }
}

function getOrCreate(tokenId: string): SubState {
  let s = subs.get(tokenId);
  if (!s) {
    s = { depthRefCount: 0, bestOddsRefCount: 0, pendingTeardown: null };
    subs.set(tokenId, s);
  }
  return s;
}

function scheduleTeardown(tokenId: string): void {
  const state = subs.get(tokenId);
  if (!state) return;
  if (totalRef(state) > 0) return;
  if (state.pendingTeardown) return;
  state.pendingTeardown = setTimeout(() => {
    const s = subs.get(tokenId);
    if (!s || totalRef(s) > 0) return;
    subs.delete(tokenId);
    if (client && client.isConnected) {
      client.unsubscribe([tokenId]);
    }
    polymarketBookCache.clearBook(tokenId);
    polymarketOddsCache.clear(tokenId);
  }, UNSUBSCRIBE_GRACE_MS);
}

export function subscribeToPolyBook(tokenId: string): void {
  if (!started) {
    log.warn({ tokenId }, 'subscribeToPolyBook called before service started');
    return;
  }
  const state = getOrCreate(tokenId);
  const upstreamActive = totalRef(state) > 0 || state.pendingTeardown !== null;
  if (state.pendingTeardown) {
    clearTimeout(state.pendingTeardown);
    state.pendingTeardown = null;
  }
  const wasDepthActive = state.depthRefCount > 0;
  state.depthRefCount += 1;
  if (!wasDepthActive) {
    polymarketBookCache.clearBook(tokenId);
    seedBook(tokenId).catch((err) => {
      log.error({ err, tokenId }, 'seedBook failed');
    });
  }
  if (!client) {
    const proxyUrl = getEffectiveHttpPlatformProxyUrl() ?? undefined;
    client = new ClobMarketClient({
      proxyUrl,
      connectionTimeout: 30000,
      heartbeatInterval: 30000,
      headers: POLYMARKET_WS_HEADERS,
    });
    client.onBook(handleBookEvent);
    client.onPriceChange(handlePriceChangeEvent);
    client.on('error', (err) => {
      log.warn({ err }, 'polymarket ws error');
    });
    client.on('stateChange', ({ state: s }) => {
      if (s === 'connected') {
        log.info({ viaProxy: Boolean(proxyUrl) }, 'polymarket ws connected');
        const tokens = getActiveTokenIds();
        if (tokens.length > 0) client!.subscribe(tokens);
      } else if (s === 'disconnected' || s === 'reconnecting') {
        log.info({ state: s }, 'polymarket ws state');
      }
    });
    client.connect().catch((err) => {
      log.error({ err }, 'polymarket ws connect failed');
    });
  }
  if (!upstreamActive && client.isConnected) {
    client.subscribe([tokenId]);
  }
}

export function unsubscribeFromPolyBook(tokenId: string): void {
  const state = subs.get(tokenId);
  if (!state || state.depthRefCount === 0) return;
  state.depthRefCount -= 1;
  if (totalRef(state) > 0) return;
  scheduleTeardown(tokenId);
}

export async function refreshPolymarketBook(tokenId: string): Promise<void> {
  if (!tokenId) return;
  polymarketBookCache.clearBook(tokenId);
  polymarketOddsCache.clear(tokenId);
  await seedBook(tokenId);
}

export function subscribeToPolyBestOdds(tokenId: string): void {
  if (!started) {
    log.warn({ tokenId }, 'subscribeToPolyBestOdds called before service started');
    return;
  }
  const state = getOrCreate(tokenId);
  const upstreamActive = totalRef(state) > 0 || state.pendingTeardown !== null;
  if (state.pendingTeardown) {
    clearTimeout(state.pendingTeardown);
    state.pendingTeardown = null;
  }
  const wasBestOddsActive = state.bestOddsRefCount > 0;
  state.bestOddsRefCount += 1;
  if (!wasBestOddsActive && !polymarketOddsCache.has(tokenId)) {
    seedBestOdds(tokenId).catch((err) => {
      log.error({ err, tokenId }, 'seedBestOdds failed');
    });
  }
  if (!client) {
    const proxyUrl = getEffectiveHttpPlatformProxyUrl() ?? undefined;
    client = new ClobMarketClient({
      proxyUrl,
      connectionTimeout: 30000,
      heartbeatInterval: 30000,
      headers: POLYMARKET_WS_HEADERS,
    });
    client.onBook(handleBookEvent);
    client.onPriceChange(handlePriceChangeEvent);
    client.on('error', (err) => {
      log.warn({ err }, 'polymarket ws error');
    });
    client.on('stateChange', ({ state: s }) => {
      if (s === 'connected') {
        log.info({ viaProxy: Boolean(proxyUrl) }, 'polymarket ws connected');
        const tokens = getActiveTokenIds();
        if (tokens.length > 0) client!.subscribe(tokens);
      } else if (s === 'disconnected' || s === 'reconnecting') {
        log.info({ state: s }, 'polymarket ws state');
      }
    });
    client.connect().catch((err) => {
      log.error({ err }, 'polymarket ws connect failed');
    });
  }
  if (!upstreamActive && client.isConnected) {
    client.subscribe([tokenId]);
  }
}

export function unsubscribeFromPolyBestOdds(tokenId: string): void {
  const state = subs.get(tokenId);
  if (!state || state.bestOddsRefCount === 0) return;
  state.bestOddsRefCount -= 1;
  if (totalRef(state) > 0) return;
  scheduleTeardown(tokenId);
}

export function startPolymarketWsService(): void {
  if (started) return;
  started = true;
  log.info('service started (lazy socket)');
}