// REAL Testnet-10 end-to-end: agent hot wallet pays the seller gateway; seller verifies
// and broadcasts via upstream adapters. Test funds only. Never mainnet.
import fs from "node:fs";
import { createUpstream } from "../demo-upstream.mjs";
import { createGateway } from "../gateway.mjs";
import { loadConfig } from "../config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "../agent-wallet.mjs";
import { connectTn10 } from "./sdk.mjs";
import { addressOf, loadKeyHex, KEY_FILE } from "./wallet-init.mjs";
import { RealTn10FundingProvider, createRealPayerAddressCodec } from "./real-adapters.mjs";

const merchant = addressOf(KEY_FILE.replace("tn10-wallet.key", "tn10-merchant.key"));
const cfg = loadConfig(new URL("../../config/routes.yaml", import.meta.url).pathname);
cfg.payTo = merchant;
const { rpc, info } = await connectTn10(process.env.TN10_WRPC_URL);
console.log(`TN10 node ${rpc.url} synced=${info.isSynced} daa=${info.virtualDaaScore}`);
const payer = new RealTn10FundingProvider({ rpc, keyHex: loadKeyHex() });
const utxos = await payer.spendableUtxos(); const bal = utxos.reduce((a, e) => a + BigInt(e.amount), 0n);
console.log(`payer ${payer.address} balance ${bal} sompi; merchant ${merchant}`);
if (bal < 20_000_000n) {
  console.log(`\nBLOCKED: payer wallet unfunded. Fund it at https://faucet-tn10.kaspanet.io/ (Cloudflare challenge — needs a browser), then rerun: npm run demo:live`);
  await rpc.disconnect(); process.exit(2);
}
const up = createUpstream().listen(0, "127.0.0.1"); await new Promise((r) => up.once("listening", r));
cfg.upstream = `http://127.0.0.1:${up.address().port}`;
const ledgerPath = new URL("../../data/ledger-live.jsonl", import.meta.url).pathname;
const gw = createGateway(cfg, { chain: "real", ledgerPath }); const gs = await gw.listen(0, "127.0.0.1");
const O = cfg.publicOrigin;
const wallet = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "50000000", dailyCapSompi: "100000000",
  allowedPayTo: [merchant], fetch: createDevLoopbackFetch({ [O]: `http://127.0.0.1:${gs.address().port}` }),
  fundingProvider: payer, addressCodec: createRealPayerAddressCodec() });
const results = [];
for (const path of ["/weather/brisbane"]) {
  const t0 = Date.now();
  try { const r = await wallet.fetch(O + path);
    const tx = r.settlement?.response?.transaction;
    results.push({ path, status: r.response.status, txid: tx, ms: Date.now() - t0, body: await r.response.json() });
  } catch (e) { results.push({ path, error: String(e.message ?? e), ms: Date.now() - t0 }); if (process.env.X402_DEBUG) console.error(e.stack, e.cause); }
}
console.log(JSON.stringify({ results, ledger: gw.ledger.summary().byRoute, wallet: wallet.report().spends }, null, 2));
for (const r of results) if (r.txid) console.log(`explorer: https://explorer-tn10.kaspa.org/txs/${r.txid}`);
fs.mkdirSync(new URL("../../data", import.meta.url).pathname, { recursive: true });
fs.writeFileSync(new URL("../../data/live-run.json", import.meta.url).pathname, JSON.stringify({ at: new Date().toISOString(), node: rpc.url, results }, null, 2));
gs.close(); up.close(); await rpc.disconnect();
