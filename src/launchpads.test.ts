import { describe, expect, test } from "bun:test";
import {
  createWalletClient,
  custom,
  decodeFunctionData,
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { waitForTransactionReceipt } from "viem/actions";
import { base } from "viem/chains";
import { bankrLaunchpadRegistryAbi } from "./abis/suite3.js";
import { ANY_CURVE, encodeCurve } from "./curve.js";
import { isLaunchSdkError, type LaunchSdkErrorCode } from "./errors.js";
import { PAD_TREASURY_MARKER } from "./launchpad.js";
import {
  buildSetCurveAllowed,
  type LaunchpadPayeeWithDecay,
} from "./launchpads.js";
import { FEES_TO_HOLDERS } from "./recipient.js";
import { percentToBps, percentToPips } from "./units.js";
import { eventLog } from "./__internal__/fakeRpc.js";
import {
  LAUNCHER,
  OTHER,
  SUITE,
  WETH,
  postLaunchFixture,
} from "./__internal__/fakeLaunch.js";
import {
  FAKE_REGISTRATION_BOND,
  PAD_OPERATOR,
  fakeAddress,
  setFakeCurveAllowed,
} from "./__internal__/fakeSuite.js";

const PAYEE_A = getAddress("0x3333333333333333333333333333333333333333");
const PAYEE_B = getAddress("0x4444444444444444444444444444444444444444");
/** Hex letters, so its checksummed and lowercase spellings differ. */
const PAYEE_HEX = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
const WAD_PER_BPS = 10n ** 14n;

async function expectCode(
  p: Promise<unknown> | (() => unknown),
  code: LaunchSdkErrorCode,
  detail?: string,
) {
  let thrown: unknown;
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    thrown = err;
  }
  expect(isLaunchSdkError(thrown, code), `${code}, got ${String(thrown)}`).toBe(
    true,
  );
  if (detail !== undefined) {
    expect((thrown as { detail?: string }).detail).toContain(detail);
  }
}

const decode = (data: Hex) =>
  decodeFunctionData({ abi: bankrLaunchpadRegistryAbi, data });

function receiptWith(
  logs: ReturnType<typeof eventLog>[],
  removed: boolean[] = [],
): TransactionReceipt {
  return {
    transactionHash: `0x${"ab".repeat(32)}`,
    blockNumber: 7n,
    status: "success",
    logs: logs.map((l, i) => ({
      ...l,
      logIndex: i,
      removed: removed[i] ?? false,
    })),
  } as unknown as TransactionReceipt;
}

const registered = (id: bigint, address: Address = SUITE.launchpadRegistry) =>
  eventLog(
    bankrLaunchpadRegistryAbi,
    "LaunchpadRegistered",
    { id, operator: LAUNCHER, signer: zeroAddress, metadataUri: "" },
    address,
  );

