// Usage: node scripts/balances.mjs [address...]  (defaults to current TN10 payer + merchant)
import { connectTn10 } from "../src/live/sdk.mjs";
const DEFAULTS = {
  payer: process.env.PAYER_ADDRESS,
  merchant: process.env.MERCHANT_ADDRESS,
};
const addrs = process.argv.length > 2 ? process.argv.slice(2).map((a) => [a, a]) : Object.entries(DEFAULTS);
const { rpc } = await connectTn10();
for (const [label, a] of addrs) {
  const { entries } = await rpc.getUtxosByAddresses({ addresses: [a] });
  const sum = entries.reduce((s, e) => s + BigInt(e.utxoEntry?.amount ?? e.amount ?? 0), 0n);
  console.log(`${label} ${a} utxos=${entries.length} sompi=${sum} (${Number(sum) / 1e8} TKAS)`);
}
process.exit(0);
