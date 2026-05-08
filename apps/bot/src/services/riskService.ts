import type { RiskTask as RiskTaskRow } from '@prisma/client';
import { prisma } from '../db';
import { createLogger } from '../logger';
import { resolveStopLossPctForOpenYesCents } from '../effectiveBotSettings';
import { executePolymarketSell } from '../executor/polymarket';
import { getPolymarketClobClient } from './polymarketTrading';

const log = createLogger('risk');

const DEFAULT_STOP_PCT = 20;

function estimatedShares(costUsd: number, fillOdds: number): number {
  if (!(fillOdds > 0)) return 0;
  return costUsd / fillOdds;
}

export async function recordPolymarketBuyFill(params: {
  outcomeId: string;
  tokenId: string;
  title: string;
  sideLabel: string;
  fillOdds: number;
  costUsd: number;
}): Promise<void> {
  const { outcomeId, tokenId, title, sideLabel, fillOdds, costUsd } = params;
  const entryCents = fillOdds * 100;
  const newShares = estimatedShares(costUsd, fillOdds);
  if (newShares <= 0) return;

  const stopLossPct = resolveStopLossPctForOpenYesCents(entryCents) ?? DEFAULT_STOP_PCT;

  const existing = await prisma.riskPosition.findFirst({
    where: { outcomeId, status: 'open' },
  });

  if (!existing) {
    await prisma.riskPosition.create({
      data: {
        platform: 'polymarket',
        outcomeId,
        tokenId,
        title,
        sideLabel,
        avgEntryCents: entryCents,
        sizeShares: newShares,
        costUsd,
        highWaterCents: entryCents,
        stopLossPct,
      },
    });
    log.info({ outcomeId, tokenId, newShares }, 'risk position opened');
    return;
  }

  const totalShares = existing.sizeShares + newShares;
  const avgEntryCents =
    (existing.avgEntryCents * existing.sizeShares + entryCents * newShares) / totalShares;
  const highWaterCents = Math.max(existing.highWaterCents, entryCents);
  await prisma.riskPosition.update({
    where: { id: existing.id },
    data: {
      sizeShares: totalShares,
      costUsd: existing.costUsd + costUsd,
      avgEntryCents,
      highWaterCents,
      title,
      sideLabel,
    },
  });
  log.info({ outcomeId, id: existing.id, totalShares }, 'risk position scaled');
}

async function readBestBidCents(tokenId: string): Promise<number | null> {
  try {
    const client = await getPolymarketClobClient();
    const book = await client.getOrderBook(tokenId);
    const p = parseFloat(book.bids[0]?.price ?? '');
    if (!Number.isFinite(p) || p <= 0) return null;
    return p * 100;
  } catch (err) {
    log.warn({ err, tokenId }, 'risk: failed to read order book');
    return null;
  }
}

export interface RiskPositionApiRow {
  id: string;
  title: string;
  sideLabel: string;
  avgEntryCents: number;
  currentCents: number | null;
  sizeShares: number;
  costUsd: number;
  highWaterCents: number;
  stopLossPct: number;
  trailingStopCents: number;
  valueUsd: number | null;
  pnlUsd: number | null;
  maxPayoffUsd: number;
  potentialProfitUsd: number;
  status: string;
}

export async function listRiskPositionsEnriched(): Promise<RiskPositionApiRow[]> {
  const rows = await prisma.riskPosition.findMany({
    where: { status: { in: ['open', 'closing'] } },
    orderBy: { updatedAt: 'desc' },
  });

  const out: RiskPositionApiRow[] = [];

  for (const p of rows) {
    const bidCents = await readBestBidCents(p.tokenId);
    let highWater = p.highWaterCents;
    if (bidCents != null && bidCents > highWater) {
      highWater = bidCents;
      await prisma.riskPosition.update({
        where: { id: p.id },
        data: { highWaterCents: highWater },
      });
    }

    const trailingStopCents = highWater * (1 - p.stopLossPct / 100);
    const currentCents = bidCents;
    const currentUsd = currentCents != null ? currentCents / 100 : null;
    const valueUsd = currentUsd != null ? p.sizeShares * currentUsd : null;
    const pnlUsd = valueUsd != null ? valueUsd - p.costUsd : null;
    const maxPayoffUsd = p.sizeShares * 1;
    const potentialProfitUsd = maxPayoffUsd - p.costUsd;

    if (p.status === 'open' && currentCents != null && currentCents <= trailingStopCents) {
      await ensureCloseTask(p.id);
    }

    out.push({
      id: p.id,
      title: p.title,
      sideLabel: p.sideLabel,
      avgEntryCents: p.avgEntryCents,
      currentCents,
      sizeShares: p.sizeShares,
      costUsd: p.costUsd,
      highWaterCents: highWater,
      stopLossPct: p.stopLossPct,
      trailingStopCents,
      valueUsd,
      pnlUsd,
      maxPayoffUsd,
      potentialProfitUsd,
      status: p.status,
    });
  }

  return out;
}

