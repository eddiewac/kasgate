// Clean entry point for the REAL Testnet-10 batch-settlement adapters ported from
// kaspa-x402's live-adapter-reference.mjs (see ./upstream-ref, MIT). Keys stay in memory /
// gitignored .secrets; nothing is printed.
import path from "node:path";
import { createRequire } from "node:module";
import { sdk } from "./sdk.mjs";
import { createLiveKit } from "./upstream-ref/live-adapter-reference.mjs";
import { loadKeyHex, addressOf, KEY_FILE } from "./wallet-init.mjs";
const { schnorr } = createRequire(import.meta.url)("@noble/curves/secp256k1");

export async function createLiveBatchKit({ rpc, dataDir = path.resolve(new URL("../../.secrets/live-batch", import.meta.url).pathname), confirmations = 100 } = {}) {
  const merchantFile = KEY_FILE.replace("tn10-wallet.key", "tn10-merchant.key");
  return createLiveKit({ sdk, schnorr, rpc, network: "kaspa:testnet-10", fundingPrivateKeyHex: loadKeyHex(),
    serverPayoutAddress: addressOf(merchantFile), dataDir, confirmations });
}
