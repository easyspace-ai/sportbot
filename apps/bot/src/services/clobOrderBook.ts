/**
 * Polymarket CLOB `getOrderBook` returns `bids` sorted ascending by price (see
 * `calculateSellMarketPrice` in @polymarket/clob-client-v2: best bid is at the end).
 * Using `bids[0]` reads the *worst* bid — risk checks then fire stop-loss immediately.
 */
export function bestBidPrice(bids: { price: string }[] | undefined | null): number | null {
  if (!bids?.length) return null;
  let best = -Infinity;
  for (const b of bids) {
    const p = parseFloat(b.price);
    if (Number.isFinite(p) && p > best) best = p;
  }
  return best > 0 && Number.isFinite(best) ? best : null;
}

/**
 * Polymarket CLOB `asks` are sorted descending by price in the client examples
 * (best / lowest ask is last). Taking the minimum positive price is robust.
 */
export function bestAskPrice(asks: { price: string }[] | undefined | null): number | null {
  if (!asks?.length) return null;
  let best = Infinity;
  for (const a of asks) {
    const p = parseFloat(a.price);
    if (Number.isFinite(p) && p > 0 && p < best) best = p;
  }
  return best < Infinity && best > 0 ? best : null;
}
