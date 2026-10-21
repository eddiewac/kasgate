// Restart-recovery for a live TN10 batch run (H1): reopen data/live-batch.sqlite, let the gateway
// recover any open claim attempt (recoverAcceptedClaim), then refund the payer's channels if refundable.
// Usage: node src/live/recover-live-batch.mjs [--refund]   (Testnet-10 only; nothing is published)
import { connectTn10 } from "./sdk.mjs";
import { openDb } from "../store.mjs";
import { createLiveBatchKit } from "./batch-kit.mjs";
import { createGateway } from "../gateway.mjs";
import { validateConfig } from "../config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "../agent-wallet.mjs";
const run = JSON.parse((await import("node:fs")).readFileSync(new URL("../../data/live-batch-run.json", import.meta.url), "utf8"));
const { rpc } = await connectTn10(); const kit = await createLiveBatchKit({ rpc });
const db = openDb(new URL("../../data/live-batch.sqlite", import.meta.url).pathname);
const DELTA = BigInt(run.params.DELTA), DEPOSIT = String(run.params.DEPOSIT), PRICE = String(run.params.PRICE), O = "https://api.demo.test";
const cfg = validateConfig({ network: "kaspa:testnet-10", publicOrigin: O, payTo: kit.serverPayoutAddress, upstream: "http://127.0.0.1:9", listen: {},
  dashboard: { path: "/d", token: "t" }, batch: { minDepositSompi: DEPOSIT, claimReserveSompi: kit.feeSompi.toString(), refundTimeoutDeltaDaa: String(DELTA),
    claimMarginDaa: String(DELTA / 6n), rotateEveryDaa: String(DELTA / 12n), acceptedFinality: "confirmed", allowShortRefundTimeout: true },
  routes: [{ match: "GET /weather/*", scheme: "batch-settlement", priceSompi: PRICE }] });
const gw = createGateway(cfg, { chain: "real", liveKit: kit, nowDaa: await kit.virtualDaa(), db });
console.log("seeded", kit.seededOnStart, JSON.stringify(kit.seedErrors)); const recovery = await gw.recovered; console.log("recovery:", JSON.stringify(recovery));
const wallet = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "5000000", dailyCapSompi: "300000000", db, walletId: "live-payer", allowedPayTo: [kit.serverPayoutAddress],
  fetch: createDevLoopbackFetch({ [O]: "http://127.0.0.1:9" }), liveKit: kit,
  batch: { maxDepositSompi: DEPOSIT, maxRefundHorizonDaa: (DELTA + 1000n).toString(), allowedResources: [`${O}/weather/brisbane`], allowedServerPublicKeys: [kit.serverPublicKey] } });
if (process.argv.includes("--refund")) {
  try { const d = await kit.virtualDaa(); console.log("refund:", JSON.stringify(await wallet.refundAll(d.toString()))); } catch (e) { console.log("refund not possible yet:", e.message); }
}
gw.close(); db.close(); await rpc.disconnect(); process.exit(0);
