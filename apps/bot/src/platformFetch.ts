import { getPlatformProxyDispatcher } from './proxySupport';

/**
 * HTTP(S) fetch for outbound platform APIs (SX Bet, Polymarket Gamma/CLOB, etc.).
 * When `HTTP_PLATFORM_PROXY_URL` is set in env, traffic is routed through that proxy.
 *
 * Node's `fetch` accepts Undici's `dispatcher` option; DOM `RequestInit` typings omit it.
 */
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
  const dispatcher = getPlatformProxyDispatcher();
  if (!dispatcher) return fetch(input, merged);
  return fetch(input, { ...merged, dispatcher } as unknown as RequestInit);
}
