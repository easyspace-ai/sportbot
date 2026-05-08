import { prisma } from '../db';
import { polymarketBookCache } from '../services/polymarketBookCache';
import { warmPolyBook } from '../services/polymarketWs';
import type { AllocationPlan, Allocation, Platform } from '../types';

const DEFAULT_MAX_TRADE_SIZE = 100;
const DEFAULT_SLIPPAGE_TOLERANCE = 0.05;
const ORDERBOOK_WARM_TIMEOUT_MS = 1500;

interface LiquidityLevel {
  odds: number;
  size: number;
}

/**
 * Order book + routing use **Polymarket liquidity only** (SX remains for fixtures /
 * metadata sync elsewhere). Canonical siblings on SX are ignored here.
 */
function polySiblingsOnly<T extends { market: { platform: string } }>(siblings: T[]): T[] {
  return siblings.filter((s) => s.market.platform === 'polymarket');
}

/**
 * Pull fresh Polymarket order-book levels for an outcome (live WS cache, then DB snapshot).
 */
function liveLevelsFor(
  platform: Platform,
  externalId: string | null,
  liquidityLevels: string | null,
  currentOdds: number,
  liquidityDepth: number,
): LiquidityLevel[] {
  if (platform === 'polymarket' && externalId) {
    const live = polymarketBookCache.getLevels(externalId);
    if (live.length > 0) return live.map((l) => ({ odds: l.odds, size: l.size }));
  }

  const parsed = parseLevels(liquidityLevels);
  if (parsed.length > 0) return parsed;
  if (liquidityDepth > 0 && currentOdds > 0) {
    return [{ odds: currentOdds, size: liquidityDepth }];
  }
  return [];
}

async function getBotConfigValue(key: string, defaultValue: number): Promise<number> {
  try {
    const row = await prisma.botConfig.findUnique({ where: { key } });
    if (!row) return defaultValue;
    const parsed = parseFloat(row.value);
    return isNaN(parsed) ? defaultValue : parsed;
  } catch {
    return defaultValue;
  }
}

function parseLevels(json: string | null): LiquidityLevel[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as LiquidityLevel[];
  } catch {
    return [];
  }
}

export interface OrderBookLevel {
  odds: number;
  size: number;
  platform: Platform;
}

export interface OrderBookResponse {
  levels: OrderBookLevel[];
  /** @deprecated SX book removed from UI; always omitted. */
  sxMarketHash?: string;
  sxSide?: 0 | 1;
  polyTokenId?: string;
}

interface OutcomeWithMarket {
  id: string;
  label: string;
  externalId: string | null;
  currentOdds: number;
  liquidityDepth: number;
  liquidityLevels: string | null;
  market: { id: string; platform: string; status: string };
}

async function getCanonicalSiblings(primary: OutcomeWithMarket, canonicalBetId: string | null) {
  if (!canonicalBetId) return [primary];
  const all = await prisma.outcome.findMany({
    where: { canonicalBetId, market: { status: 'active' } },
    include: { market: true },
  });
  if (all.length === 0) return [primary];
  return all;
}

export async function getOrderBookLevels(primaryOutcomeId: string): Promise<OrderBookResponse> {
  const primaryOutcome = await prisma.outcome.findUnique({
    where: { id: primaryOutcomeId },
    include: { market: true },
  });

  if (!primaryOutcome) return { levels: [] };

  const siblings = await getCanonicalSiblings(primaryOutcome, primaryOutcome.canonicalBetId);
  const polySiblings = polySiblingsOnly(siblings);
  if (polySiblings.length === 0) {
    return { levels: [], polyTokenId: undefined };
  }

  const warmJobs: Promise<void>[] = [];
  for (const o of polySiblings) {
    if (!o.externalId) continue;
    const live = polymarketBookCache.getLevels(o.externalId);
    if (live.length === 0) {
      warmJobs.push(warmPolyBook(o.externalId).catch(() => undefined));
    }
  }
  if (warmJobs.length > 0) {
    await Promise.race([
      Promise.all(warmJobs),
      new Promise<void>((res) => setTimeout(res, ORDERBOOK_WARM_TIMEOUT_MS)),
    ]);
  }

  const levels: OrderBookLevel[] = [];
  for (const o of polySiblings) {
    const platform = o.market.platform as Platform;
    const live = liveLevelsFor(
      platform,
      o.externalId,
      o.liquidityLevels,
      o.currentOdds,
      o.liquidityDepth,
    );
    for (const lvl of live) {
      levels.push({ odds: lvl.odds, size: lvl.size, platform });
    }
  }

  levels.sort((a, b) => a.odds - b.odds);

  const polyOutcome = polySiblings.find((o) => o.market.platform === 'polymarket');
  const polyTokenId = polyOutcome?.externalId ?? undefined;

  return { levels, polyTokenId };
}

export interface RouterError {
  code: 'size_exceeds_max' | 'slippage_exceeded' | 'outcome_not_found' | 'no_liquidity';
  message: string;
  detail?: { slippage?: number; tolerance?: number };
}

export type RouterResult =
  | { ok: true; plan: AllocationPlan }
  | { ok: false; error: RouterError };

