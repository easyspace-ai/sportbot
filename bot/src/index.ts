import './config'; // validates env vars first — exits process if any are missing
import { config } from './config';
import { prisma } from './db';
import { refreshBotConfigCache } from './botConfigCache';
import {
  installAxiosProxyForPolymarket,
  resetAxiosPolymarketProxy,
  resetPlatformProxyAgents,
} from './proxySupport';
import { resetOutboundWsProxyAgent } from './proxiedWebSocket';
import { getTelegramAuthorizedChatId, getTelegramBotToken } from './effectiveBotSettings';
import app from './app';
import publicApp from './publicApp';
import { startMarketSync } from './sync/marketSync';
import { startTelegramBot } from './telegram/bot';
import { startWsRelay } from './ws/relay';
import { startCentrifugoService } from './services/centrifugo';
import { startPolymarketWsService } from './services/polymarketWs';
import { startPersistentPolyOddsService } from './services/persistentPolyOdds';
import { startFixtureFinalizer } from './services/sxFixtureService';
import { processRiskTasksOnce } from './services/riskService';
import { createLogger } from './logger';

const dbLog = createLogger('db');
const apiLog = createLogger('api');
const publicApiLog = createLogger('api:public');

async function applyNetworkingFromDb(): Promise<void> {
  await refreshBotConfigCache();
  resetPlatformProxyAgents();
  resetOutboundWsProxyAgent();
  resetAxiosPolymarketProxy();
  installAxiosProxyForPolymarket();
}

async function main() {
  try {
    await prisma.$connect();
    dbLog.info('connected');
  } catch (err) {
    dbLog.error({ err }, 'failed to connect');
    process.exit(1);
  }

  await applyNetworkingFromDb();

  const port = Number(config.PORT);

  if (config.READ_ONLY_MODE) {
    const server = publicApp.listen(port, () => {
      publicApiLog.info({ port, logLevel: config.LOG_LEVEL }, 'Public read-only API listening');
      startWsRelay(server);
      startFixtureFinalizer();
      startCentrifugoService();
      startPolymarketWsService();
      startPersistentPolyOddsService();
      startMarketSync();
    });
    return;
  }

  const server = app.listen(port, () => {
    apiLog.info({ port, logLevel: config.LOG_LEVEL }, 'Sports Prediction Market Router API listening');
    startWsRelay(server);
    startFixtureFinalizer();
    startCentrifugoService();
    startPolymarketWsService();
    startPersistentPolyOddsService();
    startMarketSync();
    setInterval(() => {
      processRiskTasksOnce().catch((err) => apiLog.error({ err }, 'risk task tick failed'));
    }, 3000);
    processRiskTasksOnce().catch((err) => apiLog.error({ err }, 'risk task initial tick failed'));
    if (getTelegramBotToken() && getTelegramAuthorizedChatId()) {
      startTelegramBot();
    } else {
      apiLog.info(
        'Telegram bot disabled (set TELEGRAM_* in env and/or 电报 tab in dashboard / BotConfig)',
      );
    }
  });

  if (config.PUBLIC_PORT) {
    const publicPort = Number(config.PUBLIC_PORT);
    const publicServer = publicApp.listen(publicPort, () => {
      publicApiLog.info({ port: publicPort }, 'Public read-only API listening');
      startWsRelay(publicServer);
    });
  }
}

main();
