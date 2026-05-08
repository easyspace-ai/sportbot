import { cn } from '../lib/utils';

export interface LeagueNavTag {
  /** Lowercase tag (matches `eventClassificationTags` / `group.league` case-insensitively) */
  tag: string;
  /** Shown in sidebar (e.g. NBA) */
  label: string;
  count: number;
}

interface LeagueTreeProps {
  tags: LeagueNavTag[];
  selectedTag: string;
  inPlayMode: boolean;
  livePlayCount: number;
  onSelectInPlay: () => void;
  onSelectTag: (tag: string) => void;
}

/**
 * Market league sidebar: 进行中 + flat list of configured classification tags with counts.
 */
export function LeagueTree({
  tags,
  selectedTag,
  inPlayMode,
  livePlayCount,
  onSelectInPlay,
  onSelectTag,
}: LeagueTreeProps) {
  return (
    <div className="p-2">
      <p className="px-2 py-2 font-mono text-[10px] font-semibold tracking-[0.2em] text-tm-tx-mut">
        联赛
      </p>
      <button
        onClick={onSelectInPlay}
        className={cn(
          'w-full flex items-center justify-between px-2 py-1.5 text-[13px] transition-colors',
          inPlayMode
            ? 'bg-tm-bg-el text-tm-tx border-l-2 border-tm-neg pl-[6px]'
            : livePlayCount === 0
              ? 'text-tm-tx-mut hover:text-tm-tx-dim hover:bg-tm-bg-el/60'
              : 'text-tm-tx-dim hover:text-tm-tx hover:bg-tm-bg-el/60',
        )}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full shrink-0',
              livePlayCount > 0 ? 'bg-tm-neg animate-pulse' : 'bg-tm-bd',
            )}
          />
          <span className="truncate">进行中</span>
        </span>
        <span className="font-mono text-[10px] text-tm-tx-mut ml-2 shrink-0">{livePlayCount}</span>
      </button>
      {tags.map(({ tag, label, count }) => (
        <button
          key={tag}
          onClick={() => onSelectTag(tag)}
          className={cn(
            'w-full flex items-center justify-between px-2 py-1.5 mt-0.5 text-[13px] transition-colors',
            !inPlayMode && selectedTag === tag
              ? 'bg-tm-bg-el text-tm-tx border-l-2 border-tm-sx pl-[6px]'
              : 'text-tm-tx-dim hover:text-tm-tx hover:bg-tm-bg-el/60',
          )}
        >
          <span className="truncate text-left font-medium">{label}</span>
          <span className="font-mono text-[10px] text-tm-tx-mut ml-2 shrink-0">{count}</span>
        </button>
      ))}
    </div>
  );
}
