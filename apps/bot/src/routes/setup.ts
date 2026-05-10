import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { config } from '../config';
import { readNeedsOnboarding } from '../onboarding';
import { markOnboardingCompleteAndStartHeavy } from '../heavyServices';
import { createLogger } from '../logger';

const log = createLogger('setup');
const router = Router();

async function hasPolymarketTradingConfigured(): Promise<boolean> {
  const active = await prisma.polymarketAccount.findFirst({ where: { isActive: true } });
  if (active) {
    return true;
  }
  return Boolean(config.POLYMARKET_PRIVATE_KEY?.trim());
}

function hasOutboundProxyConfigured(): boolean {
  if (Boolean(config.HTTP_PLATFORM_PROXY_URL?.trim())) {
    return true;
  }
  return false;
}

async function hasOutboundProxyInDb(): Promise<boolean> {
  const row = await prisma.botConfig.findUnique({ where: { key: 'httpPlatformProxyUrl' } });
  return Boolean(row?.value?.trim());
}

router.get('/api/setup/status', async (_req: Request, res: Response) => {
  try {
    const needsOnboarding = await readNeedsOnboarding();
    const proxyInDb = await hasOutboundProxyInDb();
    const poly = await hasPolymarketTradingConfigured();
    res.json({
      needsOnboarding,
      proxyConfigured: hasOutboundProxyConfigured() || proxyInDb,
      polymarketConfigured: poly,
    });
  } catch (err) {
    log.error({ err }, 'setup status failed');
    res.status(500).json({ error: 'setup_status_failed' });
  }
});

router.post('/api/setup/complete', async (_req: Request, res: Response) => {
  try {
    const mode = config.READ_ONLY_MODE ? 'readOnly' : 'full';
    await markOnboardingCompleteAndStartHeavy(mode);
    res.json({ ok: true });
  } catch (err) {
    log.error({ err }, 'setup complete failed');
    res.status(500).json({
      error: 'setup_complete_failed',
      message: err instanceof Error ? err.message : 'unknown_error',
    });
  }
});

export default router;
