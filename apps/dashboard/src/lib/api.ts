export interface MarketOutcome {
  id: string;
  label: string;
  platform: string;
  externalId?: string;
  impliedOdds: number;
  availableSize: number;
  lastUpdated: string;
  canonicalKey?: string | null;
}

export interface FixturePeriod {
  label: string;
  isFinished: boolean;
  teamOneScore: string;
  teamTwoScore: string;
}

export interface FixtureState {
  sxEventId: string;
  status: number;
  teamOneScore: number;
  teamTwoScore: number;
  currentPeriod: string;
  periodTime: string;
  periods: FixturePeriod[];
  updatedAt: number;
}

export interface Market {
  id: string;
  platform: string;
  externalId: string;
  sport: string;
  league: string;
  name: string;
  startTime: string;
  status: string;
  betType?: string;
  line?: number | null;
  mainLine?: boolean;
  sxEventId?: string | null;
  fixtureState?: FixtureState | null;
  outcomes: MarketOutcome[];
}

export interface Allocation {
  platform: string;
  outcomeId: string;
  externalMarketId: string;
  externalOutcomeId: string;
  size: number;
  expectedOdds: number;
  estimatedSlippage: number;
}

export interface AllocationPlan {
  allocations: Allocation[];
  totalSize: number;
  weightedOdds: number;
  totalSlippage: number;
}

export interface TradeResult {
  tradeId: string;
  status: string;
  platform: string;
  txHash?: string;
}

export interface TradeResponse {
  status: string;
  trades: TradeResult[];
  plan: AllocationPlan;
}

export interface Trade {
  id: string;
  createdAt: string;
  marketName: string;
  outcomeLabel: string;
  platform: string;
  side: string;
  requestedSize: number;
  executedSize: number | null;
  requestedOdds: number;
  fillOdds: number | null;
  status: string;
  txHash: string | null;
  failureReason: string | null;
}

export interface TradesResponse {
  total: number;
  page: number;
  limit: number;
  trades: Trade[];
}

export interface OrderBookLevel {
  odds: number;
  size: number;
  platform: 'sx' | 'polymarket';
}

export interface OrderBookResponse {
  levels: OrderBookLevel[];
  sxMarketHash?: string;
  sxSide?: 0 | 1;
  polyTokenId?: string;
}

export interface ConfigRow {
  key: string;
  value: string;
}

export interface PolymarketAccountBalanceRow {
  id: string;
  name: string;
  isActive: boolean;
  polymarket: number | null;
}

export interface BalanceSummary {
  polymarket: number | null;
  polymarketAccounts: PolymarketAccountBalanceRow[];
}

export interface PolymarketAccountListItem {
  id: string;
  name: string;
  funderAddress: string;
  isActive: boolean;
  createdAt: string;
}

export interface PolymarketAccountCreateBody {
  name: string;
  /** Owner EOA private key; server derives CLOB API key + CREATE2 funder (POLY_1271). */
  privateKey: string;
}

const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as { message?: string; error?: string }).message
      || (body as { error?: string }).error
      || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const getMarkets = () => apiFetch<Market[]>('/api/markets');

export const getOrderBook = (outcomeId: string) =>
  apiFetch<OrderBookResponse>(`/api/trade/orderbook?outcomeId=${encodeURIComponent(outcomeId)}`);

export const getTradePreview = (outcomeId: string, side: string, size: number) =>
  apiFetch<AllocationPlan>(`/api/trade/preview?outcomeId=${encodeURIComponent(outcomeId)}&side=${encodeURIComponent(side)}&size=${size}`);

export const postTrade = (outcomeId: string, side: string, size: number) =>
  apiFetch<TradeResponse>('/api/trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcomeId, side, size }),
  });

export const getTrades = (page = 1, limit = 20) =>
  apiFetch<TradesResponse>(`/api/trades?page=${page}&limit=${limit}`);

export const getConfig = () => apiFetch<ConfigRow[]>('/api/config');

export const getBalances = () => apiFetch<BalanceSummary>('/api/balances');

export const listPolymarketAccounts = () => apiFetch<PolymarketAccountListItem[]>('/api/polymarket/accounts');

export const createPolymarketAccount = (body: PolymarketAccountCreateBody) =>
  apiFetch<{ id: string; name: string; funderAddress: string; isActive: boolean }>('/api/polymarket/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const activatePolymarketAccount = (id: string) =>
  apiFetch<{ ok: boolean; id: string }>(`/api/polymarket/accounts/${encodeURIComponent(id)}/activate`, {
    method: 'PATCH',
  });

export const deletePolymarketAccount = async (id: string): Promise<void> => {
  const res = await fetch(`${BASE}/api/polymarket/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as { message?: string; error?: string }).message
      || (body as { error?: string }).error
      || `HTTP ${res.status}`;
    throw new Error(msg);
  }
};

export interface BestOddsCount {
  sx: number;
  poly: number;
  total: number;
}

export interface WinnerEdgeDepth {
  venue: 'sx' | 'poly';
  avgSize: number;
  sampleCount: number;
}

export interface MarketStatsResponse {
  bestOddsMatched24h: BestOddsCount;
  bestOddsAllMatched24h: BestOddsCount;
  edgeMatched24h: WinnerEdgeDepth | null;
  edgeAllMatched24h: WinnerEdgeDepth | null;
}

export const getMarketStats = () => apiFetch<MarketStatsResponse>('/api/stats/markets');

export interface RiskPositionRow {
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
  /** bot = 本系统路由成交；polymarket_clob = CLOB 用户通道 / REST 同步 */
  source?: string;
}

export interface RiskPositionsMeta {
  userWsConnected: boolean;
  userWsConnecting?: boolean;
  userWsLastMessageAt: string | null;
  restTradesSyncLastAt: string | null;
  /** Bot-reported last WS/credentials issue. */
  userWsLastIssue?: string | null;
  minOpenRiskShares?: number;
}

export interface RiskTaskRow {
  id: string;
  type: string;
  positionId: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  nextRunAt: string;
  updatedAt: string;
}

export const getRiskPositions = () =>
  apiFetch<{ positions: RiskPositionRow[]; meta?: RiskPositionsMeta }>('/api/risk/positions');

export const getRiskTasks = (limit = 40) =>
  apiFetch<{ tasks: RiskTaskRow[] }>(`/api/risk/tasks?limit=${limit}`);

export const postRiskClosePosition = (id: string) =>
  apiFetch<{ ok: boolean; positionId: string }>(
    `/api/risk/positions/${encodeURIComponent(id)}/close`,
    { method: 'POST' },
  );

export const postRiskCloseAll = () =>
  apiFetch<{ ok: boolean }>('/api/risk/close-all', { method: 'POST' });

export const putConfig = (key: string, value: string) =>
  apiFetch<ConfigRow>(`/api/config/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