describe("launchpads.register", () => {
  test("an open pad from the operator, paying the live bond, shares as WAD", async () => {
    const { client } = postLaunchFixture();
    const tx = await client.launchpads.register({
      operator: LAUNCHER,
      payees: [
        { address: PAYEE_A, shareBps: percentToBps("10") },
        { address: PAYEE_B, shareBps: 8_500 },
      ],
    });
    expect(tx).toMatchObject({
      chainId: 8453,
      from: LAUNCHER,
      to: SUITE.launchpadRegistry,
      value: FAKE_REGISTRATION_BOND,
    });
    expect(decode(tx.data)).toEqual({
      functionName: "register",
      args: [
        zeroAddress,
        [PAYEE_A, PAYEE_B],
        [1_000n * WAD_PER_BPS, 950_000_000_000_000_000n - 1_000n * WAD_PER_BPS],
        "",
      ],
    });
  });

  test("a signer, metadata and the treasury marker as a payee; the bond is read live", async () => {
    const { f, client } = postLaunchFixture();
    f.set("registry", "registrationBondWei", 25n * 10n ** 18n);
    const signer = fakeAddress(0x5160);
    const tx = await client.launchpads.register({
      operator: LAUNCHER,
      signer,
      payees: [{ address: PAD_TREASURY_MARKER, shareBps: 0 }],
      metadataUri: "ipfs://my-pad",
    });
    expect(tx.value).toBe(25n * 10n ** 18n);
    expect(decode(tx.data).args).toEqual([
      signer,
      [getAddress(PAD_TREASURY_MARKER)],
      [0n],
      "ipfs://my-pad",
    ]);
    const open = await client.launchpads.register({
      operator: LAUNCHER,
      signer: zeroAddress,
      payees: [{ address: PAYEE_A, shareBps: 1 }],
    });
    expect(decode(open.data).args[0]).toBe(zeroAddress);
  });

  test("refuses what the registry reverts, and payees the factory refuses at every launch", async () => {
    const { f, client } = postLaunchFixture();
    const reg = (
      o: Partial<Parameters<typeof client.launchpads.register>[0]>,
    ) =>
      client.launchpads.register({
        operator: LAUNCHER,
        payees: [{ address: PAYEE_A, shareBps: 1_000 }],
        ...o,
      });
    const cfg = "INVALID_LAUNCHPAD_CONFIG";
    await expectCode(reg({ payees: [] }), cfg, "1 to 4 payees");
    await expectCode(
      reg({
        payees: [1, 2, 3, 4, 5].map((n) => ({
          address: fakeAddress(0x900 + n),
          shareBps: 1,
        })),
      }),
      cfg,
    );
    expect(PAYEE_HEX).not.toBe(PAYEE_HEX.toLowerCase());
    await expectCode(
      reg({
        payees: [
          { address: PAYEE_HEX, shareBps: 1 },
          { address: PAYEE_HEX.toLowerCase() as Address, shareBps: 1 },
        ],
      }),
      cfg,
      "once",
    );
    await expectCode(
      reg({
        payees: [
          { address: PAYEE_A, shareBps: 5_000 },
          { address: PAYEE_B, shareBps: 4_501 },
        ],
      }),
      cfg,
      "9500 bps (95 %)",
    );
    for (const shareBps of [9_501, -1, 1.5, Number.NaN]) {
      await expectCode(reg({ payees: [{ address: PAYEE_A, shareBps }] }), cfg);
    }
    await expectCode(
      reg({ metadataUri: "é".repeat(1_025) }),
      cfg,
      "2048 bytes",
    );
    expect((await reg({ metadataUri: "é".repeat(1_024) })).value).toBe(
      FAKE_REGISTRATION_BOND,
    );
    await expectCode(
      reg({ payees: [{ address: SUITE.ledger, shareBps: 1 }] }),
      cfg,
      "cannot be a payee",
    );
    await expectCode(
      reg({ payees: [{ address: FEES_TO_HOLDERS, shareBps: 1 }] }),
      cfg,
    );
    // Round 9 RSEC-1: a contract payee that lets anyone claim for it is refused; restricted (or a 7702 wallet), taken.
    f.fake.setCode(PAYEE_B, "0x6080");
    const contractPayee = {
      payees: [
        { address: PAYEE_A, shareBps: 1 },
        { address: PAYEE_B, shareBps: 1 },
      ],
    };
    await expectCode(reg(contractPayee), cfg, "setClaimRestricted(true)");
    f.fake.contract(SUITE.ledger, [], {
      claimRestricted: ([a]: readonly unknown[]) =>
        String(a).toLowerCase() === PAYEE_B.toLowerCase(),
    });
    expect((await reg(contractPayee)).value).toBe(FAKE_REGISTRATION_BOND);
    f.fake.contract(SUITE.ledger, [], { claimRestricted: false });
    f.fake.setCode(PAYEE_B, `0xef0100${"ab".repeat(20)}`);
    expect((await reg(contractPayee)).value).toBe(FAKE_REGISTRATION_BOND);
    // The registry reverts a zero payee; a value that is no address is malformed. Each names the payee.
    await expectCode(
      reg({ payees: [{ address: zeroAddress, shareBps: 1 }] }),
      cfg,
      "Payee 1 is the zero address",
    );
    await expectCode(
      reg({
        payees: [
          { address: PAYEE_A, shareBps: 1 },
          { address: "0x12" as Address, shareBps: 1 },
        ],
      }),
      "INVALID_PARAMS",
      "Payee 2 is not an address",
    );
    await expectCode(
      reg({ operator: "0x12" as Address }),
      "INVALID_PARAMS",
      "The operator is not an address",
    );
    await expectCode(
      reg({ operator: zeroAddress }),
      "INVALID_PARAMS",
      "The operator is the zero address",
    );
    await expectCode(
      reg({ signer: "nope" as Address }),
      "INVALID_PARAMS",
      "The signer",
    );
  });

  test("refuses a decay share rather than drop it: register takes no decay split", async () => {
    const { client } = postLaunchFixture();
    const payees: LaunchpadPayeeWithDecay[] = [
      { address: PAYEE_A, shareBps: 1_000, decayShareBps: 6_000 },
    ];
    await expectCode(
      client.launchpads.register({ operator: LAUNCHER, payees }),
      "INVALID_LAUNCHPAD_CONFIG",
      "setPayees after registering",
    );
  });
});

