import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { isAddress } from 'ethers';
import { prisma } from '../db';
import { invalidatePolymarketClientCache } from '../services/polymarketTrading';
import { createLogger } from '../logger';

const log = createLogger('polymarket-accounts');
const router = Router();

const createBody = z.object({
  name: z.string().min(1).max(64),
  apiKey: z.string().min(1),
  secret: z.string().min(1),
  passphrase: z.string().min(1),
  privateKey: z.string().min(1),
  funderAddress: z.string().min(1),
});

router.get('/api/polymarket/accounts', async (_req: Request, res: Response) => {
  const rows = await prisma.polymarketAccount.findMany({ orderBy: { createdAt: 'asc' } });
  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      funderAddress: r.funderAddress,
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

router.post('/api/polymarket/accounts', async (req: Request, res: Response) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const { name, apiKey, secret, passphrase, privateKey, funderAddress } = parsed.data;
  const addr = funderAddress.trim();
  if (!isAddress(addr)) {
    res.status(400).json({ error: 'invalid_funder', message: 'funderAddress 不是有效的 Polygon 地址' });
    return;
  }

  const count = await prisma.polymarketAccount.count();
  const created = await prisma.polymarketAccount.create({
    data: {
      name: name.trim(),
      apiKey,
      secret,
      passphrase,
      privateKey,
      funderAddress: addr,
      isActive: count === 0,
    },
  });

  invalidatePolymarketClientCache();

  log.info({ id: created.id, isActive: created.isActive }, 'polymarket account created');
  res.status(201).json({
    id: created.id,
    name: created.name,
    funderAddress: created.funderAddress,
    isActive: created.isActive,
  });
});

router.patch('/api/polymarket/accounts/:id/activate', async (req: Request, res: Response) => {
  const { id } = req.params;
  const exists = await prisma.polymarketAccount.findUnique({ where: { id } });
  if (!exists) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.polymarketAccount.updateMany({ data: { isActive: false } });
    await tx.polymarketAccount.update({ where: { id }, data: { isActive: true } });
  });

  invalidatePolymarketClientCache();
  res.json({ ok: true, id });
});

router.delete('/api/polymarket/accounts/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const row = await prisma.polymarketAccount.findUnique({ where: { id } });
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  await prisma.polymarketAccount.delete({ where: { id } });
  invalidatePolymarketClientCache();
  res.status(204).send();
});

export default router;
