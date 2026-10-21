// Round 6 regressions (audits round6-*: per-channel 402 offer, pending TTL <= authorization lifetime, replay alert).
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

const open = []; after(() => open.forEach((f) => f()));
const O = "https://api.demo.test", PAY = "kaspatest:payout";
const raw = (over = {}) => ({ network: "kaspa:testnet-10", publicOrigin: O, payTo: PAY, upstream: "", listen: {},
  dashboard: { path: "/_x402/dashboard", token: "t" }, batch: { minDepositSompi: "4000000", claimReserveSompi: "2000000", refundTimeoutDeltaDaa: "900" },
  routes: [{ match: "GET /weather/*", scheme: "batch-settlement", priceSompi: "50000" }], ...over });
const exactCfg = (U, over = {}) => validateConfig({ ...raw(), batch: undefined, upstream: U, routes: [{ match: "GET /weather/*", scheme: "exact", priceSompi: "10000000" }], ...over });
const batchCfg = (U) => validateConfig({ ...raw(), upstream: U, settlement: { minClaimNetSompi: "1000000" }, batch: { ...raw().batch, openChargeSompi: "3000000" } });
const dbPath = () => join(mkdtempSync(join(tmpdir(), "x402r6-")), "g.sqlite");
async function up(server = createUpstream()) { server.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r)); open.push(() => { server.closeAllConnections?.(); server.close(); }); return `http://127.0.0.1:${server.address().port}`; }
async function start(cfg, opts) { const gw = createGateway(cfg, opts); const s = http.createServer((q, r) => gw.handler(q, r));
  await new Promise((r) => s.listen(0, "127.0.0.1", r)); open.push(() => { s.closeAllConnections?.(); s.close(); gw.close(); }); return { gw, base: `http://127.0.0.1:${s.address().port}` }; }
const exactWallet = (base) => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: createDevLoopbackFetch({ [O]: base }) });
const batchWallet = (world, base) => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY],
  fetch: createDevLoopbackFetch({ [O]: base }), mockWorld: world,
  batch: { maxDepositSompi: "20000000", allowedResources: [`${O}/weather/brisbane`], allowedServerPublicKeys: [world.serverPublicKey], minRefundLeadDaa: "1" } });
const offer = async (base, headers = {}) => { const ch = await fetch(`${base}/weather/brisbane`, { headers }); assert.equal(ch.status, 402);
  const req = JSON.parse(Buffer.from(ch.headers.get("payment-required"), "base64").toString()); return (req.accepts.find((x) => x.scheme === "batch-settlement") ?? req.accepts[0]).amount; };

test("R6-L1/L2: the 402 offer follows the client's own (hinted) channel, not other channels on its IP", async () => {
  const U = await up(); const db = openDb(dbPath()), world = createMockBatchWorld();
  const a = await start(batchCfg(U), { mockWorld: world, db, refundTimeoutDaa: "5000" });
  assert.equal((await batchWallet(world, a.base).fetch(`${O}/weather/brisbane`)).response.status, 200);
  const [c] = await a.gw.store.listChannels(); const healthy = String(c.channelId ?? c.id).toLowerCase(), starved = "cd".repeat(32);
  // a second, failed-open channel from the same client IP key (e.g. another agent behind the same NAT)
  const ipRow = db.prepare("SELECT v FROM kv WHERE ns='batch-open-ip' AND k=?").get(healthy); assert.ok(ipRow);
  db.prepare("INSERT INTO kv (ns,k,v) VALUES ('batch-open-ip',?,?)").run(starved, ipRow.v);
  const real = a.gw.store.loadChannel.bind(a.gw.store);
  a.gw.store.loadChannel = async (x) => String(x).toLowerCase() === starved ? { ...(await real(healthy)), channelId: starved, chargedCumulativeAmount: "0" } : real(x);
  assert.equal(await offer(a.base), "3000000", "no hint: per-IP rule (a sub-minimum channel exists)");
  assert.equal(await offer(a.base, { "kasgate-channel-id": healthy }), "50000", "hinted healthy channel: route price, as the paid request will charge");
  assert.equal(await offer(a.base, { "kasgate-channel-id": starved }), "3000000");
  assert.equal(await offer(a.base, { "kasgate-channel-id": "ab".repeat(32) }), "3000000", "unknown hint falls back to the IP rule");
});

test("R6-L1 (protocol): exactPendingTtlMs above the payer authorization lifetime is refused; default equals it", async () => {
  const U = await up();
  assert.throws(() => createGateway(exactCfg(U, { exactFinality: "confirmed", exactPendingTtlMs: 600000 }), { db: openDb(dbPath()) }), /must be <= the payer authorization lifetime/);
  assert.throws(() => createGateway(exactCfg(U, { maxTimeoutSeconds: 120, exactPendingTtlMs: 121000 }), { db: openDb(dbPath()) }), /<= the payer authorization lifetime/);
  const g = createGateway(exactCfg(U, { maxTimeoutSeconds: 120, exactPendingTtlMs: 120000 }), { db: openDb(dbPath()) }); g.close();
  const a = await start(exactCfg(U, { exactFinality: "confirmed" }), { db: openDb(dbPath()), depthPreflight: async () => {}, settleReplayDelaysMs: [] });
  a.gw.store.acceptExactSettlement = async () => { throw new Error("selected-chain positions ended before the pinned checkpoint"); };
  await exactWallet(a.base).fetch(`${O}/weather/brisbane`).catch(() => {});
  const [p] = a.gw.pendingExact(); assert.ok(p?.txid, "held as pending");
  assert.deepEqual(a.gw.expirePending(Date.parse(p.firstAt) + 61_000), [p.txid], "default TTL = 60 s authorization lifetime, not 10 min");
});

test("R6 (info): a journal replay failure raises an alert (ledger + hook), also when acknowledged", async () => {
  const U = await up(); const p = dbPath();
  const a = await start(exactCfg(U), { db: openDb(p) });
  assert.equal((await exactWallet(a.base).fetch(`${O}/weather/brisbane`)).response.status, 200);
  a.gw.close();
  const db = openDb(p); db.prepare("INSERT INTO store_journal (ns, at, method, args) VALUES ('server-channels', ?, 'commitExactPayment', '[{}]')").run(Date.now());
  const seen = []; const prev = process.env.X402_ACK_REPLAY_ERRORS; process.env.X402_ACK_REPLAY_ERRORS = "1";
  let b; try { b = await start(exactCfg(U), { db, onReplayError: (ev) => seen.push(ev) }); } finally { if (prev == null) delete process.env.X402_ACK_REPLAY_ERRORS; else process.env.X402_ACK_REPLAY_ERRORS = prev; }
  await b.gw.store.ready;
  assert.equal(seen.length, 1); assert.equal(seen[0].acknowledged, true); assert.ok(seen[0].errors.length >= 1);
  assert.ok(b.gw.ledger.entries.some((e) => e.outcome === "store-replay-alert"), "booked in the ledger / dashboard");
});