export async function buildAllocationPlan(
  primaryOutcomeId: string,
  side: string,
  size: number,
): Promise<RouterResult> {
  void side;
  const [maxTradeSize, slippageTolerance] = await Promise.all([
    getBotConfigValue('maxTradeSize', DEFAULT_MAX_TRADE_SIZE),
    getBotConfigValue('slippageTolerance', DEFAULT_SLIPPAGE_TOLERANCE),
  ]);

  if (size > maxTradeSize) {
    return {
      ok: false,
      error: { code: 'size_exceeds_max', message: `Size ${size} exceeds maxTradeSize ${maxTradeSize}` },
    };
  }

  const primaryOutcome = await prisma.outcome.findUnique({
    where: { id: primaryOutcomeId },
    include: { market: true },
  });

  if (!primaryOutcome) {
    return { ok: false, error: { code: 'outcome_not_found', message: `Outcome ${primaryOutcomeId} not found` } };
  }

  const siblings = await getCanonicalSiblings(primaryOutcome, primaryOutcome.canonicalBetId);
  const polySiblings = polySiblingsOnly(siblings);

  if (polySiblings.length === 0) {
    return {
      ok: false,
      error: { code: 'no_liquidity', message: '该结果在 Polymarket 上无对应盘口（仅支持 Polymarket 下单）' },
    };
  }

  interface Candidate {
    outcomeId: string;
    externalOutcomeId: string;
    marketExternalId: string;
    platform: Platform;
    levels: LiquidityLevel[];
    bestOdds: number;
    totalAvailable: number;
  }

  const candidates: Candidate[] = polySiblings.map((o) => {
    const platform = o.market.platform as Platform;
    const levels = liveLevelsFor(
      platform,
      o.externalId,
      o.liquidityLevels,
      o.currentOdds,
      o.liquidityDepth,
    );
    const totalAvailable = levels.reduce((s, l) => s + l.size, 0);
    const bestOdds = levels.length > 0 ? levels[0].odds : o.currentOdds;
    return {
      outcomeId: o.id,
      externalOutcomeId: o.externalId ?? '',
      marketExternalId: '',
      platform,
      levels,
      bestOdds,
      totalAvailable,
    };
  });

  const marketIds = Array.from(new Set(polySiblings.map((o) => o.market.id)));
  const markets = await prisma.market.findMany({
    where: { id: { in: marketIds } },
    select: { id: true, externalId: true },
  });
  const marketIdToExternal = new Map(markets.map((m) => [m.id, m.externalId]));
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].marketExternalId = marketIdToExternal.get(polySiblings[i].market.id) ?? '';
  }

  interface LevelWithSource {
    odds: number;
    size: number;
    candidateIdx: number;
  }

  const allLevels: LevelWithSource[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (const lvl of candidates[i].levels) {
      allLevels.push({ odds: lvl.odds, size: lvl.size, candidateIdx: i });
    }
  }

  allLevels.sort((a, b) => a.odds - b.odds);

  if (allLevels.length === 0) {
    return { ok: false, error: { code: 'no_liquidity', message: 'No liquidity available for this outcome' } };
  }

  const globalBestOdds = allLevels[0].odds;
  const perCand = candidates.map(() => ({ filledSize: 0, weightedOddsSum: 0 }));
  let remaining = size;

  for (const lvl of allLevels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.size);
    perCand[lvl.candidateIdx].filledSize += take;
    perCand[lvl.candidateIdx].weightedOddsSum += lvl.odds * take;
    remaining -= take;
  }

  const totalSize = perCand.reduce((s, c) => s + c.filledSize, 0);
  if (totalSize === 0) {
    return { ok: false, error: { code: 'no_liquidity', message: 'No liquidity available for this outcome' } };
  }

  const weightedOdds = perCand.reduce((s, c) => s + c.weightedOddsSum, 0) / totalSize;
  const totalSlippage = globalBestOdds > 0
    ? Math.max(0, (weightedOdds - globalBestOdds) / globalBestOdds)
    : 0;

  if (totalSlippage > slippageTolerance) {
    return {
      ok: false,
      error: {
        code: 'slippage_exceeded',
        message: `Estimated slippage ${(totalSlippage * 100).toFixed(2)}% exceeds tolerance ${(slippageTolerance * 100).toFixed(2)}%`,
        detail: { slippage: totalSlippage, tolerance: slippageTolerance },
      },
    };
  }

  const allocations: Allocation[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (perCand[i].filledSize <= 0) continue;
    const c = candidates[i];
    allocations.push({
      platform: c.platform,
      outcomeId: c.outcomeId,
      externalMarketId: c.marketExternalId,
      externalOutcomeId: c.externalOutcomeId,
      size: perCand[i].filledSize,
      expectedOdds: perCand[i].weightedOddsSum / perCand[i].filledSize,
      estimatedSlippage: totalSlippage,
    });
  }

  if (allocations.length === 0) {
    return { ok: false, error: { code: 'no_liquidity', message: 'No liquidity available for this outcome' } };
  }

  return {
    ok: true,
    plan: { allocations, totalSize, weightedOdds, totalSlippage },
  };
}
