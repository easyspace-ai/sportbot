import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  prisma: {
    botConfig: {
      findUnique: vi.fn(),
    },
    outcome: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    market: {
      findMany: vi.fn(),
    },
  },
}));

const { mockPolyGetLevels, mockWarmPolyBook } = vi.hoisted(() => ({
  mockPolyGetLevels: vi.fn(),
  mockWarmPolyBook: vi.fn(),
}));
vi.mock('../services/polymarketBookCache', () => ({
  polymarketBookCache: { getLevels: mockPolyGetLevels },
}));
vi.mock('../services/polymarketWs', () => ({
  warmPolyBook: mockWarmPolyBook,
}));

import { prisma } from '../db';
import { buildAllocationPlan, getOrderBookLevels } from './index';

const mockPrisma = prisma as unknown as {
  botConfig: { findUnique: ReturnType<typeof vi.fn> };
  outcome: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  market: { findMany: ReturnType<typeof vi.fn> };
};

const POLY_MARKET = {
  id: 'market-p1',
  eventId: 'event-1',
  platform: 'polymarket',
  externalId: '0xpolyCond',
  betType: '1x2',
  line: null,
  status: 'active',
};

const POLY_OUTCOME = {
  id: 'outcome-p1',
  marketId: 'market-p1',
  label: 'Lakers',
  externalId: '0xpolyToken',
  currentOdds: 0.55,
  liquidityDepth: 500,
  liquidityLevels: JSON.stringify([
    { odds: 0.55, size: 200 },
    { odds: 0.53, size: 300 },
  ]),
  canonicalBetId: 'cb-1',
  market: POLY_MARKET,
};

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.botConfig.findUnique.mockResolvedValue(null);
  mockPrisma.outcome.findMany.mockResolvedValue([]);
  mockPrisma.market.findMany.mockResolvedValue([
    { id: POLY_MARKET.id, externalId: POLY_MARKET.externalId },
  ]);
  mockPolyGetLevels.mockReturnValue([]);
  mockWarmPolyBook.mockResolvedValue(undefined);
});

