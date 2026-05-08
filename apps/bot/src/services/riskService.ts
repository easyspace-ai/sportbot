import type { RiskPosition, RiskTask as RiskTaskRow } from '@prisma/client';
import { ApiError, AssetType } from '@polymarket/clob-client-v2';
import { prisma } from '../db';
import { createLogger } from '../logger';
import { getMinOpenRiskShares, resolveStopLossPctForOpenYesCents } from '../effectiveBotSettings';
import { conditionalBalanceToShareFloat, executePolymarketSell } from '../executor/polymarket';
import { getPolymarketClobClient } from './polymarketTrading';
import { bestBidPrice } from './clobOrderBook';
import { polymarketBookCache } from './polymarketBookCache';

const log = createLogger('risk');

const DEFAULT_STOP_PCT = 20;

/** Serialize `ensureCloseTask` per position to avoid duplicate `close_position` rows under concurrent WS + poller. */
const ensureCloseTaskTailByPosition = new Map<string, Promise<unknown>>();

/** Only true float dust / empty book — used to mark `closed` without touching sub‑1 but ≥ dust positions. */
const RISK_SHARE_DUST = 1e-5;

/** Throttle CLOB balance reconciliation on dashboard poll. */
let lastRiskBalanceReconcileMs = 0;
const RISK_BALANCE_RECONCILE_MIN_INTERVAL_MS = 25_000;

async function normalizeDustOpenRiskRows(): Promise<void> {
  await prisma.riskPosition.updateMany({
    where: {
      status: { in: ['open', 'closing'] },
      sizeShares: { lte: RISK_SHARE_DUST },
    },
    data: { status: 'closed', sizeShares: 0, costUsd: 0 },
  });
}

/** CLOB returns 404 when the market has no book (resolved, retired, or wrong token). */
function isMissingOrderBookError(err: unknown): boolean {
  if (err instanceof ApiError && err.status === 404) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /no orderbook exists/i.test(msg);
}