describe("launchpads.launchpadIdFromReceipt", () => {
  test("reads LaunchpadRegistered from the registry's address only", async () => {
    const { client } = postLaunchFixture();
    const lp = client.launchpads;
    expect(lp.launchpadIdFromReceipt(receiptWith([registered(7n)]))).toBe(7n);
    expect(
      lp.launchpadIdFromReceipt(
        receiptWith([registered(8n, OTHER), registered(9n)]),
      ),
    ).toBe(9n);
    for (const r of [
      receiptWith([]),
      receiptWith([registered(7n, OTHER)]),
      receiptWith([registered(7n)], [true]),
      receiptWith([registered(7n), registered(8n)]),
    ]) {
      await expectCode(
        () => lp.launchpadIdFromReceipt(r),
        "RECEIPT_MISSING_LAUNCHPAD",
      );
    }
  });

  test("register, send from the wallet, then read the new id from the mined receipt", async () => {
    const { f, client } = postLaunchFixture();
    f.fake.setBalance(LAUNCHER, 10n ** 18n);
    f.fake.onSend = (sent) => ({
      logs:
        sent.to.toLowerCase() === SUITE.launchpadRegistry.toLowerCase()
          ? [registered(3n)]
          : [],
    });
    const tx = await client.launchpads.register({
      operator: LAUNCHER,
      payees: [{ address: PAYEE_A, shareBps: 500 }],
    });
    // A wallet with its account and chain set takes the unsigned transaction as it is.
    const node = f.fake.walletClient(LAUNCHER);
    const wallet = createWalletClient({
      account: LAUNCHER,
      chain: base,
      transport: custom({ request: (r) => node.request(r) }),
    });
    const hash = await wallet.sendTransaction(tx);
    const receipt = await waitForTransactionReceipt(client.publicClient, {
      hash,
    });
    expect(f.fake.sent[0]).toMatchObject({
      from: LAUNCHER,
      to: SUITE.launchpadRegistry,
      value: FAKE_REGISTRATION_BOND,
    });
    expect(client.launchpads.launchpadIdFromReceipt(receipt)).toBe(3n);
  });
});

