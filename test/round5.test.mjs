// Round 5 regressions (audits CONSOLIDATED-R5: pricing, quorum, depth preflight, pending expiry, journal replay).
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
import { openDb, createPersistentServerStore } from "../src/store.mjs";
import { withMinDepth } from "../src/live/pnn-deps.mjs";

const open = []; after(() => open.forEach((f) => f()));
const O = "https://api.demo.test", PAY = "kaspatest:payout";
const raw = (over = {}) => ({ network: "kaspa:testnet-10", publicOrigin: O, payTo: PAY, upstream: "", listen: {},
  dashboard: { path: "/_x402/dashboard", token: "t" }, batch: { minDepositSompi: "4000000", claimReserveSompi: "2000000", refundTimeoutDeltaDaa: "900" },
  routes: [{ match: "GET /weather/*", scheme: "batch-settlement", priceSompi: "50000" }], ...over });
const exactCfg = (U, over = {}) => validateConfig({ ...raw(), batch: undefined, upstream: U, routes: [{ match: "GET /weather/*", scheme: "exact", priceSompi: "10000000" }], ...over });
const batchCfg = (U, batch = {}, over = {}) => validateConfig({ ...raw(), upstream: U, settlement: { minClaimNetSompi: "1000000" }, batch: { ...raw().batch, openChargeSompi: "3000000", ...batch }, ...over });
const dbPath = () => join(mkdtempSync(join(tmpdir(), "x402r5-")), "g.sqlite");
async function up(server = createUpstream()) { server.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r)); open.push(() => { server.closeAllConnections?.(); server.close(); }); return `http://127.0.0.1:${server.address().port}`; }
async function start(cfg, opts, { sigs } = {}) { const gw = createGateway(cfg, opts);
  const s = http.createServer((req, res) => { if (sigs && req.headers["payment-signature"]) sigs.push(req.headers["payment-signature"]); gw.handler(req, res); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r)); open.push(() => { s.closeAllConnections?.(); s.close(); gw.close(); }); return { gw, s, base: `http://127.0.0.1:${s.address().port}` }; }
const exactWallet = (base, extra = {}) => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: createDevLoopbackFetch({ [O]: base }), ...extra });
const batchWallet = (world, base) => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY],
  fetch: createDevLoopbackFetch({ [O]: base }), mockWorld: world,
  batch: { maxDepositSompi: "20000000", allowedResources: [`${O}/weather/brisbane`], allowedServerPublicKeys: [world.serverPublicKey], minRefundLeadDaa: "1" } });
const challengeAmount = async (base) => { const ch = await fetch(`${base}/weather/brisbane`); assert.equal(ch.status, 402);
  const req = JSON.parse(Buffer.from(ch.headers.get("payment-required"), "base64").toString()); return (req.accepts.find((x) => x.scheme === "batch-settlement") ?? req.accepts[0]).amount; };