function jsonSafeSnippet(v: unknown, maxLen: number): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.length > maxLen ? `${v.slice(0, maxLen)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return '[non-JSON]';
  }
}

/**
 * Turn arbitrary throw values into a dashboard-friendly line + structured log fields
 * (unwraps `cause`, surfaces Polymarket `ApiError` status/body).
 */
function formatRiskExecutionError(err: unknown): { oneLine: string; logFields: Record<string, unknown> } {
  const logFields: Record<string, unknown> = {};
  const segments: string[] = [];

  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur != null; depth++) {
    if (cur instanceof ApiError) {
      segments.push(cur.message);
      logFields.apiStatus = cur.status;
      logFields.apiDataSnippet = jsonSafeSnippet(cur.data, 900);
      logFields.errorName = cur.name;
      if (cur.stack) logFields.stackTop = cur.stack.split('\n').slice(0, 12).join('\n');
      break;
    }
    if (cur instanceof Error) {
      segments.push(cur.message);
      logFields.errorName = logFields.errorName ?? cur.name;
      if (!logFields.stackTop && cur.stack) {
        logFields.stackTop = cur.stack.split('\n').slice(0, 12).join('\n');
      }
      cur = cur.cause;
      continue;
    }
    segments.push(String(cur));
    break;
  }

  const oneLine = segments.filter(Boolean).join(' | ').slice(0, 1900);
  return { oneLine, logFields };
}

function estimatedShares(costUsd: number, fillOdds: number): number {
  if (!(fillOdds > 0)) return 0;
  return costUsd / fillOdds;
}

export async function recordPolymarketBuyFill(params: {
  outcomeId: string;
  tokenId: string;
  title: string;
  sideLabel: string;
  fillOdds: number;
  costUsd: number;
}): Promise<void> {
  const { outcomeId, tokenId, title, sideLabel, fillOdds, costUsd } = params;
  const entryCents = fillOdds * 100;
  const newShares = estimatedShares(costUsd, fillOdds);
  if (newShares <= 0) return;

  const stopLossPct = resolveStopLossPctForOpenYesCents(entryCents) ?? DEFAULT_STOP_PCT;

  await normalizeDustOpenRiskRows();

  const existing = await prisma.riskPosition.findFirst({
    where: { tokenId, status: 'open' },
  });

  if (!existing) {
    await prisma.riskPosition.create({
      data: {
        platform: 'polymarket',
        outcomeId,
        tokenId,
        title,
        sideLabel,
        avgEntryCents: entryCents,
        sizeShares: newShares,
        costUsd,
        highWaterCents: entryCents,
        stopLossPct,
        source: 'bot',
      },
    });
    log.info({ outcomeId, tokenId, newShares }, 'risk position opened');
    return;
  }

  const totalShares = existing.sizeShares + newShares;
  const avgEntryCents =
    (existing.avgEntryCents * existing.sizeShares + entryCents * newShares) / totalShares;
  const highWaterCents = Math.max(existing.highWaterCents, entryCents);
  await prisma.riskPosition.update({
    where: { id: existing.id },
    data: {
      sizeShares: totalShares,
      costUsd: existing.costUsd + costUsd,
      avgEntryCents,
      highWaterCents,
      title,
      sideLabel,
      outcomeId: existing.outcomeId ?? outcomeId,
    },
  });
  log.info({ outcomeId, id: existing.id, totalShares }, 'risk position scaled');
}

async function readBestBidCents(tokenId: string): Promise<number | null> {
  try {
    const client = await getPolymarketClobClient();
    const book = await client.getOrderBook(tokenId);
    const p = bestBidPrice(book.bids);
    if (p == null) return null;
    return p * 100;
  } catch (err) {
    if (isMissingOrderBookError(err)) {
      log.debug({ tokenId }, 'risk: no CLOB orderbook for token (resolved/delisted or invalid id)');
    } else {
      log.warn({ err, tokenId }, 'risk: failed to read order book');
    }
    return null;
  }
}

async function bestBidCentsForRisk(tokenId: string): Promise<number | null> {
  const top = polymarketBookCache.getTopOfBook(tokenId);
  if (top?.bestBid != null && Number.isFinite(top.bestBid) && top.bestBid > 0) {
    return top.bestBid * 100;
  }
  return readBestBidCents(tokenId);
}

async function resolveOutcomeIdForToken(tokenId: string): Promise<string | null> {
  const o = await prisma.outcome.findFirst({
    where: { externalId: tokenId },
    select: { id: true },
  });
  return o?.id ?? null;
}

/** Apply high-water + trailing stop check for one row (mutates DB highWater when bid rises). */
async function updateHighWaterAndMaybeQueueStop(
  p: RiskPosition,
  bidCents: number | null,
): Promise<{ highWater: number; trailingStopCents: number; currentCents: number | null }> {
  let highWater = p.highWaterCents;
  if (bidCents != null && bidCents > highWater) {
    highWater = bidCents;
    await prisma.riskPosition.update({
      where: { id: p.id },
      data: { highWaterCents: highWater },
    });
  }
  const trailingStopCents = highWater * (1 - p.stopLossPct / 100);
  if (
    p.status === 'open' &&
    p.sizeShares >= getMinOpenRiskShares() &&
    bidCents != null &&
    bidCents <= trailingStopCents
  ) {
    await ensureCloseTask(p.id);
  }
  return { highWater, trailingStopCents, currentCents: bidCents };
}

/** Called from market book WS (debounced) — fast path without full REST list. */
export async function riskEvaluateTokenAfterBookUpdate(tokenId: string): Promise<void> {
  const rows = await prisma.riskPosition.findMany({
    where: { tokenId, status: 'open', sizeShares: { gte: getMinOpenRiskShares() } },
  });
  if (rows.length === 0) return;
  const bidCents = await bestBidCentsForRisk(tokenId);
  if (bidCents == null) return;
  for (const p of rows) {
    await updateHighWaterAndMaybeQueueStop(p, bidCents);
  }
}

/**
 * Apply a single CLOB trade (user channel or REST) idempotently.
 * Returns true if applied.
 */
export async function applyClobTradeIfNew(trade: {
  id: string;
  asset_id: string;
  side: string;
  size: string;
  price: string;
  status: string;
  market?: string;
  outcome?: string;
}): Promise<boolean> {
  const st = String(trade.status ?? '').toUpperCase();
  if (!['MATCHED', 'MINED', 'CONFIRMED'].includes(st)) return false;

  await normalizeDustOpenRiskRows();

  try {
    await prisma.riskAppliedClobTrade.create({ data: { id: trade.id } });
  } catch {
    return false;
  }

  const assetId = String(trade.asset_id ?? '');
  const side = String(trade.side ?? '').toUpperCase();
  const size = parseFloat(String(trade.size ?? '0'));
  const price = parseFloat(String(trade.price ?? '0'));
  if (!assetId || !Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
    return true;
  }

  if (side === 'BUY') {
    const entryCents = price * 100;
    const newShares = size;
    const costUsd = size * price;
    const stopLossPct = resolveStopLossPctForOpenYesCents(entryCents) ?? DEFAULT_STOP_PCT;
    const outcomeId = await resolveOutcomeIdForToken(assetId);
    const titleFromMarket = trade.market ? `CLOB ${String(trade.market).slice(0, 10)}…` : 'Polymarket';
    const sideLabel = String(trade.outcome ?? 'YES');

    const existing = await prisma.riskPosition.findFirst({
      where: { tokenId: assetId, status: 'open' },
    });

    if (!existing) {
      await prisma.riskPosition.create({
        data: {
          platform: 'polymarket',
          ...(outcomeId ? { outcomeId } : {}),
          tokenId: assetId,
          title: titleFromMarket,
          sideLabel,
          avgEntryCents: entryCents,
          sizeShares: newShares,
          costUsd,
          highWaterCents: entryCents,
          stopLossPct,
          source: 'polymarket_clob',
        },
      });
      log.info({ assetId, newShares, tradeId: trade.id }, 'risk position opened from CLOB trade');
    } else {
      const totalShares = existing.sizeShares + newShares;
      const avgEntryCents =
        (existing.avgEntryCents * existing.sizeShares + entryCents * newShares) / totalShares;
      const highWaterCents = Math.max(existing.highWaterCents, entryCents);
      await prisma.riskPosition.update({
        where: { id: existing.id },
        data: {
          sizeShares: totalShares,
          costUsd: existing.costUsd + costUsd,
          avgEntryCents,
          highWaterCents,
          outcomeId: existing.outcomeId ?? outcomeId,
        },
      });
      log.info({ assetId, id: existing.id, totalShares }, 'risk position scaled from CLOB trade');
    }
    return true;
  }

  if (side === 'SELL') {
    const existing = await prisma.riskPosition.findFirst({
      where: { tokenId: assetId, status: 'open' },
    });
    if (!existing) return true;
    const nextShares = existing.sizeShares - size;
    if (!Number.isFinite(nextShares) || nextShares < getMinOpenRiskShares()) {
      await prisma.riskPosition.update({
        where: { id: existing.id },
        data: { status: 'closed', sizeShares: 0, costUsd: 0 },
      });
      log.info({ assetId, id: existing.id }, 'risk position closed by CLOB sell trade');
    } else {
      const ratio = size / existing.sizeShares;
      const costUsd = Math.max(0, existing.costUsd * (1 - ratio));
      await prisma.riskPosition.update({
        where: { id: existing.id },
        data: { sizeShares: nextShares, costUsd },
      });
      log.info({ assetId, id: existing.id, nextShares }, 'risk position reduced by CLOB sell trade');
    }
    return true;
  }

  return true;
}

export function parseUserWsTradePayload(raw: unknown): {
  id: string;
  asset_id: string;
  side: string;
  size: string;
  price: string;
  status: string;
  market?: string;
  outcome?: string;
} | null {
  if (raw == null) return null;
  let o: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof raw === 'object') {
    o = raw as Record<string, unknown>;
  } else {
    return null;
  }
  const eventType = String(o.event_type ?? '').toLowerCase();
  const typeField = String(o.type ?? '').toUpperCase();
  if (eventType !== 'trade' && typeField !== 'TRADE') return null;
  const id = String(o.id ?? '');
  const asset_id = String(o.asset_id ?? '');
  if (!id || !asset_id) return null;
  return {
    id,
    asset_id,
    side: String(o.side ?? ''),
    size: String(o.size ?? '0'),
    price: String(o.price ?? '0'),
    status: String(o.status ?? ''),
    market: o.market != null ? String(o.market) : undefined,
    outcome: o.outcome != null ? String(o.outcome) : undefined,
  };
}

export async function applyPolymarketUserTradeFromWs(raw: unknown): Promise<void> {
  const parsed = parseUserWsTradePayload(raw);
  if (!parsed) return;
  await applyClobTradeIfNew(parsed);
}

/** REST fallback: recent trades (newest page) when user WS is quiet. */
export async function syncRiskPositionsFromRestTrades(): Promise<void> {
  const client = await getPolymarketClobClient();
  const { trades } = await client.getTradesPaginated(undefined, undefined);
  const slice = trades.slice(0, 100);
  for (const t of [...slice].reverse()) {
    await applyClobTradeIfNew({
      id: t.id,
      asset_id: t.asset_id,
      side: t.side,
      size: t.size,
      price: t.price,
      status: t.status,
      market: t.market,
      outcome: t.outcome,
    });
  }
  await reconcileOpenRiskPositionsWithClobBalances();
}

export interface RiskPositionApiRow {
  id: string;
  title: string;
  sideLabel: string;
  avgEntryCents: number;
  currentCents: number | null;
  sizeShares: number;
  costUsd: number;
  highWaterCents: number;
  stopLossPct: number;
  trailingStopCents: number;
  valueUsd: number | null;
  pnlUsd: number | null;
  maxPayoffUsd: number;
  potentialProfitUsd: number;
  status: string;
  source: string;
}

export interface RiskPositionsResponseMeta {
  userWsConnected: boolean;
  userWsConnecting: boolean;
  userWsLastMessageAt: string | null;
  restTradesSyncLastAt: string | null;
  userWsLastIssue: string | null;
  minOpenRiskShares: number;
}

/**
 * Align `RiskPosition` rows with CLOB conditional token balance (source of truth vs trade replay).
 * Closes rows whose on-chain balance is below `minOpenRiskShares`; shrinks `sizeShares` when DB is high.
 */
export async function reconcileOpenRiskPositionsWithClobBalances(): Promise<void> {
  const minShares = getMinOpenRiskShares();
  const rows = await prisma.riskPosition.findMany({
    where: { status: { in: ['open', 'closing'] } },
    select: { id: true, tokenId: true, sizeShares: true, costUsd: true },
  });
  if (rows.length === 0) return;

  let client;
  try {
    client = await getPolymarketClobClient();
  } catch (err) {
    log.debug({ err }, 'risk: reconcile skipped (no CLOB client)');
    return;
  }

  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        const bal = await client.getBalanceAllowance({
          asset_type: AssetType.CONDITIONAL,
          token_id: row.tokenId,
        });
        const onChainShares = conditionalBalanceToShareFloat(String(bal.balance));
        if (!Number.isFinite(onChainShares) || onChainShares < minShares) {
          await prisma.riskPosition.update({
            where: { id: row.id },
            data: { status: 'closed', sizeShares: 0, costUsd: 0 },
          });
          log.info(
            { id: row.id, tokenId: row.tokenId, onChainShares, minShares },
            'risk: position closed (CLOB balance below minOpenRiskShares)',
          );
          return;
        }
        if (onChainShares + 1e-9 < row.sizeShares) {
          const ratio = onChainShares / row.sizeShares;
          await prisma.riskPosition.update({
            where: { id: row.id },
            data: {
              sizeShares: onChainShares,
              costUsd: Math.max(0, row.costUsd * ratio),
            },
          });
          log.info(
            { id: row.id, tokenId: row.tokenId, dbShares: row.sizeShares, onChainShares },
            'risk: position size reconciled to CLOB balance',
          );
        }
      } catch (err) {
        log.debug({ err, tokenId: row.tokenId }, 'risk: reconcile balance skipped for token');
      }
    }),
  );
}

export async function listRiskPositionsEnriched(): Promise<RiskPositionApiRow[]> {
  await normalizeDustOpenRiskRows();

  const now = Date.now();
  if (now - lastRiskBalanceReconcileMs >= RISK_BALANCE_RECONCILE_MIN_INTERVAL_MS) {
    lastRiskBalanceReconcileMs = now;
    try {
      await reconcileOpenRiskPositionsWithClobBalances();
    } catch (err) {
      log.warn({ err }, 'risk: balance reconcile failed');
    }
  }

  const minShares = getMinOpenRiskShares();
  const rows = await prisma.riskPosition.findMany({
    where: {
      status: { in: ['open', 'closing'] },
      sizeShares: { gte: minShares },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const bidCentsArr = await Promise.all(
    rows.map((p) => bestBidCentsForRisk(p.tokenId).catch(() => null as number | null)),
  );

  const out: RiskPositionApiRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    const bidCents = bidCentsArr[i];
    const { highWater, trailingStopCents, currentCents } = await updateHighWaterAndMaybeQueueStop(
      p,
      bidCents,
    );

    const currentUsd = currentCents != null ? currentCents / 100 : null;
    const valueUsd = currentUsd != null ? p.sizeShares * currentUsd : null;
    const pnlUsd = valueUsd != null ? valueUsd - p.costUsd : null;
    const maxPayoffUsd = p.sizeShares * 1;
    const potentialProfitUsd = maxPayoffUsd - p.costUsd;

    out.push({
      id: p.id,
      title: p.title,
      sideLabel: p.sideLabel,
      avgEntryCents: p.avgEntryCents,
      currentCents,
      sizeShares: p.sizeShares,
      costUsd: p.costUsd,
      highWaterCents: highWater,
      stopLossPct: p.stopLossPct,
      trailingStopCents,
      valueUsd,
      pnlUsd,
      maxPayoffUsd,
      potentialProfitUsd,
      status: p.status,
      source: p.source,
    });
  }

  return out;
}

async function ensureCloseTask(positionId: string): Promise<void> {
  const prev = ensureCloseTaskTailByPosition.get(positionId) ?? Promise.resolve();
  const job = prev.then(() => ensureCloseTaskBody(positionId));
  ensureCloseTaskTailByPosition.set(positionId, job);
  try {
    await job;
  } finally {
    if (ensureCloseTaskTailByPosition.get(positionId) === job) {
      ensureCloseTaskTailByPosition.delete(positionId);
    }
  }
}

async function ensureCloseTaskBody(positionId: string): Promise<void> {
  const active = await prisma.riskTask.findFirst({
    where: {
      positionId,
      type: 'close_position',
      status: { in: ['pending', 'running'] },
    },
  });
  if (active) return;
  await prisma.riskTask.create({
    data: {
      type: 'close_position',
      positionId,
      status: 'pending',
      nextRunAt: new Date(),
    },
  });
  log.info({ positionId }, 'risk: stop-loss queued close_position task');
}

export async function patchRiskPositionStop(params: {
  id: string;
  stopLossPct?: number;
  highWaterCents?: number;
}): Promise<RiskPosition> {
  const { id, stopLossPct, highWaterCents } = params;
  const data: { stopLossPct?: number; highWaterCents?: number } = {};
  if (stopLossPct != null) {
    if (!Number.isFinite(stopLossPct) || stopLossPct < 1 || stopLossPct > 99) {
      throw new Error('stopLossPct must be 1–99');
    }
    data.stopLossPct = stopLossPct;
  }
  if (highWaterCents != null) {
    if (!Number.isFinite(highWaterCents) || highWaterCents <= 0 || highWaterCents > 100) {
      throw new Error('highWaterCents must be in (0, 100]');
    }
    data.highWaterCents = highWaterCents;
  }
  if (Object.keys(data).length === 0) {
    throw new Error('no updatable fields');
  }
  return prisma.riskPosition.update({ where: { id }, data });
}

export async function enqueueClosePosition(positionId: string): Promise<void> {
  await ensureCloseTask(positionId);
}

export async function enqueueCloseAll(): Promise<void> {
  await prisma.riskTask.create({
    data: { type: 'close_all', status: 'pending', nextRunAt: new Date() },
  });
}

export interface RiskTaskApiRow {
  id: string;
  type: string;
  positionId: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  nextRunAt: string;
  updatedAt: string;
}

export async function listRecentRiskTasks(limit = 40): Promise<RiskTaskApiRow[]> {
  const rows = await prisma.riskTask.findMany({
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return rows.map((t: RiskTaskRow) => ({
    id: t.id,
    type: t.type,
    positionId: t.positionId,
    status: t.status,
    attempts: t.attempts,
    lastError: t.lastError,
    nextRunAt: t.nextRunAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }));
}

/** Aggressive early retries for stop FOK failures, then exponential cap. */
function closePositionRetryMs(attempts: number): number {
  const n = Math.max(1, attempts);
  if (n <= 6) return Math.min(10_000, 400 * 2 ** (n - 1));
  return Math.min(60_000, 2000 * 2 ** Math.min(n - 6, 5));
}

function defaultBackoffMs(attempts: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.min(attempts, 5));
}

async function runClosePositionTask(taskId: string, positionId: string): Promise<void> {
  const position = await prisma.riskPosition.findUnique({ where: { id: positionId } });
  if (!position || position.status === 'closed') {
    await prisma.riskTask.update({
      where: { id: taskId },
      data: { status: 'succeeded', lastError: null },
    });
    return;
  }

  await prisma.riskPosition.update({
    where: { id: positionId },
    data: { status: 'closing' },
  });

  try {
    await executePolymarketSell(position.tokenId, position.sizeShares);
    await prisma.riskPosition.update({
      where: { id: positionId },
      data: { status: 'closed', sizeShares: 0 },
    });
    await prisma.riskTask.updateMany({
      where: {
        positionId,
        type: 'close_position',
        status: { in: ['pending', 'failed'] },
        id: { not: taskId },
      },
      data: { status: 'cancelled', lastError: 'superseded' },
    });
    await prisma.riskTask.update({
      where: { id: taskId },
      data: { status: 'succeeded', lastError: null },
    });
    log.info({ positionId, tokenId: position.tokenId }, 'risk: position closed');
  } catch (err) {
    await prisma.riskPosition.update({
      where: { id: positionId },
      data: { status: 'open' },
    });
    const { oneLine, logFields } = formatRiskExecutionError(err);
    log.warn(
      {
        positionId,
        tokenId: position.tokenId,
        dbShares: position.sizeShares,
        ...logFields,
      },
      `risk: close_position executePolymarketSell failed: ${oneLine}`,
    );
    throw err;
  }
}

async function runCloseAllTask(taskId: string): Promise<void> {
  const open = await prisma.riskPosition.findMany({
    where: { status: 'open', sizeShares: { gte: getMinOpenRiskShares() } },
  });
  for (const p of open) {
    await ensureCloseTask(p.id);
  }
  await prisma.riskTask.update({
    where: { id: taskId },
    data: { status: 'succeeded', lastError: null },
  });
}

export async function processRiskTasksOnce(): Promise<void> {
  const tasks = await prisma.riskTask.findMany({
    where: {
      status: { in: ['pending', 'failed'] },
      nextRunAt: { lte: new Date() },
    },
    orderBy: { nextRunAt: 'asc' },
    take: 20,
  });

  for (const task of tasks) {
    await prisma.riskTask.update({
      where: { id: task.id },
      data: { status: 'running' },
    });

    try {
      if (task.type === 'close_position' && task.positionId) {
        await runClosePositionTask(task.id, task.positionId);
      } else if (task.type === 'close_all') {
        await runCloseAllTask(task.id);
      } else {
        await prisma.riskTask.update({
          where: { id: task.id },
          data: {
            status: 'failed',
            lastError: `unknown_task_type:${task.type}`,
            nextRunAt: new Date(Date.now() + 86_400_000),
          },
        });
      }
    } catch (err) {
      const { oneLine, logFields } = formatRiskExecutionError(err);
      const attemptsAfter = task.attempts + 1;
      const delayMs =
        task.type === 'close_position'
          ? closePositionRetryMs(attemptsAfter)
          : defaultBackoffMs(attemptsAfter);
      log.warn(
        {
          taskId: task.id,
          taskType: task.type,
          positionId: task.positionId,
          attemptsBefore: task.attempts,
          attemptsAfter,
          retryInMs: delayMs,
          ...logFields,
        },
        `risk task failed, will retry: ${oneLine}`,
      );
      await prisma.riskTask.update({
        where: { id: task.id },
        data: {
          status: 'failed',
          attempts: { increment: 1 },
          lastError: oneLine.slice(0, 2000),
          nextRunAt: new Date(Date.now() + delayMs),
        },
      });
    }
  }
}
