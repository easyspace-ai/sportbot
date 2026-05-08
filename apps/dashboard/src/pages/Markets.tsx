import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { type Market, type MarketOutcome, getConfig } from '../lib/api';
import {
  DEFAULT_EVENT_CLASSIFICATION_TAGS,
  leagueMatchesEventTag,
  parseEventClassificationTags,
} from '../lib/eventClassification';
import { BetSlip } from '../components/BetSlip';
import { MatchDetail } from './MatchDetail';
import {
  groupMarkets,
  getBestOdds,
  get1X2,
  getSpreadMLTotal,
  isAmericanSport,
  localDateKey,
  formatDateHeader,
  matchGroupKey,
  type MatchGroup,
  type OutcomeRow,
  type BetSlipSelection,
} from '../lib/marketUtils';
import { cn } from '../lib/utils';
import { formatOdds, type OddsFormat } from '../lib/oddsFormat';
import { useOddsFormat } from '../hooks/useOddsFormat';
import { useLiveOdds, liveOddsKey, type LiveOddsMap } from '../hooks/useLiveOdds';
import { useLivePolyOdds, type LivePolyOddsMap } from '../hooks/useLivePolyOdds';
import { useLiveFixtureState } from '../hooks/useLiveFixtureState';
import { useMarketList } from '../hooks/useMarketList';
import { LiveMatchHeader } from '../components/LiveMatchHeader';
import { type FixtureState } from '../lib/wsBus';
import { LeagueTree, type LeagueNavTag } from '../components/LeagueTree';
import { BottomSheet } from '../components/BottomSheet';
import { VenueLogo } from '../components/VenueLogo';
import { OddsLegend } from '../components/OddsLegend';

const IN_PLAY_STATUS = 2;

function isLive(s: FixtureState | undefined): s is FixtureState {
  return !!s && s.status === IN_PLAY_STATUS;
}

// ─── Odds cell primitives ─────────────────────────────────────────────────────

const DIAG_HASH = '0xc846423fee394c7b17508d3b253e1d681fddcf5666007f2d99e6bf470c5414b0';
// Populated by applyLiveOdds whenever it sees an SX outcome whose externalId starts
// with DIAG_HASH — used by oddsDecimal to log the corresponding render verdict.
const diagLabels = new Set<string>();

function oddsDecimal(outcome: OutcomeRow | null, format: OddsFormat): { decimal: string | null; platform: 'sx' | 'polymarket' | null } {
  if (!outcome) return { decimal: null, platform: null };
  const best = getBestOdds(outcome);
  if (diagLabels.has(outcome.label)) {
    console.log('[DIAG render]', {
      label: outcome.label,
      betType: outcome.betType,
      sx: outcome.sx,
      polymarket: outcome.polymarket,
      bestPlatform: best?.platform,
      bestImplied: best?.impliedOdds,
      formatted: best ? formatOdds(best.impliedOdds, format) : null,
    });
  }
  if (!best || best.impliedOdds <= 0) return { decimal: null, platform: best?.platform ?? null };
  return { decimal: formatOdds(best.impliedOdds, format), platform: best.platform };
}