describe("launchpads operator setters", () => {
  test("setFeeBounds from the pad's live operator; refused on id 0, outside the protocol and for an unknown pad", async () => {
    const { client } = postLaunchFixture();
    const bounds = {
      minSteadyPips: percentToPips("0.5"),
      maxSteadyPips: percentToPips("5"),
      maxStartPips: percentToPips("50"),
      maxDecaySecs: 60,
      maxReferrerBps: percentToBps("2.5"),
    };
    const tx = await client.launchpads.setFeeBounds(1n, bounds);
    expect(tx).toMatchObject({
      from: PAD_OPERATOR,
      to: SUITE.launchpadRegistry,
      value: 0n,
    });
    expect(decode(tx.data)).toEqual({
      functionName: "setFeeBounds",
      args: [1n, bounds],
    });
    const cfg = "INVALID_LAUNCHPAD_CONFIG";
    await expectCode(client.launchpads.setFeeBounds(0n, bounds), cfg, "id 0");
    for (const bad of [
      { minSteadyPips: 499 },
      { minSteadyPips: 60_000 },
      { maxSteadyPips: 100_001, maxStartPips: 200_000 },
      { maxStartPips: 4_000 },
      { maxStartPips: 800_001 },
      { maxDecaySecs: 121 },
      { maxReferrerBps: 501 },
      { maxDecaySecs: 1.5 },
    ]) {
      await expectCode(
        client.launchpads.setFeeBounds(1n, { ...bounds, ...bad }),
        cfg,
        "Fee bounds keep 0.05 %",
      );
    }
    // The fake has pads 0-2: 3 is the first unknown id, where the registry would return a zeroed pad.
    await expectCode(
      client.launchpads.setFeeBounds(3n, bounds),
      "UNKNOWN_LAUNCHPAD",
    );
    for (const id of [1 as never, -1n, 2n ** 64n]) {
      await expectCode(
        client.launchpads.setFeeBounds(id, bounds),
        "INVALID_PARAMS",
        "launchpad id",
      );
    }
    await expectCode(
      client.launchpads.setFeeBounds(1n, null as never),
      "INVALID_PARAMS",
    );
  });

  test("setPolicy merges over the live policy, then holds the whole to the registry's rules", async () => {
    const { f, client } = postLaunchFixture();
    const live = f.pads.get(1n)!.pad.policy;
    const tx = await client.launchpads.setPolicy(1n, {
      maxBuybackBps: 0,
      allowBuilderLane: false,
      minVestToHoldersSecs: 7n * 86_400n,
    });
    expect(tx.from).toBe(PAD_OPERATOR);
    expect(decode(tx.data)).toEqual({
      functionName: "setPolicy",
      args: [
        1n,
        {
          ...live,
          maxBuybackBps: 0,
          allowBuilderLane: false,
          minVestToHoldersSecs: 7n * 86_400n,
        },
      ],
    });
    // A pad shortens its launches' scheduled-start window, or turns it off with 0.
    for (const maxStartDelay of [0, 3_600, 7 * 86_400]) {
      const delay = await client.launchpads.setPolicy(1n, { maxStartDelay });
      expect(decode(delay.data).args[1]).toEqual({ ...live, maxStartDelay });
    }
    // Id 0's operator is the registry owner.
    const own = await client.launchpads.setPolicy(0n, { maxBuybackBps: 0 });
    expect(own.from).toBe(SUITE.owner);
    // A number of seconds is taken as the uint64 it encodes to.
    const secs = await client.launchpads.setPolicy(1n, {
      minVestToHoldersSecs: 86_400 as never,
    });
    expect(
      (decode(secs.data).args[1] as { minVestToHoldersSecs: bigint })
        .minVestToHoldersSecs,
    ).toBe(86_400n);
    const cfg = "INVALID_LAUNCHPAD_CONFIG";
    for (const [bad, detail] of [
      [{ defaultHoldersBps: 10_000, maxHoldersBps: 5_000 }, "Holders keep"],
      [{ maxHoldersBps: 10_001 }, "Holders keep"],
      [{ minHoldersBps: live.defaultHoldersBps + 1 }, "Holders keep"],
      [{ defaultVestBps: 5_000, maxVestBps: 4_000 }, "Vesting keeps"],
      [{ minAutoLpBps: 4_000 }, "Auto-LP keeps"],
      [{ defaultHoldersBps: 7_001, defaultAutoLpBps: 3_000 }, "add up"],
      [{ maxVestBps: 5_001 }, "Vesting keeps"],
      [{ defaultVestBps: 100, minVestBps: 200 }, "Vesting keeps"],
      [{ allowedExtensions: 8 }, "bits 0-2"],
      [{ maxExtensionPips: 100_001 }, "maxExtensionPips"],
      [{ maxVestToHoldersBps: 5_001 }, "maxVestToHoldersBps"],
      [{ minVestToHoldersSecs: 365n * 86_400n + 1n }, "365 days"],
      [{ maxBuybackBps: 10_001 }, "maxBuybackBps"],
      [{ maxStartDelay: 7 * 86_400 + 1 }, "maxStartDelay"],
      [{ minHoldersBps: -1 }, "whole number"],
      [{ minHoldersBps: 0.5 }, "whole number"],
      [{ maxHoldersBpz: 1 }, "not a launchpad policy field"],
      [{ minVestToHoldersSecs: -1n }, "seconds"],
    ] as const) {
      await expectCode(
        client.launchpads.setPolicy(1n, bad as never),
        cfg,
        detail,
      );
    }
    await expectCode(
      client.launchpads.setPolicy(1n, { allowBuilderLane: 1 as never }),
      "INVALID_PARAMS",
    );
    await expectCode(
      client.launchpads.setPolicy(1n, null as never),
      "INVALID_PARAMS",
    );
    // A detail repeats at most 32 characters of an unknown field's name.
    await expectCode(
      client.launchpads.setPolicy(1n, { ["x".repeat(100)]: 1 } as never),
      cfg,
      `"${"x".repeat(32)}…" is not`,
    );
  });

  test("setVanity: 4-6 hex digits or none, prefix-free with every other pad's suffix", async () => {
    const { f, client } = postLaunchFixture();
    const tx = await client.launchpads.setVanity(1n, {
      suffix: 0xbeef,
      nibbles: 4,
    });
    expect(tx.from).toBe(PAD_OPERATOR);
    expect(decode(tx.data)).toEqual({
      functionName: "setVanity",
      args: [1n, { suffix: 0xbeef, nibbles: 4 }],
    });
    expect(
      decode(
        (await client.launchpads.setVanity(1n, { suffix: 0, nibbles: 0 })).data,
      ).args,
    ).toEqual([1n, { suffix: 0, nibbles: 0 }]);
    // Pad 2 owns 0xa/1 itself: its old suffix is released before the new one is checked.
    await client.launchpads.setVanity(2n, { suffix: 0x123a, nibbles: 4 });
    // Id 0 may keep its 3-digit `…ba3`.
    await client.launchpads.setVanity(0n, { suffix: 0xba3, nibbles: 3 });
    const cfg = "INVALID_LAUNCHPAD_CONFIG";
    await expectCode(
      client.launchpads.setVanity(1n, { suffix: 0x12, nibbles: 2 }),
      cfg,
      "4 to 6 hex digits",
    );
    for (const bad of [
      { suffix: 0x12345, nibbles: 4 },
      { suffix: 1, nibbles: 7 },
      { suffix: -1, nibbles: 4 },
      { suffix: 0x1, nibbles: 0 },
    ]) {
      await expectCode(client.launchpads.setVanity(1n, bad), cfg);
    }
    await expectCode(
      client.launchpads.setVanity(1n, { suffix: 0x0ba3, nibbles: 4 }),
      cfg,
      "launchpad 0 owns 0xba3",
    );
    await expectCode(
      client.launchpads.setVanity(1n, { suffix: 0xbeefa, nibbles: 5 }),
      cfg,
      "launchpad 2 owns 0xa",
    );
    // A revoked suffix is held: its designee may take it whole (the chain decides), never as a tail.
    const HELD = 2n ** 64n - 1n;
    f.set("registry", "vanityOwner", ([s, n]: readonly unknown[]) =>
      s === 0xcafe && n === 4 ? [true, HELD] : [false, 0n],
    );
    await client.launchpads.setVanity(1n, { suffix: 0xcafe, nibbles: 4 });
    await expectCode(
      client.launchpads.setVanity(1n, { suffix: 0x1cafe, nibbles: 5 }),
      cfg,
      "holds",
    );
    await expectCode(
      client.launchpads.setVanity(3n, { suffix: 0xbeef, nibbles: 4 }),
      "UNKNOWN_LAUNCHPAD",
    );
    await expectCode(
      client.launchpads.setVanity(1n, null as never),
      "INVALID_PARAMS",
    );
  });

  test("setPayees: the decay split off, on through a payee's decayShareBps, or on through decayAutoLpBps alone", async () => {
    const { client } = postLaunchFixture();
    const off = await client.launchpads.setPayees(1n, [
      { address: PAYEE_A, shareBps: 2_000 },
    ]);
    expect(off.from).toBe(PAD_OPERATOR);
    expect(decode(off.data)).toEqual({
      functionName: "setPayees",
      args: [
        1n,
        [PAYEE_A],
        [2_000n * WAD_PER_BPS],
        { on: false, autoLpBps: 0, sharesWad: [] },
      ],
    });
    const on = await client.launchpads.setPayees(
      1n,
      [
        { address: PAYEE_A, shareBps: 2_000, decayShareBps: 6_000 },
        { address: PAYEE_B, shareBps: 1_000 },
      ],
      { decayAutoLpBps: 5_000 },
    );
    expect(decode(on.data).args[3]).toEqual({
      on: true,
      autoLpBps: 5_000,
      sharesWad: [6_000n * WAD_PER_BPS, 0n],
    });
    const lpOnly = await client.launchpads.setPayees(
      1n,
      [{ address: PAYEE_A, shareBps: 2_000 }],
      { decayAutoLpBps: 10_000 },
    );
    expect(decode(lpOnly.data).args[3]).toEqual({
      on: true,
      autoLpBps: 10_000,
      sharesWad: [0n],
    });
    const cfg = "INVALID_LAUNCHPAD_CONFIG";
    await expectCode(
      client.launchpads.setPayees(0n, [{ address: PAYEE_A, shareBps: 1 }]),
      cfg,
      "id 0",
    );
    await expectCode(
      client.launchpads.setPayees(1n, [
        { address: PAYEE_A, shareBps: 1, decayShareBps: 5_000 },
        { address: PAYEE_B, shareBps: 1, decayShareBps: 4_501 },
      ]),
      cfg,
      "add up to at most 9500",
    );
    for (const decayShareBps of [-1, 1.5, 9_501]) {
      await expectCode(
        client.launchpads.setPayees(1n, [
          { address: PAYEE_A, shareBps: 1, decayShareBps },
        ]),
        cfg,
        "A payee's share",
      );
    }
    await expectCode(
      client.launchpads.setPayees(1n, [{ address: PAYEE_A, shareBps: 1 }], {
        decayAutoLpBps: 10_001,
      }),
      cfg,
      "auto-LP",
    );
    await expectCode(
      client.launchpads.setPayees(1n, [{ address: SUITE.hook, shareBps: 1 }]),
      cfg,
      "cannot be a payee",
    );
  });

  test("setSigner, setMetadataUri, setPaused and setQuoteAllowed from the operator", async () => {
    const { client } = postLaunchFixture();
    const lp = client.launchpads;
    const signer = fakeAddress(0x5162);
    for (const [tx, functionName, args] of [
      [await lp.setSigner(1n, signer), "setSigner", [1n, signer]],
      [await lp.setSigner(1n, zeroAddress), "setSigner", [1n, zeroAddress]],
      [
        await lp.setMetadataUri(1n, "ipfs://x"),
        "setMetadataUri",
        [1n, "ipfs://x"],
      ],
      [await lp.setPaused(1n, true), "setPaused", [1n, true]],
      [
        await lp.setQuoteAllowed(1n, WETH, true),
        "setQuoteAllowed",
        [1n, WETH, true],
      ],
      [
        await lp.setQuoteAllowed(1n, OTHER, false),
        "setQuoteAllowed",
        [1n, OTHER, false],
      ],
    ] as const) {
      expect(tx.from, functionName).toBe(PAD_OPERATOR);
      expect(decode(tx.data) as unknown, functionName).toEqual({
        functionName,
        args,
      });
    }
    await expectCode(lp.setSigner(1n, "0x1" as Address), "INVALID_PARAMS");
    await expectCode(
      lp.setMetadataUri(1n, "x".repeat(2_049)),
      "INVALID_LAUNCHPAD_CONFIG",
    );
    await expectCode(lp.setPaused(1n, "yes" as never), "INVALID_PARAMS");
    await expectCode(lp.setMetadataUri(1n, 5 as never), "INVALID_PARAMS");
    // Any pad but Bankr's may name any quote (any-quote pairing); id 0 keeps the factory's (QuoteNotInFactoryRegistry).
    expect(decode((await lp.setQuoteAllowed(1n, OTHER, true)).data)).toEqual({
      functionName: "setQuoteAllowed",
      args: [1n, OTHER, true],
    });
    await expectCode(
      lp.setQuoteAllowed(0n, OTHER, true),
      "INVALID_LAUNCHPAD_CONFIG",
      "only a quote the factory allows",
    );
    await expectCode(
      lp.setQuoteAllowed(1n, "0x1" as Address, true),
      "INVALID_PARAMS",
      "The quote is not an address",
    );
    await expectCode(
      lp.setQuoteAllowed(1n, WETH, "yes" as never),
      "INVALID_PARAMS",
      "allowed",
    );
    await expectCode(lp.setPaused(3n, true), "UNKNOWN_LAUNCHPAD");
  });

  test("transferOperator then acceptOperator, from the pending operator; never on id 0", async () => {
    const { f, client } = postLaunchFixture();
    const lp = client.launchpads;
    const tx = await lp.transferOperator(1n, OTHER);
    expect(tx.from).toBe(PAD_OPERATOR);
    expect(decode(tx.data)).toEqual({
      functionName: "transferOperator",
      args: [1n, OTHER],
    });
    await expectCode(
      lp.acceptOperator(1n),
      "INVALID_LAUNCHPAD_CONFIG",
      "No operator handover is pending",
    );
    f.pads.get(1n)!.pad.pendingOperator = OTHER;
    const accept = await lp.acceptOperator(1n);
    expect(accept.from).toBe(OTHER);
    expect(decode(accept.data)).toEqual({
      functionName: "acceptOperator",
      args: [1n],
    });
    await expectCode(
      lp.transferOperator(0n, OTHER),
      "INVALID_LAUNCHPAD_CONFIG",
      "registry's ownership",
    );
    await expectCode(
      lp.transferOperator(1n, zeroAddress),
      "INVALID_LAUNCHPAD_CONFIG",
      "The new operator is the zero address",
    );
    await expectCode(
      lp.transferOperator(1n, "0x1" as Address),
      "INVALID_PARAMS",
      "The new operator is not an address",
    );
  });
});

