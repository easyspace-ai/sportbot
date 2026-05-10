import { ApiError, AssetType, Side, OrderType } from '@polymarket/clob-client-v2';
import { formatUnits } from 'viem';
import { getPolymarketFokBuyExtraTicks, getPolymarketFokSellExtraTicks } from '../effectiveBotSettings';
import { getPolymarketClobClient } from '../services/polymarketTrading';
import { bestAskPrice, bestBidPrice } from '../services/clobOrderBook';

/** CLOB `balance-allowance` for CONDITIONAL returns base units (6 decimals on Polygon), not human share count. */
const CONDITIONAL_BALANCE_DECIMALS = 6 as const;

export function conditionalBalanceToShareFloat(balanceStr: string): number {
  const t = balanceStr.trim();
  if (!t || t === '0') return 0;
  try {
    return Number(formatUnits(BigInt(t), CONDITIONAL_BALANCE_DECIMALS));
  } catch {
    const f = parseFloat(t);
    return Number.isFinite(f) && f >= 0 ? f : 0;
  }
}

function tokenShort(id: string): string {
  if (id.length <= 22) return id;
  return `${id.slice(0, 12)}…${id.slice(-8)}`;
}

export interface PolyFillResult {
  orderId: string;
  filledSize: number;
  fillOdds: number;
}

/** FOK SELL: worst price = best bid minus configured extra ticks (floored at tick). */
export async function executePolymarketSell(
  tokenId: string,
  sizeShares: number,
): Promise<{ orderId: string; soldShares: number }> {
  const tok = tokenShort(tokenId);
  const client = await getPolymarketClobClient();

  let tickSize: Awaited<ReturnType<typeof client.getTickSize>>;
  let negRisk: boolean;
  let book: Awaited<ReturnType<typeof client.getOrderBook>>;
  try {
    [tickSize, negRisk, book] = await Promise.all([
      client.getTickSize(tokenId),
      client.getNegRisk(tokenId),
      client.getOrderBook(tokenId),
    ]);
  } catch (err) {
    const inner = err instanceof Error ? err.message : String(err);
    const extra = err instanceof ApiError ? ` httpStatus=${err.status}` : '';
    const hint =
      err instanceof ApiError && err.status === 404
        ? '（市场可能已结算/下线，或 token 无效；CLOB 无订单簿时无法 FOK 卖出）'
        : '';
    throw new Error(`getMarketParams_failed token=${tok}${extra}: ${inner}${hint}`, { cause: err });
  }

  const tick = parseFloat(String(tickSize));
  const bestBid = bestBidPrice(book.bids) ?? 0;
  const bidLevels = book.bids?.length ?? 0;
  if (!Number.isFinite(bestBid) || bestBid <= 0) {
    throw new Error(
      `no_bid_liquidity token=${tok} tick=${tick} bidLevels=${bidLevels} requestedShares=${sizeShares}`,
    );
  }

  let bal: Awaited<ReturnType<typeof client.getBalanceAllowance>>;
  try {
    bal = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
  } catch (err) {
    const inner = err instanceof Error ? err.message : String(err);
    const extra = err instanceof ApiError ? ` httpStatus=${err.status}` : '';
    throw new Error(`getBalanceAllowance_failed token=${tok}${extra}: ${inner}`, { cause: err });
  }

  const onChainShares = conditionalBalanceToShareFloat(bal.balance);
  const sellAmount = Math.min(
    sizeShares,
    Number.isFinite(onChainShares) && onChainShares > 0 ? onChainShares : sizeShares,
  );
  if (!Number.isFinite(sellAmount) || sellAmount <= 0) {
    throw new Error(
      `zero_conditional_balance token=${tok} requestedShares=${sizeShares} clobBalanceRaw=${bal.balance} onChainShares=${onChainShares}`,
    );
  }

  const sellExtraTicks = getPolymarketFokSellExtraTicks();
  const floorPrice = Math.max(tick, bestBid - sellExtraTicks * tick);

  let order: Awaited<ReturnType<typeof client.createMarketOrder>>;
  try {
    order = await client.createMarketOrder(
      {
        tokenID: tokenId,
        side: Side.SELL,
        amount: sellAmount,
        price: floorPrice,
        orderType: OrderType.FOK,
      },
      { tickSize, negRisk },
    );
  } catch (err) {
    const inner = err instanceof Error ? err.message : String(err);
    const extra = err instanceof ApiError ? ` httpStatus=${err.status}` : '';
    throw new Error(
      `createMarketOrder_failed token=${tok} sellAmount=${sellAmount} floorPrice=${floorPrice} bestBid=${bestBid} tick=${tick} negRisk=${negRisk} extraTicks=${sellExtraTicks}${extra}: ${inner}`,
      { cause: err },
    );
  }

  try {
    const result = await client.postOrder(order, OrderType.FOK);
    if (!result.success) {
      const detail = result.errorMsg ?? JSON.stringify(result);
      throw new Error(
        `postOrder_rejected token=${tok} sellAmount=${sellAmount} floorPrice=${floorPrice}: ${detail}`,
      );
    }
    return {
      orderId: result.orderID ?? `order_${Date.now()}`,
      soldShares: sellAmount,
    };
  } catch (err: unknown) {
    const inner = err instanceof Error ? err.message : String(err);
    if (inner.includes('maker address not allowed')) {
      throw new Error(
        'Polymarket 订单被拒：maker 地址不被允许。' +
          '本 bot 固定 POLY_1271：funder 须为 CREATE2 推导的 deposit 钱包（与私钥对应 EOA 唯一确定）。' +
          '若曾手动改过 funder，请删除账号后仅用私钥重新添加，或检查 embeddedEnv / 账号配置是否与该 EOA 匹配。',
        { cause: err instanceof Error ? err : undefined },
      );
    }
    const extra = err instanceof ApiError ? ` httpStatus=${err.status} body=${JSON.stringify(err.data)}` : '';
    throw new Error(
      `postOrder_failed token=${tok} sellAmount=${sellAmount} floorPrice=${floorPrice} bestBid=${bestBid} tick=${tick}${extra}: ${inner}`,
      { cause: err instanceof Error ? err : undefined },
    );
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
  const [tickSize, negRisk, book] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
    client.getOrderBook(tokenId),
  ]);

  const tick = parseFloat(String(tickSize));
  const buyExtraTicks = getPolymarketFokBuyExtraTicks();
  let limitPrice = price;
  if (Number.isFinite(tick) && tick > 0) {
    const bestAsk = bestAskPrice(book.asks);
    if (bestAsk != null && Number.isFinite(bestAsk)) {
      const padded = bestAsk + buyExtraTicks * tick;
      const cap = 1 - tick;
      limitPrice = Math.min(cap, Math.max(price, padded));
    }
    limitPrice = Math.max(tick, Math.min(1 - tick, limitPrice));
  }

  const order = await client.createMarketOrder(
    {
      tokenID: tokenId,
      side: Side.BUY,
      amount: size, // pUSD to spend
      price: limitPrice,
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
      fillOdds: limitPrice,
    };
  } catch (err: any) {
    if (err?.message?.includes('maker address not allowed')) {
      throw new Error(
        'Polymarket 订单被拒：maker 地址不被允许。' +
          '本 bot 固定 POLY_1271：funder 须为 CREATE2 推导的 deposit 钱包（与私钥对应 EOA 唯一确定）。' +
          '若曾手动改过 funder，请删除账号后仅用私钥重新添加，或检查 embeddedEnv / 账号配置是否与该 EOA 匹配。',
      );
    }
    throw err;
  }
}
