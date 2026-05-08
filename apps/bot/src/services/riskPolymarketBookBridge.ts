import { createLogger } from '../logger';
import { polymarketBookCache } from './polymarketBookCache';
import { riskEvaluateTokenAfterBookUpdate } from './riskService';

const log = createLogger('risk-poly-book');

const debounceByToken = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * On each order-book cache update for a token, re-run trailing-stop checks for
 * open positions on that token (debounced to avoid hammering SQLite).
 */
export function startRiskPolymarketBookBridge(): void {
  polymarketBookCache.on('polyBookUpdate', ({ tokenId }: { tokenId: string }) => {
    const prev = debounceByToken.get(tokenId);
    if (prev) clearTimeout(prev);
    debounceByToken.set(
      tokenId,
      setTimeout(() => {
        debounceByToken.delete(tokenId);
        riskEvaluateTokenAfterBookUpdate(tokenId).catch((err) => {
          log.warn({ err, tokenId }, 'risk book-trigger evaluation failed');
        });
      }, 120),
    );
  });
}
