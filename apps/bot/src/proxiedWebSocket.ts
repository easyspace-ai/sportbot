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

/**
 * Some HTTP CONNECT proxies mishandle `Sec-WebSocket-Extensions` (permessage-deflate),
 * which can surface as failed handshake or abnormal close (1006). Disable for all
 * outbound WSS that share `HttpsProxyAgent` (Polymarket, Centrifugo, …).
 */
const proxyWebSocketClientDefaults: ClientOptions = {
  perMessageDeflate: false,
};

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
 * and direct use. When a platform proxy is set, connections use that HTTP CONNECT proxy.
 * In Docker, loopback proxy URLs are resolved to the configured host gateway.
 */
export function getWebSocketConstructorForProxy(): typeof WebSocket {
  const agent = getOutboundWsProxyAgent();
  if (!agent) return WebSocket;

  const handshakeTimeout = wsHandshakeTimeoutMs();

  class WebSocketThroughProxy extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[] | ClientOptions, options?: ClientOptions) {
      if (typeof protocols === 'string' || Array.isArray(protocols)) {
        super(address, protocols, {
          ...proxyWebSocketClientDefaults,
          handshakeTimeout,
          ...(options ?? {}),
          agent,
        });
      } else {
        super(address, {
          ...proxyWebSocketClientDefaults,
          handshakeTimeout,
          ...((protocols as ClientOptions) ?? {}),
          agent,
        });
      }
    }
  }

  return WebSocketThroughProxy as unknown as typeof WebSocket;
}
