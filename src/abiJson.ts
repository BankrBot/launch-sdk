import {
  getAddress,
  isAddress,
  isHex,
  type AbiParameter,
  type Hex,
} from "viem";
import type { LaunchParams } from "./economics.js";
import { LAUNCH_PARAMS_PARAM } from "./terms.js";

// ABI values over JSON, the shape Bankr's API and the SDK's HTTP helpers use: bigints as decimal strings, viem's
// small integers (48 bits and under) as numbers, addresses checksummed. Parsing is strict and names the bad path.

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const INT = /^(u?)int(\d*)$/;
const ARRAY = /^(.*)\[(\d*)\]$/;
const DECIMAL = /^-?\d+$/;

/** viem decodes uint/int of at most 48 bits as `number`, wider ones as `bigint`. */
const isSmallInt = (bits: number) => bits <= 48;

const components = (p: AbiParameter): readonly AbiParameter[] =>
  "components" in p && p.components ? p.components : [];

/** `value` (as viem encodes `param`) as JSON. */
export function abiToJson(param: AbiParameter, value: unknown): Json {
  const array = ARRAY.exec(param.type);
  if (array) {
    const inner = { ...param, type: array[1]! };
    return (value as readonly unknown[]).map((v) => abiToJson(inner, v));
  }
  if (param.type === "tuple") {
    const v = value as Record<string, unknown>;
    return Object.fromEntries(
      components(param).map((c) => [
        c.name ?? "",
        abiToJson(c, v[c.name ?? ""]),
      ]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value as Json;
}

function bad(path: string): never {
  throw new TypeError(`invalid value at ${path || "root"}`);
}

/** JSON back into the value viem encodes for `param`; throws a TypeError naming the first bad path. */
export function abiFromJson(
  param: AbiParameter,
  value: unknown,
  path = "",
): unknown {
  const array = ARRAY.exec(param.type);
  if (array) {
    if (!Array.isArray(value)) bad(path);
    const n = array[2] === "" ? null : Number(array[2]);
    if (n !== null && value.length !== n) bad(path);
    const inner = { ...param, type: array[1]! };
    return value.map((v, i) => abiFromJson(inner, v, `${path}[${i}]`));
  }
  if (param.type === "tuple") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      bad(path);
    const v = value as Record<string, unknown>;
    const names = components(param).map((c) => c.name ?? "");
    if (Object.keys(v).some((k) => !names.includes(k))) bad(path);
    return Object.fromEntries(
      components(param).map((c) => {
        const name = c.name ?? "";
        return [name, abiFromJson(c, v[name], path ? `${path}.${name}` : name)];
      }),
    );
  }
  const int = INT.exec(param.type);
  if (int) {
    const bits = int[2] === "" ? 256 : Number(int[2]);
    const signed = int[1] === "";
    let n: bigint;
    if (typeof value === "string" && DECIMAL.test(value)) n = BigInt(value);
    else if (typeof value === "number" && Number.isSafeInteger(value))
      n = BigInt(value);
    else return bad(path);
    const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
    const max = signed
      ? (1n << BigInt(bits - 1)) - 1n
      : (1n << BigInt(bits)) - 1n;
    if (n < min || n > max) bad(path);
    return isSmallInt(bits) ? Number(n) : n;
  }
  switch (param.type) {
    case "address":
      if (typeof value !== "string" || !isAddress(value, { strict: false }))
        bad(path);
      return getAddress(value as string);
    case "bool":
      if (typeof value !== "boolean") bad(path);
      return value;
    case "string":
      if (typeof value !== "string") bad(path);
      return value;
    default: {
      // bytes and bytesN
      if (typeof value !== "string" || !isHex(value, { strict: true }))
        bad(path);
      const size = /^bytes(\d+)$/.exec(param.type)?.[1];
      if (size && (value as string).length !== 2 + 2 * Number(size)) bad(path);
      if ((value as string).length % 2 !== 0) bad(path);
      return (value as Hex).toLowerCase();
    }
  }
}

/** `LaunchParams` as JSON (bigints as decimal strings; `options` rides as hex bytes). */
export const launchParamsToJson = (p: LaunchParams): Json =>
  abiToJson(LAUNCH_PARAMS_PARAM, p);

/** JSON back into `LaunchParams`; throws a TypeError naming the first bad field. */
export const launchParamsFromJson = (value: unknown): LaunchParams =>
  abiFromJson(LAUNCH_PARAMS_PARAM, value, "params") as LaunchParams;
