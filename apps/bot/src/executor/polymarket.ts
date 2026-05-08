import { AssetType, Side, OrderType } from '@polymarket/clob-client-v2';
import { getPolymarketClobClient } from '../services/polymarketTrading';

export interface PolyFillResult {
  orderId: string;
  filledSize: number;
  fillOdds: number;
}

/** FOK SELL: worst price = best bid minus 10 tick sizes (floored at tick), to improve fill odds. */
export async function executePolymarketSell(
  tokenId: string,
  sizeShares: number,
): Promise<{ orderId: string; soldShares: number }> {
  const client = await getPolymarketClobClient();
  const [tickSize, negRisk, book] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
    client.getOrderBook(tokenId),
  ]);

  const tick = parseFloat(String(tickSize));
  const bestBid = parseFloat(book.bids[0]?.price ?? '0');
  if (!Number.isFinite(bestBid) || bestBid <= 0) {
    throw new Error('no_bid_liquidity');
  }

  const bal = await client.getBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: tokenId,
  });
  const onChain = parseFloat(bal.balance);
  const sellAmount = Math.min(
    sizeShares,
    Number.isFinite(onChain) && onChain > 0 ? onChain : sizeShares,
  );
  if (!Number.isFinite(sellAmount) || sellAmount <= 0) {
    throw new Error('zero_conditional_balance');
  }

  const floorPrice = Math.max(tick, bestBid - 10 * tick);

  const order = await client.createMarketOrder(
    {
      tokenID: tokenId,
      side: Side.SELL,
      amount: sellAmount,
      price: floorPrice,
      orderType: OrderType.FOK,
    },
    { tickSize, negRisk },
  );

  try {
    const result = await client.postOrder(order, OrderType.FOK);
    if (!result.success) {
      throw new Error(`Polymarket sell rejected: ${result.errorMsg ?? JSON.stringify(result)}`);
    }
    return {
      orderId: result.orderID ?? `order_${Date.now()}`,
      soldShares: sellAmount,
    };
  } catch (err: any) {
    if (err?.message?.includes('maker address not allowed')) {
      throw new Error(
        'Polymarket 订单被拒：maker 地址不被允许。' +
          '本 bot 固定 POLY_1271：funder 须为 CREATE2 推导的 deposit 钱包（与私钥对应 EOA 唯一确定）。' +
          '若曾手动改过 funder，请删除账号后仅用私钥重新添加，或检查 .env 四项是否与该 EOA 匹配。',
      );
    }
    throw err;
  }
}

/**
 * Execute a FOK BUY order on Polymarket CLOB.
 *
 * Fills entirely at the user's last-seen price or throws immediately if the
 * market has moved. No order is left resting on the book either way.
 *
 * @param tokenId - ERC-1155 outcome token ID (from Outcome.externalId)
 * @param size    - pUSD amount to spend
 * @param price   - Worst acceptable price (0–1); FOK cancels if unavailable
 */
export async function executePolymarketOrder(
  tokenId: string,
  size: number,
  price: number,
): Promise<PolyFillResult> {
  const client = await getPolymarketClobClient();

  // tickSize and negRisk are per-market requirements for order signing.
  // negRisk is true for multi-outcome markets (e.g. soccer home/draw/away).
  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
  ]);

  const order = await client.createMarketOrder(
    {
      tokenID: tokenId,
      side: Side.BUY,
      amount: size, // pUSD to spend
      price,        // worst-case price — FOK cancels if market moved past this
    },
    { tickSize, negRisk },
  );

  try {
    const result = await client.postOrder(order, OrderType.FOK);
    if (!result.success) {
      throw new Error(`Polymarket order rejected: ${result.errorMsg ?? JSON.stringify(result)}`);
    }
    return {
      orderId: result.orderID ?? `order_${Date.now()}`,
      filledSize: size,
      fillOdds: price,
    };
  } catch (err: any) {
    if (err?.message?.includes('maker address not allowed')) {
      throw new Error(
        'Polymarket 订单被拒：maker 地址不被允许。' +
          '本 bot 固定 POLY_1271：funder 须为 CREATE2 推导的 deposit 钱包（与私钥对应 EOA 唯一确定）。' +
          '若曾手动改过 funder，请删除账号后仅用私钥重新添加，或检查 .env 四项是否与该 EOA 匹配。',
      );
    }
    throw err;
  }
}
