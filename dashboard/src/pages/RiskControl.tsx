import { useCallback, useEffect, useState } from 'react';
import {
  getRiskPositions,
  getRiskTasks,
  postRiskCloseAll,
  postRiskClosePosition,
  type RiskPositionRow,
  type RiskTaskRow,
} from '../lib/api';
import { toast } from '../components/ui/use-toast';
import { cn } from '../lib/utils';

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const v = Math.abs(n);
  return `${sign}$${v.toFixed(2)}`;
}

function fmtCents(c: number | null | undefined): string {
  if (c == null || !Number.isFinite(c)) return '—';
  return `${c.toFixed(1)}¢`;
}

export function RiskControl() {
  const [positions, setPositions] = useState<RiskPositionRow[]>([]);
  const [tasks, setTasks] = useState<RiskTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([getRiskPositions(), getRiskTasks(50)]);
      setPositions(p.positions);
      setTasks(t.tasks);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  async function onCloseOne(id: string) {
    setClosingId(id);
    try {
      await postRiskClosePosition(id);
      toast({ title: '已排队', description: '平仓任务已加入队列（失败会自动重试）', variant: 'success' });
      await load();
    } catch (e) {
      toast({
        title: '失败',
        description: e instanceof Error ? e.message : '未知错误',
        variant: 'destructive',
      });
    } finally {
      setClosingId(null);
    }
  }

  async function onCloseAll() {
    setClosingAll(true);
    try {
      await postRiskCloseAll();
      toast({ title: '已排队', description: '已为所有持仓创建平仓任务', variant: 'success' });
      await load();
    } catch (e) {
      toast({
        title: '失败',
        description: e instanceof Error ? e.message : '未知错误',
        variant: 'destructive',
      });
    } finally {
      setClosingAll(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-tm-bg">
      <div className="h-10 shrink-0 flex items-center justify-between gap-3 px-4 bg-tm-bg border-b border-tm-bd">
        <span className="font-mono text-[10px] font-semibold tracking-[0.2em] text-tm-tx-dim">
          风控
        </span>
        <button
          type="button"
          disabled={closingAll || positions.length === 0}
          onClick={() => void onCloseAll()}
          className={cn(
            'rounded-sm px-2.5 py-1 font-mono text-[10px] font-bold tracking-wider transition-colors',
            closingAll || positions.length === 0
              ? 'bg-tm-bg-sunk text-tm-tx-mut cursor-not-allowed'
              : 'bg-tm-neg/90 text-white hover:bg-tm-neg',
          )}
        >
          {closingAll ? '…' : '一键全部平仓'}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {error && (
          <div className="mb-3 rounded-sm border border-tm-neg/30 bg-tm-neg/10 px-3 py-2 font-mono text-[11px] text-tm-neg">
            {error}
          </div>
        )}
        {loading && (
          <div className="font-mono text-[11px] text-tm-tx-mut">加载中…</div>
        )}

        {!loading && positions.length === 0 && !error && (
          <p className="font-mono text-[11px] text-tm-tx-mut max-w-md">
            暂无持仓。通过本系统成交的 Polymarket 买单会自动出现在此处；止损按「设置 → 价格区间」中的比例，相对
            <span className="text-tm-tx"> 最高水位 </span>
            计算移动止损价。平仓使用 FOK 卖单，允许相对最优买价向下 10 个 tick 以提高成交率；失败任务会指数退避重试。
          </p>
        )}

        {positions.length > 0 && (
          <div className="overflow-x-auto rounded-sm border border-tm-bd">
            <table className="w-full min-w-[960px] border-collapse font-mono text-[10px]">
              <thead>
                <tr className="border-b border-tm-bd bg-tm-bg-el text-tm-tx-mut text-left">
                  <th className="px-2 py-2 font-semibold">盘口</th>
                  <th className="px-2 py-2 font-semibold">均价 → 当前</th>
                  <th className="px-2 py-2 font-semibold">份额</th>
                  <th className="px-2 py-2 font-semibold">成本</th>
                  <th className="px-2 py-2 font-semibold">可赢利</th>
                  <th className="px-2 py-2 font-semibold">市值</th>
                  <th className="px-2 py-2 font-semibold">最高水位</th>
                  <th className="px-2 py-2 font-semibold">止损%</th>
                  <th className="px-2 py-2 font-semibold">止损价</th>
                  <th className="px-2 py-2 font-semibold w-[72px]" />
                </tr>
              </thead>
              <tbody>
                {positions.map((row) => {
                  const pnlPct =
                    row.pnlUsd != null && row.costUsd > 0
                      ? (row.pnlUsd / row.costUsd) * 100
                      : null;
                  return (
                    <tr key={row.id} className="border-b border-tm-bd/80 hover:bg-tm-bg-el/40">
                      <td className="px-2 py-2 align-top">
                        <div className="text-tm-tx font-semibold leading-snug max-w-[220px]">{row.title}</div>
                        <div className="mt-0.5 text-tm-tx-dim">{row.sideLabel}</div>
                        {row.status === 'closing' && (
                          <span className="mt-1 inline-block text-[9px] text-amber-400">平仓中…</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-tm-tx whitespace-nowrap">
                        {fmtCents(row.avgEntryCents)}
                        <span className="text-tm-tx-mut mx-0.5">→</span>
                        {fmtCents(row.currentCents)}
                      </td>
                      <td className="px-2 py-2 text-tm-tx">{row.sizeShares.toFixed(2)}</td>
                      <td className="px-2 py-2 text-tm-tx">{fmtUsd(row.costUsd)}</td>
                      <td className="px-2 py-2 text-tm-pos">{fmtUsd(row.potentialProfitUsd)}</td>
                      <td className="px-2 py-2">
                        <div className="text-tm-tx">{fmtUsd(row.valueUsd)}</div>
                        {row.pnlUsd != null && (
                          <div
                            className={cn(
                              'text-[9px] mt-0.5',
                              row.pnlUsd >= 0 ? 'text-tm-pos' : 'text-tm-neg',
                            )}
                          >
                            {fmtUsd(row.pnlUsd)}
                            {pnlPct != null && Number.isFinite(pnlPct)
                              ? ` (${pnlPct >= 0 ? '' : '−'}${Math.abs(pnlPct).toFixed(1)}%)`
                              : ''}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-tm-poly">{fmtCents(row.highWaterCents)}</td>
                      <td className="px-2 py-2 text-tm-tx">{row.stopLossPct.toFixed(0)}%</td>
                      <td className="px-2 py-2 text-tm-neg">{fmtCents(row.trailingStopCents)}</td>
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          disabled={row.status !== 'open' || closingId === row.id}
                          onClick={() => void onCloseOne(row.id)}
                          className={cn(
                            'w-full rounded-sm py-1 text-[10px] font-bold',
                            row.status !== 'open' || closingId === row.id
                              ? 'bg-tm-bg-sunk text-tm-tx-mut cursor-not-allowed'
                              : 'bg-sky-600 text-white hover:bg-sky-500',
                          )}
                        >
                          {closingId === row.id ? '…' : '卖出'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-6">
          <div className="font-mono text-[10px] font-semibold tracking-[0.2em] text-tm-tx-dim mb-2">
            任务队列
          </div>
          <p className="font-mono text-[9px] text-tm-tx-mut mb-2 max-w-2xl">
            止损触发与手动平仓均进入此队列；状态为 failed 时会按退避时间自动重试。卖单价格 = max(tick, 最优买价 − 10×tick)。
          </p>
          {tasks.length === 0 ? (
            <div className="font-mono text-[10px] text-tm-tx-mut">暂无任务</div>
          ) : (
            <ul className="space-y-1.5 max-h-[280px] overflow-y-auto rounded-sm border border-tm-bd bg-tm-bg-el p-2">
              {tasks.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[10px] text-tm-tx border-b border-tm-bd/50 pb-1.5 last:border-0"
                >
                  <span className="text-tm-tx-dim shrink-0">{t.updatedAt.slice(5, 16)}</span>
                  <span className="font-semibold text-tm-sx">{t.type}</span>
                  <span
                    className={cn(
                      'uppercase text-[9px]',
                      t.status === 'succeeded' && 'text-tm-pos',
                      t.status === 'failed' && 'text-tm-neg',
                      t.status === 'pending' && 'text-amber-400',
                      t.status === 'running' && 'text-sky-400',
                      t.status === 'cancelled' && 'text-tm-tx-mut',
                    )}
                  >
                    {t.status}
                  </span>
                  {t.positionId && (
                    <span className="text-tm-tx-mut truncate max-w-[120px]" title={t.positionId}>
                      pos {t.positionId.slice(0, 8)}…
                    </span>
                  )}
                  <span className="text-tm-tx-mut">#{t.attempts}</span>
                  {t.lastError && (
                    <span className="text-tm-neg w-full break-all text-[9px]">{t.lastError}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