/** `a` with its last hex digit mistyped and its casing kept: a mixed-case spelling whose EIP-55 checksum breaks. */
const typoOf = (a: Address): Address =>
  `${a.slice(0, -1)}${a.endsWith("d") ? "e" : "E"}` as Address;

describe("R7-18: operator addresses must keep their EIP-55 checksum", () => {
  const typo = typoOf(PAYEE_HEX);
  const checksum = "does not match its EIP-55 checksum; check for a typo";

  test("R7-18: a payee, signer or new operator with a one-digit typo is refused, not re-checksummed", async () => {
    const { client } = postLaunchFixture();
    const lp = client.launchpads;
    expect(isAddress(typo)).toBe(false);
    expect(isAddress(typo, { strict: false })).toBe(true);
    await expectCode(
      lp.setPayees(1n, [{ address: typo, shareBps: 5_000 }]),
      "INVALID_PARAMS",
      checksum,
    );
    await expectCode(
      lp.register({
        operator: LAUNCHER,
        payees: [{ address: typo, shareBps: 5_000 }],
      }),
      "INVALID_PARAMS",
      checksum,
    );
    await expectCode(
      lp.register({
        operator: LAUNCHER,
        signer: typo,
        payees: [{ address: PAYEE_A, shareBps: 5_000 }],
      }),
      "INVALID_PARAMS",
      `The signer ${checksum}`,
    );
    await expectCode(
      lp.setSigner(1n, typo),
      "INVALID_PARAMS",
      `The signer ${checksum}`,
    );
    await expectCode(
      lp.transferOperator(1n, typo),
      "INVALID_PARAMS",
      `The new operator ${checksum}`,
    );
    await expectCode(
      lp.setQuoteAllowed(1n, typo, false),
      "INVALID_PARAMS",
      `The quote ${checksum}`,
    );
  });

  test("R7-18 control: checksummed, all-lowercase and all-uppercase spellings are still taken", async () => {
    const { client } = postLaunchFixture();
    const lp = client.launchpads;
    const upper = `0x${PAYEE_HEX.slice(2).toUpperCase()}` as Address;
    for (const spelling of [PAYEE_HEX, PAYEE_HEX.toLowerCase(), upper]) {
      const payees = await lp.setPayees(1n, [
        { address: spelling as Address, shareBps: 5_000 },
      ]);
      expect(decode(payees.data).args[1], spelling).toEqual([PAYEE_HEX]);
      const signer = await lp.setSigner(1n, spelling as Address);
      expect(decode(signer.data).args[1], spelling).toBe(PAYEE_HEX);
    }
    // The zero address still opens a pad; a non-address is still "not an address".
    const open = await lp.setSigner(1n, zeroAddress);
    expect(decode(open.data).args[1]).toBe(zeroAddress);
    await expectCode(
      lp.setSigner(1n, "0x1" as Address),
      "INVALID_PARAMS",
      "The signer is not an address",
    );
  });
});

