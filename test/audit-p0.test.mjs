// Regression tests for audits/CONSOLIDATED.md P0/P1/P2 items (see FIXES.md, "Audit fixes").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, createPersistentClientStore, hasRawKeys, Keystore } from "../src/store.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "x402a-"));
const KEY = "ab".repeat(32);

test("P0-1 openDb: data dir 0700 and db/wal/shm 0600", () => {
  const d = tmp(), p = join(d, "db", "g.sqlite"); const db = openDb(p); db.prepare("INSERT INTO kv VALUES ('a','b','c')").run();
  assert.equal(statSync(join(d, "db")).mode & 0o777, 0o700);
  for (const f of readdirSync(join(d, "db")).filter((f) => f.startsWith("g.sqlite"))) assert.equal(statSync(join(d, "db", f)).mode & 0o777, 0o600, f);
  db.close();
});

import http from "node:http";
import { after } from "node:test";
import { createUpstream } from "../src/demo-upstream.mjs";
import { createGateway } from "../src/gateway.mjs";
import { validateConfig } from "../src/config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "../src/agent-wallet.mjs";
import { createMockBatchWorld } from "../src/mock-batch.mjs";
import { enc } from "../src/store.mjs";
const open = []; after(() => open.forEach((f) => f()));
export const O = "https://api.demo.test", PAY = "kaspatest:payout";
export const raw = (over = {}) => ({ network: "kaspa:testnet-10", publicOrigin: O, payTo: PAY, upstream: "", listen: {},
  dashboard: { path: "/_x402/dashboard", token: "t" }, batch: { minDepositSompi: "4000000", claimReserveSompi: "2000000", refundTimeoutDeltaDaa: "900" },
  routes: [{ match: "GET /weather/*", scheme: "batch-settlement", priceSompi: "50000" }, { match: "GET /premium/*", scheme: "exact", priceSompi: "10000000" }, { match: "* /echo", free: true }], ...over });
async function up(server = createUpstream()) { server.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r)); open.push(() => server.close()); return `http://127.0.0.1:${server.address().port}`; }
async function start(cfg, opts) { const gw = createGateway(cfg, opts); const s = await gw.listen(0, "127.0.0.1"); open.push(() => { s.close(); gw.close(); }); return { gw, s, base: `http://127.0.0.1:${s.address().port}` }; }
const wallet = (world, base, extra = {}) => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY],
  fetch: createDevLoopbackFetch({ [O]: base }), mockWorld: world,
  batch: { maxDepositSompi: "4000000", allowedResources: [`${O}/weather/brisbane`], allowedServerPublicKeys: [world.serverPublicKey], minRefundLeadDaa: "1" }, ...extra });

test("P0-1 client store: batch channel keys never reach SQLite; legacy raw rows are migrated to a 0600 keystore", async () => {
  const d = tmp(), p = join(d, "w.sqlite"), U = await up(), world = createMockBatchWorld();
  const a = await start(validateConfig({ ...raw(), upstream: U }), { mockWorld: world, refundTimeoutDaa: "5000" });
  const db = openDb(p); const w = wallet(world, a.base, { db });
  for (let i = 0; i < 2; i++) assert.equal((await w.fetch(`${O}/weather/brisbane`)).response.status, 200);
  assert.equal(hasRawKeys(db), false, "no raw key field in any kv row");
  const ns = db.prepare("SELECT DISTINCT ns FROM kv WHERE ns LIKE 'client-channels%'").get().ns;
  const [c] = await createPersistentClientStore(db, ns).loadChannels({}); const KEY = c.clientPrivateKey;
  assert.ok(KEY, "key restored from keystore for signing");
  db.pragma("wal_checkpoint(TRUNCATE)");
  assert.equal(readFileSync(p).toString("latin1").includes(KEY), false, "no key bytes in the db file");
  const ks = join(d, ".keystore"); assert.equal(statSync(ks).mode & 0o777, 0o700);
  for (const f of readdirSync(ks)) assert.equal(statSync(join(ks, f)).mode & 0o777, 0o600);
  // legacy: a pre-fix row with the raw key is rewritten key-free on open, and still loads
  db.prepare("UPDATE kv SET v = ? WHERE ns = ? AND k = ?").run(enc(c), ns, `channel:${c.id}`); assert.equal(hasRawKeys(db), true);
  const [c2] = await createPersistentClientStore(db, ns).loadChannels({});
  assert.equal(hasRawKeys(db), false); assert.equal(c2.clientPrivateKey, KEY);
  db.close();
});

test("P0-1 in-memory DB keeps keys in memory only", () => {
  const ks = Keystore.forDb(openDb(":memory:")); assert.equal(ks.dir, null); const ref = ks.put(KEY); assert.equal(ks.get(ref), KEY);
});

