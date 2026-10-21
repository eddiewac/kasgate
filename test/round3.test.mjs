// Round 3 regressions (audits/round3-*.md; FIXES.md "Round 3").
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpstream } from "../src/demo-upstream.mjs";
import { createGateway } from "../src/gateway.mjs";
import { validateConfig } from "../src/config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "../src/agent-wallet.mjs";
import { createMockBatchWorld } from "../src/mock-batch.mjs";
import { openDb } from "../src/store.mjs";
import { withMinDepth } from "../src/live/pnn-deps.mjs";

const open = []; after(() => open.forEach((f) => f()));
const O = "https://api.demo.test", PAY = "kaspatest:payout";
const raw = (over = {}) => ({ network: "kaspa:testnet-10", publicOrigin: O, payTo: PAY, upstream: "", listen: {},
  dashboard: { path: "/_x402/dashboard", token: "t" }, batch: { minDepositSompi: "4000000", claimReserveSompi: "2000000", refundTimeoutDeltaDaa: "900" },
  routes: [{ match: "GET /weather/*", scheme: "batch-settlement", priceSompi: "50000" }], ...over });
const exactCfg = (U, over = {}) => validateConfig({ ...raw(), batch: undefined, upstream: U, routes: [{ match: "GET /weather/*", scheme: "exact", priceSompi: "10000000" }], ...over });
const tmpDb = () => openDb(join(mkdtempSync(join(tmpdir(), "x402r3-")), "g.sqlite"));
async function up(server = createUpstream()) { server.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r)); open.push(() => { server.closeAllConnections?.(); server.close(); }); return `http://127.0.0.1:${server.address().port}`; }
async function start(cfg, opts) { const gw = createGateway(cfg, opts); const s = await gw.listen(0, "127.0.0.1"); open.push(() => { s.closeAllConnections?.(); s.close(); gw.close(); }); return { gw, s, base: `http://127.0.0.1:${s.address().port}` }; }
const exactWallet = (base, extra = {}) => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: createDevLoopbackFetch({ [O]: base }), ...extra });
const batchWallet = (world, base, extra = {}) => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY],
  fetch: createDevLoopbackFetch({ [O]: base }), mockWorld: world,
  batch: { maxDepositSompi: "4000000", allowedResources: [`${O}/weather/brisbane`], allowedServerPublicKeys: [world.serverPublicKey], minRefundLeadDaa: "1" }, ...extra });
