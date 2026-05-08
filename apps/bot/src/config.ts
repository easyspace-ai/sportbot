import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const readOnlyMode = process.env.READ_ONLY_MODE === 'true';

const requiredUnlessReadOnly = (msg: string) =>
  readOnlyMode ? z.string().optional() : z.string().min(1, msg);

/** Empty / whitespace → undefined so Polymarket can be configured via DB accounts only. */
const optStr = z.preprocess((val) => {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  return s === '' ? undefined : s;
}, z.string().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  READ_ONLY_MODE: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  PORT: z.string().default('3001'),
  /**
   * HTTP listen address. Default `127.0.0.1` so the API is not reachable from the LAN.
   * Use `0.0.0.0` in Docker or when remote machines must connect (use firewall accordingly).
   */
  HOST: z.preprocess((val) => {
    if (val === undefined || val === null || String(val).trim() === '') return '127.0.0.1';
    return String(val).trim();
  }, z.string().min(1)),
  /** Comma-separated browser origins allowed by CORS (dashboard dev server, etc.). */
  CORS_ORIGINS: z.string().optional(),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_AUTHORIZED_CHAT_ID: z.string().optional(),
  SX_BET_API_URL: z.string().url().default('https://api.sx.bet'),
  SX_BET_API_KEY: z.string().min(1, 'SX_BET_API_KEY is required for real-time Centrifugo connection'),
  SX_BET_WS_URL: z.string().url().default('wss://realtime.sx.bet/connection/websocket'),
  POLYMARKET_API_URL: z.string().url().default('https://clob.polymarket.com'),
  POLYMARKET_FUNDER_ADDRESS: optStr,
  POLYMARKET_API_KEY: optStr,
  POLYMARKET_SECRET: optStr,
  POLYMARKET_PASSPHRASE: optStr,
  POLYMARKET_PRIVATE_KEY: optStr,
  /** Optional: SX Bet order signing; fixture/orderbook uses SX_BET_API_KEY. */
  SX_PRIVATE_KEY: optStr,
  POLYGON_RPC_URL: z.string().url().default('https://polygon-rpc.com'),
  SX_NETWORK_RPC_URL: z.string().url().default('https://rpc-rollup.sx.technology'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_PORT: z.string().optional(),
  /** Optional HTTP(S) proxy for SX Bet + Polymarket REST (and other platformFetch callers). */
  HTTP_PLATFORM_PROXY_URL: z.preprocess(
    (val) => {
      if (val === undefined || val === '') return undefined;
      if (typeof val === 'string' && val.trim() === '') return undefined;
      return typeof val === 'string' ? val.trim() : val;
    },
    z.string().url().optional(),
  ),
  /**
   * When true, TLS to the **origin** (e.g. clob.polymarket.com) after CONNECT uses `rejectUnauthorized: false`.
   * Only for broken / MITM proxies — weakens security.
   */
  HTTP_PLATFORM_PROXY_TLS_INSECURE: z.preprocess((val) => {
    if (val === undefined || val === null || String(val).trim() === '') return false;
    const s = String(val).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }, z.boolean()),
  /** CONNECT + axios request timeout (ms). Default 120000. */
  HTTP_PLATFORM_PROXY_TIMEOUT_MS: z.preprocess((val) => {
    if (val === undefined || val === null || String(val).trim() === '') return undefined;
    const n = Number(String(val).trim());
    return Number.isFinite(n) ? n : undefined;
  }, z.number().int().min(5000).max(600_000).optional()),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`[config] Missing or invalid environment variables:\n${missing}`);
  process.exit(1);
}

const defaultCorsOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function buildCorsAllowedOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [...defaultCorsOrigins];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : [...defaultCorsOrigins];
}

const baseConfig = parsed.data;

export const config = {
  ...baseConfig,
  corsAllowedOrigins: buildCorsAllowedOrigins(baseConfig.CORS_ORIGINS),
};

if (config.HTTP_PLATFORM_PROXY_TLS_INSECURE) {
  console.warn(
    '[config] HTTP_PLATFORM_PROXY_TLS_INSECURE=true: TLS certificate verification to platform origins is disabled when using HTTP_PLATFORM_PROXY_URL (MITM risk if the proxy is untrusted).',
  );
}