function OddsCell({
  outcome,
  matchName,
  selection,
  onOddsClick,
  lineLabel,
  lineValue,
  compact = false,
}: {
  outcome: OutcomeRow | null;
  matchName: string;
  selection: BetSlipSelection | null;
  onOddsClick: (id: string, label: string, matchName: string) => void;
  lineLabel?: string;
  lineValue?: string | null;
  // compact: shorter chip for mobile cards (h-11 / 44px) where chips are stacked
  // vertically and need to fit more info per card. Desktop rows omit it and keep
  // h-14. 44px still meets the iOS/Android tap-target minimum.
  compact?: boolean;
}) {
  const [format] = useOddsFormat();
  const { decimal, platform } = oddsDecimal(outcome, format);
  const heightClass = compact ? 'h-11' : 'h-14';
  if (!outcome || !decimal) {
    return (
      <div className={cn(heightClass, 'flex items-center justify-center rounded-[var(--tm-rad)] border border-tm-bd text-tm-tx-mut text-sm')}>
        —
      </div>
    );
  }
  const isSx = platform === 'sx';
  const isSelected = selection?.outcomeId === outcome.outcomeId;
  const venueText = isSx ? 'text-tm-sx' : 'text-tm-poly';
  const venueHover = isSx ? 'hover:bg-tm-sx/10' : 'hover:bg-tm-poly/10';
  const venueSel = isSx
    ? 'bg-tm-sx/15 border-tm-sx ring-1 ring-tm-sx/40'
    : 'bg-tm-poly/15 border-tm-poly ring-1 ring-tm-poly/40';
  // lineValue (when provided, including empty string) takes priority over lineLabel
  // and the venue fallback. This is what the mobile cards use to put e.g. "+1.5"
  // or "3.5" inside the chip above the odds.
  const explicitLabel =
    lineValue !== undefined && lineValue !== null
      ? lineValue
      : (lineLabel ?? null);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOddsClick(outcome.outcomeId, outcome.label, matchName); }}
      className={cn(
        heightClass,
        'flex flex-col items-center justify-center rounded-[var(--tm-rad)] border transition-colors',
        compact ? 'gap-0.5' : 'gap-1',
        isSelected ? venueSel : `bg-tm-bg-el border-tm-bd ${venueHover}`,
      )}
    >
      {explicitLabel !== null ? (
        <span className={cn('font-mono tracking-wider text-tm-tx-mut leading-none', compact ? 'text-[9px]' : 'text-[10px]')}>{explicitLabel}</span>
      ) : (
        <VenueLogo platform={isSx ? 'sx' : 'polymarket'} size={compact ? 13 : 16} />
      )}
      <span className={cn('font-mono font-bold leading-none', compact ? 'text-[14px]' : 'text-[16px]', venueText)}>{decimal}</span>
    </button>
  );
}

// ─── Line-label helpers ───────────────────────────────────────────────────────

function formatKickoff(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: 'numeric', minute: '2-digit' });
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

interface MatchRowProps {
  group: MatchGroup;
  selection: BetSlipSelection | null;
  liveState?: FixtureState;
  onRowClick: (group: MatchGroup) => void;
  onOddsClick: (outcomeId: string, label: string, matchName: string) => void;
}

const SOCCER_GRID_COLS = '1fr 70px 70px 70px 36px';
const SOCCER_GRID_GAP = '6px';

function SoccerMatchRow({ group, selection, liveState, onRowClick, onOddsClick }: MatchRowProps) {
  const { home, draw, away } = get1X2(group);
  const { spreadHome, spreadAway, totalOver, totalUnder, mlHome, mlAway } = getSpreadMLTotal(group);

  const consumed = [home, draw, away, spreadHome, spreadAway, mlHome, mlAway, totalOver, totalUnder].filter(
    Boolean,
  ).length;
  const extraCount = group.outcomes.length - consumed;

  return (
    <div
      className="hidden md:grid items-center px-4 py-2.5 border-b border-tm-bd hover:bg-tm-bg-el/60 cursor-pointer transition-colors"
      style={{ gridTemplateColumns: SOCCER_GRID_COLS, columnGap: SOCCER_GRID_GAP }}
      onClick={() => onRowClick(group)}
    >
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-tm-tx truncate leading-tight">{group.name.split(' vs ')[0]?.trim() ?? group.name}</p>
        <p className="text-[13px] text-tm-tx-dim truncate leading-tight">{group.name.split(' vs ')[1]?.trim() ?? ''}</p>
        {isLive(liveState) ? (
          <LiveMatchHeader state={liveState} />
        ) : (
          <p className="font-mono text-[9px] tracking-wider text-tm-tx-mut mt-1">
            {formatKickoff(group.startTime)}
          </p>
        )}
      </div>
      <OddsCell outcome={home} lineLabel="1" matchName={group.name} selection={selection} onOddsClick={onOddsClick} />
      <OddsCell outcome={draw} lineLabel="X" matchName={group.name} selection={selection} onOddsClick={onOddsClick} />
      <OddsCell outcome={away} lineLabel="2" matchName={group.name} selection={selection} onOddsClick={onOddsClick} />
      <div className="text-right">
        {extraCount > 0 && (
          <span className="font-mono text-[10px] text-tm-tx-mut">+{extraCount}</span>
        )}
      </div>
    </div>
  );
}

