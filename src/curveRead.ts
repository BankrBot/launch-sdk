import { encodePacked, keccak256, type Hex } from "viem";
import {
  BUILT_IN_CURVES,
  CURVE_MAX_BANDS,
  CURVE_NAMES,
  curveWordHex,
  encodeCurve,
  type CurveBand,
  type CurveId,
  type LaunchCurve,
} from "./curve.js";
import { MAX_USABLE_TICK } from "./economics.js";
import { sqrtPriceX96AtTick } from "./tickMath.js";

// A launched token's curve from the chain's state: the locker holds each launch band as its own position, for good
// (it has no remove path, and the hook's compounds land in positions of their own).

/** `BankrLaunchLocker.positionsOf(poolId)`; the locker's ABI is not vendored. Held equal to core's locker ABI entry. */
export const LOCKER_POSITIONS_FRAGMENT = [
  {
    type: "function",
    name: "positionsOf",
    inputs: [{ name: "poolId", type: "bytes32", internalType: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        internalType: "struct LockedPosition[]",
        components: [
          { name: "lower", type: "int24", internalType: "int24" },
          { name: "upper", type: "int24", internalType: "int24" },
          { name: "salt", type: "bytes32", internalType: "bytes32" },
          { name: "liquidity", type: "uint128", internalType: "uint128" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

/** One of the locker's positions. */
export interface LockedPosition {
  lower: number;
  upper: number;
  salt: Hex;
  liquidity: bigint;
}

const Q96 = 1n << 96n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** The locker's salt for a launch's band `i`: keccak256(abi.encodePacked("launch", i)). */
export const launchBandSalt = (i: number): Hex =>
  keccak256(encodePacked(["string", "uint256"], ["launch", BigInt(i)]));

/** The TOKEN a one-sided position holds, rounded up as the pool took it at the mint. */
function positionAmount(p: LockedPosition, tokenIsCurrency0: boolean): bigint {
  const [lo, hi] = [sqrtPriceX96AtTick(p.lower), sqrtPriceX96AtTick(p.upper)];
  return tokenIsCurrency0
    ? ceilDiv(ceilDiv((p.liquidity << 96n) * (hi - lo), hi), lo)
    : ceilDiv(p.liquidity * (hi - lo), Q96);
}

/** Each amount's share of the total in whole bps; the largest carries what rounding leaves, so they add up to 10,000. */
function sharesOf(amounts: readonly bigint[]): number[] {
  const total = amounts.reduce((s, a) => s + a, 0n);
  if (total === 0n) return amounts.map(() => 0);
  const bps = amounts.map((a) => Number((a * 10_000n + total / 2n) / total));
  const top = bps.indexOf(Math.max(...bps));
  bps[top]! += 10_000 - bps.reduce((s, b) => s + b, 0);
  return bps;
}

const sameBands = (a: readonly CurveBand[], b: readonly CurveBand[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.widthTicks === b[i]!.widthTicks && x.shareBps === b[i]!.shareBps,
  );

/**
 * A launch's curve from the locker's positions for its pool: its bands in order, each with its share of the sale
 * (rounding at the mint left far under a basis point, so shares read back exactly). Bands equal to a built-in
 * curve's read as that built-in: the pool is the same, and only the launch's receipt tells the two apart.
 */
export function launchCurveFromPositions(
  positions: readonly LockedPosition[],
  tokenIsCurrency0: boolean,
): LaunchCurve {
  const launch: LockedPosition[] = [];
  for (let i = 0; i < CURVE_MAX_BANDS; i += 1) {
    const salt = launchBandSalt(i);
    const at = positions.find((p) => p.salt.toLowerCase() === salt);
    if (!at) break;
    launch.push(at);
  }
  const shares = sharesOf(
    launch.map((p) => positionAmount(p, tokenIsCurrency0)),
  );
  const bands = launch.map((p, i) => {
    const far = tokenIsCurrency0 ? p.upper : -p.lower;
    const open = i + 1 === launch.length && far === MAX_USABLE_TICK;
    return {
      widthTicks: open ? 0 : p.upper - p.lower,
      shareBps: shares[i]!,
      tickLower: p.lower,
      tickUpper: p.upper,
    };
  });
  const first = launch[0];
  const startTick = first ? (tokenIsCurrency0 ? first.lower : -first.upper) : 0;
  const curveId =
    ([0, 1, 2] as const).find((id) => sameBands(BUILT_IN_CURVES[id], bands)) ??
    null;
  const word = curveId === null ? encodeCurve(bands) : null;
  return {
    curveId: curveId as CurveId | null,
    name: curveId === null ? null : CURVE_NAMES[curveId],
    curveTable: word === null ? null : curveWordHex(word),
    startTick,
    bands,
  };
}
