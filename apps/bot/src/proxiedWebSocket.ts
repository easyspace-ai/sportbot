import WebSocket from 'ws';
import type { ClientOptions } from 'ws';
import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getEffectiveHttpPlatformProxyUrl } from './effectiveBotSettings';

let agentInited = false;
let proxyAgent: Agent | undefined;

export function resetOutboundWsProxyAgent(): void {
  agentInited = false;
  proxyAgent = undefined;
}

/** Shared HTTP CONNECT agent for outbound WSS (SX Centrifugo, Polymarket CLOB, …). */
export function getOutboundWsProxyAgent(): Agent | undefined {
  if (!agentInited) {
    agentInited = true;
    const url = getEffectiveHttpPlatformProxyUrl();
    proxyAgent = url ? new HttpsProxyAgent(url) : undefined;
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

  class WebSocketThroughProxy extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[] | ClientOptions, options?: ClientOptions) {
      if (typeof protocols === 'string' || Array.isArray(protocols)) {
        super(address, protocols, { ...(options ?? {}), agent });
      } else {
        super(address, { ...((protocols as ClientOptions) ?? {}), agent });
      }
    }
  }

  return WebSocketThroughProxy as unknown as typeof WebSocket;
}
