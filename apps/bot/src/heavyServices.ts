import type { Server } from 'node:http';
import { createLogger } from './logger';
import { startMarketSync } from './sync/marketSync';
import { startTelegramBot } from './telegram/bot';
import { startWsRelay } from './ws/relay';
import { startCentrifugoService } from './services/centrifugo';
import { startPolymarketWsService } from './services/polymarketWs';
import { startPolymarketUserWsService } from './services/polymarketUserWs';
import { startRiskPolymarketBookBridge } from './services/riskPolymarketBookBridge';
import { startPersistentPolyOddsService } from './services/persistentPolyOdds';
import { startFixtureFinalizer } from './services/sxFixtureService';
import { processRiskTasksOnce } from './services/riskService';
import { getTelegramAuthorizedChatId, getTelegramBotToken } from './effectiveBotSettings';
import { prisma } from './db';
import { applyNetworkingFromDb } from './applyNetworking';
import { ONBOARDING_CONFIG_KEY } from './onboarding';

const log = createLogger('bootstrap');
const apiLog = createLogger('api');

let heavyStarted = false;
let mainServer: Server | null = null;

export function areHeavyServicesStarted(): boolean {
  return heavyStarted;
}

export function registerMainHttpServer(server: Server): void {
  mainServer = server;
}

export function startHeavyServicesIfIdle(server: Server, mode: 'full' | 'readOnly'): void {
  if (heavyStarted) {
    return;
  }
  heavyStarted = true;
  startWsRelay(server);
  startFixtureFinalizer();
  startCentrifugoService();
  startPolymarketWsService();
  startRiskPolymarketBookBridge();
  startPolymarketUserWsService();
  startPersistentPolyOddsService();
  startMarketSync();
  if (mode === 'full') {
    setInterval(() => {
      processRiskTasksOnce().catch((err) => apiLog.error({ err }, 'risk task tick failed'));
    }, 3000);
    processRiskTasksOnce().catch((err) => apiLog.error({ err }, 'risk task initial tick failed'));
    if (getTelegramBotToken() && getTelegramAuthorizedChatId()) {
      startTelegramBot();
    } else {
      log.info(
        'Telegram bot disabled (set TELEGRAM_* in env and/or dashboard BotConfig / 电报)',
      );
    }
  }
  log.info({ mode }, 'heavy services started (market sync, platform realtime, WS relay)');
}

export async function markOnboardingCompleteAndStartHeavy(mode: 'full' | 'readOnly'): Promise<void> {
  await prisma.botConfig.upsert({
    where: { key: ONBOARDING_CONFIG_KEY },
    create: { key: ONBOARDING_CONFIG_KEY, value: 'true' },
    update: { value: 'true' },
  });
  await applyNetworkingFromDb();
  if (!mainServer) {
    throw new Error('main HTTP server not registered');
  }
  startHeavyServicesIfIdle(mainServer, mode);
}