async function ensureCloseTask(positionId: string): Promise<void> {
  const active = await prisma.riskTask.findFirst({
    where: {
      positionId,
      type: 'close_position',
      status: { in: ['pending', 'running'] },
    },
  });
  if (active) return;
  await prisma.riskTask.create({
    data: {
      type: 'close_position',
      positionId,
      status: 'pending',
      nextRunAt: new Date(),
    },
  });
  log.info({ positionId }, 'risk: stop-loss queued close_position task');
}

export async function enqueueClosePosition(positionId: string): Promise<void> {
  await ensureCloseTask(positionId);
}

export async function enqueueCloseAll(): Promise<void> {
  await prisma.riskTask.create({
    data: { type: 'close_all', status: 'pending', nextRunAt: new Date() },
  });
}

export interface RiskTaskApiRow {
  id: string;
  type: string;
  positionId: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  nextRunAt: string;
  updatedAt: string;
}

export async function listRecentRiskTasks(limit = 40): Promise<RiskTaskApiRow[]> {
  const rows = await prisma.riskTask.findMany({
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return rows.map((t: RiskTaskRow) => ({
    id: t.id,
    type: t.type,
    positionId: t.positionId,
    status: t.status,
    attempts: t.attempts,
    lastError: t.lastError,
    nextRunAt: t.nextRunAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }));
}

function backoffMs(attempts: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.min(attempts, 5));
}

async function runClosePositionTask(taskId: string, positionId: string): Promise<void> {
  const position = await prisma.riskPosition.findUnique({ where: { id: positionId } });
  if (!position || position.status === 'closed') {
    await prisma.riskTask.update({
      where: { id: taskId },
      data: { status: 'succeeded', lastError: null },
    });
    return;
  }

  await prisma.riskPosition.update({
    where: { id: positionId },
    data: { status: 'closing' },
  });

  try {
    await executePolymarketSell(position.tokenId, position.sizeShares);
    await prisma.riskPosition.update({
      where: { id: positionId },
      data: { status: 'closed', sizeShares: 0 },
    });
    await prisma.riskTask.updateMany({
      where: {
        positionId,
        type: 'close_position',
        status: { in: ['pending', 'failed'] },
        id: { not: taskId },
      },
      data: { status: 'cancelled', lastError: 'superseded' },
    });
    await prisma.riskTask.update({
      where: { id: taskId },
      data: { status: 'succeeded', lastError: null },
    });
    log.info({ positionId }, 'risk: position closed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.riskPosition.update({
      where: { id: positionId },
      data: { status: 'open' },
    });
    throw new Error(msg);
  }
}

async function runCloseAllTask(taskId: string): Promise<void> {
  const open = await prisma.riskPosition.findMany({ where: { status: 'open' } });
  for (const p of open) {
    await ensureCloseTask(p.id);
  }
  await prisma.riskTask.update({
    where: { id: taskId },
    data: { status: 'succeeded', lastError: null },
  });
}

export async function processRiskTasksOnce(): Promise<void> {
  const tasks = await prisma.riskTask.findMany({
    where: {
      status: { in: ['pending', 'failed'] },
      nextRunAt: { lte: new Date() },
    },
    orderBy: { nextRunAt: 'asc' },
    take: 8,
  });

  for (const task of tasks) {
    await prisma.riskTask.update({
      where: { id: task.id },
      data: { status: 'running' },
    });

    try {
      if (task.type === 'close_position' && task.positionId) {
        await runClosePositionTask(task.id, task.positionId);
      } else if (task.type === 'close_all') {
        await runCloseAllTask(task.id);
      } else {
        await prisma.riskTask.update({
          where: { id: task.id },
          data: {
            status: 'failed',
            lastError: `unknown_task_type:${task.type}`,
            nextRunAt: new Date(Date.now() + 86_400_000),
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ taskId: task.id, msg }, 'risk task failed, will retry');
      await prisma.riskTask.update({
        where: { id: task.id },
        data: {
          status: 'failed',
          attempts: { increment: 1 },
          lastError: msg.slice(0, 2000),
          nextRunAt: new Date(Date.now() + backoffMs(task.attempts + 1)),
        },
      });
    }
  }
}