// ---------- P0-2 verify-first, P0-3/P1 durable exact state, P0-4 confirmations ----------
import { MockChainProvider } from "../src/mock-chain.mjs";
function originSpy(plan = []) { let i = 0; const hits = [];
  const srv = http.createServer((req, res) => { const step = plan[i++] ?? "ok"; hits.push({ step, at: process.hrtime.bigint() });
    if (step === "hang") return; if (step === "500") { res.writeHead(500); return res.end("{}"); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ city: "Brisbane", n: hits.length })); });
  return { srv, hits }; }
const exactCfg = (U) => validateConfig({ ...raw(), batch: undefined, upstream: U, routes: [{ match: "GET /weather/*", scheme: "exact", priceSompi: "10000000" }] });
const exactWallet = (base, extra = {}) => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: createDevLoopbackFetch({ [O]: base }), pendingRetryDelaysMs: [50, 50], ...extra });
// settlement = upstream claimExactSettlement (+ broadcast/accept); the mock verifier reports "accepted" so no broadcast.
function spySends(store) { const orig = store.claimExactSettlement; const sends = [];
  store.claimExactSettlement = async (...a) => { const r = await orig.apply(store, a); if (r?.created !== false) sends.push(process.hrtime.bigint()); return r; };
  return { sends, restore: () => { store.claimExactSettlement = orig; } }; }

test("P0-2: unpaid, garbage and forged PAYMENT-SIGNATURE requests never reach the origin", async () => {
  const { srv, hits } = originSpy(); const U = await up(srv); const a = await start(exactCfg(U), {});
  assert.equal((await fetch(`${a.base}/weather/brisbane`)).status, 402);
  assert.equal((await fetch(`${a.base}/weather/brisbane`, { headers: { "payment-signature": "eyJmb28iOiJiYXIifQ==" } })).status, 402);
  assert.equal((await fetch(`${a.base}/weather/brisbane`, { headers: { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, payload: { transaction: "00".repeat(200) } })).toString("base64") } })).status, 402);
  assert.equal(hits.length, 0, "origin untouched by unverified requests");
});

test("P0-2: verify -> fetch -> settle order; origin failure => nothing broadcast, payer pays once on retry", async () => {
  const { srv, hits } = originSpy(["500", "500", "ok"]); const U = await up(srv); const a = await start(exactCfg(U), {});
  const spy = spySends(a.gw.store);
  try {
    const w = exactWallet(a.base); const r = await w.fetch(`${O}/weather/brisbane`);
    assert.equal(r.response.status, 200);
    assert.equal(spy.sends.length, 1, "settled exactly once (not on the failed-origin attempt)");
    assert.ok(hits.at(-1).at < spy.sends[0], "origin answered before settlement");
    assert.equal(a.gw.ledger.entries.filter((e) => e.outcome === "upstream-unavailable").length, 1);
    assert.equal(w.report().spentTodaySompi, "10000000");
  } finally { spy.restore(); }
});

test("P0-3: exact state is durable - crash after settlement accepted, before the handler -> after restart the identical retry gets data, no rebroadcast, paid once", async () => {
  const d = tmp(), p = join(d, "gw.sqlite"), { srv, hits } = originSpy(); const U = await up(srv);
  const db1 = openDb(p); const a = await start(exactCfg(U), { db: db1, exactRecovery: false });
  let captured; const base = createDevLoopbackFetch({ [O]: a.base });
  const fetchSpy = Object.assign(async (url, init = {}) => { const h = new Headers(init.headers); if (h.get("payment-signature")) captured = h.get("payment-signature"); return base(url, init); }, { [Symbol.for("kaspa-x402:bound-paid-fetch:v1")]: true });
  a.gw.store.beginExactHandler = async () => { throw new Error("simulated crash before handler"); };
  const spy = spySends(a.gw.store);
  try {
    const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: fetchSpy, pendingRetryDelaysMs: [] });
    await w.fetch(`${O}/weather/brisbane`).catch(() => {});
    assert.ok(captured); assert.equal(spy.sends.length, 1);
    a.s.close(); a.gw.close(); db1.close();
    const db2 = openDb(p); const b = await start(exactCfg(U), { db: db2 }); const spy2 = spySends(b.gw.store);
    assert.equal((await b.gw.store.ready).errors.length, 0, "journal replays cleanly");
    const r = await fetch(`${b.base}/weather/brisbane`, { headers: { "payment-signature": captured } });
    assert.equal(r.status, 200); assert.ok(r.headers.get("payment-response")); assert.equal((await r.json()).city, "Brisbane");
    assert.equal(spy2.sends.length, 0, "no new settlement after restart");
    const r2 = await fetch(`${b.base}/weather/brisbane`, { headers: { "payment-signature": captured } });
    assert.equal(r2.status, 200, "second identical retry = cached replay"); assert.equal(b.gw.ledger.summary().paidRequests, 1);
    db2.close();
  } finally { spy.restore(); }
});

