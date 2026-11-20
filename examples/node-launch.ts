/**
 * Launch a coin on a launchpad on Base from a Node backend: no key and no call to Bankr before the launch. Your
 * wallet signs the launch and pays the gas, and every field left out takes the launchpad's own default. The signer
 * is an encrypted keystore (`cast wallet import launcher --interactive`), never a raw key in an env file.
 *
 *   LAUNCHER_KEYSTORE=~/.foundry/keystores/launcher KEYSTORE_PASSWORD=… LAUNCHPAD_ID=7 bun examples/node-launch.ts
 *
 * LAUNCHPAD_ID is a launchpad without a signer (`own-launchpad.ts` registers one); one with a signer also takes
 * its `authorizer` on the client. In your app, import from "@bankr/launch-sdk".
 */
import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  bytesToHex,
  createWalletClient,
  http,
  keccak256,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createLaunchClient, isLaunchSdkError } from "../src/index.js";

interface KeystoreV3 {
  crypto: {
    cipher: string;
    cipherparams: { iv: string };
    ciphertext: string;
    kdf: "scrypt" | "pbkdf2";
    kdfparams: {
      dklen: number;
      salt: string;
      n?: number;
      r?: number;
      p?: number;
      c?: number;
      prf?: string;
    };
    mac: string;
  };
}

/** The private key in a Web3 Secret Storage v3 keystore (Foundry, Geth), checked against its MAC. */
export function decryptKeystore(json: string, password: string): Hex {
  const { crypto: c } = JSON.parse(json) as KeystoreV3;
  const k = c.kdfparams;
  if (c.cipher !== "aes-128-ctr")
    throw new Error(`Unsupported cipher ${c.cipher}`);
  const salt = Buffer.from(k.salt, "hex");
  const derived =
    c.kdf === "scrypt"
      ? scryptSync(password, salt, k.dklen, {
          N: k.n,
          r: k.r,
          p: k.p,
          maxmem: 256 * (k.n ?? 0) * (k.r ?? 0),
        })
      : pbkdf2Sync(password, salt, k.c ?? 0, k.dklen, "sha256");
  const ciphertext = Buffer.from(c.ciphertext, "hex");
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext]));
  if (mac.slice(2) !== c.mac.toLowerCase()) {
    throw new Error("Wrong keystore password");
  }
  const decipher = createDecipheriv(
    "aes-128-ctr",
    derived.subarray(0, 16),
    Buffer.from(c.cipherparams.iv, "hex"),
  );
  return bytesToHex(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]),
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

async function main(): Promise<void> {
  const keystore = readFileSync(requireEnv("LAUNCHER_KEYSTORE"), "utf8");
  const account = privateKeyToAccount(
    decryptKeystore(keystore, requireEnv("KEYSTORE_PASSWORD")),
  );
  const rpcUrl = process.env.BASE_RPC_URL;
  const client = createLaunchClient({
    chain: "base",
    rpcUrl,
    walletClient: createWalletClient({
      account,
      chain: base,
      transport: http(rpcUrl),
    }),
  });

  try {
    const launch = await client.launch({
      name: "My Token",
      symbol: "MINE",
      launcher: account.address,
      launchpadId: BigInt(requireEnv("LAUNCHPAD_ID")),
      metadataUri: "ipfs://bafy…", // your token's metadata JSON
    });
    console.log(
      `Launched ${launch.token} (pool ${launch.poolId}) in ${launch.txHash}`,
    );
    // Registered at 5 confirmations, so Bankr's index already serves it (null if not registered within two minutes).
    console.log("Indexed:", launch.registration?.launches ?? "pending");
    console.log(await client.index.launch(launch.token));
  } catch (err) {
    // Fixed messages, stable codes: branch on `code`; upstream detail is on `cause`.
    if (!isLaunchSdkError(err)) throw err;
    console.error(`${err.code}: ${err.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
