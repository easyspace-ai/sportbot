import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { prisma } from '../db';
import { invalidatePolymarketClientCache } from '../services/polymarketTrading';
import { provisionPolymarketFromPrivateKey } from '../services/polymarketProvision';
import { createLogger } from '../logger';

const log = createLogger('polymarket-accounts');
const router = Router();

const createBody = z.object({
  name: z.string().min(1).max(64),
  privateKey: z.string().min(1),
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

  const pk = parsed.data.privateKey.trim();
  const hex = pk.startsWith('0x') ? pk : `0x${pk}`;
  if (!isHex(hex) || hex.length !== 66) {
    res.status(400).json({ error: 'invalid_private_key', message: 'privateKey 须为 32 字节十六进制私钥' });
    return;
  }

  try {
    privateKeyToAccount(hex as `0x${string}`);
  } catch {
    res.status(400).json({ error: 'invalid_private_key', message: '无法从 privateKey 解析出 EOA' });
    return;
  }

  let funderAddress: string;
  let apiKey: string;
  let secret: string;
  let passphrase: string;

  try {
    const p = await provisionPolymarketFromPrivateKey(hex);
    funderAddress = p.funderAddress;
    apiKey = p.apiKey;
    secret = p.secret;
    passphrase = p.passphrase;
  } catch (err) {
    log.error({ err }, 'polymarket provision failed');
    res.status(502).json({
      error: 'provision_failed',
      message:
        err instanceof Error
          ? err.message
          : '无法从 Polymarket CLOB 获取 API 凭证（请检查网络、代理与私钥是否为 Polygon 上的 Polymarket 账号）',
    });
    return;
  }

  const count = await prisma.polymarketAccount.count();
  const created = await prisma.polymarketAccount.create({
    data: {
      name: parsed.data.name.trim(),
      apiKey,
      secret,
      passphrase,
      privateKey: hex,
      funderAddress,
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
