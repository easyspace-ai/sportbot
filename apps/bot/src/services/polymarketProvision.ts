import { ClobClient, Chain, type ApiKeyCreds } from '@polymarket/clob-client-v2';
import { fetch as undiciFetch } from 'undici';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { config } from '../config';
import { getPlatformProxyDispatcher, installAxiosProxyForPolymarket } from '../proxySupport';
import { derivePolymarketDepositWalletAddress } from './polymarketDepositWallet';

function normalizePrivateKey(pk: string): `0x${string}` {
  const hex = pk.startsWith('0x') ? pk : `0x${pk}`;
  return hex as `0x${string}`;
}

function isCompleteApiCreds(c: ApiKeyCreds): boolean {
  return Boolean(c.key?.trim() && c.secret?.trim() && c.passphrase?.trim());
}

/**
 * Polymarket / Go example order: **derive** (GET) first for wallets that already have a key,
 * then **create** (POST). The SDK's `createOrDeriveApiKey` does the reverse and triggers
 * `400 Could not create api key` when a key already exists.
 */
async function deriveThenCreateApiKey(client: ClobClient): Promise<ApiKeyCreds> {
  try {
    const d = await client.deriveApiKey();
    if (isCompleteApiCreds(d)) return d;
  } catch {
    // no key yet or transient error — try create
  }

  try {
    const c = await client.createApiKey();
    if (isCompleteApiCreds(c)) return c;
  } catch (err) {
    // "Could not create api key" (400) when key already exists — derive again
    try {
      const d = await client.deriveApiKey();
      if (isCompleteApiCreds(d)) return d;
    } catch {
      /* fall through */
    }
    throw err;
  }

  throw new Error('polymarket_api_key_incomplete');
}

/**
 * Derive Polymarket V2 deposit-wallet address + CLOB L2 API credentials from the owner EOA private key only.
 * L1 flow matches `polymarket-clob-v2-go-exmaple` (derive-api-key before api-key).
 */
export async function provisionPolymarketFromPrivateKey(privateKey: string): Promise<{
  funderAddress: string;
  signerAddress: string;
  apiKey: string;
  secret: string;
  passphrase: string;
}> {
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

  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport,
  });

  const l1Client = new ClobClient({
    host: config.POLYMARKET_API_URL,
    chain: Chain.POLYGON,
    signer,
    throwOnError: true,
    retryOnError: true,
  });

  const creds = await deriveThenCreateApiKey(l1Client);
  if (!isCompleteApiCreds(creds)) {
    throw new Error('polymarket_api_key_incomplete');
  }

  const funderAddress = derivePolymarketDepositWalletAddress(account.address);

  return {
    funderAddress,
    signerAddress: account.address,
    apiKey: creds.key,
    secret: creds.secret,
    passphrase: creds.passphrase,
  };
}
