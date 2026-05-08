import { describe, expect, it } from 'vitest';
import { bestAskPrice, bestBidPrice } from './clobOrderBook';

describe('bestBidPrice', () => {
  it('returns highest bid when book is ascending (Polymarket CLOB)', () => {
    const bids = [{ price: '0.40' }, { price: '0.45' }, { price: '0.50' }];
    expect(bestBidPrice(bids)).toBeCloseTo(0.5, 6);
  });

  it('returns highest bid when book is descending', () => {
    const bids = [{ price: '0.52' }, { price: '0.48' }];
    expect(bestBidPrice(bids)).toBeCloseTo(0.52, 6);
  });

  it('returns null for empty or invalid', () => {
    expect(bestBidPrice([])).toBeNull();
    expect(bestBidPrice(undefined)).toBeNull();
    expect(bestBidPrice([{ price: '0' }, { price: '-1' }])).toBeNull();
  });
});

describe('bestAskPrice', () => {
  it('returns lowest ask when asks are descending (Polymarket CLOB example)', () => {
    const asks = [{ price: '0.6' }, { price: '0.55' }, { price: '0.5' }];
    expect(bestAskPrice(asks)).toBeCloseTo(0.5, 6);
  });

  it('returns lowest ask when asks are ascending', () => {
    const asks = [{ price: '0.48' }, { price: '0.52' }];
    expect(bestAskPrice(asks)).toBeCloseTo(0.48, 6);
  });

  it('returns null for empty or invalid', () => {
    expect(bestAskPrice([])).toBeNull();
    expect(bestAskPrice(undefined)).toBeNull();
  });
});