const sig = (payload) => ({ "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: {}, payload })).toString("base64") });

test("R3-M3: depth-gated mode - node cannot serve depth evidence -> verified but NOT broadcast (503); same payment later pays once", async () => {
  const U = await up(); const db = tmpDb(); let probes = 0;
  const a = await start(exactCfg(U, { exactFinality: "confirmed" }), { db, depthPreflight: async () => { probes++; if (probes === 1) throw new Error("selected-chain positions ended before the pinned checkpoint"); } });
  const claims = []; const orig = a.gw.store.claimExactSettlement.bind(a.gw.store);
  a.gw.store.claimExactSettlement = async (...x) => { claims.push(x[0]?.transactionId); return orig(...x); };
  const w = exactWallet(a.base, { pendingRetryDelaysMs: [30] });
  const r = await w.fetch(`${O}/weather/brisbane`);
  assert.equal(r.response.status, 200);
  const L = a.gw.ledger.entries;
  assert.equal(L.filter((e) => e.outcome === "depth-unavailable").length, 1, "first attempt refused before broadcast");
  assert.equal(L.filter((e) => e.outcome === "paid").length, 1); assert.equal(w.report().spentTodaySompi, "10000000", "charged once");
  assert.ok(probes >= 2); assert.equal(new Set(claims).size, 1, "a single settlement claim (one tx)");
});

test("R3-M3: broadcast but not provable at depth -> held pending (durable, 503 payment_pending), delivered on a retry of the SAME payment, charged once", async () => {
  const U = await up(); const db = tmpDb();
  const a = await start(exactCfg(U, { exactFinality: "confirmed" }), { db, depthPreflight: async () => {}, settleReplayDelaysMs: [10] });
  // the node keeps failing the depth re-verification after the broadcast for the first 3 settlement checks
  let fails = 3; const st = a.gw.store; const orig = st.acceptExactSettlement.bind(st);
  st.acceptExactSettlement = async (...x) => { if (fails-- > 0) throw new Error("selected-chain positions ended before the pinned checkpoint"); return orig(...x); };
  const seenPending = [];
  const w = exactWallet(a.base, { pendingRetryDelaysMs: [20, 20, 20] });
  const wf = w.fetch(`${O}/weather/brisbane`);
  const poll = setInterval(() => { for (const p of a.gw.pendingExact()) seenPending.push(p.txid); }, 5);
  const r = await wf; clearInterval(poll);
  assert.equal(r.response.status, 200);
  const L = a.gw.ledger.entries;
  assert.ok(L.filter((e) => e.outcome === "payment-pending").length >= 1, JSON.stringify(L.map((e) => e.outcome)));
  assert.ok(seenPending.length >= 1, "pending row was persisted");
  assert.equal(L.filter((e) => e.outcome === "pending-delivered").length, 1);
  assert.equal(L.filter((e) => e.outcome === "paid").length, 1); assert.equal(w.report().spentTodaySompi, "10000000", "charged once");
  assert.deepEqual(a.gw.pendingExact(), [], "pending cleared after delivery");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM kv WHERE ns='exact-pending'").get().n, 0);
});

test("R3-M1 (risk): a channel opened on a request that ends WITHOUT PAYMENT-RESPONSE (origin hang) still counts against the IP", async () => {
  const hang = http.createServer(() => {}); const U = await up(hang); const db = tmpDb(), world = createMockBatchWorld();
  const cfg = validateConfig({ ...raw(), upstream: U, settlement: { minClaimNetSompi: "100000000" }, batch: { ...raw().batch, maxSubMinimumChannelsPerClient: 1, claimMarginDaa: "200" } });
  const a = await start(cfg, { mockWorld: world, db, adapterTimeoutMs: 300 });
  const w1 = batchWallet(world, a.base);
  await w1.fetch(`${O}/weather/brisbane`).then((r) => r.response.status, (e) => e.message);
  const active = (await a.gw.store.listChannels()).filter((c) => c.status === "active").length;
  assert.equal(active, 1, "repro precondition: the open created an active channel");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM kv WHERE ns='batch-open-ip'").get().n, 1, "channel recorded against the IP without PAYMENT-RESPONSE");
  const r2 = await fetch(`${a.base}/weather/brisbane`, { headers: sig({ type: "open", channelId: "ab".repeat(32), fundingTransaction: "00" }) });
  assert.equal(r2.status, 429, "next new channel from the same IP refused before upstream");
});

test("R3 economic: the channel-opening call is charged >= claim minimum up front; later calls pay the normal price", async () => {
  const U = await up(); const db = tmpDb(), world = createMockBatchWorld();
  const cfg = validateConfig({ ...raw(), upstream: U, settlement: { minClaimNetSompi: "1000000" }, batch: { ...raw().batch, openChargeSompi: "3000000" } });
  const a = await start(cfg, { mockWorld: world, db, refundTimeoutDaa: "5000" });
  const ch = await fetch(`${a.base}/weather/brisbane`); assert.equal(ch.status, 402);
  const req = JSON.parse(Buffer.from(ch.headers.get("payment-required"), "base64").toString());
  assert.equal(req.accepts.find((x) => x.scheme === "batch-settlement")?.amount ?? req.accepts[0].amount, "3000000", "new client is offered the opening charge");
  const w = batchWallet(world, a.base, { batch: { maxDepositSompi: "20000000", allowedResources: [`${O}/weather/brisbane`], allowedServerPublicKeys: [world.serverPublicKey], minRefundLeadDaa: "1" } });
  for (let i = 0; i < 3; i++) assert.equal((await w.fetch(`${O}/weather/brisbane`)).response.status, 200);
  const paid = a.gw.ledger.entries.filter((e) => e.outcome === "paid").map((e) => e.amountSompi);
  assert.deepEqual(paid, ["3000000", "50000", "50000"]);
  const [c] = await a.gw.store.listChannels(); assert.equal(String(c.chargedCumulativeAmount), "3100000", "channel is above the claim minimum from call 1");
  const claim = await a.gw.claimAll(); assert.ok(claim.claims[0].txid, "claimable immediately: " + JSON.stringify(claim));
});

test("R3-M1 (protocol): quorum depth = MIN confirmationCount across authorities (never the first authority's)", async () => {
  const mkA = (n) => ({ client: { confirmAcceptedTransaction: async () => ({ txid: "t", confirmationCount: n }), findAcceptedTransaction: async () => ({ raw: 1, evidence: { confirmationCount: String(n) } }) } });
  const auth = [mkA(500), mkA(120), { client: { confirmAcceptedTransaction: async () => { throw new Error("down"); }, findAcceptedTransaction: async () => { throw new Error("down"); } } }];
  const corr = withMinDepth({ confirmAcceptedTransaction: async () => ({ txid: "t", confirmationCount: 500 }), findAcceptedTransaction: async () => ({ raw: 1, evidence: { confirmationCount: "500" } }) }, auth);
  assert.equal((await corr.confirmAcceptedTransaction("t")).confirmationCount, 120);
  assert.equal((await corr.findAcceptedTransaction("t")).evidence.confirmationCount, "120");
  const hi = withMinDepth({ confirmAcceptedTransaction: async () => ({ confirmationCount: 50 }) }, [mkA(500)]);
  assert.equal((await hi.confirmAcceptedTransaction("t")).confirmationCount, 50, "never raised");
});

test("R3-M3 (live shape): after the broadcast, re-verification at depth answers 402 -> payer gets 503 payment_pending (never a 402 that invites a 2nd payment); same payment later delivered, charged once", async () => {
  const U = await up(); const db = tmpDb();
  const a = await start(exactCfg(U, { exactFinality: "confirmed" }), { db, depthPreflight: async () => {}, settleReplayDelaysMs: [] });
  const st = a.gw.store; const origAccept = st.acceptExactSettlement.bind(st); let fails = 1;
  st.acceptExactSettlement = async (...x) => { if (fails-- > 0) throw new Error("PNN selected-chain positions ended before the pinned checkpoint"); return origAccept(...x); };
  const { DirectModeServer } = await import("@kaspa-x402/server"); const orig = DirectModeServer.prototype.handlePaidRequest; let depth402 = 3; // client retries: node re-verification fails BEFORE our verifier hook (no txid in ctx)
  DirectModeServer.prototype.handlePaidRequest = async function (req, h) {
    if (req.headers["payment-signature"] && fails <= 0 && depth402-- > 0) return { status: 402, headers: {}, body: { error: "invalid_transaction_state" } };
    return orig.call(this, req, h); };
  try {
    const w = exactWallet(a.base, { pendingRetryDelaysMs: [20, 20, 20, 20] });
    const r = await w.fetch(`${O}/weather/brisbane`);
    assert.equal(r.response.status, 200);
    const L = a.gw.ledger.entries;
    assert.ok(L.some((e) => e.outcome === "payment-pending" && e.error === "invalid_transaction_state"), JSON.stringify(L.map((e) => [e.outcome, e.error])));
    assert.equal(L.filter((e) => e.outcome === "pending-delivered").length, 1);
    assert.equal(L.filter((e) => e.outcome === "paid").length, 1); assert.equal(w.report().spentTodaySompi, "10000000", "charged once");
    assert.deepEqual(a.gw.pendingExact(), []);
  } finally { DirectModeServer.prototype.handlePaidRequest = orig; }
});

test("R4-M3: a channel left at charged 0 (failed open) pays the open charge again; the price comes from server state, not the client's accepted.amount", async () => {
  const U = await up(); const db = tmpDb(), world = createMockBatchWorld();
  const cfg = validateConfig({ ...raw(), upstream: U, settlement: { minClaimNetSompi: "1000000" }, batch: { ...raw().batch, openChargeSompi: "3000000" } });
  const a = await start(cfg, { mockWorld: world, db, refundTimeoutDaa: "5000" });
  const w = batchWallet(world, a.base, { batch: { maxDepositSompi: "20000000", allowedResources: [`${O}/weather/brisbane`], allowedServerPublicKeys: [world.serverPublicKey], minRefundLeadDaa: "1" } });
  assert.equal((await w.fetch(`${O}/weather/brisbane`)).response.status, 200);
  const [c] = await a.gw.store.listChannels(); const id = String(c.channelId ?? c.id).toLowerCase();
  const { DirectModeServer } = await import("@kaspa-x402/server"); const orig = DirectModeServer.prototype.handlePaidRequest; const seen = [];
  DirectModeServer.prototype.handlePaidRequest = async function (req) { seen.push(req.paymentAmount); return { status: 402, headers: {}, body: { error: "spy" } }; };
  const hdr = (amount) => ({ "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: { amount }, payload: { channelId: id } })).toString("base64") });
  try {
    await fetch(`${a.base}/weather/brisbane`, { headers: hdr("3000000") }); // healthy channel: client claims the open price
    const reloaded = await a.gw.store.loadChannel(id); // simulate a failed open: same channel, active, charged 0
    a.gw.store.loadChannel = async (x) => (String(x).toLowerCase() === id ? { ...reloaded, chargedCumulativeAmount: "0" } : null);
    await fetch(`${a.base}/weather/brisbane`, { headers: hdr("50000") }); // unfunded channel: client asks for the route price
  } finally { DirectModeServer.prototype.handlePaidRequest = orig; }
  assert.deepEqual(seen, ["50000", "3000000"], "healthy channel pays route price whatever the header says; charged-0 channel pays the open charge");
});