const NA_GRID_COLS = '1fr 76px 76px 36px';
const NA_GRID_GAP = '6px';

function NAMatchRow({ group, selection, liveState, onRowClick, onOddsClick }: MatchRowProps) {
  const [team1, team2] = group.name.split(' vs ').map((s) => s.trim());
  const { mlHome, mlAway, spreadHome, spreadAway, totalOver, totalUnder } = getSpreadMLTotal(group);

  const consumed = [spreadHome, spreadAway, mlHome, mlAway, totalOver, totalUnder].filter(Boolean).length;
  const extraCount = group.outcomes.length - consumed;

  return (
    <div
      className="hidden md:grid items-center px-4 py-2.5 border-b border-tm-bd hover:bg-tm-bg-el/60 cursor-pointer transition-colors"
      style={{ gridTemplateColumns: NA_GRID_COLS, columnGap: NA_GRID_GAP }}
      onClick={() => onRowClick(group)}
    >
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-tm-tx truncate leading-tight">{team1 ?? group.name}</p>
        <p className="text-[13px] text-tm-tx-dim truncate leading-tight">{team2 ?? ''}</p>
        {isLive(liveState) ? (
          <LiveMatchHeader state={liveState} />
        ) : (
          <p className="font-mono text-[9px] tracking-wider text-tm-tx-mut mt-1">
            {formatKickoff(group.startTime)}
          </p>
        )}
      </div>
      <OddsCell outcome={mlHome} lineLabel="1" matchName={group.name} selection={selection} onOddsClick={onOddsClick} />
      <OddsCell outcome={mlAway} lineLabel="2" matchName={group.name} selection={selection} onOddsClick={onOddsClick} />
      <div className="text-right">
        {extraCount > 0 && (
          <span className="font-mono text-[10px] text-tm-tx-mut">+{extraCount}</span>
        )}
      </div>
    </div>
  );
}

// ─── Mobile cards ─────────────────────────────────────────────────────────────

function CardMatchHeader({
  group,
  liveState,
  extraCount,
}: {
  group: MatchGroup;
  liveState?: FixtureState;
  extraCount: number;
}) {
  const [team1, team2] = group.name.split(' vs ').map((s) => s.trim());
  return (
    <div className="min-w-0">
      <p className="text-[13px] font-semibold text-tm-tx truncate leading-tight">{team1 ?? group.name}</p>
      <p className="text-[13px] text-tm-tx-dim truncate leading-tight">{team2 ?? ''}</p>
      {isLive(liveState) ? (
        <LiveMatchHeader state={liveState} />
      ) : (
        <p className="font-mono text-[10px] tracking-wider text-tm-tx-mut mt-1">
          {formatKickoff(group.startTime)}
        </p>
      )}
      {extraCount > 0 && (
        <p className="font-mono text-[10px] tracking-wider text-tm-tx-mut mt-0.5">
          +{extraCount} <span aria-hidden="true">›</span>
        </p>
      )}
    </div>
  );
}