const sigFor = (id, extra = {}) => ({ "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: { amount: "50000" }, payload: { channelId: id, ...extra } })).toString("base64") });
async function spyPaidAmounts(fn) { const { DirectModeServer } = await import("@kaspa-x402/server"); const orig = DirectModeServer.prototype.handlePaidRequest; const seen = [];
  DirectModeServer.prototype.handlePaidRequest = async function (req) { seen.push(req.paymentAmount); return { status: 402, headers: {}, body: { error: "spy" } }; };
  try { await fn(); } finally { DirectModeServer.prototype.handlePaidRequest = orig; } return seen; }

test("R5-M1: open charge below the claim minimum is refused at startup", async () => {
  const U = await up();
  assert.throws(() => createGateway(batchCfg(U, { openChargeSompi: "2500000" }), { mockWorld: createMockBatchWorld(), db: openDb(dbPath()), refundTimeoutDaa: "5000" }), /openChargeSompi .* must be >=/);
});

test("R5-M1: a client whose channel is still below the minimum is CHALLENGED at the open price it will be charged", async () => {
  const U = await up(); const db = openDb(dbPath()), world = createMockBatchWorld();
  const a = await start(batchCfg(U), { mockWorld: world, db, refundTimeoutDaa: "5000" });
  assert.equal((await batchWallet(world, a.base).fetch(`${O}/weather/brisbane`)).response.status, 200);
  const [c] = await a.gw.store.listChannels(); const id = String(c.channelId ?? c.id).toLowerCase();
  assert.equal(await challengeAmount(a.base), "50000", "healthy channel: route price offered");
  const real = a.gw.store.loadChannel.bind(a.gw.store); // failed open: same channel, active, charged 0
  a.gw.store.loadChannel = async (x) => { const v = await real(x); return v && String(x).toLowerCase() === id ? { ...v, chargedCumulativeAmount: "0" } : v; };
  assert.equal(await challengeAmount(a.base), "3000000", "challenge = price the paid request will be judged at");
  const seen = await spyPaidAmounts(() => fetch(`${a.base}/weather/brisbane`, { headers: sigFor(id) }));
  assert.deepEqual(seen, ["3000000"]);
});

test("R5-L1: raising the claim fee after a restart does not charge an already-opened channel the open price again", async () => {
  const U = await up(); const p = dbPath(), world = createMockBatchWorld();
  const a = await start(batchCfg(U), { mockWorld: world, db: openDb(p), refundTimeoutDaa: "5000" });
  assert.equal((await batchWallet(world, a.base).fetch(`${O}/weather/brisbane`)).response.status, 200);
  const [c] = await a.gw.store.listChannels(); const id = String(c.channelId ?? c.id).toLowerCase();
  a.gw.close();
  const b = await start(batchCfg(U, { claimReserveSompi: "2500000", openChargeSompi: "3500000" }), { mockWorld: world, db: openDb(p), refundTimeoutDaa: "5000" });
  await b.gw.store.ready;
  const seen = await spyPaidAmounts(() => fetch(`${b.base}/weather/brisbane`, { headers: sigFor(id) }));
  assert.deepEqual(seen, ["50000"], "threshold recorded at open is honoured");
});

test("R5-M1 (protocol): the per-IP cap uses the same rule as pricing - an open-charged channel after a claim does not block a new open", async () => {
  const U = await up(); const db = openDb(dbPath()), world = createMockBatchWorld();
  const a = await start(batchCfg(U, { maxSubMinimumChannelsPerClient: 1 }), { mockWorld: world, db, refundTimeoutDaa: "5000" });
  assert.equal((await batchWallet(world, a.base).fetch(`${O}/weather/brisbane`)).response.status, 200);
  const claim = await a.gw.claimAll(); assert.ok(claim.claims[0]?.txid, JSON.stringify(claim));
  const r = await fetch(`${a.base}/weather/brisbane`, { headers: sigFor("cd".repeat(32), { fundingTransaction: "00" }) });
  assert.notEqual(r.status, 429, "claimed residue is not counted as a sub-minimum channel");
});

test("R5-M2: quorum min-depth fails closed when fewer than `required` authorities answer the second round", async () => {
  const ok = (n) => ({ client: { confirmAcceptedTransaction: async () => ({ confirmationCount: n }) } });
  const down = { client: { confirmAcceptedTransaction: async () => { throw new Error("timeout"); } } };
  const corr = withMinDepth({ confirmAcceptedTransaction: async () => ({ confirmationCount: 500 }) }, [ok(500), down, down], 2);
  await assert.rejects(corr.confirmAcceptedTransaction("t"), /failing closed/);
  const corr2 = withMinDepth({ confirmAcceptedTransaction: async () => ({ confirmationCount: 500 }) }, [ok(500), ok(90), down], 2);
  assert.equal((await corr2.confirmAcceptedTransaction("t")).confirmationCount, 90);
});

test("R5-M3: discoverCovenantLineage depth is the minimum across authorities (and fails closed without `required` answers)", async () => {
  const lin = (g, t) => ({ addedChainBlocks: [{ blockHash: "b1", genesisAcceptance: { confirmationCount: g }, transitions: [{ acceptance: { confirmationCount: t } }] }] });
  const A = (g, t) => ({ client: { discoverCovenantLineage: async () => lin(g, t) } });
  const down = { client: { discoverCovenantLineage: async () => { throw new Error("down"); } } };
  const corr = withMinDepth({ discoverCovenantLineage: async () => lin(400, 300) }, [A(400, 300), A(120, 80)], 2);
  const r = await corr.discoverCovenantLineage({});
  assert.equal(r.addedChainBlocks[0].genesisAcceptance.confirmationCount, 120);
  assert.equal(r.addedChainBlocks[0].transitions[0].acceptance.confirmationCount, 80);
  await assert.rejects(withMinDepth({ discoverCovenantLineage: async () => lin(400, 300) }, [A(400, 300), down], 2).discoverCovenantLineage({}), /failing closed/);
});

test("R5-M4: depth-gated mode without a depth proof fails closed BEFORE broadcast (health alone is not enough)", async () => {
  const U = await up(); const db = openDb(dbPath());
  const a = await start(exactCfg(U, { exactFinality: "confirmed" }), { db, settleReplayDelaysMs: [] });
  const claims = []; const orig = a.gw.store.claimExactSettlement.bind(a.gw.store);
  a.gw.store.claimExactSettlement = async (...x) => { claims.push(x[0]?.transactionId); return orig(...x); };
  const r = await exactWallet(a.base, { pendingRetryDelaysMs: [] }).fetch(`${O}/weather/brisbane`).then((x) => x.response.status, (e) => e.message);
  assert.notEqual(r, 200);
  assert.ok(a.gw.ledger.entries.some((e) => e.outcome === "depth-unavailable"), JSON.stringify(a.gw.ledger.entries.map((e) => e.outcome)));
  assert.equal(claims.length, 0, "nothing claimed / broadcast");
});

test("R5-L3: a held pending payment expires to a refund-due queue; the same payment then gets 410, and the refund is recorded", async () => {
  const U = await up(); const db = openDb(dbPath()); const sigs = [];
  const a = await start(exactCfg(U, { exactFinality: "confirmed", exactPendingTtlMs: 60000 }), { db, depthPreflight: async () => {}, settleReplayDelaysMs: [] }, { sigs });
  const st = a.gw.store; st.acceptExactSettlement = async () => { throw new Error("selected-chain positions ended before the pinned checkpoint"); };
  await exactWallet(a.base, { pendingRetryDelaysMs: [] }).fetch(`${O}/weather/brisbane`).catch(() => {});
  const [p] = a.gw.pendingExact(); assert.ok(p?.txid, "held as pending");
  assert.deepEqual(a.gw.expirePending(Date.now()), [], "not before the TTL");
  assert.deepEqual(a.gw.expirePending(Date.now() + 61_000), [p.txid]);
  assert.deepEqual(a.gw.pendingExact(), []);
  assert.equal(a.gw.refundsDue()[0].status, "refund-due"); assert.equal(a.gw.refundsDue()[0].amountSompi, "10000000");
  const r = await fetch(`${a.base}/weather/brisbane`, { headers: { "payment-signature": sigs.at(-1) } });
  assert.equal(r.status, 410); assert.equal((await r.json()).error, "payment_expired_refund_due");
  a.gw.markRefunded(p.txid, "ef".repeat(32));
  assert.equal(a.gw.refundsDue()[0].status, "refunded");
  assert.ok(a.gw.ledger.entries.some((e) => e.outcome === "refunded" && e.txid === p.txid));
});

test("R5-M2 (specialist): journal replay never leaves the global Date frozen while it awaits", async () => {
  const U = await up(); const p = dbPath();
  const a = await start(exactCfg(U), { db: openDb(p) });
  assert.equal((await exactWallet(a.base).fetch(`${O}/weather/brisbane`)).response.status, 200);
  a.gw.close();
  const { MemoryServerChannelStore } = await import("@kaspa-x402/server");
  const D0 = globalThis.Date; const names = Object.getOwnPropertyNames(MemoryServerChannelStore.prototype).filter((n) => /^(claimExactSettlement|acceptExactSettlement|recordExactSettlementBroadcast|beginExactHandler|recordExactHandlerResult|commitExactPayment)$/.test(n));
  const saved = names.map((n) => [n, MemoryServerChannelStore.prototype[n]]); let sawFrozen = 0;
  for (const [n, f] of saved) MemoryServerChannelStore.prototype[n] = function (...x) { const r = f.apply(this, x); return (async () => { await new Promise((ok) => setTimeout(ok, 3)); return r; })(); };
  const iv = setInterval(() => { if (globalThis.Date !== D0) sawFrozen++; }, 1);
  try { const s = createPersistentServerStore(openDb(p)); const res = await s.ready; assert.equal(res.errors.length, 0, JSON.stringify(res.errors)); assert.ok(res.replayed > 0); }
  finally { clearInterval(iv); for (const [n, f] of saved) MemoryServerChannelStore.prototype[n] = f; }
  assert.equal(sawFrozen, 0, "other code never observed the frozen Date");
});

test("R5-M3 (specialist): a journal replay error fails closed - no paid route is served", async () => {
  const U = await up(); const p = dbPath();
  const a = await start(exactCfg(U), { db: openDb(p) });
  assert.equal((await exactWallet(a.base).fetch(`${O}/weather/brisbane`)).response.status, 200);
  a.gw.close();
  const db = openDb(p); db.prepare("INSERT INTO store_journal (ns, at, method, args) VALUES ('server-channels', ?, 'commitExactPayment', '[{}]')").run(Date.now());
  const b = await start(exactCfg(U), { db });
  const res = await b.gw.store.ready; assert.ok(res.errors.length >= 1);
  const r = await fetch(`${b.base}/weather/brisbane`); assert.equal(r.status, 503); assert.equal((await r.json()).error, "gateway_state_unavailable");
  await assert.rejects(b.gw.store.claimExactSettlement({ transactionId: "aa".repeat(32) }), /fail closed/);
});
