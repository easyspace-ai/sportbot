import {
  concat,
  encodeAbiParameters,
  getAddress,
  hexToBytes,
  keccak256,
  pad,
  toHex,
  type Address,
} from 'viem';

/** Polymarket CLOB V2 deposit-wallet factory (Polygon). Same as `polymarket-clob-v2-go-exmaple/main.go`. */
export const POLYMARKET_DEPOSIT_WALLET_FACTORY: Address =
  '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';

const DEPOSIT_WALLET_IMPLEMENTATION: Address =
  '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB';

const INIT_CONST_1 = hexToBytes(
  '0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3',
);
const INIT_CONST_2 = hexToBytes(
  '0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076',
);

/** `common.LeftPadBytes(combined.Bytes(), 10)` from Go `initCodeHashERC1967`. */
function leftPadBytesTo10(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const raw = hexToBytes(`0x${hex}` as `0x${string}`);
  const out = new Uint8Array(10);
  const copyLen = Math.min(10, raw.length);
  out.set(raw.subarray(raw.length - copyLen), 10 - copyLen);
  return out;
}

function initCodeHashErc1967(implementation: Address, args: Uint8Array): `0x${string}` {
  const prefix = BigInt('0x61003D3D8160233D3973');
  const combined = prefix + (BigInt(args.length) << 56n);
  const head = leftPadBytesTo10(combined);
  const implBytes = hexToBytes(implementation);
  const initCode = concat([
    head,
    implBytes,
    new Uint8Array([0x60, 0x09]),
    INIT_CONST_2,
    INIT_CONST_1,
    args,
  ]);
  return keccak256(initCode);
}

/**
 * Deterministic Polymarket V2 **deposit wallet** for an owner EOA.
 * Matches `deriveDepositWallet` in `polymarket-clob-v2-go-exmaple/main.go`.
 */
export function derivePolymarketDepositWalletAddress(ownerEoa: Address): Address {
  const owner = getAddress(ownerEoa);
  const factory = POLYMARKET_DEPOSIT_WALLET_FACTORY;
  /** Right-aligned owner in 32 bytes — same as Go `walletID[12:]=owner`. */
  const walletId = pad(owner, { size: 32 });

  const args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }],
    [factory, walletId],
  );
  const argsBytes = hexToBytes(args);

  const salt = keccak256(argsBytes);
  const bytecodeHash = initCodeHashErc1967(DEPOSIT_WALLET_IMPLEMENTATION, argsBytes);

  const create2Input = concat(['0xff', factory, salt, bytecodeHash]);
  const hash = keccak256(create2Input);
  return getAddress(toHex(hexToBytes(hash).slice(12, 32)));
}
