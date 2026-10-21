import { connectTn10 } from "./sdk.mjs";
import { addressOf, KEY_FILE } from "./wallet-init.mjs";
const { rpc } = await connectTn10(process.env.TN10_WRPC_URL);
for (const [role, f] of [["payer", KEY_FILE], ["merchant", KEY_FILE.replace("tn10-wallet.key", "tn10-merchant.key")]]) {
  const address = addressOf(f); const { entries } = await rpc.getUtxosByAddresses({ addresses: [address] });
  const bal = entries.reduce((a, e) => a + BigInt(e.amount), 0n);
  console.log(`${role} ${address}: ${bal} sompi (${Number(bal) / 1e8} TKAS), ${entries.length} UTXOs`);
}
await rpc.disconnect();
