import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config', () => ({
  config: {
    POLYGON_RPC_URL: 'https://polygon.test',
    POLYMARKET_FUNDER_ADDRESS: '0x1111111111111111111111111111111111111111',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  },
}));

vi.mock('../db', () => ({
  prisma: {
    polymarketAccount: {
      findMany: vi.fn(),
    },
  },
}));

const fetchPolymarketCollateralBalanceMock = vi.fn();
vi.mock('../services/polymarketTrading', () => ({
  fetchPolymarketCollateralBalance: (...args: unknown[]) =>
    fetchPolymarketCollateralBalanceMock(...args),
}));

const balanceOfMock = vi.fn();
const contractMock = vi.fn().mockImplementation(() => ({ balanceOf: balanceOfMock }));

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  return {
    ...actual,
    JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
    Contract: contractMock,
  };
});

beforeEach(() => {
  balanceOfMock.mockReset();
  contractMock.mockClear();
  fetchPolymarketCollateralBalanceMock.mockReset();
});

const POLYMARKET_PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

describe('fetchBalances', () => {
  it('with no DB accounts, reads env funder pUSD', async () => {
    const { prisma } = await import('../db');
    vi.mocked(prisma.polymarketAccount.findMany).mockResolvedValueOnce([]);

    balanceOfMock.mockResolvedValueOnce(12_340_000n);

    const { fetchBalances } = await import('./balance');
    const result = await fetchBalances();

    expect(result.polymarket).toBe(12.34);
    expect(result.polymarketAccounts).toEqual([]);

    const tokens = contractMock.mock.calls.map((call) => call[0]);
    expect(tokens).toContain(POLYMARKET_PUSD);
  });

  it('returns polymarketAccounts rows with CLOB collateral balances', async () => {
    const { prisma } = await import('../db');
    vi.mocked(prisma.polymarketAccount.findMany).mockResolvedValueOnce([
      {
        id: 'a1',
        name: 'One',
        apiKey: 'k',
        secret: 's',
        passphrase: 'p',
        privateKey: '0x1',
        funderAddress: '0x2222222222222222222222222222222222222222',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    fetchPolymarketCollateralBalanceMock.mockResolvedValueOnce(42.5);

    const { fetchBalances } = await import('./balance');
    const result = await fetchBalances();

    expect(fetchPolymarketCollateralBalanceMock).toHaveBeenCalledTimes(1);
    expect(result.polymarketAccounts).toHaveLength(1);
    expect(result.polymarketAccounts[0].polymarket).toBe(42.5);
    expect(result.polymarket).toBe(42.5);
  });

  it('falls back to on-chain pUSD when CLOB collateral fails', async () => {
    const { prisma } = await import('../db');
    vi.mocked(prisma.polymarketAccount.findMany).mockResolvedValueOnce([
      {
        id: 'a1',
        name: 'One',
        apiKey: 'k',
        secret: 's',
        passphrase: 'p',
        privateKey: '0x1',
        funderAddress: '0x2222222222222222222222222222222222222222',
        isActive: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    fetchPolymarketCollateralBalanceMock.mockRejectedValueOnce(new Error('clob down'));
    balanceOfMock.mockResolvedValueOnce(3_000_000n);

    const { fetchBalances } = await import('./balance');
    const result = await fetchBalances();

    expect(result.polymarketAccounts[0].polymarket).toBe(3);
  });

  it('returns null polymarket when RPC rejects', async () => {
    const { prisma } = await import('../db');
    vi.mocked(prisma.polymarketAccount.findMany).mockResolvedValueOnce([]);

    balanceOfMock.mockRejectedValueOnce(new Error('polygon down'));

    const { fetchBalances } = await import('./balance');
    const result = await fetchBalances();

    expect(result).toMatchObject({ polymarket: null, polymarketAccounts: [] });
  });
});
