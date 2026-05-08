import WebSocket from 'ws';
import type { ClientOptions } from 'ws';
import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from './config';
import { getEffectiveHttpPlatformProxyUrl } from './effectiveBotSettings';

let agentInited = false;
let proxyAgent: Agent | undefined;

function platformProxyTimeoutMs(): number {
  return config.HTTP_PLATFORM_PROXY_TIMEOUT_MS ?? 120_000;
}

/** Opening handshake (CONNECT + TLS + WS upgrade); align with axios / HttpsProxyAgent tunnel budget. */
export function wsHandshakeTimeoutMs(): number {
  return platformProxyTimeoutMs();
}

export function resetOutboundWsProxyAgent(): void {
  agentInited = false;
  proxyAgent = undefined;
}

/**
 * Shared HTTP CONNECT agent for outbound WSS (SX Centrifugo, Polymarket CLOB, …).
 * Uses the same `timeout` / `keepAlive` / TLS flags as `getPlatformHttpsProxyAgent` in proxySupport.
 */
export function getOutboundWsProxyAgent(): Agent | undefined {
  if (!agentInited) {
    agentInited = true;
    const url = getEffectiveHttpPlatformProxyUrl();
    if (!url) {
      proxyAgent = undefined;
      return undefined;
    }
    const timeout = platformProxyTimeoutMs();
    const tlsOpts = config.HTTP_PLATFORM_PROXY_TLS_INSECURE ? { rejectUnauthorized: false as const } : {};
    proxyAgent = new HttpsProxyAgent(url, {
      keepAlive: false,
      timeout,
      ...tlsOpts,
    });
  }
  return proxyAgent;
}

/**
 * `ws` constructor compatible with Centrifuge (`new ws(url)` / `new ws(url, subProtocol)`)
 * and direct use. When `HTTP_PLATFORM_PROXY_URL` is set, connections use that HTTP CONNECT proxy.
 */
export function getWebSocketConstructorForProxy(): typeof WebSocket {
  const agent = getOutboundWsProxyAgent();
  if (!agent) return WebSocket;

  const handshakeTimeout = wsHandshakeTimeoutMs();

  class WebSocketThroughProxy extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[] | ClientOptions, options?: ClientOptions) {
      if (typeof protocols === 'string' || Array.isArray(protocols)) {
        super(address, protocols, { handshakeTimeout, ...(options ?? {}), agent });
      } else {
        super(address, { handshakeTimeout, ...((protocols as ClientOptions) ?? {}), agent });
      }
    }
  }

  return WebSocketThroughProxy as unknown as typeof WebSocket;
}
