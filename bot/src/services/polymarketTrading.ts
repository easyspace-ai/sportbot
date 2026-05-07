import { AssetType, ClobClient, Chain, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { fetch as undiciFetch } from 'undici';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { config } from '../config';
import { prisma } from '../db';
import { getPlatformProxyDispatcher, installAxiosProxyForPolymarket } from '../proxySupport';
import { createLogger } from '../logger';
import { derivePolymarketDepositWalletAddress } from './polymarketDepositWallet';
import { provisionPolymarketFromPrivateKey } from './polymarketProvision';

const log = createLogger('polymarketTrading');

/**
 * Polymarket CLOB V2 **only** (`POLY_1271` / signature type 3), matching
 * `polymarket-clob-v2-go-exmaple`: EOA private key signs; **funder** = deterministic
 * `derivePolymarketDepositWalletAddress(EOA)` (CREATE2; UI 上常与「代理/交易钱包」为同一地址).
 */

export interface PolymarketTradingCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
  privateKey: string;
  funderAddress: string;
  source: 'database' | 'env';
  accountId?: string;
}

const clientCache = new Map<string, ClobClient>();

/** In-memory L2 creds derived from env `POLYMARKET_PRIVATE_KEY` when API fields omitted. */
let envProvisioned: PolymarketTradingCredentials | null = null;
let envProvisionInFlight: Promise<PolymarketTradingCredentials> | null = null;

function normalizePrivateKey(pk: string): `0x${string}` {
  const hex = pk.startsWith('0x') ? pk : `0x${pk}`;
  return hex as `0x${string}`;
}

function buildClobClient(creds: PolymarketTradingCredentials): ClobClient {
  installAxiosProxyForPolymarket();

  const dispatcher = getPlatformProxyDispatcher();
  const transport = dispatcher
    ? http(config.POLYGON_RPC_URL, {
        fetchFn: (input, init) =>
          undiciFetch(input as string | URL, {
            ...(init ?? {}),
            dispatcher,
          } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>,
      })
    : http(config.POLYGON_RPC_URL);

  const account = privateKeyToAccount(normalizePrivateKey(creds.privateKey));
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport,
  });

  const funder = creds.funderAddress.toLowerCase();
  const signerAddr = account.address.toLowerCase();
  const derived = derivePolymarketDepositWalletAddress(account.address).toLowerCase();
  if (funder !== derived) {
    log.warn(
      { funderAddress: funder, derivedDepositWallet: derived, signerAddress: signerAddr },
      'funderAddress differs from CREATE2-derived deposit wallet — orders may fail if this is intentional',
    );
  } else {
    log.info(
      { funderAddress: funder, signerAddress: signerAddr },
      'Polymarket ClobClient initialized (POLY_1271)',
    );
  }

  return new ClobClient({
    host: config.POLYMARKET_API_URL,
    chain: Chain.POLYGON,
    signer,
    creds: {
      key: creds.apiKey,
      secret: creds.secret,
      passphrase: creds.passphrase,
    },
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: creds.funderAddress,
    /** Without this, failed HTTP calls return `{ error }` and helpers like getTickSize assume success → `.toString()` on undefined. */
    throwOnError: true,
    retryOnError: true,
  });
}

export type PolymarketClobBalanceCreds = Pick<
  PolymarketTradingCredentials,
  'apiKey' | 'secret' | 'passphrase' | 'privateKey' | 'funderAddress'
>;

/**
 * CLOB-reported collateral for this signer + funder (same view as Polymarket Wallet / trading).
 */
export async function fetchPolymarketCollateralBalance(
  creds: PolymarketClobBalanceCreds,
): Promise<number> {
  const client = buildClobClient({
    ...creds,
    source: 'database',
  });
  const res = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const n = parseFloat(String(res.balance));
  if (!Number.isFinite(n)) {
    throw new Error('invalid_clob_collateral_balance');
  }
  return n;
}

/**
 * Resolves credentials: active DB Polymarket account, else env.
 * Env may supply only `POLYMARKET_PRIVATE_KEY` — API key + funder are derived once per process.
 */
export async function resolvePolymarketTradingCredentials(): Promise<PolymarketTradingCredentials> {
  const active = await prisma.polymarketAccount.findFirst({ where: { isActive: true } });
  if (active) {
    return {
      apiKey: active.apiKey,
      secret: active.secret,
      passphrase: active.passphrase,
      privateKey: active.privateKey,
      funderAddress: active.funderAddress,
      source: 'database',
      accountId: active.id,
    };
  }

  const pk = config.POLYMARKET_PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      'Polymarket 未配置：请在「账号」页添加并激活一个 Polymarket 账号，或在环境中设置 POLYMARKET_PRIVATE_KEY。',
    );
  }

  const {
    POLYMARKET_API_KEY,
    POLYMARKET_SECRET,
    POLYMARKET_PASSPHRASE,
    POLYMARKET_FUNDER_ADDRESS,
  } = config;

  const hasL2Creds = POLYMARKET_API_KEY && POLYMARKET_SECRET && POLYMARKET_PASSPHRASE;

  if (hasL2Creds && POLYMARKET_FUNDER_ADDRESS) {
    return {
      apiKey: POLYMARKET_API_KEY,
      secret: POLYMARKET_SECRET,
      passphrase: POLYMARKET_PASSPHRASE,
      privateKey: pk,
      funderAddress: POLYMARKET_FUNDER_ADDRESS,
      source: 'env',
    };
  }

  if (hasL2Creds) {
    const account = privateKeyToAccount(normalizePrivateKey(pk));
    return {
      apiKey: POLYMARKET_API_KEY,
      secret: POLYMARKET_SECRET,
      passphrase: POLYMARKET_PASSPHRASE,
      privateKey: pk,
      funderAddress: derivePolymarketDepositWalletAddress(account.address),
      source: 'env',
    };
  }

  if (envProvisioned) {
    return envProvisioned;
  }
  if (envProvisionInFlight) {
    return envProvisionInFlight;
  }

  envProvisionInFlight = (async () => {
    try {
      const p = await provisionPolymarketFromPrivateKey(pk);
      const row: PolymarketTradingCredentials = {
        apiKey: p.apiKey,
        secret: p.secret,
        passphrase: p.passphrase,
        privateKey: pk,
        funderAddress: p.funderAddress,
        source: 'env',
      };
      envProvisioned = row;
      return row;
    } finally {
      envProvisionInFlight = null;
    }
  })();

  return envProvisionInFlight;
}

export async function getPolymarketClobClient(): Promise<ClobClient> {
  const creds = await resolvePolymarketTradingCredentials();
  const cacheKey = creds.accountId ?? 'env';
  const existing = clientCache.get(cacheKey);
  if (existing) return existing;
  const client = buildClobClient(creds);
  clientCache.set(cacheKey, client);
  return client;
}

/** Call after create/update/delete/activate so the next trade picks up new keys. */
export function invalidatePolymarketClientCache(accountId?: string): void {
  if (accountId) clientCache.delete(accountId);
  else clientCache.clear();
  envProvisioned = null;
  envProvisionInFlight = null;
}
