import './config'; // validates env vars first — exits process if any are missing
import { config } from './config';
import { runPendingMigrationsOrThrow } from './runPendingMigrations';
import { prisma } from './db';
import { applyNetworkingFromDb } from './applyNetworking';
import { ensureOnboardingDefault, isOnboardingCompleteCached } from './onboarding';
import {
  registerMainHttpServer,
  startHeavyServicesIfIdle,
} from './heavyServices';
import app from './app';
import publicApp from './publicApp';
import { startWsRelay } from './ws/relay';
import { createLogger } from './logger';

const dbLog = createLogger('db');
const apiLog = createLogger('api');
const publicApiLog = createLogger('api:public');

async function main() {
  try {
    runPendingMigrationsOrThrow();
    await prisma.$connect();
    dbLog.info('connected');
  } catch (err) {
    dbLog.error({ err }, 'failed to connect');
    process.exit(1);
  }

  const staleRunning = await prisma.riskTask.updateMany({
    where: { status: 'running' },
    data: {
      status: 'pending',
      nextRunAt: new Date(),
      lastError: 'reset_after_restart',
    },
  });
  if (staleRunning.count > 0) {
    dbLog.info({ count: staleRunning.count }, 'risk: reset stale running tasks on startup');
  }

  await ensureOnboardingDefault();
  await applyNetworkingFromDb();

  const port = Number(config.PORT);
  const host = config.HOST;

  if (config.READ_ONLY_MODE) {
    const roServer = publicApp.listen(port, host, () => {
      publicApiLog.info({ port, host, logLevel: config.LOG_LEVEL }, 'Public read-only API listening');
      registerMainHttpServer(roServer);
      startHeavyServicesIfIdle(roServer, 'readOnly');
    });
    void roServer;
    return;
  }

  const server = app.listen(port, host, () => {
    apiLog.info({ port, host, logLevel: config.LOG_LEVEL }, 'Sports Prediction Market Router API listening');
    registerMainHttpServer(server);
    if (isOnboardingCompleteCached()) {
      startHeavyServicesIfIdle(server, 'full');
    } else {
      apiLog.info('onboarding: heavy services deferred until POST /api/setup/complete');
    }
  });

  if (config.PUBLIC_PORT) {
    const publicPort = Number(config.PUBLIC_PORT);
    const publicServer = publicApp.listen(publicPort, host, () => {
      publicApiLog.info({ port: publicPort, host }, 'Public read-only API listening');
      startWsRelay(publicServer);
    });
  }
}

main();
