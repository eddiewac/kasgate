import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpstream } from "../src/demo-upstream.mjs";
import { createGateway } from "../src/gateway.mjs";
import { validateConfig } from "../src/config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "../src/agent-wallet.mjs";
import { createMockBatchWorld } from "../src/mock-batch.mjs";
import { openDb } from "../src/store.mjs";
import { hashPassword, verifyPassword } from "../src/auth.mjs";

const open = []; after(() => open.forEach((f) => f()));
const O = "https://api.demo.test", PAY = "kaspatest:payout";
const raw = (over = {}) => ({ network: "kaspa:testnet-10", defaultScheme: "exact", publicOrigin: O, payTo: PAY, upstream: "", listen: {},
  dashboard: { path: "/_x402/dashboard", token: "t" }, batch: { minDepositSompi: "4000000", claimReserveSompi: "2000000", refundTimeoutDeltaDaa: "900" },
  routes: [{ match: "GET /weather/*", scheme: "batch-settlement", priceSompi: "50000" }, { match: "GET /health", free: true }], ...over });
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "x402-")), "gw.sqlite");

async function up() { const u = createUpstream(); u.listen(0, "127.0.0.1"); await new Promise((r) => u.once("listening", r)); open.push(() => u.close()); return `http://127.0.0.1:${u.address().port}`; }
async function start(cfg, opts) { const gw = createGateway(cfg, opts); const s = await gw.listen(0, "127.0.0.1"); open.push(() => { s.close(); gw.close(); }); return { gw, s, base: `http://127.0.0.1:${s.address().port}` }; }
const wallet = (world, base, extra = {}) => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "100000", dailyCapSompi: "10000000", allowedPayTo: [PAY],
  fetch: createDevLoopbackFetch({ [O]: base }), mockWorld: world,
  batch: { maxDepositSompi: "4000000", allowedResources: [`${O}/weather/brisbane`], allowedServerPublicKeys: [world.serverPublicKey] }, ...extra });

test("SQLite: ledger + server channel state survive a gateway restart; seller can still claim", async () => {
  const path = tmpDb(), U = await up(), world = createMockBatchWorld(), cfg = validateConfig({ ...raw(), upstream: U });
  const db1 = openDb(path); const a = await start(cfg, { mockWorld: world, db: db1, refundTimeoutDaa: "5000" });
  const w = wallet(world, a.base);
  for (let i = 0; i < 4; i++) assert.equal((await w.fetch(`${O}/weather/brisbane`)).response.status, 200);
  a.s.close(); a.gw.close(); db1.close();
  const db2 = openDb(path); const b = await start(cfg, { mockWorld: world, db: db2, refundTimeoutDaa: "5000" });
  assert.equal(b.gw.ledger.summary().batchAccruedSompi, "200000", "ledger reloaded from SQLite");
  assert.equal((await b.gw.server.listClaimableChannels()).length, 1, "channel reloaded from SQLite");
  const { claims } = await b.gw.claimAll(); assert.equal(claims[0].claimAmount, "200000"); assert.ok(claims[0].txid);
  db2.close();
});

test("SQLite: wallet spend history + reservations persist and still count toward the caps", async () => {
  const path = tmpDb(), U = await up(), world = createMockBatchWorld(), cfg = validateConfig({ ...raw(), upstream: U });
  const a = await start(cfg, { mockWorld: world, refundTimeoutDaa: "5000" });
  const db = openDb(path); const w1 = wallet(world, a.base, { db, dailyVoucherCapSompi: "200000" });
  for (let i = 0; i < 3; i++) await w1.fetch(`${O}/weather/brisbane`);
  db.prepare("INSERT INTO spends (id, wallet, day, status, amount_sompi, entry) VALUES ('r1','default',?,'unknown','50000',?)")
    .run(w1.dayKey(), JSON.stringify({ id: "r1", day: w1.dayKey(), scheme: "batch-settlement", lockedSompi: "0", status: "unknown", amountSompi: "50000", note: "crash-interrupted voucher" }));
  const w2 = wallet(world, a.base, { db, dailyVoucherCapSompi: "200000" });
  assert.equal(w2.vouchersToday(), 200000n, "history + reservation reloaded"); assert.equal(w2.spentToday(), 4000000n, "deposit reloaded");
  assert.equal(w2.reservations().length, 1);
  await assert.rejects(w2.fetch(`${O}/weather/brisbane`), /daily voucher cap/);
  assert.equal((await w2.releaseReservation("r1")).released, false, "H3: signed batch voucher never released");
  db.close();
});

