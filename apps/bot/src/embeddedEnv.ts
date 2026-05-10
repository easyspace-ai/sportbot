/**
 * Built-in defaults for all bot configuration (replaces `.env` / `~/.polybot/.env`).
 * Edit values here for your machine; `process.env` still overrides when set (e.g. CI, tests).
 *
 * Do not commit production secrets if this repository is shared.
 */

export const EMBEDDED_ENV: Partial<Record<string, string>> = {
  NODE_ENV: 'development',
  PORT: '7633',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'file:./prisma/dev.db',
 
  SX_BET_API_URL: 'https://api.sx.bet',
  /** Required for SX REST + Centrifugo — replace with your real API key. */
  SX_BET_API_KEY: '7b7f3ec6-b5d8-4c78-951b-d6f06e1388a7',
  SX_BET_WS_URL: 'wss://realtime.sx.bet/connection/websocket',

 

  POLYMARKET_API_URL: 'https://clob.polymarket.com',
 
  SX_PRIVATE_KEY: '0x' + '0'.repeat(64),
  POLYGON_RPC_URL: 'https://polygon-rpc.com',
  SX_NETWORK_RPC_URL: 'https://rpc-rollup.sx.technology'

 };

/** Apply embedded defaults for any env key that is missing or empty. */
export function applyEmbeddedEnvDefaults(): void {
  for (const [k, v] of Object.entries(EMBEDDED_ENV)) {
    const cur = process.env[k];
    if ((cur === undefined || cur === '') && v !== '') {
      process.env[k] = v;
    }
  }
}
