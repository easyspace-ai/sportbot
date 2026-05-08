import { cn } from '../lib/utils';
import { VenueLogo } from './VenueLogo';

interface OddsLegendProps {
  className?: string;
}

export function OddsLegend({ className }: OddsLegendProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 font-mono text-[10px] tracking-wider text-tm-tx-mut',
        className,
      )}
      title="盘口颜色表示当前更优报价所在平台"
    >
      <span className="text-tm-tx-dim">最优盘</span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-sm bg-tm-sx" />
        <VenueLogo platform="sx" size={12} />
        <span className="text-tm-sx">SX</span>
      </span>
      <span className="text-tm-bd-st">·</span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-sm bg-tm-poly" />
        <VenueLogo platform="polymarket" size={12} />
        <span className="text-tm-poly">POLY</span>
      </span>
    </div>
  );
}
