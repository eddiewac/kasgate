// REAL TN10 exact-scheme paid calls against the running gateway (config/routes-weather.yaml). Test funds only.
// Usage: node scripts/pay-weather-live.mjs brisbane sydney
import fs from "node:fs";
import { AgentWallet, createDevLoopbackFetch } from "../src/agent-wallet.mjs";
import { connectTn10 } from "../src/live/sdk.mjs";
import { loadKeyHex } from "../src/live/wallet-init.mjs";
import { RealTn10FundingProvider, createRealPayerAddressCodec } from "../src/live/real-adapters.mjs";
import { loadConfig } from "../src/config.mjs";
import { openDb } from "../src/store.mjs";
const cfg = loadConfig(new URL("../config/routes-weather.yaml", import.meta.url).pathname), O = cfg.publicOrigin;
const { rpc } = await connectTn10();
// RR-M1/RR-L2: spend history + UTXO reservations in one 0600 SQLite file shared by every payer process (atomic cap).
const db = openDb(new URL("../data/payer-wallet.sqlite", import.meta.url).pathname);
const payer = new RealTn10FundingProvider({ rpc, keyHex: loadKeyHex(), db });
const wallet = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "100000000", dailyCapSompi: process.env.DAILY_CAP_SOMPI ?? "300000000", allowedPayTo: [cfg.payTo],
  fetch: createDevLoopbackFetch({ [O]: process.env.GATEWAY ?? "http://127.0.0.1:8402" }), fundingProvider: payer, addressCodec: createRealPayerAddressCodec(), db, walletId: "tn10-payer", ...(process.env.PENDING_RETRY_MS ? { pendingRetryDelaysMs: process.env.PENDING_RETRY_MS.split(",").map(Number) } : {}) });
const results = [];
for (const city of process.argv.slice(2)) {
  const t0 = Date.now();
  try { const r = await wallet.fetch(`${O}/weather/${encodeURIComponent(city)}`); const txid = r.settlement?.response?.transaction;
    results.push({ city, status: r.response.status, txid, explorer: txid && `https://explorer-tn10.kaspa.org/txs/${txid}`, ms: Date.now() - t0, body: await r.response.json() });
  } catch (e) { results.push({ city, error: String(e.message ?? e), ms: Date.now() - t0 }); }
}
console.log(JSON.stringify(results, null, 2));
fs.writeFileSync(new URL("../data/weather-live-run.json", import.meta.url).pathname, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
await rpc.disconnect(); process.exit(0);
