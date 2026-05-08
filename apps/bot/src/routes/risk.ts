import { Prisma } from '@prisma/client';
import { Router, Request, Response } from 'express';
import {
  enqueueCloseAll,
  enqueueClosePosition,
  listRecentRiskTasks,
  listRiskPositionsEnriched,
  patchRiskPositionStop,
} from '../services/riskService';
import { getMinOpenRiskShares } from '../effectiveBotSettings';
import { getPolymarketUserWsMeta } from '../services/polymarketUserWs';
import { createLogger } from '../logger';

const log = createLogger('risk-http');
const router = Router();

router.get('/api/risk/positions', async (_req: Request, res: Response) => {
  try {
    const positions = await listRiskPositionsEnriched();
    const ws = getPolymarketUserWsMeta();
    res.json({
      positions,
      meta: {
        userWsConnected: ws.connected,
        userWsConnecting: ws.connecting,
        userWsLastMessageAt: ws.lastMessageAt,
        restTradesSyncLastAt: ws.restTradesSyncLastAt,
        userWsLastIssue: ws.lastIssue,
        outboundProxyConfigured: ws.outboundProxyConfigured,
        minOpenRiskShares: getMinOpenRiskShares(),
      },
    });
  } catch (err) {
    log.error({ err }, 'list risk positions failed');
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/api/risk/tasks', async (req: Request, res: Response) => {
  const limit = Math.min(80, Math.max(1, parseInt(String(req.query.limit ?? '40'), 10) || 40));
  try {
    const tasks = await listRecentRiskTasks(limit);
    res.json({ tasks });
  } catch (err) {
    log.error({ err }, 'list risk tasks failed');
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.patch('/api/risk/positions/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const body = req.body as { stopLossPct?: number; highWaterCents?: number };
  try {
    const position = await patchRiskPositionStop({
      id,
      stopLossPct: body.stopLossPct,
      highWaterCents: body.highWaterCents,
    });
    log.info({ id, stopLossPct: body.stopLossPct, highWaterCents: body.highWaterCents }, 'risk position stop updated');
    res.json({ ok: true, position });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (err instanceof Error) {
      if (
        err.message === 'no updatable fields' ||
        err.message.startsWith('stopLossPct') ||
        err.message.startsWith('highWaterCents')
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
    }
    log.error({ err, id }, 'patch risk position failed');
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.post('/api/risk/positions/:id/close', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await enqueueClosePosition(id);
    res.status(202).json({ ok: true, positionId: id });
  } catch (err) {
    log.error({ err, id }, 'enqueue close failed');
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.post('/api/risk/close-all', async (_req: Request, res: Response) => {
  try {
    await enqueueCloseAll();
    res.status(202).json({ ok: true });
  } catch (err) {
    log.error({ err }, 'enqueue close-all failed');
    res.status(500).json({ error: 'internal_server_error' });
  }
});

export default router;