function SoccerMatchCard({ group, selection, liveState, onRowClick, onOddsClick }: MatchRowProps) {
  const { home, draw, away } = get1X2(group);
  const { spreadHome, spreadAway, totalOver, totalUnder, mlHome, mlAway } = getSpreadMLTotal(group);

  const consumed = [home, draw, away, spreadHome, spreadAway, mlHome, mlAway, totalOver, totalUnder].filter(
    Boolean,
  ).length;
  const extraCount = group.outcomes.length - consumed;

  return (
    <div
      className="px-3 py-2.5 border-b border-tm-bd hover:bg-tm-bg-el/40 cursor-pointer transition-colors"
      onClick={() => onRowClick(group)}
    >
      <div className="grid grid-cols-[2fr_3fr] gap-2.5 items-start">
        <CardMatchHeader group={group} liveState={liveState} extraCount={extraCount} />

        <div className="flex flex-col gap-1 min-w-0">
          <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-tm-tx-mut text-center truncate">
            独赢 · 1 / X / 2
          </span>
          <div className="grid grid-cols-3 gap-1 items-start">
            <OddsCell compact outcome={home} matchName={group.name} selection={selection} onOddsClick={onOddsClick} lineLabel="1" />
            <OddsCell compact outcome={draw} matchName={group.name} selection={selection} onOddsClick={onOddsClick} lineLabel="X" />
            <OddsCell compact outcome={away} matchName={group.name} selection={selection} onOddsClick={onOddsClick} lineLabel="2" />
          </div>
        </div>
      </div>
    </div>
  );
}

