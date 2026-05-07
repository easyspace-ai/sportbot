import { ClobClient, Chain, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { fetch as undiciFetch } from 'undici';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { config } from '../config';
import { prisma } from '../db';
import { getPlatformProxyDispatcher, installAxiosProxyForPolymarket } from '../proxySupport';
import { createLogger } from '../logger';

const log = createLogger('polymarketTrading');

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
  if (funder === signerAddr) {
    log.warn(
      { funderAddress: funder, signerAddress: signerAddr },
      'funderAddress equals signer address — this usually means the deposit wallet is not configured correctly. Polymarket requires funderAddress to be the Gnosis Safe deposit wallet, not the signing EOA.',
    );
  } else {
    log.info(
      { funderAddress: funder, signerAddress: signerAddr },
      'Polymarket ClobClient initialized',
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
    signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
    funderAddress: creds.funderAddress,
    /** Without this, failed HTTP calls return `{ error }` and helpers like getTickSize assume success → `.toString()` on undefined. */
    throwOnError: true,
    retryOnError: true,
  });
}

/**
 * Resolves credentials for Polymarket CLOB: active DB account, else complete `POLYMARKET_*` env.
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

  const {
    POLYMARKET_API_KEY,
    POLYMARKET_SECRET,
    POLYMARKET_PASSPHRASE,
    POLYMARKET_PRIVATE_KEY,
    POLYMARKET_FUNDER_ADDRESS,
  } = config;

  if (
    !POLYMARKET_API_KEY
    || !POLYMARKET_SECRET
    || !POLYMARKET_PASSPHRASE
    || !POLYMARKET_PRIVATE_KEY
    || !POLYMARKET_FUNDER_ADDRESS
  ) {
    throw new Error(
      'Polymarket 未配置：请在「账号」页添加并激活一个 Polymarket 账号，或在环境中填写完整的 POLYMARKET_* 变量。',
    );
  }

  return {
    apiKey: POLYMARKET_API_KEY,
    secret: POLYMARKET_SECRET,
    passphrase: POLYMARKET_PASSPHRASE,
    privateKey: POLYMARKET_PRIVATE_KEY,
    funderAddress: POLYMARKET_FUNDER_ADDRESS,
    source: 'env',
  };
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
}