describe('buildAllocationPlan', () => {
  it('returns size_exceeds_max when size > maxTradeSize', async () => {
    mockPrisma.botConfig.findUnique.mockImplementation(({ where }: { where: { key: string } }) => {
      if (where.key === 'maxTradeSize') return Promise.resolve({ key: 'maxTradeSize', value: '50' });
      return Promise.resolve(null);
    });
    mockPrisma.outcome.findUnique.mockResolvedValue(POLY_OUTCOME);
    mockPrisma.outcome.findMany.mockResolvedValue([POLY_OUTCOME]);

    const result = await buildAllocationPlan('outcome-p1', 'buy', 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('size_exceeds_max');
    }
  });

  it('returns outcome_not_found for unknown outcomeId', async () => {
    mockPrisma.outcome.findUnique.mockResolvedValue(null);

    const result = await buildAllocationPlan('nonexistent', 'buy', 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('outcome_not_found');
    }
  });

  it('returns no_liquidity when only SX siblings exist (Polymarket-only router)', async () => {
    const sxOnly = {
      ...POLY_OUTCOME,
      id: 'sx-1',
      market: { ...POLY_MARKET, id: 'sx-m', platform: 'sx', externalId: '0xhash' },
      externalId: '0xhash:0',
    };
    mockPrisma.outcome.findUnique.mockResolvedValue(sxOnly);
    mockPrisma.outcome.findMany.mockResolvedValue([sxOnly]);

    const result = await buildAllocationPlan('sx-1', 'buy', 10);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('no_liquidity');
    }
  });

  it('returns slippage_exceeded when slippage > tolerance', async () => {
    mockPrisma.botConfig.findUnique.mockImplementation(({ where }: { where: { key: string } }) => {
      if (where.key === 'slippageTolerance') return Promise.resolve({ key: 'slippageTolerance', value: '0.01' });
      return Promise.resolve(null);
    });
    const out = {
      ...POLY_OUTCOME,
      currentOdds: 0.40,
      liquidityLevels: JSON.stringify([
        { odds: 0.40, size: 5 },
        { odds: 0.55, size: 200 },
      ]),
    };
    mockPrisma.outcome.findUnique.mockResolvedValue(out);
    mockPrisma.outcome.findMany.mockResolvedValue([out]);

    const result = await buildAllocationPlan('outcome-p1', 'buy', 50);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('slippage_exceeded');
    }
  });

  it('falls back to single Polymarket outcome when canonicalBetId is null (legacy)', async () => {
    const legacy = { ...POLY_OUTCOME, canonicalBetId: null };
    mockPrisma.outcome.findUnique.mockResolvedValue(legacy);

    const result = await buildAllocationPlan('outcome-p1', 'buy', 50);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.allocations).toHaveLength(1);
      expect(result.plan.allocations[0].platform).toBe('polymarket');
      expect(result.plan.allocations[0].size).toBeCloseTo(50);
    }
    expect(mockPrisma.outcome.findMany).not.toHaveBeenCalled();
  });

  it('aggregates only Polymarket siblings for the same canonical bet', async () => {
    mockPrisma.botConfig.findUnique.mockImplementation(({ where }: { where: { key: string } }) => {
      if (where.key === 'maxTradeSize') return Promise.resolve({ key: 'maxTradeSize', value: '500' });
      if (where.key === 'slippageTolerance') return Promise.resolve({ key: 'slippageTolerance', value: '0.20' });
      return Promise.resolve(null);
    });

    const sxOut = {
      ...POLY_OUTCOME,
      id: 'sx-out1',
      label: 'Lakers -1.5',
      externalId: '0xsx:0',
      currentOdds: 0.55,
      liquidityDepth: 100,
      liquidityLevels: JSON.stringify([{ odds: 0.55, size: 100 }]),
      market: { ...POLY_MARKET, id: 'sx-m1', platform: 'sx', externalId: '0xsx1' },
    };
    const polyA = {
      ...POLY_OUTCOME,
      id: 'poly-a',
      label: 'Lakers -1.5',
      externalId: '0xpolyToken1',
      currentOdds: 0.54,
      liquidityDepth: 60,
      liquidityLevels: JSON.stringify([{ odds: 0.54, size: 60 }]),
      market: { ...POLY_MARKET, id: 'poly-m1', platform: 'polymarket', externalId: '0xpolyCond1' },
    };
    const polyB = {
      ...POLY_OUTCOME,
      id: 'poly-b',
      label: 'Lakers -1.5',
      externalId: '0xpolyToken2',
      currentOdds: 0.56,
      liquidityDepth: 50,
      liquidityLevels: JSON.stringify([{ odds: 0.56, size: 50 }]),
      market: { ...POLY_MARKET, id: 'poly-m2', platform: 'polymarket', externalId: '0xpolyCond2' },
    };

    mockPrisma.outcome.findUnique.mockResolvedValue(sxOut);
    mockPrisma.outcome.findMany.mockResolvedValue([sxOut, polyA, polyB]);
    mockPrisma.market.findMany.mockResolvedValue([
      { id: 'poly-m1', externalId: '0xpolyCond1' },
      { id: 'poly-m2', externalId: '0xpolyCond2' },
    ]);

    const result = await buildAllocationPlan('sx-out1', 'buy', 200);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const platforms = result.plan.allocations.map((a) => a.platform);
      // Only Polymarket depth exists here (60 + 50); SX liquidity is ignored by the router.
      expect(result.plan.totalSize).toBeCloseTo(110);
      expect(platforms.every((p) => p === 'polymarket')).toBe(true);
      expect(result.plan.allocations).toHaveLength(2);
    }
  });

  it('uses single-level fallback when liquidityLevels is null', async () => {
    const out = { ...POLY_OUTCOME, liquidityLevels: null, canonicalBetId: null };
    mockPrisma.outcome.findUnique.mockResolvedValue(out);

    const result = await buildAllocationPlan('outcome-p1', 'buy', 50);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.allocations[0].estimatedSlippage).toBe(0);
      expect(result.plan.allocations[0].expectedOdds).toBe(POLY_OUTCOME.currentOdds);
    }
  });

  it('uses live polymarketBookCache levels when available, ignoring stale DB liquidityLevels', async () => {
    const stale = {
      ...POLY_OUTCOME,
      canonicalBetId: null,
      liquidityDepth: 0,
      currentOdds: 0,
      liquidityLevels: '[]',
    };
    mockPrisma.outcome.findUnique.mockResolvedValue(stale);
    mockPrisma.market.findMany.mockResolvedValue([{ id: POLY_MARKET.id, externalId: POLY_MARKET.externalId }]);
    mockPolyGetLevels.mockReturnValue([{ odds: 0.45, size: 500 }]);

    const result = await buildAllocationPlan('outcome-p1', 'buy', 50);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.allocations).toHaveLength(1);
      expect(result.plan.allocations[0].platform).toBe('polymarket');
      expect(result.plan.allocations[0].expectedOdds).toBeCloseTo(0.45);
    }
  });
});

