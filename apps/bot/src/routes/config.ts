import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { orderBookCache } from '../services/orderBookCache';
import { createLogger } from '../logger';
import { refreshBotConfigCache } from '../botConfigCache';
import {
  installAxiosProxyForPolymarket,
  resetAxiosPolymarketProxy,
  resetPlatformProxyAgents,
} from '../proxySupport';
import { resetOutboundWsProxyAgent } from '../proxiedWebSocket';
import { areHeavyServicesStarted } from '../heavyServices';

const log = createLogger('config');
const router = Router();

/** Keys whose values must not appear in `GET /api/config` JSON (browser / logs). */
const SENSITIVE_CONFIG_KEYS = new Set([
  'telegramBotToken',
  'telegramAuthorizedChatId',
  'polymarketApiKey',
  'polymarketSecret',
  'polymarketPassphrase',
]);

function applyProxyFromDb(): void {
  resetPlatformProxyAgents();
  resetOutboundWsProxyAgent();
  resetAxiosPolymarketProxy();
  installAxiosProxyForPolymarket();
}

function validateConfigPut(key: string, value: string): string | null {
  if (key === 'orderBookLevels') {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < 3 || parsed > 25) {
      return 'orderBookLevels must be an integer between 3 and 25';
    }
  }

  if (key === 'polymarketFokBuyExtraTicks' || key === 'polymarketFokSellExtraTicks') {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > 50) {
      return `${key} must be an integer between 0 and 50`;
    }
  }

  if (key === 'httpPlatformProxyUrl') {
    const t = value.trim();
    if (t === '') return null;
    const r = z.string().url().safeParse(t);
    if (!r.success) return 'httpPlatformProxyUrl must be empty or a valid http(s) URL';
  }

  if (key === 'eventClassificationTags') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return 'eventClassificationTags must be valid JSON';
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      return 'eventClassificationTags must be a JSON array of strings';
    }
    if (parsed.some((s: string) => !String(s).trim())) {
      return 'eventClassificationTags entries must be non-empty strings';
    }
  }

  if (key === 'minOpenRiskShares') {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1_000_000) {
      return 'minOpenRiskShares must be a number > 0 and ≤ 1000000';
    }
  }

  if (key === 'onboardingComplete') {
    const t = value.trim();
    if (t !== 'true' && t !== 'false') {
      return 'onboardingComplete must be true or false';
    }
  }

  if (key === 'priceStopLossRanges') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return 'priceStopLossRanges must be valid JSON';
    }
    if (!Array.isArray(parsed)) {
      return 'priceStopLossRanges must be a JSON array';
    }
    if (parsed.length === 0) return null;
    const rowSchema = z.object({
      id: z.string().min(1),
      name: z.string(),
      minCents: z.number().finite(),
      maxCents: z.number().finite(),
      fundPct: z.number().finite().min(0).max(100),
      stopLossPct: z.number().finite().min(0).max(100),
    });
    for (const row of parsed) {
      const r = rowSchema.safeParse(row);
      if (!r.success) return 'priceStopLossRanges rows need id, name, minCents, maxCents, fundPct, stopLossPct';
      if (r.data.minCents >= r.data.maxCents) {
        return `range "${r.data.name}": minCents must be < maxCents`;
      }
    }
  }

  return null;
}

router.get('/api/config', async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.botConfig.findMany({ orderBy: { key: 'asc' } });
    res.json(
      rows.map((r) =>
        SENSITIVE_CONFIG_KEYS.has(r.key) ? { ...r, value: '***' } : r,
      ),
    );
  } catch (err) {
    log.error({ err }, 'failed to fetch config');
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.put('/api/config/:key', async (req: Request, res: Response) => {
  const { key } = req.params;
  const { value } = req.body as { value?: string };

  if (value == null) {
    res.status(400).json({ error: 'value is required' });
    return;
  }

  const validationError = validateConfigPut(key, value);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  try {
    const row = await prisma.botConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    await refreshBotConfigCache();
    if (key === 'orderBookLevels') {
      orderBookCache.setTopLevels(parseInt(value, 10));
    }
    if (key === 'httpPlatformProxyUrl') {
      applyProxyFromDb();
      if (areHeavyServicesStarted()) {
        void import('../services/polymarketUserWs').then((m) => m.hardResetPolymarketUserWs());
      }
    }
    res.json(row);
  } catch (err) {
    log.error({ err, key }, 'failed to update config');
    res.status(500).json({ error: 'internal_server_error' });
  }
});

export default router;
