import { describe, expect, it } from 'vitest';
import { conditionalBalanceToShareFloat } from './polymarket';

describe('conditionalBalanceToShareFloat', () => {
  it('converts CLOB base units (6 decimals) to share float', () => {
    expect(conditionalBalanceToShareFloat('1639343')).toBeCloseTo(1.639343, 5);
    expect(conditionalBalanceToShareFloat('3310000')).toBeCloseTo(3.31, 5);
  });

  it('returns 0 for empty or zero', () => {
    expect(conditionalBalanceToShareFloat('')).toBe(0);
    expect(conditionalBalanceToShareFloat('0')).toBe(0);
  });
});
