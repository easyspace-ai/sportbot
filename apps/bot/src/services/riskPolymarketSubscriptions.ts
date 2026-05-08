import { createLogger } from '../logger';
import { prisma } from '../db';
import { getMinOpenRiskShares } from '../effectiveBotSettings';
import { subscribeToPolyBook, unsubscribeFromPolyBook } from './polymarketWs';

const log = createLogger('risk-poly-subs');

const riskHeldTokens = new Map<string, number>();

/**
 * Keep Polymarket market WS depth subscribed for every open risk `tokenId`.
 * Ref-count so multiple positions on the same token share one upstream sub.
 */
export async function syncRiskPolymarketBookSubscriptions(): Promise<void> {
  const minShares = getMinOpenRiskShares();
  const rows = await prisma.riskPosition.findMany({
    where: {
      status: { in: ['open', 'closing'] },
      sizeShares: { gte: minShares },
    },
    select: { tokenId: true },
  });
  const wanted = new Set<string>();
  for (const r of rows) {
    if (r.tokenId) wanted.add(r.tokenId);
  }

  for (const tokenId of wanted) {
    if (!riskHeldTokens.has(tokenId)) {
      riskHeldTokens.set(tokenId, 1);
      subscribeToPolyBook(tokenId);
      log.info({ tokenId }, 'risk: subscribed market book for token');
    }
  }

  for (const [tokenId, ref] of [...riskHeldTokens.entries()]) {
    if (wanted.has(tokenId)) continue;
    riskHeldTokens.delete(tokenId);
    unsubscribeFromPolyBook(tokenId);
    log.info({ tokenId }, 'risk: unsubscribed market book for token');
  }
}
