import { Router, Request, Response } from 'express';
import {
  enqueueCloseAll,
  enqueueClosePosition,
  listRecentRiskTasks,
  listRiskPositionsEnriched,
} from '../services/riskService';
import { createLogger } from '../logger';

const log = createLogger('risk-http');
const router = Router();

router.get('/api/risk/positions', async (_req: Request, res: Response) => {
  try {
    const positions = await listRiskPositionsEnriched();
    res.json({ positions });
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
