import { getPlatformProxyDispatcher } from './proxySupport';
import { getEffectiveHttpPlatformProxyUrl } from './effectiveBotSettings';

/**
 * HTTP(S) fetch for outbound platform APIs (SX Bet, Polymarket Gamma/CLOB, etc.).
 * When a platform proxy is set in env or BotConfig, traffic is routed through it.
 * In Docker, loopback proxy URLs are resolved to the configured host gateway.
 *
 * Node's `fetch` accepts Undici's `dispatcher` option; Bun uses its native `proxy` option.
 * DOM `RequestInit` typings omit both runtime-specific fields.
 */
type RuntimeFetchInit = RequestInit & {
  dispatcher?: unknown;
  proxy?: string;
};

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

function mergeInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  // Some CDNs / SX edge return 403 to anonymous Node defaults — set a stable UA.
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'sports-prediction-market-router/1.0');
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  return { ...init, headers };
}

export function platformFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const merged = mergeInit(init);
  const proxyUrl = getEffectiveHttpPlatformProxyUrl();
  if (!proxyUrl) return fetch(input, merged);
  if (isBunRuntime()) return fetch(input, { ...merged, proxy: proxyUrl } as RuntimeFetchInit);

  const dispatcher = getPlatformProxyDispatcher();
  if (!dispatcher) return fetch(input, merged);
  return fetch(input, { ...merged, dispatcher } as RuntimeFetchInit);
}
