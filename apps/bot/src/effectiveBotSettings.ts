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