describe("R7-17: a queued setPolicy can be checked against the live policy", () => {
  test("R7-17: a setPolicy built over an older policy is refused with STALE_POLICY, then rebuilt keeping both changes", async () => {
    const { f, client } = postLaunchFixture();
    const lp = client.launchpads;
    const base = { ...f.pads.get(1n)!.pad.policy };
    expect(base.maxBuybackBps).toBeGreaterThan(0);
    const changes = { defaultVestBps: 0, minVestBps: 0 };
    const queued = await lp.setPolicy(1n, changes, { expectBasePolicy: base });
    // Another change lands first; the registry stores each setPolicy's whole struct.
    const other = await lp.setPolicy(1n, { maxBuybackBps: 0 });
    f.pads.get(1n)!.pad.policy = decode(other.data).args[1] as typeof base;
    await expectCode(
      lp.setPolicy(1n, changes, { expectBasePolicy: base }),
      "STALE_POLICY",
    );
    const live = f.pads.get(1n)!.pad.policy;
    const rebuilt = await lp.setPolicy(1n, changes, { expectBasePolicy: live });
    expect(rebuilt.data).not.toBe(queued.data);
    expect(decode(rebuilt.data).args[1]).toEqual({
      ...base,
      maxBuybackBps: 0,
      defaultVestBps: 0,
      minVestBps: 0,
    });
  });

  test("R7-17 control: an unchanged base rebuilds the same transaction; a malformed base is INVALID_PARAMS", async () => {
    const { f, client } = postLaunchFixture();
    const lp = client.launchpads;
    const base = { ...f.pads.get(1n)!.pad.policy };
    const changes = { maxBuybackBps: 0 };
    const queued = await lp.setPolicy(1n, changes, { expectBasePolicy: base });
    expect(queued).toEqual(await lp.setPolicy(1n, changes));
    expect(await lp.setPolicy(1n, changes, { expectBasePolicy: base })).toEqual(
      queued,
    );
    for (const bad of [null, 5, "policy"]) {
      await expectCode(
        lp.setPolicy(1n, changes, { expectBasePolicy: bad as never }),
        "INVALID_PARAMS",
        "expectBasePolicy",
      );
    }
    // A base missing a field is not the live policy.
    const partial: Record<string, unknown> = { ...base };
    delete partial.maxBuybackBps;
    await expectCode(
      lp.setPolicy(1n, changes, { expectBasePolicy: partial as never }),
      "STALE_POLICY",
    );
  });

  test("R7-17 fixup: a base stored as JSON next to the queued Safe transaction still matches; an array is INVALID_PARAMS", async () => {
    const { f, client } = postLaunchFixture();
    const lp = client.launchpads;
    const base = { ...f.pads.get(1n)!.pad.policy };
    expect(typeof base.minVestToHoldersSecs).toBe("bigint");
    const changes = { maxBuybackBps: 0 };
    const queued = await lp.setPolicy(1n, changes);
    // bigints written as strings, or as numbers where they fit
    for (const asNumber of [false, true]) {
      const stored = JSON.parse(
        JSON.stringify(base, (_k, v: unknown) =>
          typeof v === "bigint" ? (asNumber ? Number(v) : v.toString()) : v,
        ),
      ) as never;
      expect(
        await lp.setPolicy(1n, changes, { expectBasePolicy: stored }),
      ).toEqual(queued);
    }
    const moved = JSON.parse(
      JSON.stringify({ ...base, minVestToHoldersSecs: "1" }),
    ) as never;
    await expectCode(
      lp.setPolicy(1n, changes, { expectBasePolicy: moved }),
      "STALE_POLICY",
    );
    await expectCode(
      lp.setPolicy(1n, changes, { expectBasePolicy: [] as never }),
      "INVALID_PARAMS",
      "expectBasePolicy",
    );
  });
});