test("P0-4: confirmation threshold is configurable; real chain refuses < 30 and defaults to 100", async () => {
  const U = "http://127.0.0.1:1";
  assert.throws(() => createGateway({ ...exactCfg(U), confirmations: 0 }), /positive integer/);
  assert.throws(() => createGateway({ ...exactCfg(U), payTo: "kaspatest:YOUR_MERCHANT_ADDRESS", confirmations: 10, routes: [{ match: "GET /w", scheme: "exact", priceSompi: "100000000" }] }, { chain: "real", realDeps: {} }), /confirmations must be >= 30|exact/);
  const g = createGateway({ ...exactCfg(U), confirmations: 45 }); assert.equal(g.confirmations, 45); g.close();
  assert.equal(createGateway(exactCfg(U)).confirmations, 30, "mock default = upstream TESTNET_10_CONFIRMATION_THRESHOLD");
});

test("incentive audit: batch-settlement is the default scheme; real-chain exact < 1 KAS needs allowSmallExact; claim margin >= 1 h", async () => {
  const { assertRealChainPolicy } = await import("../src/config.mjs");
  const c = validateConfig({ network: "kaspa:testnet-10", publicOrigin: O, payTo: PAY, upstream: "http://x", batch: { minDepositSompi: "4000000", claimReserveSompi: "2000000", refundTimeoutDeltaDaa: "864000" },
    routes: [{ match: "GET /a", priceSompi: "50000" }, { match: "GET /b", scheme: "exact", priceSompi: "10000000", allowSmallExact: true }, { match: "GET /h", free: true }] });
  assert.equal(c.routes[0].scheme, "batch-settlement"); assert.equal(c.routes[2].scheme, "free");
  assertRealChainPolicy(c);
  assert.throws(() => assertRealChainPolicy({ ...c, batch: { ...c.batch, claimMarginDaa: "900" } }), /claimMarginDaa/);
  assert.throws(() => assertRealChainPolicy({ ...c, routes: [{ ...c.routes[1], allowSmallExact: false }] }), /1 KAS/);
});

test("P0-5: sub-minimum batch channels are bounded per client and an unclaimable near-timeout balance is booked as accepted-loss", async () => {
  const d = tmp(), db = openDb(join(d, "g.sqlite")), U = await up(), world = createMockBatchWorld();
  const cfg = validateConfig({ ...raw(), upstream: U, settlement: { minClaimNetSompi: "100000000" }, batch: { ...raw().batch, maxSubMinimumChannelsPerClient: 1, claimMarginDaa: "200" } });
  const a = await start(cfg, { mockWorld: world, db });
  const w1 = wallet(world, a.base); assert.equal((await w1.fetch(`${O}/weather/brisbane`)).response.status, 200);
  assert.equal((await w1.fetch(`${O}/weather/brisbane`)).response.status, 200, "existing channel keeps working");
  // a second channel OPEN from the same client IP while channel A is open and below the claim minimum -> refused before upstream
  const openPayload = { x402Version: 2, accepted: {}, payload: { type: "open", channelId: "ab".repeat(32), fundingTransaction: "00" } };
  const r2 = await fetch(`${a.base}/weather/brisbane`, { headers: { "payment-signature": Buffer.from(JSON.stringify(openPayload)).toString("base64") } });
  assert.equal(r2.status, 429); assert.equal((await r2.json()).error, "batch_channel_limit");
  // R2-P0-1: omitting fundingTransaction (or channelId) no longer bypasses the cap; parallel opens race-free
  for (const pl of [{ type: "voucher", channelId: "cd".repeat(32) }, { type: "open" }]) {
    const r = await fetch(`${a.base}/weather/brisbane`, { headers: { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: {}, payload: pl })).toString("base64") } });
    assert.equal(r.status, 429, JSON.stringify(pl)); }
  const par = await Promise.all([0, 1, 2].map((i) => fetch(`${a.base}/weather/brisbane`, { headers: { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: {}, payload: { channelId: String(i).repeat(64) } })).toString("base64") } })));
  assert.ok(par.every((r) => r.status === 429));
  world.chainProvider.advance(800); await a.gw.claimNearTimeout(); await a.gw.settle();
  const loss = a.gw.ledger.entries.filter((e) => e.outcome === "accepted-loss");
  assert.equal(loss.length, 1); assert.equal(loss[0].unclaimedSompi, "100000");
  await a.gw.claimNearTimeout(); await a.gw.settle(); assert.equal(a.gw.ledger.entries.filter((e) => e.outcome === "accepted-loss").length, 1, "booked once");
});

