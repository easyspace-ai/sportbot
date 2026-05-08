import { config } from './config';
import { getBotConfigCached } from './botConfigCache';

/** Implied YES price in cents (0–100); returns configured `stopLossPct` for the matching range, or null. */
export function resolveStopLossPctForOpenYesCents(openYesCents: number): number | null {
  const raw = getBotConfigCached('priceStopLossRanges')?.trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const min = Number(r.minCents);
    const max = Number(r.maxCents);
    const stop = Number(r.stopLossPct);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(stop)) continue;
    if (openYesCents >= min && openYesCents < max) return stop;
  }
  return null;
}

/** DB `httpPlatformProxyUrl` overrides env when non-empty. */
export function getEffectiveHttpPlatformProxyUrl(): string | undefined {
  const fromDb = getBotConfigCached('httpPlatformProxyUrl')?.trim();
  if (fromDb) return fromDb;
  return config.HTTP_PLATFORM_PROXY_URL;
}

export function getTelegramBotToken(): string | undefined {
  const fromDb = getBotConfigCached('telegramBotToken')?.trim();
  if (fromDb) return fromDb;
  return config.TELEGRAM_BOT_TOKEN;
}

export function getTelegramAuthorizedChatId(): string | undefined {
  const fromDb = getBotConfigCached('telegramAuthorizedChatId')?.trim();
  if (fromDb) return fromDb;
  return config.TELEGRAM_AUTHORIZED_CHAT_ID;
}

const DEFAULT_POLY_FOK_EXTRA_TICKS = 5;
const MAX_POLY_FOK_EXTRA_TICKS = 50;

function parsePolyFokExtraTicks(key: string): number {
  const raw = getBotConfigCached(key)?.trim();
  if (!raw) return DEFAULT_POLY_FOK_EXTRA_TICKS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_POLY_FOK_EXTRA_TICKS;
  return Math.min(MAX_POLY_FOK_EXTRA_TICKS, n);
}

/** Extra tick steps above best ask for Polymarket FOK BUY limit (wider = easier fill). */
export function getPolymarketFokBuyExtraTicks(): number {
  return parsePolyFokExtraTicks('polymarketFokBuyExtraTicks');
}

/** Extra tick steps below best bid for Polymarket FOK SELL floor (wider = easier fill). */
export function getPolymarketFokSellExtraTicks(): number {
  return parsePolyFokExtraTicks('polymarketFokSellExtraTicks');
}

const DEFAULT_MIN_OPEN_RISK_SHARES = 1;
const MAX_MIN_OPEN_RISK_SHARES = 1_000_000;

/**
 * Minimum outcome shares for a position to appear in 风控 and to stay `open` vs CLOB balance.
 * BotConfig `minOpenRiskShares` (default 1). Invalid / empty falls back to 1.
 */
export function getMinOpenRiskShares(): number {
  const raw = getBotConfigCached('minOpenRiskShares')?.trim();
  if (!raw) return DEFAULT_MIN_OPEN_RISK_SHARES;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MIN_OPEN_RISK_SHARES;
  return Math.min(MAX_MIN_OPEN_RISK_SHARES, n);
}