describe("launchpads: the curves a pad allows", () => {
  const POCKET = [
    { widthTicks: 6_800, shareBps: 304 },
    { widthTicks: 0, shareBps: 9_696 },
  ];
  const WORD = encodeCurve(POCKET)!;

  test("setCurveAllowed lists a launcher's bands, opens the pad to any, or switches a built-in, from the operator", async () => {
    const { client } = postLaunchFixture();
    const lp = client.launchpads;
    for (const [tx, args] of [
      [await lp.setCurveAllowed(1n, { bands: POCKET }, true), [1n, WORD, true]],
      [await lp.setCurveAllowed(1n, WORD, false), [1n, WORD, false]],
      [await lp.setCurveAllowed(1n, "any", true), [1n, ANY_CURVE, true]],
      [await lp.setCurveAllowed(1n, "degen", false), [1n, 1n, false]],
      [await lp.setCurveAllowed(1n, 2, true), [1n, 2n, true]],
    ] as const) {
      expect(tx).toMatchObject({
        chainId: 8453,
        from: PAD_OPERATOR,
        to: SUITE.launchpadRegistry,
        value: 0n,
      });
      expect(decode(tx.data) as unknown).toEqual({
        functionName: "setCurveAllowed",
        args,
      });
    }
    // Id 0's operator is the registry's owner.
    expect((await lp.setCurveAllowed(0n, "any", true)).from).toBe(
      fakeAddress(0x800f),
    );
  });

  test("a key no launch could carry, a bad flag or an unknown pad is refused", async () => {
    const { client } = postLaunchFixture();
    const lp = client.launchpads;
    await expectCode(
      lp.setCurveAllowed(1n, 3n, true),
      "INVALID_PARAMS",
      "This word is not a curve",
    );
    await expectCode(
      lp.setCurveAllowed(
        1n,
        { bands: [{ widthTicks: 6_800, shareBps: 300 }] },
        true,
      ),
      "INVALID_PARAMS",
      "Liquidity band 1 is the last, so its widthTicks must be 0",
    );
    await expectCode(
      lp.setCurveAllowed(1n, "any", "yes" as never),
      "INVALID_PARAMS",
      "allowed",
    );
    await expectCode(lp.setCurveAllowed(3n, "any", true), "UNKNOWN_LAUNCHPAD");
    await expectCode(lp.isCurveAllowed(3n, "any"), "UNKNOWN_LAUNCHPAD");
  });

  test("buildSetCurveAllowed is the same call without a read", () => {
    const tx = buildSetCurveAllowed({
      chainId: 8453,
      registry: SUITE.launchpadRegistry,
      operator: PAD_OPERATOR,
      launchpadId: 1n,
      curve: { bands: POCKET },
      allowed: true,
    });
    expect(tx).toEqual({
      chainId: 8453,
      from: PAD_OPERATOR,
      to: SUITE.launchpadRegistry,
      data: tx.data,
      value: 0n,
    });
    expect(decode(tx.data) as unknown).toEqual({
      functionName: "setCurveAllowed",
      args: [1n, WORD, true],
    });
    expect(() =>
      buildSetCurveAllowed({
        chainId: 8453,
        registry: SUITE.launchpadRegistry,
        operator: PAD_OPERATOR,
        launchpadId: 1n,
        curve: 7n,
        allowed: true,
      }),
    ).toThrow();
  });

  test("isCurveAllowed answers what a launch would meet: a new pad takes the built-ins and no bands", async () => {
    const { f, client } = postLaunchFixture();
    const lp = client.launchpads;
    expect(
      await Promise.all([
        lp.isCurveAllowed(1n, "runner_v1"),
        lp.isCurveAllowed(1n, 1),
        lp.isCurveAllowed(1n, "thin_topside"),
        lp.isCurveAllowed(1n, "any"),
        lp.isCurveAllowed(1n, { bands: POCKET }),
        lp.isCurveAllowed(0n, { bands: POCKET }),
      ]),
    ).toEqual([true, true, true, false, false, false]);
    const pad = f.pads.get(1n)!;
    setFakeCurveAllowed(pad, WORD, true);
    expect(await lp.isCurveAllowed(1n, WORD)).toBe(true);
    setFakeCurveAllowed(pad, WORD, false);
    setFakeCurveAllowed(pad, ANY_CURVE, true);
    setFakeCurveAllowed(pad, 1n, false);
    // Open to any bands: unlisted bands launch, and a built-in switched off stays off.
    expect(
      await Promise.all([
        lp.isCurveAllowed(1n, { bands: POCKET }),
        lp.isCurveAllowed(1n, "any"),
        lp.isCurveAllowed(1n, "degen"),
        lp.isCurveAllowed(1n, 0),
      ]),
    ).toEqual([true, true, false, true]);
  });
});
