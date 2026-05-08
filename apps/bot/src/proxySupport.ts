import type { Agent } from 'node:http';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'undici';
import { config } from './config';
import { getEffectiveHttpPlatformProxyUrl } from './effectiveBotSettings';
import { createLogger } from './logger';

const log = createLogger('proxy');

let nodeProxyAgent: Agent | null | undefined;
let undiciProxyAgent: ProxyAgent | undefined | null;
let axiosProxyInstalled = false;

function proxyAgentTimeoutMs(): number {
  return config.HTTP_PLATFORM_PROXY_TIMEOUT_MS ?? 120_000;
}

/** Drop cached agents so the next lookup uses the current effective proxy URL (env + DB). */
export function resetPlatformProxyAgents(): void {
  nodeProxyAgent = undefined;
  undiciProxyAgent = undefined;
}

/**
 * Node `http(s).request` agent for axios + ethers `FetchRequest.createGetUrlFunc` (HTTP CONNECT).
 * Uses `keepAlive: false` — some proxies drop reused TLS tunnels to Polymarket CLOB.
 */
export function getPlatformHttpsProxyAgent(): Agent | undefined {
  if (nodeProxyAgent === undefined) {
    const u = getEffectiveHttpPlatformProxyUrl();
    if (!u) {
      nodeProxyAgent = null;
      return undefined;
    }
    const timeout = proxyAgentTimeoutMs();
    const tlsInsecure = config.HTTP_PLATFORM_PROXY_TLS_INSECURE;
    const tlsOpts = tlsInsecure ? { rejectUnauthorized: false as const } : {};
    nodeProxyAgent = new HttpsProxyAgent(u, {
      keepAlive: false,
      timeout,
      ...tlsOpts,
    });
  }
  return nodeProxyAgent ?? undefined;
}

/** Undici dispatcher for `fetch(..., { dispatcher })` (e.g. `platformFetch`, viem HTTP transport). */
export function getPlatformProxyDispatcher(): ProxyAgent | undefined {
  if (undiciProxyAgent === undefined) {
    const u = getEffectiveHttpPlatformProxyUrl();
    undiciProxyAgent = u ? new ProxyAgent(u) : null;
  }
  return undiciProxyAgent ?? undefined;
}

/**
 * Polymarket CLOB uses axios. Use `httpAgent` / `httpsAgent` with `HttpsProxyAgent`.
 * `@polymarket/clob-client-v2` is patched (patch-package) so error logs do not `JSON.stringify`
 * `err.response.config` (circular when agents are present).
 */
export function resetAxiosPolymarketProxy(): void {
  axios.defaults.httpAgent = undefined;
  axios.defaults.httpsAgent = undefined;
  axios.defaults.proxy = undefined;
  axios.defaults.timeout = 0;
  axiosProxyInstalled = false;
}

export function installAxiosProxyForPolymarket(): void {
  if (axiosProxyInstalled) return;
  const agent = getPlatformHttpsProxyAgent();
  if (!agent) return;
  axios.defaults.httpAgent = agent;
  axios.defaults.httpsAgent = agent;
  axios.defaults.proxy = false;
  axios.defaults.timeout = proxyAgentTimeoutMs();
  axiosProxyInstalled = true;
  log.info(
    {
      timeoutMs: proxyAgentTimeoutMs(),
      tlsInsecure: config.HTTP_PLATFORM_PROXY_TLS_INSECURE,
      keepAlive: false,
    },
    'axios CONNECT proxy enabled for Polymarket CLOB (HttpsProxyAgent)',
  );
}