describe('getOrderBookLevels', () => {
  it('returns empty levels when outcome not found', async () => {
    mockPrisma.outcome.findUnique.mockResolvedValue(null);
    const result = await getOrderBookLevels('nope');
    expect(result.levels).toEqual([]);
  });

  it('returns empty when only SX outcomes (no Polymarket sibling)', async () => {
    const sxOnly = {
      ...POLY_OUTCOME,
      market: { ...POLY_MARKET, platform: 'sx' },
      externalId: '0xhash:0',
      canonicalBetId: null,
    };
    mockPrisma.outcome.findUnique.mockResolvedValue(sxOnly);

    const result = await getOrderBookLevels('outcome-p1');
    expect(result.levels).toEqual([]);
    expect(result.polyTokenId).toBeUndefined();
  });

  it('returns Polymarket levels for legacy single outcome', async () => {
    const legacy = { ...POLY_OUTCOME, canonicalBetId: null };
    mockPrisma.outcome.findUnique.mockResolvedValue(legacy);

    const result = await getOrderBookLevels('outcome-p1');
    expect(result.levels.length).toBeGreaterThan(0);
    expect(result.levels.every((l) => l.platform === 'polymarket')).toBe(true);
    expect(result.polyTokenId).toBe('0xpolyToken');
    expect(mockPrisma.outcome.findMany).not.toHaveBeenCalled();
  });

  it('aggregates levels from Polymarket canonical siblings only', async () => {
    const sxSib = {
      ...POLY_OUTCOME,
      id: 'sx-sib',
      externalId: '0xhash:1',
      market: { ...POLY_MARKET, id: 'sx-m', platform: 'sx', externalId: '0xhash' },
    };
    const polySib = {
      ...POLY_OUTCOME,
      id: 'poly-sib',
      externalId: '0xpolyToken2',
      currentOdds: 0.51,
      liquidityLevels: JSON.stringify([{ odds: 0.51, size: 100 }]),
      market: { ...POLY_MARKET, id: 'poly-m', platform: 'polymarket', externalId: '0xpolyCond' },
    };
    mockPrisma.outcome.findUnique.mockResolvedValue(POLY_OUTCOME);
    mockPrisma.outcome.findMany.mockResolvedValue([POLY_OUTCOME, sxSib, polySib]);

    const result = await getOrderBookLevels('outcome-p1');
    const platforms = new Set(result.levels.map((l) => l.platform));
    expect(platforms).toEqual(new Set(['polymarket']));
    expect(result.polyTokenId).toBe('0xpolyToken');
    for (let i = 1; i < result.levels.length; i++) {
      expect(result.levels[i].odds).toBeGreaterThanOrEqual(result.levels[i - 1].odds);
    }
  });
});
