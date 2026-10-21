// REAL Testnet-10 batch-settlement run: covenant deposit -> N cheap voucher calls -> seller claim -> payer refund.
// Test funds only. Never mainnet.
import fs from "node:fs";
import { createUpstream } from "../demo-upstream.mjs";
import { createGateway } from "../gateway.mjs";
import { validateConfig } from "../config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "../agent-wallet.mjs";
import { connectTn10 } from "./sdk.mjs";
import { openDb } from "../store.mjs";
import { createLiveBatchKit } from "./batch-kit.mjs";

const N = Number(process.env.CALLS ?? 12), PRICE = process.env.PRICE ?? "2000000", DEPOSIT = process.env.DEPOSIT ?? "200000000";
const DELTA = BigInt(process.env.TIMEOUT_DELTA_DAA ?? "3600"), WAIT_REFUND = process.env.WAIT_REFUND !== "0";
const out = { at: new Date().toISOString(), params: { N, PRICE, DEPOSIT, DELTA: String(DELTA) }, steps: [] };
const save = () => { fs.mkdirSync(new URL("../../data", import.meta.url).pathname, { recursive: true });
  fs.writeFileSync(new URL("../../data/live-batch-run.json", import.meta.url).pathname, JSON.stringify(out, (k, v) => typeof v === "bigint" ? String(v) : v, 2)); };
const log = (m, extra) => { console.log(m); out.steps.push({ t: new Date().toISOString(), m, ...(extra ?? {}) }); save(); };

const { rpc } = await connectTn10(process.env.TN10_WRPC_URL);
const kit = await createLiveBatchKit({ rpc });
const bal = async (a) => (await rpc.getUtxosByAddresses({ addresses: [a] })).entries.reduce((x, e) => x + BigInt(e.amount), 0n);
out.balancesBefore = { payer: await bal(kit.fundingAddress), merchant: await bal(kit.serverPayoutAddress) };
log(`node ${rpc.url}; payer ${kit.fundingAddress} ${out.balancesBefore.payer}; merchant ${kit.serverPayoutAddress} ${out.balancesBefore.merchant}`);
const startDaa = await kit.virtualDaa();
const FINALITY = process.env.FINALITY ?? "confirmed";
log(`DAA ${startDaa}; per-channel refund timeout = open DAA + ${DELTA}; finality ${FINALITY}`);

const O = "https://api.demo.test";
const up = createUpstream().listen(0, "127.0.0.1"); await new Promise((r) => up.once("listening", r));
const cfg = validateConfig({ network: "kaspa:testnet-10", publicOrigin: O, payTo: kit.serverPayoutAddress, upstream: `http://127.0.0.1:${up.address().port}`,
  listen: {}, dashboard: { path: "/d", token: "t" }, batch: { minDepositSompi: DEPOSIT, claimReserveSompi: kit.feeSompi.toString(), refundTimeoutDeltaDaa: String(DELTA),
    claimMarginDaa: String(DELTA / 6n), rotateEveryDaa: String(DELTA / 12n), acceptedFinality: FINALITY, allowShortRefundTimeout: true },
  routes: [{ match: "GET /weather/*", scheme: "batch-settlement", priceSompi: PRICE }] });
let db = openDb((process.env.LIVE_BATCH_DB ?? new URL("../../data/live-batch.sqlite", import.meta.url).pathname));
let gw = createGateway(cfg, { chain: "real", liveKit: kit, nowDaa: startDaa, db });
out.runId = gw.runId; out.recovery = await gw.recovered; if (out.recovery.length) log(`recovery: ${JSON.stringify(out.recovery)}`);
let gs = await gw.listen(0, "127.0.0.1");
const mkWallet = () => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "5000000", dailyCapSompi: "300000000", db, walletId: process.env.WALLET_ID ?? "live-payer-v2", allowedPayTo: [kit.serverPayoutAddress],
  fetch: createDevLoopbackFetch({ [O]: `http://127.0.0.1:${gs.address().port}` }), liveKit: kit,
  batch: { maxDepositSompi: DEPOSIT, maxRefundHorizonDaa: (DELTA + 1000n).toString(), allowedResources: [`${O}/weather/brisbane`], allowedServerPublicKeys: [kit.serverPublicKey] } });