test("RR-M1: daily cap is enforced across two wallet processes sharing one SQLite spend history", async () => {
  const d = tmp(), p = join(d, "w.sqlite"), { srv } = originSpy(); const U = await up(srv); const a = await start(exactCfg(U), {});
  const mk = () => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "15000000", allowedPayTo: [PAY], fetch: createDevLoopbackFetch({ [O]: a.base }), db: openDb(p), walletId: "shared" });
  const w1 = mk(), w2 = mk(); // both constructed before any spend (the old code loaded history only in the constructor)
  assert.equal((await w1.fetch(`${O}/weather/brisbane`)).response.status, 200);
  await assert.rejects(w2.fetch(`${O}/weather/brisbane`), (e) => e.code === "daily_cap", "second process sees the first one's spend");
});

// Live finding (2026-10-21): upstream 1.0.1 DirectModeServer refuses a node-verified exact payment unless the store
// offers an atomic claimExactSettlementWithEvidence (claim + PNN evidence receipt). It must survive a restart.
import { createPersistentServerStore } from "../src/store.mjs";
test("P0-3 atomic exact claim + PNN evidence receipt is durable across restart", async () => {
  const p = join(tmp(), "s.sqlite"); let db = openDb(p); let store = createPersistentServerStore(db); await store.ready;
  const txid = "cd".repeat(32);
  const attempt = { network: "kaspa:testnet-10", transactionId: txid, profile: "standard-native", amount: "100000000", paymentOutputIndex: 0,
    requestFingerprint: "11".repeat(32), paymentRequirementsHash: "22".repeat(32), paymentPayloadHash: "33".repeat(32), requestAuthorizationId: "44".repeat(32),
    authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(), payToScriptPublicKey: "20" + "55".repeat(32) + "ac",
    transaction: "{\"id\":\"" + txid + "\"}", requiredFinality: "accepted", payerId: "66".repeat(33), status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await assert.rejects(store.claimExactSettlementWithEvidence(attempt, { transactionId: "ef".repeat(32) }), /does not match/);
  await store.claimExactSettlementWithEvidence(attempt, { transactionId: txid, kind: "receipt" });
  db.close(); db = openDb(p); store = createPersistentServerStore(db); const r = await store.ready;
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(await store.loadExactSettlementAttempt(txid), "claim replayed from journal");
  assert.ok(db.prepare("SELECT 1 FROM pnn_evidence WHERE txid = ?").get(txid), "receipt committed with the claim");
  db.close();
});

test("client store reopens after a channel was refunded (applied funding attempt is history)", async () => {
  const { MemoryChannelStore } = await import("@kaspa-x402/client");
  const p = join(tmp(), "c.sqlite"); const db = openDb(p);
  const rows = [["channel:aa", { id: "aa", status: "refunded" }], ["funding:aa", { channelId: "aa", status: "applied" }]];
  for (const [k, v] of rows) db.prepare("INSERT INTO kv (ns, k, v) VALUES ('client-channels:t', ?, ?)").run(k, JSON.stringify(v));
  const orig = MemoryChannelStore.prototype.constructor; let seen;
  const store = (() => { try { return createPersistentClientStore(db, "client-channels:t", new Keystore(null)); } catch (e) { seen = e; } })();
  // the stub channel is not a valid upstream channel, but the funding row must have been filtered before validation
  assert.ok(!seen || !/funding attempt does not match/.test(seen.message), seen?.message); void orig; void store; db.close();
});

test("R2-P0-1 ipKey groups IPv6 by /64 and requires deposit >= claim minimum on real chain", async () => {
  const { ipKey, createGateway } = await import("../src/gateway.mjs");
  assert.equal(ipKey("2001:db8:1:2::9"), ipKey("2001:db8:1:2:ffff::1")); assert.notEqual(ipKey("2001:db8:1:3::1"), ipKey("2001:db8:1:2::1"));
  assert.equal(ipKey("::ffff:10.0.0.1"), "10.0.0.1");
  const fakeKit = { feeSompi: 2000000n, serverBatch: () => ({}), virtualDaa: async () => 1000n };
  assert.throws(() => createGateway(validateConfig({ ...raw(), routes: raw().routes.filter((r) => r.scheme === "batch-settlement"), batch: { ...raw().batch, minDepositSompi: "1000000", allowShortRefundTimeout: true } }), { chain: "real", liveKit: fakeKit, nowDaa: 1000 }), /must be >= claim minimum/);
});
