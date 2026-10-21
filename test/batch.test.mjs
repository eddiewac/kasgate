import { test, after } from "node:test";
const open = []; after(() => open.forEach((f) => f()));
import assert from "node:assert/strict";
import { createUpstream } from "../src/demo-upstream.mjs";
import { createGateway } from "../src/gateway.mjs";
import { validateConfig } from "../src/config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "../src/agent-wallet.mjs";
import { createMockBatchWorld } from "../src/mock-batch.mjs";

const O = "https://api.demo.test";
const PAY = "kaspatest:payout";
const cfgRaw = (over = {}) => ({ network: "kaspa:testnet-10", defaultScheme: "exact", publicOrigin: O, payTo: PAY, upstream: "", listen: {},
  dashboard: { path: "/d", token: "t" }, batch: { minDepositSompi: "4000000", claimReserveSompi: "2000000", refundTimeoutDeltaDaa: "900" },
  routes: [{ match: "GET /weather/*", scheme: "batch-settlement", priceSompi: "50000" }, { match: "GET /premium/*", priceSompi: "10000000" }], ...over });

async function setup({ wallet = {}, batch = {} } = {}) {
  const up = createUpstream(); let hits = 0; up.on("request", () => hits++);
  up.listen(0, "127.0.0.1"); await new Promise((r) => up.once("listening", r));
  const cfg = validateConfig({ ...cfgRaw(), upstream: `http://127.0.0.1:${up.address().port}` });
  const world = createMockBatchWorld();
  const gw = createGateway(cfg, { mockWorld: world }); const gs = await gw.listen(0, "127.0.0.1");
  const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "100000", dailyCapSompi: "10000000", allowedPayTo: [PAY],
    fetch: createDevLoopbackFetch({ [O]: `http://127.0.0.1:${gs.address().port}` }), mockWorld: world, ...wallet,
    batch: { maxDepositSompi: "4000000", allowedResources: [`${O}/weather/brisbane`, `${O}/weather/sydney`], allowedServerPublicKeys: [world.serverPublicKey], ...batch } });
  const close = () => { gs.close(); up.close(); }; open.push(close);
  return { gw, w, world, hits: () => hits, close };
}