test("periodic seller claim: every N calls (respects minClaimSompi)", async () => {
  const U = await up(), world = createMockBatchWorld();
  const cfg = validateConfig({ ...raw(), upstream: U, settlement: { claimEveryCalls: 3, minClaimSompi: "100000" } });
  const a = await start(cfg, { mockWorld: world, refundTimeoutDaa: "5000" }); const w = wallet(world, a.base);
  for (let i = 0; i < 3; i++) await w.fetch(`${O}/weather/brisbane`);
  await a.gw.settle();
  assert.equal(a.gw.autoClaims.length, 1); assert.equal(a.gw.autoClaims[0].claims[0].claimAmount, "150000");
  assert.equal(a.gw.ledger.summary().batchUnclaimedSompi, "0");
  assert.throws(() => validateConfig({ ...raw(), settlement: { claimEveryMinutes: 0 } }), /claimEveryMinutes/);
});

test("dashboard login: scrypt hash, session cookie, token disabled, throttled", async () => {
  const hash = hashPassword("correct horse battery"); assert.ok(verifyPassword("correct horse battery", hash)); assert.ok(!verifyPassword("nope", hash));
  assert.throws(() => hashPassword("short"), /12 characters/);
  const U = await up(); const a = await start(validateConfig({ ...raw(), upstream: U }), { passwordHash: hash, secureCookie: false, db: openDb(":memory:") });
  assert.equal((await fetch(`${a.base}/_x402/dashboard.json?token=t`)).status, 401, "legacy token refused when login enabled");
  assert.equal((await fetch(`${a.base}/_x402/dashboard`, { redirect: "manual" })).status, 303);
  const bad = await fetch(`${a.base}/_x402/login`, { method: "POST", body: "password=wrong", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${a.base}/_x402/login`, { method: "POST", body: "password=" + encodeURIComponent("correct horse battery"), headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
  assert.equal(ok.status, 303); const cookie = ok.headers.get("set-cookie"); assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const c = cookie.split(";")[0];
  assert.equal((await fetch(`${a.base}/_x402/dashboard.json`, { headers: { cookie: c } })).status, 200);
  assert.equal((await fetch(`${a.base}/_x402/claim`, { method: "POST", headers: { cookie: c } })).status, 200);
  await fetch(`${a.base}/_x402/logout`, { method: "POST", headers: { cookie: c }, redirect: "manual" });
  assert.equal((await fetch(`${a.base}/_x402/dashboard.json`, { headers: { cookie: c } })).status, 401, "session revoked");
  for (let i = 0; i < 5; i++) await fetch(`${a.base}/_x402/login`, { method: "POST", body: "password=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal((await fetch(`${a.base}/_x402/login`, { method: "POST", body: "password=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 429);
});

test("upstream response headers pass through (hop-by-hop, set-cookie, payment-* dropped)", async () => {
  const U = await up(), world = createMockBatchWorld();
  const a = await start(validateConfig({ ...raw(), upstream: U }), { mockWorld: world, refundTimeoutDaa: "5000" });
  const free = await fetch(`${a.base}/health?evil=1`);
  assert.equal(free.headers.get("cache-control"), "max-age=60"); assert.equal(free.headers.get("x-ratelimit-remaining"), "99");
  assert.equal(free.headers.get("set-cookie"), null); assert.equal(free.headers.get("payment-response"), null);
  const r = await wallet(world, a.base).fetch(`${O}/weather/brisbane`);
  assert.equal(r.response.headers.get("x-ratelimit-remaining"), "99");
  assert.match(r.response.headers.get("cache-control"), /no-store/, "x402 server's no-store wins over upstream caching on paid responses"); assert.ok(r.response.headers.get("payment-response"), "gateway's own PAYMENT-RESPONSE kept");
});