function NAMatchCard({ group, selection, liveState, onRowClick, onOddsClick }: MatchRowProps) {
  const { mlHome, mlAway, spreadHome, spreadAway, totalOver, totalUnder } = getSpreadMLTotal(group);

  const consumed = [spreadHome, spreadAway, mlHome, mlAway, totalOver, totalUnder].filter(Boolean).length;
  const extraCount = group.outcomes.length - consumed;

  return (
    <div
      className="px-3 py-2.5 border-b border-tm-bd hover:bg-tm-bg-el/40 cursor-pointer transition-colors"
      onClick={() => onRowClick(group)}
    >
      <div className="grid grid-cols-[2fr_3fr] gap-2.5 items-start">
        <CardMatchHeader group={group} liveState={liveState} extraCount={extraCount} />

        <div className="flex flex-col gap-1 min-w-0">
          <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-tm-tx-mut text-center truncate">
            独赢
          </span>
          <div className="grid grid-cols-2 gap-1 items-start">
            <OddsCell compact outcome={mlHome} lineLabel="1" matchName={group.name} selection={selection} onOddsClick={onOddsClick} />
            <OddsCell compact outcome={mlAway} lineLabel="2" matchName={group.name} selection={selection} onOddsClick={onOddsClick} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Column-header rows (per league) ──────────────────────────────────────────

function SoccerColHead() {
  return (
    <div
      className="hidden md:grid items-center px-4 py-1.5 border-b border-tm-bd font-mono text-[9px] tracking-[0.18em] text-tm-tx-mut bg-tm-bg"
      style={{ gridTemplateColumns: SOCCER_GRID_COLS, columnGap: SOCCER_GRID_GAP }}
    >
      <span />
      <span className="text-center">1</span>
      <span className="text-center">X</span>
      <span className="text-center">2</span>
      <span />
    </div>
  );
}

function NAColHead() {
  return (
    <div
      className="hidden md:grid items-center px-4 py-1.5 border-b border-tm-bd font-mono text-[9px] tracking-[0.18em] text-tm-tx-mut bg-tm-bg"
      style={{ gridTemplateColumns: NA_GRID_COLS, columnGap: NA_GRID_GAP }}
    >
      <span />
      <span className="text-center" style={{ gridColumn: 'span 2' }}>独赢</span>
      <span />
    </div>
  );
}

// ─── Mobile league dropdown ───────────────────────────────────────────────────

interface LeagueDropdownProps {
  tags: LeagueNavTag[];
  selectedTag: string;
  inPlayMode: boolean;
  livePlayCount: number;
  onSelectInPlay: () => void;
  onSelectTag: (tag: string) => void;
}

function LeagueDropdown({
  tags,
  selectedTag,
  inPlayMode,
  livePlayCount,
  onSelectInPlay,
  onSelectTag,
}: LeagueDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectedLabel = tags.find((t) => t.tag === selectedTag)?.label ?? selectedTag.toUpperCase();

  const triggerLabel = inPlayMode
    ? `进行中（${livePlayCount}）`
    : `${selectedLabel}`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        className="w-full h-11 pl-3 pr-9 flex items-center justify-between rounded-[var(--tm-rad)] border border-tm-bd bg-tm-bg-el text-tm-tx font-mono text-[12px] font-semibold tracking-[0.1em] focus:outline-none focus:border-tm-bd-st"
      >
        <span className="truncate">{triggerLabel}</span>
        <span
          aria-hidden="true"
          className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-tm-tx-mut"
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="选择联赛"
          className="absolute left-0 right-0 z-30 mt-1 max-h-[60vh] overflow-y-auto rounded-[var(--tm-rad)] border border-tm-bd bg-tm-bg-el shadow-lg"
        >
          <button
            type="button"
            role="option"
            aria-selected={inPlayMode}
            onClick={() => { onSelectInPlay(); setOpen(false); }}
            className={cn(
              'w-full px-3 py-2.5 flex items-center justify-between font-mono text-[12px] tracking-[0.1em] border-b border-tm-bd hover:bg-tm-bg-sunk transition-colors',
              inPlayMode ? 'bg-tm-bg-sunk text-tm-tx font-semibold' : 'text-tm-tx',
            )}
          >
            <span className="flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-tm-neg animate-pulse" />
              <span>进行中</span>
            </span>
            <span className="text-tm-tx-mut">({livePlayCount})</span>
          </button>

          {tags.map(({ tag, label, count }) => {
            const isSelected = !inPlayMode && selectedTag === tag;
            return (
              <button
                key={tag}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => { onSelectTag(tag); setOpen(false); }}
                className={cn(
                  'w-full px-3 py-2 flex items-center justify-between font-mono text-[12px] tracking-[0.05em] border-b border-tm-bd/50 last:border-b-0 hover:bg-tm-bg-sunk transition-colors',
                  isSelected ? 'bg-tm-sx/10 text-tm-sx font-semibold' : 'text-tm-tx',
                )}
              >
                <span className="truncate">{label}</span>
                <span className={cn('shrink-0', isSelected ? 'text-tm-sx/70' : 'text-tm-tx-mut')}>({count})</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Top strip ────────────────────────────────────────────────────────────────

function useFetchAge(lastFetch: Date | null): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!lastFetch) return '—';
  const s = Math.floor((Date.now() - lastFetch.getTime()) / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分`;
  return `${Math.floor(s / 3600)} 小时`;
}


function TopStrip({
  title,
  fetchAge,
}: {
  title: string;
  fetchAge: string;
}) {
  return (
    <div className="h-10 shrink-0 flex items-center gap-4 px-4 bg-tm-bg border-b border-tm-bd">
      <span className="font-mono text-[10px] font-semibold tracking-[0.2em] text-tm-tx-dim">{title}</span>
      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm bg-tm-bg-el border border-tm-bd text-tm-tx-dim">
        {fetchAge}
      </span>

      <OddsLegend className="ml-auto" />
    </div>
  );
}

// ─── Live-odds helpers ────────────────────────────────────────────────────────

function applyLiveOdds(
  markets: Market[],
  liveOdds: LiveOddsMap,
  livePolyOdds: LivePolyOddsMap,
): Market[] {
  if (liveOdds.size === 0 && livePolyOdds.size === 0) return markets;
  return markets.map((m) => {
    if (m.platform === 'sx') {
      if (liveOdds.size === 0) return m;
      const liveOutcomes = m.outcomes.map((o: MarketOutcome) => {
        if (!o.externalId) return o;
        const key = liveOddsKey(o.externalId);
        const live = liveOdds.get(key);
        if (o.externalId.startsWith(DIAG_HASH)) {
          diagLabels.add(o.label);
          console.log('[DIAG applyLiveOdds SX]', { label: o.label, externalId: o.externalId, derivedKey: key, liveValue: live, dbValue: o.impliedOdds, liveMapSize: liveOdds.size });
        }
        if (live === undefined) return o;
        return { ...o, impliedOdds: live };
      });
      return { ...m, outcomes: liveOutcomes };
    }
    if (m.platform === 'polymarket') {
      if (livePolyOdds.size === 0) return m;
      const liveOutcomes = m.outcomes.map((o: MarketOutcome) => {
        if (!o.externalId) return o;
        const live = livePolyOdds.get(o.externalId);
        if (diagLabels.has(o.label) && m.betType === '1x2') {
          console.log('[DIAG applyLiveOdds POLY]', { label: o.label, tokenId: o.externalId, liveValue: live, dbValue: o.impliedOdds });
        }
        if (live === undefined) return o;
        return { ...o, impliedOdds: live };
      });
      return { ...m, outcomes: liveOutcomes };
    }
    return m;
  });
}

function collectPolyTokenIds(markets: Market[]): string[] {
  const set = new Set<string>();
  for (const m of markets) {
    if (m.platform !== 'polymarket') continue;
    for (const o of m.outcomes) {
      if (o.externalId) set.add(o.externalId);
    }
  }
  return Array.from(set);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function Markets() {
  const [error] = useState<string | null>(null);
  const [eventTags, setEventTags] = useState<string[]>(() => [...DEFAULT_EVENT_CLASSIFICATION_TAGS]);
  const [selectedLeague, setSelectedLeague] = useState<string>(DEFAULT_EVENT_CLASSIFICATION_TAGS[0] ?? 'nba');
  const [inPlayMode, setInPlayMode] = useState<boolean>(false);
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<BetSlipSelection | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  // Markets state is now WS-driven: bot pushes a marketsSnapshot at WS connect
  // and marketUpsert/marketRemoved deltas thereafter. No periodic REST polling.
  const { markets, loading } = useMarketList();
  const liveOdds = useLiveOdds();

  useEffect(() => {
    getConfig()
      .then((rows) => {
        const raw = rows.find((r) => r.key === 'eventClassificationTags')?.value ?? '';
        setEventTags(parseEventClassificationTags(raw));
      })
      .catch(() => {
        /* keep defaults */
      });
  }, []);

  useEffect(() => {
    if (eventTags.length === 0) return;
    setSelectedLeague((prev) => (eventTags.includes(prev) ? prev : eventTags[0]!));
  }, [eventTags]);
  const polyTokenIds = useMemo(() => collectPolyTokenIds(markets), [markets]);
  const livePolyOdds = useLivePolyOdds(polyTokenIds);
  const liveFixtures = useLiveFixtureState();

  // Bump lastFetch on any market change so the freshness indicator reflects
  // real data flow, not just initial load time. The previous REST-poll model
  // updated this every 30s; under WS deltas, refresh it whenever the markets
  // list mutates (snapshot lands, upsert arrives, or removal happens).
  useEffect(() => {
    setLastFetch(new Date());
  }, [markets]);

  // Esc closes the BetSlip
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && selection) setSelection(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

  const fetchAge = useFetchAge(lastFetch);

  const allGroups = useMemo(
    () => {
      const groups = groupMarkets(applyLiveOdds(markets, liveOdds, livePolyOdds));
      const now = Date.now();
      const minStart = now - 4 * 60 * 60 * 1000;
      const maxStart = now + 7 * 24 * 60 * 60 * 1000;
      return groups.filter((g) => {
        if (g.sxEventId && liveFixtures.removed.has(g.sxEventId)) return false;
        const start = new Date(g.startTime).getTime();
        if (!Number.isFinite(start)) return false;
        return start >= minStart && start <= maxStart;
      });
    },
    [markets, liveOdds, livePolyOdds, liveFixtures.removed],
  );

  const selectedGroup = useMemo(
    () =>
      selectedGroupKey
        ? allGroups.find((g) => matchGroupKey(g.name, g.sport, g.league, g.startTime) === selectedGroupKey) ?? null
        : null,
    [allGroups, selectedGroupKey],
  );

  const selectGroup = useCallback(
    (group: MatchGroup) => setSelectedGroupKey(matchGroupKey(group.name, group.sport, group.league, group.startTime)),
    [],
  );

  const taggedGroups = useMemo(
    () => allGroups.filter((g) => eventTags.some((t) => leagueMatchesEventTag(g.league, t))),
    [allGroups, eventTags],
  );

  const leagueNavTags = useMemo((): LeagueNavTag[] => {
    return eventTags.map((tag) => ({
      tag,
      label: tag.toUpperCase(),
      count: taggedGroups.filter((g) => leagueMatchesEventTag(g.league, tag)).length,
    }));
  }, [eventTags, taggedGroups]);

  const livePlayCount = useMemo(
    () =>
      taggedGroups.reduce((n, g) => {
        if (!g.sxEventId) return n;
        return isLive(liveFixtures.states.get(g.sxEventId)) ? n + 1 : n;
      }, 0),
    [taggedGroups, liveFixtures.states],
  );

  const filteredGroups = useMemo(() => {
    if (inPlayMode) {
      return taggedGroups.filter((g) => g.sxEventId && isLive(liveFixtures.states.get(g.sxEventId)));
    }
    return taggedGroups.filter((g) => leagueMatchesEventTag(g.league, selectedLeague));
  }, [inPlayMode, taggedGroups, liveFixtures.states, selectedLeague]);

  const groupsByDate = useMemo(() => {
    const byDate = new Map<string, MatchGroup[]>();
    for (const g of filteredGroups) {
      const dk = localDateKey(g.startTime);
      if (!byDate.has(dk)) byDate.set(dk, []);
      byDate.get(dk)!.push(g);
    }
    for (const list of byDate.values()) {
      list.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    }
    return byDate;
  }, [filteredGroups]);

  const handleOddsClick = useCallback((outcomeId: string, label: string, matchName: string) => {
    setSelection((prev) => (prev?.outcomeId === outcomeId ? null : { outcomeId, label, matchName }));
  }, []);

  const handleSelectInPlay = useCallback(() => {
    setInPlayMode(true);
    setSelectedGroupKey(null);
  }, []);

  const handleSelectTag = useCallback((tag: string) => {
    setInPlayMode(false);
    setSelectedLeague(tag);
    setSelectedGroupKey(null);
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-tm-tx-dim font-mono text-xs tracking-widest">
        加载市场中…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="rounded-[var(--tm-rad)] border border-tm-neg/40 bg-tm-neg/10 px-4 py-3 font-mono text-xs text-tm-neg">
          {error}
        </div>
      </div>
    );
  }

  const leagueTree = (
    <LeagueTree
      tags={leagueNavTags}
      selectedTag={selectedLeague}
      inPlayMode={inPlayMode}
      livePlayCount={livePlayCount}
      onSelectInPlay={handleSelectInPlay}
      onSelectTag={handleSelectTag}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      {/* Desktop league sidebar (hidden on mobile) */}
      <aside className="hidden md:block w-48 shrink-0 border-r border-tm-bd bg-tm-bg-sunk overflow-y-auto">
        {leagueTree}
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {selectedGroup ? (
          <MatchDetail
            group={selectedGroup}
            selection={selection}
            liveState={selectedGroup.sxEventId ? liveFixtures.states.get(selectedGroup.sxEventId) : undefined}
            onBack={() => setSelectedGroupKey(null)}
            onOddsClick={handleOddsClick}
          />
        ) : (
          <>
            <TopStrip
              title={selection ? '市场 · 投注单已打开' : '市场 · 实时'}
              fetchAge={fetchAge}
            />

            {/* Mobile league dropdown — custom panel themed to match the dark UI
                (native <select> opens an unstyled OS picker on iOS/macOS). */}
            <div className="md:hidden shrink-0 px-3 py-2 bg-tm-bg-sunk border-b border-tm-bd">
              <LeagueDropdown
                tags={leagueNavTags}
                selectedTag={selectedLeague}
                inPlayMode={inPlayMode}
                livePlayCount={livePlayCount}
                onSelectInPlay={handleSelectInPlay}
                onSelectTag={handleSelectTag}
              />
            </div>

            <div className="flex-1 overflow-y-auto">
              {filteredGroups.length === 0 ? (
                <p className="px-4 py-10 font-mono text-xs text-tm-tx-dim">
                  {markets.length === 0
                    ? '暂无市场数据 — 同步任务可能仍在运行。'
                    : inPlayMode
                      ? '当前没有进行中的比赛。'
                      : `暂无「${selectedLeague.toUpperCase()}」相关市场。`}
                </p>
              ) : (
                Array.from(groupsByDate.entries()).map(([dateKey, dateGroups]) => {
                  const allAmerican = dateGroups.length > 0 && dateGroups.every((g) => isAmericanSport(g));
                  return (
                    <div key={dateKey}>
                      {/* Date header */}
                      <div className="sticky top-0 z-20 px-4 py-2 bg-tm-bg border-b border-tm-bd flex items-center gap-2.5">
                        <span className="text-[13px] font-semibold text-tm-tx">
                          {formatDateHeader(dateKey)}
                        </span>
                        <span className="font-mono text-[10px] tracking-wider text-tm-tx-mut">
                          {dateGroups.length} 场
                        </span>
                      </div>

                      {allAmerican ? <NAColHead /> : <SoccerColHead />}
                      {dateGroups.map((group) => {
                        const liveState = group.sxEventId
                          ? liveFixtures.states.get(group.sxEventId)
                          : undefined;
                        const groupKey = matchGroupKey(group.name, group.sport, group.league, group.startTime);
                        const american = isAmericanSport(group);
                        return (
                          <div key={groupKey}>
                            {/* Desktop row (hidden on mobile via the row's own md:grid class) */}
                            {american ? (
                              <NAMatchRow
                                group={group}
                                selection={selection}
                                liveState={liveState}
                                onRowClick={selectGroup}
                                onOddsClick={handleOddsClick}
                              />
                            ) : (
                              <SoccerMatchRow
                                group={group}
                                selection={selection}
                                liveState={liveState}
                                onRowClick={selectGroup}
                                onOddsClick={handleOddsClick}
                              />
                            )}
                            {/* Mobile card */}
                            <div className="md:hidden">
                              {american ? (
                                <NAMatchCard
                                  group={group}
                                  selection={selection}
                                  liveState={liveState}
                                  onRowClick={selectGroup}
                                  onOddsClick={handleOddsClick}
                                />
                              ) : (
                                <SoccerMatchCard
                                  group={group}
                                  selection={selection}
                                  liveState={liveState}
                                  onRowClick={selectGroup}
                                  onOddsClick={handleOddsClick}
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>

      {/* Desktop BetSlip aside (hidden on mobile) */}
      <aside className="hidden md:flex w-80 shrink-0 border-l border-tm-bd bg-tm-bg-sunk overflow-hidden flex-col">
        <BetSlip
          selection={selection}
          onClose={() => setSelection(null)}
          onTradeExecuted={() => { setSelection(null); }}
        />
      </aside>

      {/* Mobile BetSlip bottom sheet */}
      <BottomSheet open={selection !== null} onClose={() => setSelection(null)}>
        <BetSlip
          selection={selection}
          onClose={() => setSelection(null)}
          onTradeExecuted={() => { setSelection(null); }}
        />
      </BottomSheet>
    </div>
  );
}
