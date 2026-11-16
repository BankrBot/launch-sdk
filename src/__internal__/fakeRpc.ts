// Test-only: an in-memory JSON-RPC node behind viem's `custom` transport, so tests exercise the real viem encode,
// decode and revert paths, and a fake v4 suite on it. Excluded from the build; the public export ships it because the
// public tests import it (viem and relative imports only).
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  hexToBigInt,
  keccak256,
  multicall3Abi,
  numberToHex,
  toHex,
  zeroAddress,
  type Abi,
  type AbiEvent,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  bankrFeeLedgerAbi,
  bankrLaunchFactoryAbi,
  bankrLaunchTokenAbi,
  bankrLaunchpadRegistryAbi,
  creatorVestingEscrowAbi,
  erc20TokenDeployerAbi,
  holderRewardsDeployerAbi,
  holderRewardsDistributorAbi,
} from "../abis/suite3.js";
import {
  bankrLaunchFactoryAbi as suite4FactoryAbi,
  bankrLaunchSettingsAbi as suite4SettingsAbi,
} from "../abis/generated.js";
import type { Erc20Slots } from "../data/erc20Slots.js";
import { HOOK_EXTENSION_ERRORS, PRESET_ERRORS } from "../simulate.js";
import { SUITE4_HOOK_ERRORS } from "../suite4/revert.js";

/** Thrown by a handler to revert the call with a named suite error, or `Error(string)` with `new Revert("Error", [reason])`. */
export class Revert extends Error {
  constructor(
    readonly errorName: string,
    readonly args: readonly unknown[] = [],
  ) {
    super(errorName);
  }
}

export interface CallContext {
  from: Address | undefined;
  value: bigint;
  /** The raw `stateOverride` object the caller sent (RPC shape), if any. */
  stateOverride:
    Record<string, { balance?: Hex; stateDiff?: Record<Hex, Hex> }> | undefined;
  /** The block tag or number the call ran at. */
  block: string | undefined;
}

/** Solidity's `mapping(address => …)` slot for `owner` in the mapping declared at `slot`. */
export function balanceSlot(owner: Address, slot: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [owner, BigInt(slot)],
    ),
  );
}

/** `mapping(address => mapping(address => …))[owner][spender]` for the mapping declared at `slot`. */
export function allowanceSlot(
  owner: Address,
  spender: Address,
  slot: number,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [spender, balanceSlot(owner, slot)],
    ),
  );
}

interface FakeErc20 {
  decimals: number;
  slots: Erc20Slots;
  balances: Map<string, bigint>;
  allowances: Map<string, bigint>;
}

type Handler = (args: readonly unknown[], call: CallContext) => unknown;

interface FakeContract {
  abi: Abi;
  fns: Record<string, Handler | unknown>;
}

export interface RpcLog {
  address: Address;
  topics: [Hex, ...Hex[]];
  data: Hex;
}

interface LogFilter {
  address?: Address | Address[];
  topics?: (Hex | Hex[] | null)[];
  fromBlock?: Hex;
  toBlock?: Hex;
}

export interface SentTx {
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint | undefined;
}

const REVERT_ABI: Abi = [
  {
    type: "error",
    name: "Error",
    inputs: [{ name: "message", type: "string" }],
  } as const,
  ...bankrLaunchFactoryAbi,
  ...bankrLaunchpadRegistryAbi,
  ...bankrFeeLedgerAbi,
  ...creatorVestingEscrowAbi,
  ...erc20TokenDeployerAbi,
  ...holderRewardsDeployerAbi,
  ...holderRewardsDistributorAbi,
  ...bankrLaunchTokenAbi,
  ...HOOK_EXTENSION_ERRORS,
  ...PRESET_ERRORS,
  // Suite 4's own errors, after suite 3's: a name both suites raise encodes as before.
  ...suite4SettingsAbi,
  ...suite4FactoryAbi,
  ...SUITE4_HOOK_ERRORS,
].filter((item) => item.type === "error");