let wallet = mkWallet();
const RESTART_AT = Number(process.env.RESTART_AT ?? -1);

out.calls = [];
for (let i = 0; i < N; i++) {
  if (i === RESTART_AT) {
    // Restart mid-flow: drop gateway + wallet objects and their in-memory state, close SQLite, reopen, rebuild.
    gw.close(); await new Promise((r) => gs.close(r)); db.close();
    db = openDb((process.env.LIVE_BATCH_DB ?? new URL("../../data/live-batch.sqlite", import.meta.url).pathname));
    gw = createGateway(cfg, { chain: "real", liveKit: kit, nowDaa: await kit.virtualDaa(), db });
    const rec = await gw.recovered; gs = await gw.listen(0, "127.0.0.1"); wallet = mkWallet();
    log(`RESTART before call ${i}: gateway+wallet rebuilt from SQLite; server journal ${gw.store.journalStats?.()} rows; recovery ${JSON.stringify(rec)}`);
  }
  const t0 = Date.now();
  try { const r = await wallet.fetch(`${O}/weather/brisbane`);
    out.calls.push({ i, status: r.response.status, opened: r.payment?.openedChannel, charged: r.settlement?.chargedAmount, ms: Date.now() - t0 });
  } catch (e) { out.calls.push({ i, error: String(e.message ?? e), details: e.details, ms: Date.now() - t0 }); log(`call ${i} failed: ${e.message}`); break; }
  log(`call ${i}: ${JSON.stringify(out.calls.at(-1))}`);
}
const artifacts = () => [...kit.batchArtifactsByTxid.entries()].map(([txid, a]) => ({ kind: a.kind ?? a.operation, txid }));
out.artifactsAfterCalls = artifacts();
for (let k = 0; process.env.SKIP_CLAIM !== "1"; k++) { // claim needs the covenant lineage at the configured confirmation depth; retry until it is
  try { out.claim = await gw.claimAll(); log(`claim: ${JSON.stringify(out.claim)}`); break; }
  catch (e) { log(`claim attempt ${k} failed: ${e.message}`, { details: e.details }); if (k >= 20 || !/confirmation threshold|not yet|unavailable/.test(e.message)) break; await new Promise((r) => setTimeout(r, 15000)); } }
out.dashboard = gw.ledger.summary({ runId: gw.runId }); delete out.dashboard.recent;
out.balancesAfterClaim = { payer: await bal(kit.fundingAddress), merchant: await bal(kit.serverPayoutAddress) };
log(`after claim balances ${JSON.stringify(out.balancesAfterClaim, (k, v) => typeof v === "bigint" ? String(v) : v)}`);
if (WAIT_REFUND) {
  const deadline = Date.now() + 30 * 60_000;
  for (;;) { const d = await kit.virtualDaa(); const ready = await wallet.client.listRefundableChannels(d.toString());
    if (ready.length) { out.refundReadyDaa = d; break; } if (Date.now() > deadline) { log("refund not reachable within 30 min"); break; }
    log(`waiting for refund timeout: DAA ${d}`); await new Promise((r) => setTimeout(r, 30000)); }
  try { out.refund = await wallet.refundAll((await kit.virtualDaa()).toString()); log(`refund: ${JSON.stringify(out.refund)}`); } catch (e) { log(`refund failed: ${e.message}`, { details: e.details }); }
}
out.artifacts = artifacts();
await new Promise((r) => setTimeout(r, 5000));
out.balancesAfter = { payer: await bal(kit.fundingAddress), merchant: await bal(kit.serverPayoutAddress) };
log(`final balances ${JSON.stringify(out.balancesAfter, (k, v) => typeof v === "bigint" ? String(v) : v)}`);
out.wallet = wallet.report(); delete out.wallet.spends;
save(); gw.close(); gs.close(); up.close(); db.close(); await rpc.disconnect();
