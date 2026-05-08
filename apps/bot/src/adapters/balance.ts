import { Contract, FetchRequest, JsonRpcProvider } from 'ethers';
import { config } from '../config';
import { prisma } from '../db';
import { createLogger } from '../logger';
import { getPlatformHttpsProxyAgent } from '../proxySupport';
import { fetchPolymarketCollateralBalance } from '../services/polymarketTrading';

const log = createLogger('balance');

const ERC20_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)'];

const POLYMARKET_PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const USDC_DECIMALS = 6;
const DIVISOR = 10 ** USDC_DECIMALS;

export interface PolymarketAccountBalanceRow {
  id: string;
  name: string;
  isActive: boolean;
  polymarket: number | null;
}

export interface BalanceSummary {
  /** Active DB account pUSD, else env `POLYMARKET_FUNDER_ADDRESS` if set. */
  polymarket: number | null;
  polymarketAccounts: PolymarketAccountBalanceRow[];
}

function jsonRpcProviderForUrl(rpcUrl: string): JsonRpcProvider {
  const agent = getPlatformHttpsProxyAgent();
  if (!agent) {
    return new JsonRpcProvider(rpcUrl);
  }
  const conn = new FetchRequest(rpcUrl);
  conn.getUrlFunc = FetchRequest.createGetUrlFunc({ agent });
  return new JsonRpcProvider(conn);
}

async function readErc20Balance(
  rpcUrl: string,
  token: string,
  owner: string,
): Promise<number> {
  const provider = jsonRpcProviderForUrl(rpcUrl);
  const contract = new Contract(token, ERC20_BALANCE_ABI, provider);
  const raw: bigint = await contract.balanceOf(owner);
  return Number(raw) / DIVISOR;
}

async function readPolyPusd(funder: string): Promise<number> {
  return readErc20Balance(config.POLYGON_RPC_URL, POLYMARKET_PUSD, funder);
}

async function readPolymarketAccountUsd(a: {
  id: string;
  apiKey: string;
  secret: string;
  passphrase: string;
  privateKey: string;
  funderAddress: string;
}): Promise<number | null> {
  try {
    return await fetchPolymarketCollateralBalance({
      apiKey: a.apiKey,
      secret: a.secret,
      passphrase: a.passphrase,
      privateKey: a.privateKey,
      funderAddress: a.funderAddress,
    });
  } catch (err) {
    log.warn({ err, accountId: a.id }, 'polymarket CLOB collateral balance failed, trying on-chain pUSD');
    try {
      return await readPolyPusd(a.funderAddress);
    } catch (err2) {
      log.error({ err: err2, accountId: a.id }, 'polymarket account balance failed');
      return null;
    }
  }
}

export async function fetchBalances(): Promise<BalanceSummary> {
  const accounts = await prisma.polymarketAccount.findMany({ orderBy: { createdAt: 'asc' } });

  const polymarketAccounts: PolymarketAccountBalanceRow[] = await Promise.all(
    accounts.map(async (a) => {
      const polymarket = await readPolymarketAccountUsd(a);
      return {
        id: a.id,
        name: a.name,
        isActive: a.isActive,
        polymarket,
      };
    }),
  );

  let polymarket: number | null = null;
  const activeRow = polymarketAccounts.find((r) => r.isActive);
  if (activeRow) {
    polymarket = activeRow.polymarket;
  } else if (config.POLYMARKET_FUNDER_ADDRESS) {
    try {
      polymarket = await readPolyPusd(config.POLYMARKET_FUNDER_ADDRESS);
    } catch (err) {
      log.error({ err }, 'polymarket env funder RPC failed');
    }
  }

  return { polymarket, polymarketAccounts };
}