const lower = (a: string): string => a.toLowerCase();
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** An event log as a receipt carries it. */
export function eventLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  address: Address,
): RpcLog {
  const event = abi.find(
    (item): item is AbiEvent =>
      item.type === "event" && item.name === eventName,
  );
  if (!event) throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({
    abi: [event],
    eventName,
    args,
  } as Parameters<typeof encodeEventTopics>[0]) as [Hex, ...Hex[]];
  const data = event.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics,
    data: encodeAbiParameters(
      data,
      data.map((i) => args[i.name ?? ""]),
    ),
  };
}

export class FakeChain {
  readonly contracts = new Map<string, FakeContract>();
  readonly code = new Map<string, Hex>();
  readonly balances = new Map<string, bigint>();
  readonly calls: Array<{
    method: string;
    to: Address;
    functionName: string;
    args: readonly unknown[];
    call: CallContext;
  }> = [];
  readonly sent: SentTx[] = [];
  /** What `eth_getLogs` serves, each at its block (`addLog`), and the block range of every request. */
  readonly logs: Array<RpcLog & { blockNumber: bigint }> = [];
  readonly logRequests: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  gas = 9_000_000n;
  /** The head block; a sent transaction is mined in it. Raise it (e.g. in `onSend`) to add confirmations. */
  blockNumber = 100n;
  /** The head block's timestamp (`eth_getBlockByNumber`); null follows the wall clock. */
  timestamp: bigint | null = null;
  /** Like an RPC without `eth_call` state overrides: any call carrying one fails with an RPC error. */
  rejectsStateOverrides = false;
  /** Logs (and status) the receipt of a sent transaction carries. */
  onSend: (tx: SentTx) => { logs: RpcLog[]; status?: "0x1" | "0x0" } = () => ({
    logs: [],
  });
  private readonly receipts = new Map<Hex, unknown>();
  private readonly erc20s = new Map<string, FakeErc20>();

  constructor(readonly chain: Chain) {}

  contract(address: Address, abi: Abi, fns: Record<string, unknown>): void {
    const existing = this.contracts.get(lower(address));
    if (existing) Object.assign(existing.fns, fns);
    else this.contracts.set(lower(address), { abi, fns: { ...fns } });
    if (!this.code.has(lower(address))) this.code.set(lower(address), "0x60");
  }

  setCode(address: Address, code: Hex): void {
    this.code.set(lower(address), code);
  }

  /** A log `eth_getLogs` returns, emitted at `blockNumber` (default the head). */
  addLog(log: RpcLog, blockNumber: bigint = this.blockNumber): void {
    this.logs.push({ ...log, blockNumber });
  }

