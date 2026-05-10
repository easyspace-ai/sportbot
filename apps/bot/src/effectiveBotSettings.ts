import { existsSync } from 'node:fs';
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

const DOCKER_MARKER_FILES = ['/.dockerenv', '/run/.containerenv'];
const LOOPBACK_PROXY_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export interface HttpPlatformProxyInfo {
  configuredUrl: string | undefined;
  effectiveUrl: string | undefined;
  configuredOrigin: string | undefined;
  effectiveOrigin: string | undefined;
  rewrittenForDockerHost: boolean;
}

function runningInDocker(): boolean {
  return DOCKER_MARKER_FILES.some((path) => existsSync(path));
}

function originForLog(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid_proxy_url)';
  }
}

/** DB `httpPlatformProxyUrl` overrides env when non-empty. */
export function getConfiguredHttpPlatformProxyUrl(): string | undefined {
  const fromDb = getBotConfigCached('httpPlatformProxyUrl')?.trim();
  if (fromDb) return fromDb;
  return config.HTTP_PLATFORM_PROXY_URL;
}

export function resolveHttpPlatformProxyUrlForRuntime(
  raw: string | undefined,
  opts: {
    runningInDocker?: boolean;
    dockerHost?: string;
    allowContainerLoopback?: boolean;
  } = {},
): { url: string | undefined; rewrittenForDockerHost: boolean } {
  if (!raw) return { url: undefined, rewrittenForDockerHost: false };

  const inDocker = opts.runningInDocker ?? runningInDocker();
  const allowContainerLoopback =
    opts.allowContainerLoopback ?? config.HTTP_PLATFORM_PROXY_ALLOW_CONTAINER_LOOPBACK;
  if (!inDocker || allowContainerLoopback) {
    return { url: raw, rewrittenForDockerHost: false };
  }

  try {
    const u = new URL(raw);
    if (!LOOPBACK_PROXY_HOSTS.has(u.hostname.toLowerCase())) {
      return { url: raw, rewrittenForDockerHost: false };
    }

    u.hostname = opts.dockerHost ?? config.HTTP_PLATFORM_PROXY_DOCKER_HOST;
    return { url: u.toString(), rewrittenForDockerHost: true };
  } catch {
    return { url: raw, rewrittenForDockerHost: false };
  }
}

export function getHttpPlatformProxyInfo(): HttpPlatformProxyInfo {
  const configuredUrl = getConfiguredHttpPlatformProxyUrl();
  const resolved = resolveHttpPlatformProxyUrlForRuntime(configuredUrl);
  return {
    configuredUrl,
    effectiveUrl: resolved.url,
    configuredOrigin: originForLog(configuredUrl),
    effectiveOrigin: originForLog(resolved.url),
    rewrittenForDockerHost: resolved.rewrittenForDockerHost,
  };
}

export function httpPlatformProxyLogFields(): {
  outboundProxyConfigured: boolean;
  outboundProxyOrigin: string | undefined;
  configuredProxyOrigin: string | undefined;
  proxyRewrittenForDockerHost: boolean;
} {
  const info = getHttpPlatformProxyInfo();
  return {
    outboundProxyConfigured: Boolean(info.configuredUrl),
    outboundProxyOrigin: info.effectiveOrigin,
    configuredProxyOrigin:
      info.configuredOrigin !== info.effectiveOrigin ? info.configuredOrigin : undefined,
    proxyRewrittenForDockerHost: info.rewrittenForDockerHost,
  };
}

export function getEffectiveHttpPlatformProxyUrl(): string | undefined {
  return getHttpPlatformProxyInfo().effectiveUrl;
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
