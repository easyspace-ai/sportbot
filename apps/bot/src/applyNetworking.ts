import { refreshBotConfigCache } from './botConfigCache';
import {
  installAxiosProxyForPolymarket,
  resetAxiosPolymarketProxy,
  resetPlatformProxyAgents,
} from './proxySupport';
import { resetOutboundWsProxyAgent } from './proxiedWebSocket';

export async function applyNetworkingFromDb(): Promise<void> {
  await refreshBotConfigCache();
  resetPlatformProxyAgents();
  resetOutboundWsProxyAgent();
  resetAxiosPolymarketProxy();
  installAxiosProxyForPolymarket();
}
