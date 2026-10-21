// Creates a Testnet-10 hot wallet key in .secrets/ (gitignored, mode 0600). Never prints the key.
import fs from "node:fs";
import crypto from "node:crypto";
import { sdk, NETWORK_ID } from "./sdk.mjs";
export const KEY_FILE = process.env.TN10_WALLET_KEY_FILE ?? new URL("../../.secrets/tn10-wallet.key", import.meta.url).pathname;
export function loadKeyHex(file = KEY_FILE) { return fs.readFileSync(file, "utf8").trim(); }
export function loadKey(file = KEY_FILE) { return new sdk.PrivateKey(loadKeyHex(file)); }
export function addressOf(file = KEY_FILE) { return loadKey(file).toAddress(NETWORK_ID).toString(); }
export function ensureKey(file = KEY_FILE) {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(new URL(".", `file://${file}`).pathname, { recursive: true, mode: 0o700 });
  for (;;) { const hex = crypto.randomBytes(32).toString("hex");
    try { new sdk.PrivateKey(hex); fs.writeFileSync(file, hex + "\n", { mode: 0o600, flag: "wx" }); return true; } catch {} }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const files = { payer: KEY_FILE, merchant: KEY_FILE.replace("tn10-wallet.key", "tn10-merchant.key") };
  for (const [role, f] of Object.entries(files)) {
    const created = ensureKey(f);
    console.log(`${role}: ${addressOf(f)} (${created ? "created" : "existing"}; key file ${f}, not printed)`);
  }
}
