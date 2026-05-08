import { describe, it, expect } from 'vitest';
import { derivePolymarketDepositWalletAddress } from './polymarketDepositWallet';

describe('derivePolymarketDepositWalletAddress', () => {
  it('matches polymarket-clob-v2-go-exmaple CREATE2 for a known Polygon EOA', () => {
    const eoa = '0x3689aA2cEb25087B1806e13ba9f44fEA081Dad98' as const;
    const derived = derivePolymarketDepositWalletAddress(eoa);
    /** Cross-checked with `deriveDepositWallet` in polymarket-clob-v2-go-exmaple/main.go (same factory/impl). */
    expect(derived.toLowerCase()).toBe('0x6579c2eef112f5187bfa322e40b24b6317a43bec');
  });
});