  // eth_getLogs as a node filters it: address, block range, and each topic position (null = any, array = one of).
  private getLogs(filter: LogFilter): unknown[] {
    const from = filter.fromBlock ? hexToBigInt(filter.fromBlock) : 0n;
    const to = filter.toBlock ? hexToBigInt(filter.toBlock) : this.blockNumber;
    this.logRequests.push({ fromBlock: from, toBlock: to });
    const addresses =
      filter.address === undefined
        ? null
        : [filter.address].flat().map((a) => lower(a));
    return this.logs
      .filter(
        (l) =>
          l.blockNumber >= from &&
          l.blockNumber <= to &&
          (addresses === null || addresses.includes(lower(l.address))) &&
          (filter.topics ?? []).every((want, i) => {
            if (want === null) return true;
            const have = l.topics[i]?.toLowerCase();
            return [want].flat().some((t) => t.toLowerCase() === have);
          }),
      )
      .map((l, i) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: numberToHex(l.blockNumber),
        blockHash: keccak256(toHex(`block-${l.blockNumber}`)),
        logIndex: numberToHex(i),
        removed: false,
        transactionHash: keccak256(toHex(`log-${l.blockNumber}-${i}`)),
        transactionIndex: "0x0",
      }));
  }

  setBalance(address: Address, wei: bigint): void {
    this.balances.set(lower(address), wei);
  }

  /**
   * An ERC-20 whose balances and allowances live at `slots`, so `eth_call` state overrides apply as on a real node.
   * `balances: null` reports the native balance in the token's decimals (Arc's USDC). Mined `approve`s persist.
   */
  erc20(address: Address, decimals: number, slots: Erc20Slots): void {
    this.erc20s.set(lower(address), {
      decimals,
      slots,
      balances: new Map(),
      allowances: new Map(),
    });
    this.contract(address, erc20Abi, {
      decimals,
      balanceOf: ([owner]: readonly unknown[], call: CallContext) =>
        this.erc20Balance(address, owner as Address, call),
      allowance: ([owner, spender]: readonly unknown[], call: CallContext) =>
        this.erc20Allowance(
          address,
          owner as Address,
          spender as Address,
          call,
        ),
    });
  }

  setErc20Balance(token: Address, owner: Address, amount: bigint): void {
    this.token(token).balances.set(lower(owner), amount);
  }

  setErc20Allowance(
    token: Address,
    owner: Address,
    spender: Address,
    amount: bigint,
  ): void {
    this.token(token).allowances.set(
      `${lower(owner)}:${lower(spender)}`,
      amount,
    );
  }

  /** `transferFrom(owner → spender)` as FiatToken checks it: reverts on a short allowance or balance. */
  pullErc20(
    token: Address,
    owner: Address,
    spender: Address,
    amount: bigint,
    call: CallContext,
  ): void {
    if (this.erc20Allowance(token, owner, spender, call) < amount) {
      throw new Revert("Error", ["ERC20: transfer amount exceeds allowance"]);
    }
    if (this.erc20Balance(token, owner, call) < amount) {
      throw new Revert("Error", ["ERC20: transfer amount exceeds balance"]);
    }
  }

  private token(address: Address): FakeErc20 {
    const token = this.erc20s.get(lower(address));
    if (!token) throw new Error(`no fake ERC-20 at ${address}`);
    return token;
  }

  private nativeBalance(address: Address, call: CallContext): bigint {
    const override = call.stateOverride?.[lower(address)]?.balance;
    return override === undefined
      ? (this.balances.get(lower(address)) ?? 0n)
      : hexToBigInt(override);
  }

  private stored(
    token: Address,
    slot: Hex,
    fallback: bigint,
    call: CallContext,
  ): bigint {
    const value = call.stateOverride?.[lower(token)]?.stateDiff?.[slot];
    return value === undefined ? fallback : hexToBigInt(value);
  }

  private erc20Balance(
    address: Address,
    owner: Address,
    call: CallContext,
  ): bigint {
    const t = this.token(address);
    if (t.slots.balances === null) {
      return this.nativeBalance(owner, call) / 10n ** BigInt(18 - t.decimals);
    }
    return this.stored(
      address,
      balanceSlot(owner, t.slots.balances),
      t.balances.get(lower(owner)) ?? 0n,
      call,
    );
  }

  private erc20Allowance(
    address: Address,
    owner: Address,
    spender: Address,
    call: CallContext,
  ): bigint {
    const t = this.token(address);
    return this.stored(
      address,
      allowanceSlot(owner, spender, t.slots.allowances),
      t.allowances.get(`${lower(owner)}:${lower(spender)}`) ?? 0n,
      call,
    );
  }

  /** Every `eth_call` / `eth_estimateGas` that reached `functionName`. */
  callsTo(functionName: string): FakeChain["calls"] {
    return this.calls.filter((c) => c.functionName === functionName);
  }

  /**
   * Serves this node over HTTP JSON-RPC on localhost, with Multicall3's `aggregate3`, so a client built from an
   * `rpcUrl` (viem's `http` transport and multicall batching) runs unchanged. Call `stop()` when done.
   */
  serve(): { url: string; stop(): void } {
    // viem batches `getBalance` through Multicall3 as well.
    this.contract(MULTICALL3, multicall3Abi, {
      aggregate3: ([calls]: readonly unknown[], call: CallContext) =>
        (calls as readonly { target: Address; callData: Hex }[]).map((c) =>
          this.subcall(c.target, c.callData, call),
        ),
      getEthBalance: ([account]: readonly unknown[], call: CallContext) =>
        this.nativeBalance(account as Address, call),
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const { id, method, params } = (await req.json()) as {
          id: number;
          method: string;
          params?: unknown;
        };
        try {
          const result = await this.request({ method, params });
          return Response.json({ jsonrpc: "2.0", id, result });
        } catch (err) {
          const e = err as { code?: number; message: string; data?: Hex };
          return Response.json({
            jsonrpc: "2.0",
            id,
            error: { code: e.code ?? -32603, message: e.message, data: e.data },
          });
        }
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => void server.stop(true),
    };
  }

  /** One `aggregate3` leg, as a node runs it: a revert fails the leg, and a call to an account without code succeeds empty. */
  private subcall(
    target: Address,
    data: Hex,
    call: CallContext,
  ): { success: boolean; returnData: Hex } {
    const contract = this.contracts.get(lower(target));
    if (!contract)
      return { success: !this.code.has(lower(target)), returnData: "0x" };
    try {
      return {
        success: true,
        returnData: this.exec(
          "eth_call",
          { to: target, data, from: MULTICALL3 },
          call.stateOverride,
          call.block,
        ),
      };
    } catch (err) {
      // A suite revert carries its data; a function the contract lacks reverts empty.
      return {
        success: false,
        returnData: (err as { data?: Hex }).data ?? "0x",
      };
    }
  }

  // No transport retries: viem retries a custom provider's plain-Error reverts, which an HTTP node's code-3 revert never is.
  publicClient(): PublicClient {
    return createPublicClient({
      chain: this.chain,
      pollingInterval: 5,
      transport: custom({ request: (r) => this.request(r) }, { retryCount: 0 }),
    });
  }

  walletClient(account: Address): WalletClient {
    return createWalletClient({
      account,
      chain: this.chain,
      transport: custom({ request: (r) => this.request(r) }, { retryCount: 0 }),
    });
  }

  private exec(
    method: string,
    tx: { to: Address; data: Hex; from?: Address; value?: Hex },
    stateOverride: CallContext["stateOverride"],
    block: string | undefined,
  ): Hex {
    const contract = this.contracts.get(lower(tx.to));
    // A call to an account without code succeeds empty, e.g. Base's precompiles on a node that does not run them.
    if (!contract && !this.code.has(lower(tx.to))) return "0x";
    if (!contract) throw new Error(`${method} to unknown contract ${tx.to}`);
    let functionName: string;
    let args: readonly unknown[];
    try {
      const decoded = decodeFunctionData({ abi: contract.abi, data: tx.data });
      functionName = decoded.functionName;
      args = decoded.args ?? [];
    } catch {
      // A selector the contract lacks reverts empty, as Solidity's dispatcher does without a fallback.
      throw Object.assign(new Error("execution reverted"), {
        code: 3,
        data: "0x",
      });
    }
    const call: CallContext = {
      from: tx.from,
      value: tx.value ? hexToBigInt(tx.value) : 0n,
      stateOverride,
      block,
    };
    this.calls.push({ method, to: tx.to, functionName, args, call });
    // A node refuses a call whose value the sender cannot cover, before running it.
    if (
      call.value > 0n &&
      call.value > this.nativeBalance(call.from ?? zeroAddress, call)
    ) {
      throw Object.assign(
        new Error("insufficient funds for gas * price + value"),
        { code: -32000 },
      );
    }
    const handler = contract.fns[functionName];
    if (handler === undefined) {
      throw new Error(`${tx.to} has no handler for ${functionName}`);
    }
    let result: unknown;
    try {
      result = typeof handler === "function" ? handler(args, call) : handler;
    } catch (err) {
      if (!(err instanceof Revert)) throw err;
      throw Object.assign(new Error("execution reverted"), {
        code: 3,
        data: encodeErrorResult({
          abi: REVERT_ABI,
          errorName: err.errorName,
          args: err.args,
        } as Parameters<typeof encodeErrorResult>[0]),
      });
    }
    return encodeFunctionResult({
      abi: contract.abi,
      functionName,
      result,
    } as Parameters<typeof encodeFunctionResult>[0]);
  }

  private async request({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return numberToHex(this.chain.id);
      case "eth_blockNumber":
        return numberToHex(this.blockNumber);
      case "eth_getBlockByNumber":
        return {
          number: numberToHex(this.blockNumber),
          hash: keccak256(toHex("block")),
          timestamp: numberToHex(
            this.timestamp ?? BigInt(Math.floor(Date.now() / 1_000)),
          ),
          transactions: [],
        };
      case "eth_call":
      case "eth_estimateGas": {
        const tx = p[0] as { to: Address; data: Hex; from?: Address };
        const raw = p.find(
          (x, i) => i > 0 && typeof x === "object" && x !== null,
        ) as CallContext["stateOverride"];
        // Keyed by lowercase address, whatever case the caller sent.
        const override =
          raw &&
          Object.fromEntries(
            Object.entries(raw).map(([k, v]) => [lower(k), v]),
          );
        if (override && this.rejectsStateOverrides) {
          throw Object.assign(new Error("state override is not supported"), {
            code: -32602,
          });
        }
        const block = typeof p[1] === "string" ? p[1] : undefined;
        const out = this.exec(method, tx, override, block);
        return method === "eth_call" ? out : numberToHex(this.gas);
      }
      case "eth_getCode":
        return this.code.get(lower(p[0] as string)) ?? "0x";
      case "eth_getBalance":
        return numberToHex(this.balances.get(lower(p[0] as string)) ?? 0n);
      case "eth_sendTransaction": {
        const raw = p[0] as {
          from: Address;
          to: Address;
          data: Hex;
          value?: Hex;
          gas?: Hex;
        };
        const tx: SentTx = {
          from: raw.from,
          to: raw.to,
          data: raw.data,
          value: raw.value ? hexToBigInt(raw.value) : 0n,
          gas: raw.gas ? hexToBigInt(raw.gas) : undefined,
        };
        this.sent.push(tx);
        const hash = keccak256(toHex(`tx-${this.sent.length}`));
        const mined = numberToHex(this.blockNumber);
        const { logs, status = "0x1" } = this.onSend(tx);
        const token = this.erc20s.get(lower(tx.to));
        if (token && status === "0x1") {
          const { functionName, args } = decodeFunctionData({
            abi: erc20Abi,
            data: tx.data,
          });
          if (functionName === "approve") {
            const [spender, amount] = args;
            token.allowances.set(`${lower(tx.from)}:${lower(spender)}`, amount);
          }
        }
        this.receipts.set(hash, {
          blockHash: keccak256(toHex("block")),
          blockNumber: mined,
          contractAddress: null,
          cumulativeGasUsed: "0x1",
          effectiveGasPrice: "0x1",
          from: tx.from,
          gasUsed: "0x1",
          logs: logs.map((log, i) => ({
            ...log,
            blockHash: keccak256(toHex("block")),
            blockNumber: mined,
            logIndex: numberToHex(i),
            removed: false,
            transactionHash: hash,
            transactionIndex: "0x0",
          })),
          logsBloom: `0x${"00".repeat(256)}`,
          status,
          to: tx.to,
          transactionHash: hash,
          transactionIndex: "0x0",
          type: "0x2",
        });
        return hash;
      }
      case "eth_getLogs":
        return this.getLogs(p[0] as LogFilter);
      case "eth_getTransactionReceipt":
        return this.receipts.get(p[0] as Hex) ?? null;
      case "eth_getTransactionByHash":
        return null;
      default:
        throw new Error(`fake RPC: unsupported ${method}`);
    }
  }
}