test("config: batch network pinned to TN10 (TN12/mainnet refused); exact < 0.1 KAS refused; batch < 0.1 KAS allowed", () => {
  assert.throws(() => validateConfig(cfgRaw({ batch: { ...cfgRaw().batch, network: "kaspa:testnet-12" } })), /testnet-10/);
  assert.throws(() => validateConfig(cfgRaw({ network: "kaspa:mainnet" })), /Testnet-10 only/);
  assert.throws(() => validateConfig(cfgRaw({ routes: [{ match: "GET /x", priceSompi: "50000" }] })), /batch-settlement for cheaper/);
  assert.equal(validateConfig(cfgRaw()).routes[0].priceSompi, "50000");
  assert.throws(() => validateConfig(cfgRaw({ batch: undefined })), /batch\.minDepositSompi/);
});
test("real chain + batch route fails closed (live batch adapters not wired)", () => {
  assert.throws(() => createGateway(validateConfig(cfgRaw()), { chain: "real" }), /require liveKit/);
});
test("deposit open -> many cheap calls -> seller claim -> payer refund (accounting balances)", async () => {
  const s = await setup();
  const N = 10;
  for (let i = 0; i < N; i++) { const r = await s.w.fetch(`${O}/weather/brisbane`);
    assert.equal(r.response.status, 200); assert.equal(r.payment.scheme, "batch-settlement"); assert.equal(r.payment.openedChannel, i === 0); }
  assert.equal(s.hits(), N);
  const sum = s.gw.ledger.summary(); assert.equal(sum.batchAccruedSompi, String(N * 50000));
  const { claims } = await s.gw.claimAll(); assert.equal(claims.length, 1); assert.equal(claims[0].claimAmount, String(N * 50000)); assert.ok(claims[0].txid);
  assert.equal(s.gw.ledger.summary().batchUnclaimedSompi, "0");
  assert.equal((await s.w.refundAll()).length, 0, "no refund before timeout");
  s.world.chainProvider.advance(2000);
  const refunds = await s.w.refundAll(); assert.equal(refunds.length, 1);
  assert.equal(BigInt(refunds[0].refundAmount) + BigInt(claims[0].claimAmount), 4000000n, "deposit = claimed + refunded");
  assert.equal(s.w.report().vouchersTodaySompi, String(N * 50000)); assert.equal(s.w.report().spentTodaySompi, "4000000", "M1: deposit counts toward daily cap");
  s.close();
});
test("per-call cap applies to batch vouchers", async () => {
  const s = await setup({ wallet: { perRequestMaxSompi: "40000" } });
  await assert.rejects(s.w.fetch(`${O}/weather/brisbane`)); assert.equal(s.hits(), 0); s.close();
});
test("deposit cap applies to escrow open", async () => {
  const s = await setup({ batch: { maxDepositSompi: "3000000" } });
  await assert.rejects(s.w.fetch(`${O}/weather/brisbane`)); assert.equal(s.hits(), 0); s.close();
});
test("daily voucher cap stops cheap calls once reached", async () => {
  const s = await setup({ wallet: { dailyVoucherCapSompi: "150000" } });
  for (let i = 0; i < 3; i++) await s.w.fetch(`${O}/weather/brisbane`);
  await assert.rejects(s.w.fetch(`${O}/weather/brisbane`), (e) => e.code === "daily_cap");
  assert.equal(s.hits(), 3); s.close();
});
test("M1: deposit counts toward the daily cap (deposit > remaining cap is refused)", async () => {
  const s = await setup({ wallet: { dailyCapSompi: "3999999" } });
  await assert.rejects(s.w.fetch(`${O}/weather/brisbane`), (e) => e.code === "daily_cap" && /deposit/.test(e.message)); assert.equal(s.hits(), 0); s.close();
});
test("resource allowlist: batch resource not listed is refused", async () => {
  const s = await setup();
  await assert.rejects(s.w.fetch(`${O}/weather/perth`)); assert.equal(s.hits(), 0); s.close();
});
test("exact and batch routes coexist on one gateway", async () => {
  const s = await setup({ wallet: { perRequestMaxSompi: "10000000", dailyCapSompi: "50000000" } });
  assert.equal((await s.w.fetch(`${O}/weather/brisbane`)).payment.scheme, "batch-settlement");
  assert.equal((await s.w.fetch(`${O}/premium/x`)).payment.scheme, "exact");
  s.close();
});

// Live finding (TN10 regression 2026-10-21): after a restart the gateway advertised a NEW refundTimeoutDaa, and
// upstream clients only reuse a channel with the identical timeout -> every payer opened and funded a new channel.
import { openDb } from "../src/store.mjs";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
test("restart re-advertises the persisted rolling refund timeout (channel reuse across restart)", async () => {
  const cfg = validateConfig({ ...cfgRaw(), upstream: "http://127.0.0.1:9" }); const p = join(mkdtempSync(join(tmpdir(), "x402t-")), "g.sqlite");
  const world = createMockBatchWorld(); let db = openDb(p);
  const g1 = createGateway(cfg, { mockWorld: world, db, nowDaa: 1000 }); const t1 = g1.refundTimeout(); g1.close(); db.close();
  db = openDb(p); const g2 = createGateway(cfg, { mockWorld: world, db, nowDaa: 1030 }); assert.equal(g2.refundTimeout(), t1, "same timeout within one rotation step"); g2.close(); db.close();
  db = openDb(p); const g3 = createGateway(cfg, { mockWorld: world, db, nowDaa: 1000 + 900 }); assert.notEqual(g3.refundTimeout(), t1, "rotates once a step has passed"); g3.close(); db.close();
});
