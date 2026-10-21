// Regression tests for REVIEW.md findings (see FIXES.md).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createUpstream } from "../src/demo-upstream.mjs";
import { createGateway } from "../src/gateway.mjs";
import { validateConfig, assertRealChainPolicy } from "../src/config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "../src/agent-wallet.mjs";
import { createMockBatchWorld } from "../src/mock-batch.mjs";
import { openDb } from "../src/store.mjs";
import { parseCookies, hashPassword, createSessionManager } from "../src/auth.mjs";

const open = []; after(() => open.forEach((f) => f()));
const O = "https://api.demo.test", PAY = "kaspatest:payout";
const raw = (over = {}) => ({ network: "kaspa:testnet-10", defaultScheme: "exact", publicOrigin: O, payTo: PAY, upstream: "", listen: {},
  dashboard: { path: "/_x402/dashboard", token: "t" }, batch: { minDepositSompi: "4000000", claimReserveSompi: "2000000", refundTimeoutDeltaDaa: "900" },
  routes: [{ match: "GET /weather/*", scheme: "batch-settlement", priceSompi: "50000" }, { match: "GET /premium/*", priceSompi: "10000000" }, { match: "* /echo", free: true }], ...over });
const tmpDb = () => join(mkdtempSync(join(tmpdir(), "x402f-")), "gw.sqlite");
async function up(server = createUpstream()) { server.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r)); open.push(() => server.close()); return `http://127.0.0.1:${server.address().port}`; }
async function start(cfg, opts) { const gw = createGateway(cfg, opts); const s = await gw.listen(0, "127.0.0.1"); open.push(() => { s.close(); gw.close(); }); return { gw, s, base: `http://127.0.0.1:${s.address().port}` }; }
const wallet = (world, base, extra = {}) => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY],
  fetch: createDevLoopbackFetch({ [O]: base }), mockWorld: world,
  batch: { maxDepositSompi: "4000000", allowedResources: [`${O}/weather/brisbane`], allowedServerPublicKeys: [world.serverPublicKey], minRefundLeadDaa: "1" }, ...extra });

test("H1 + M2: claim broadcast then crash -> attempt persisted, not retried, refused twice, recovered on restart", async () => {
  const path = tmpDb(), U = await up(), world = createMockBatchWorld(), cfg = validateConfig({ ...raw(), upstream: U });
  const db1 = openDb(path); const a = await start(cfg, { mockWorld: world, db: db1, refundTimeoutDaa: "5000" });
  const w = wallet(world, a.base);
  for (let i = 0; i < 4; i++) await w.fetch(`${O}/weather/brisbane`);
  const real = world.chainProvider.sendTransaction.bind(world.chainProvider); let sends = 0;
  world.chainProvider.sendTransaction = async (tx) => { sends++; await real(tx); throw new Error("socket hang up"); }; // landed, then "crash"
  const r1 = await a.gw.claimAll();
  assert.equal(sends, 1, "M2: executeClaim (broadcast) not retried on a transient error");
  assert.equal(r1.claims[0].pending, true); assert.ok(r1.claims[0].txid);
  const r2 = await a.gw.claimAll(); assert.ok(!r2.claims.some((c) => c.txid && !c.pending), "no second claim"); assert.equal(sends, 1, "open attempt blocks a second claim");
  world.chainProvider.sendTransaction = real;
  a.s.close(); a.gw.close(); db1.close();
  const db2 = openDb(path); const b = await start(cfg, { mockWorld: world, db: db2, refundTimeoutDaa: "5000" });
  const rec = await b.gw.recovered;
  assert.equal(rec.length, 1, "open claim attempt restored from SQLite");
  assert.equal(rec[0].transactionId, r1.claims[0].txid);
  assert.equal(rec[0].status, "recovered", "recoverAcceptedClaim applied the landed claim");
  if (rec[0].status === "recovered") assert.equal(b.gw.ledger.summary().batchUnclaimedSompi, "0");
  else { await b.gw.claimAll(); assert.equal(sends, 1, "still blocked until recovered"); }
  db2.close();
});

test("H1 (exact): a PAYMENT-SIGNATURE consumed before a restart is refused after it", async () => {
  const path = tmpDb(), U = await up(), cfg = validateConfig({ ...raw(), upstream: U });
  let captured; const db1 = openDb(path); const a = await start(cfg, { db: db1 });
  const base = createDevLoopbackFetch({ [O]: a.base });
  const spy = Object.assign(async (url, init = {}) => { const h = new Headers(init.headers); if (h.get("payment-signature")) captured = h.get("payment-signature"); return base(url, init); }, { [Symbol.for("kaspa-x402:bound-paid-fetch:v1")]: true });
  const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: spy });
  assert.equal((await w.fetch(`${O}/premium/x`)).response.status, 200); assert.ok(captured);
  a.s.close(); a.gw.close(); db1.close();
  const db2 = openDb(path); const b = await start(cfg, { db: db2 });
  // Exact state is now journaled (durable): the identical retry after a restart is upstream's idempotent replay -
  // same cached response, no second charge, no second origin call.
  const r = await fetch(`${b.base}/premium/x`, { headers: { "payment-signature": captured } });
  assert.equal(r.status, 200); assert.ok(r.headers.get("payment-response"));
  assert.equal(b.gw.ledger.summary().paidRequests, 1, "paid once across the restart");
  // a txid known only to the legacy replay guard (no journal) is still refused
  db2.prepare("DELETE FROM store_journal").run(); const db3 = db2; b.s.close(); b.gw.close();
  const c = await start(cfg, { db: db3 });
  const r2 = await fetch(`${c.base}/premium/x`, { headers: { "payment-signature": captured } });
  assert.equal(r2.status, 402); assert.match((await r2.json()).error, /already consumed/);
  db2.close();
});

test("H2: refund timeout is per channel (server rotates as DAA advances); vouchers refused inside the claim margin", async () => {
  const U = await up(), world = createMockBatchWorld(), cfg = validateConfig({ ...raw(), upstream: U, batch: { ...raw().batch, claimMarginDaa: "200", rotateEveryDaa: "50" } });
  const a = await start(cfg, { mockWorld: world });
  const t0 = a.gw.refundTimeout(); assert.equal(t0, BigInt(world.chainProvider.daa) + 900n);
  world.chainProvider.advance(600); await a.gw.rotate();
  assert.equal(a.gw.refundTimeout(), BigInt(world.chainProvider.daa) + 900n, "a channel opened now gets now+delta, not boot+delta");
  const w = wallet(world, a.base);
  assert.equal((await w.fetch(`${O}/weather/brisbane`)).response.status, 200);
  const ch = (await a.gw.server.listClaimableChannels())[0];
  assert.equal(BigInt(ch.channelConfig.refundTimeoutDaa), a.gw.refundTimeout());
  world.chainProvider.advance(750); // now within 200 DAA of this channel's timeout
  const again = await w.fetch(`${O}/weather/brisbane`);
  assert.equal(again.payment.openedChannel, true, "server refused vouchers on the near-timeout channel; client had to open a fresh one");
  const r = await a.gw.claimNearTimeout(); assert.ok(r?.claims?.some((c) => c.channelId === ch.channelId && c.txid), "seller claims the channel near its timeout");
  const big = (o = {}) => raw({ routes: [{ match: "GET /weather/*", scheme: "batch-settlement", priceSompi: "50000" }, { match: "GET /premium/*", scheme: "exact", priceSompi: "100000000" }], ...o });
  assert.throws(() => assertRealChainPolicy(validateConfig(big())), /36000/);
  assertRealChainPolicy(validateConfig(big({ batch: { ...raw().batch, allowShortRefundTimeout: true } })));
  assert.throws(() => assertRealChainPolicy(validateConfig(raw({ batch: { ...raw().batch, allowShortRefundTimeout: true } }))), /1 KAS/, "incentive audit: real exact < 1 KAS refused");
});

test("H3: exact payment that got a 5xx stays reserved; released only with on-chain 'absent' proof", async () => {
  const U = await up(), cfg = validateConfig({ ...raw(), upstream: U });
  const a = await start(cfg, {});
  const loop = createDevLoopbackFetch({ [O]: a.base });
  // Seller accepts the payment, then answers 502 (the tx may have been broadcast).
  const flaky = Object.assign(async (url, init = {}) => { const r = await loop(url, init); const h = new Headers(init.headers);
    return h.get("payment-signature") ? { ...r, status: 502, headers: new Headers({ "content-type": "application/json" }), json: async () => ({}), text: async () => "{}" } : r; }, { [Symbol.for("kaspa-x402:bound-paid-fetch:v1")]: true });
  const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "15000000", allowedPayTo: [PAY], fetch: flaky });
  await w.fetch(`${O}/premium/x`).catch(() => {});
  assert.equal(w.reservations().length, 1); assert.equal(w.spentToday(), 10_000_000n, "unknown outcome still counts");
  await assert.rejects(w.fetch(`${O}/premium/y`), (e) => e.code === "daily_cap", "cap not undercounted");
  const id = w.reservations()[0].id;
  assert.equal((await w.releaseReservation(id)).released, false, "no proof, no release");
  assert.equal((await w.releaseReservation(id, { lookupTx: async () => "unknown" })).released, false);
  // P1 late broadcast: "absent" alone no longer releases (the signed artifact could still land) ...
  assert.equal((await w.releaseReservation(id, { lookupTx: async () => "absent" })).released, false);
  assert.equal(w.spentToday(), 10_000_000n, "absent-but-unspent still counts");
  // ... only proof that its input was spent by another tx does.
  assert.equal((await w.releaseReservation(id, { lookupTx: async () => "absent", inputSpentElsewhere: async (inputs) => inputs.length > 0 })).released, true);
  assert.equal(w.spentToday(), 0n);
});

test("H4: concurrent wallet.fetch() calls book their own spends", async () => {
  const U = await up(), cfg = validateConfig({ ...raw(), upstream: U });
  const a = await start(cfg, {});
  const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: createDevLoopbackFetch({ [O]: a.base }) });
  const rs = await Promise.all([1, 2, 3, 4].map((i) => w.fetch(`${O}/premium/${i}`)));
  assert.ok(rs.every((r) => r.response.status === 200));
  assert.equal(w.spends.length, 4); assert.ok(w.spends.every((s) => s.status === "settled" && s.txid));
  assert.equal(new Set(w.spends.map((s) => s.txid)).size, 4, "each spend carries its own txid");
  assert.equal(new Set(w.spends.map((s) => s.url)).size, 4);
});

test("M6: request headers filtered (cookie/authorization/x-forwarded-* dropped, own XFF set); body capped -> 413", async () => {
  let seen; const echo = http.createServer((req, res) => { seen = req.headers; res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end("{}"); });
  const U = await up(echo); const a = await start(validateConfig({ ...raw(), upstream: U, maxBodyBytes: 1000 }), {});
  const r = await fetch(`${a.base}/echo`, { headers: { cookie: "s=1", authorization: "Bearer t", "x-forwarded-for": "6.6.6.6", "x-real-ip": "6.6.6.6", "x-custom": "ok" } });
  assert.equal(r.status, 200);
  assert.equal(seen.cookie, undefined); assert.equal(seen.authorization, undefined); assert.equal(seen["x-real-ip"], undefined);
  assert.notEqual(seen["x-forwarded-for"], "6.6.6.6"); assert.equal(seen["x-custom"], "ok");
  assert.equal(r.headers.get("access-control-allow-origin"), null, "L7: upstream CORS dropped unless allowlisted");
  assert.equal((await fetch(`${a.base}/echo`, { method: "POST", body: "x".repeat(5000) })).status, 413);
});

test("M7: batch finality configurable (accepted|confirmed); invalid refused", () => {
  assert.equal(validateConfig(raw({ batch: { ...raw().batch, acceptedFinality: "confirmed" } })).batch.acceptedFinality, "confirmed");
  assert.throws(() => validateConfig(raw({ batch: { ...raw().batch, acceptedFinality: "broadcast" } })), /accepted\|confirmed/);
});

test("L1 + L2: ledger books gross, fee and net per claim, and tags entries with the run id", async () => {
  const U = await up(), world = createMockBatchWorld(); const a = await start(validateConfig({ ...raw(), upstream: U }), { mockWorld: world, refundTimeoutDaa: "5000", runId: "runA" });
  const w = wallet(world, a.base); for (let i = 0; i < 3; i++) await w.fetch(`${O}/weather/brisbane`);
  const { claims } = await a.gw.claimAll(); assert.equal(claims[0].netSompi, String(150000n - 0n < 2000000n ? 150000n : 150000n - 2000000n));
  const s = a.gw.ledger.summary({ runId: "runA" }); assert.deepEqual(s.runs, ["runA"]); assert.equal(s.paidRequests, 3);
  assert.equal(a.gw.ledger.summary({ runId: "other" }).paidRequests, 0);
  const row = a.gw.ledger.entries.find((e) => e.outcome === "claim"); assert.ok("feeSompi" in row && "netSompi" in row);
});

test("L3-L6: async throttled login (global limit), cookie path guard, malformed cookie, generic 502", async () => {
  assert.deepEqual(parseCookies("a=%E0%A4%A; b=ok"), { a: "", b: "ok" });
  const sm = createSessionManager({ passwordHash: hashPassword("correct horse battery"), globalMaxFailsPerMin: 3 });
  for (let i = 0; i < 3; i++) await sm.login("x", `10.0.0.${i}`);
  assert.equal((await sm.login("correct horse battery", "10.9.9.9")).status, 429, "global throttle trips across IPs");
  assert.throws(() => createGateway(validateConfig(raw({ dashboard: { path: "/d" } })), { passwordHash: hashPassword("correct horse battery") }), /must start with \/_x402\//);
  const a = await start(validateConfig({ ...raw(), upstream: "http://127.0.0.1:1" }), {});
  const r = await fetch(`${a.base}/echo`); assert.equal(r.status, 502); const j = await r.json(); assert.equal(j.error, "gateway error"); assert.ok(j.id);
});

test("storage-mass guard: claims whose net merchant output is below the safe minimum are skipped", async () => {
  const U = await up(), world = createMockBatchWorld();
  const a = await start(validateConfig({ ...raw(), upstream: U, settlement: { minClaimNetSompi: "1000000" } }), { mockWorld: world, refundTimeoutDaa: "5000" });
  const w = wallet(world, a.base); for (let i = 0; i < 3; i++) await w.fetch(`${O}/weather/brisbane`);
  const { claims } = await a.gw.claimAll(); assert.match(claims[0].skipped, /storage-mass-safe/);
});

test("restart recovery: claim -> crash -> restart (gateway + wallet) -> recovered -> payer refunds the post-claim continuation", async () => {
  const path = tmpDb(), U = await up(), world = createMockBatchWorld(), cfg = validateConfig({ ...raw(), upstream: U });
  const db1 = openDb(path); const a = await start(cfg, { mockWorld: world, db: db1, refundTimeoutDaa: "5000" });
  const w1 = wallet(world, a.base, { db: db1, walletId: "payer" });
  for (let i = 0; i < 4; i++) await w1.fetch(`${O}/weather/brisbane`);
  const real = world.chainProvider.sendTransaction.bind(world.chainProvider);
  world.chainProvider.sendTransaction = async (tx) => { await real(tx); throw new Error("socket hang up"); };
  const r1 = await a.gw.claimAll(); assert.equal(r1.claims[0].pending, true);
  world.chainProvider.sendTransaction = real;
  a.s.close(); a.gw.close(); db1.close();
  const db2 = openDb(path); const b = await start(cfg, { mockWorld: world, db: db2, refundTimeoutDaa: "5000" });
  const rec = await b.gw.recovered; assert.equal(rec[0].status, "recovered");
  assert.equal(b.gw.ledger.summary().batchUnclaimedSompi, "0", "accepted claim booked as settled");
  const w2 = wallet(world, b.base, { db: db2, walletId: "payer" });
  world.chainProvider.advance(6000);
  const refunds = await w2.refundAll();
  assert.equal(refunds.length, 1, "restored payer channel is refundable");
  assert.equal(BigInt(refunds[0].refundAmount) + 4n * 50000n, 4000000n, "refund spends the continuation: deposit = claimed + refunded");
  db2.close();
});

test("refundAll is time-boxed with a clear error", async () => {
  const world = createMockBatchWorld(); const w = wallet(world, "http://127.0.0.1:9", { refundTimeoutMs: 50 });
  w.client.listRefundableChannels = () => new Promise(() => {});
  await assert.rejects(w.refundAll("1"), (e) => e.code === "REFUND_TIMEOUT" && /timed out after 0.05s/.test(e.message));
});

// ---- Exact "paid but no data" (live TN10 Brisbane 91d11b7e / e7fc5a74) ----
function flakyUpstream(plan) { // plan: array of "ok" | "slow:<ms>" | "500" | "hang" consumed per request, then "ok"
  let i = 0; const hits = [];
  const srv = http.createServer(async (req, res) => { const step = plan[i++] ?? "ok"; hits.push(step);
    if (step === "hang") return;
    if (step.startsWith("slow:")) await new Promise((r) => setTimeout(r, Number(step.slice(5))));
    if (step === "500") { res.writeHead(500, { "content-type": "application/json" }); return res.end('{"error":"origin down"}'); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ city: "Brisbane", tempC: 21.7 })); });
  return { srv, hits };
}
const exactRaw = () => ({ ...raw(), batch: undefined, routes: [{ match: "GET /weather/*", priceSompi: "10000000" }] });
const settledSpends = (w) => w.report().spends.filter((s) => s.status === "settled").length;

test("REPRO: protected handler slower than upstream's adapter timeout -> payment settled, payer gets 500 exact_settlement_recovery_required, identical retry 503", async () => {
  const { srv } = flakyUpstream(["slow:400"]); const U = await up(srv); const cfg = validateConfig({ ...exactRaw(), upstream: U });
  const a = await start(cfg, { adapterTimeoutMs: 150, verifyFirst: false, exactRecovery: false });
  const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: createDevLoopbackFetch({ [O]: a.base }), pendingRetryDelaysMs: [50] });
  await assert.rejects(w.fetch(`${O}/weather/brisbane`), (e) => e.name === "PendingExactPaymentError");
  const out = a.gw.ledger.entries.filter((e) => e.outcome === "unsettled").map((e) => e.error);
  assert.deepEqual(out, ["status 500", "status 503"], "first paid request: handler timed out after settlement (500); identical retry: handler-started marker -> 503");
});

test("FIX: slow origin beyond the origin timeout -> 503 upstream_unavailable BEFORE settlement; identical retry pays once and gets the data", async () => {
  const { srv, hits } = flakyUpstream(["hang", "hang"]); const U = await up(srv); const cfg = validateConfig({ ...exactRaw(), upstream: U });
  const a = await start(cfg, { adapterTimeoutMs: 150, upstreamTimeoutMs: 100 });
  const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: createDevLoopbackFetch({ [O]: a.base }), pendingRetryDelaysMs: [50, 50] });
  const r = await w.fetch(`${O}/weather/brisbane`);
  assert.equal(r.response.status, 200); assert.equal((await r.response.json()).city, "Brisbane"); assert.ok(r.settlement?.response?.transaction);
  assert.equal(a.gw.ledger.entries.filter((e) => e.outcome === "upstream-unavailable").length, 1);
  assert.equal(a.gw.ledger.summary().paidRequests, 1, "exactly one paid request"); assert.equal(settledSpends(w), 1); assert.equal(w.report().spentTodaySompi, "10000000", "paid once");
  assert.equal(hits.length, 3);
});

test("FIX: failing origin (5xx) -> not settled; recovers on retry with the same payment", async () => {
  const { srv } = flakyUpstream(["500", "500", "ok"]); const U = await up(srv); const cfg = validateConfig({ ...exactRaw(), upstream: U });
  const a = await start(cfg, {});
  const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: createDevLoopbackFetch({ [O]: a.base }), pendingRetryDelaysMs: [50] });
  const r = await w.fetch(`${O}/weather/brisbane`); assert.equal(r.response.status, 200);
  assert.equal(a.gw.ledger.summary().paidRequests, 1); assert.equal(w.report().spentTodaySompi, "10000000");
});

test("FIX: handler fails AFTER settlement -> gateway uses upstream recoverExactHandler + identical replay -> payer gets the data with PAYMENT-RESPONSE", async () => {
  const { srv } = flakyUpstream(["slow:400", "ok"]); const U = await up(srv); const cfg = validateConfig({ ...exactRaw(), upstream: U });
  const a = await start(cfg, { adapterTimeoutMs: 150, verifyFirst: false });
  const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: createDevLoopbackFetch({ [O]: a.base }), pendingRetryDelaysMs: [50] });
  const r = await w.fetch(`${O}/weather/brisbane`);
  assert.equal(r.response.status, 200); assert.ok(r.settlement?.response?.transaction);
  assert.equal(a.gw.ledger.entries.filter((e) => e.outcome === "exact-recovered").length, 1);
  assert.equal(a.gw.ledger.summary().paidRequests, 1); assert.equal(w.report().spentTodaySompi, "10000000");
});

test("REPRO+FIX: settlement confirmation check throws before the handler (live cause) -> gateway replays settlement in-request; payer gets data, pays once", async () => {
  // Live TN10 trace: chainProvider.sendTransaction threw "Kaspa REST checkpoint is not a selected-chain block" after the
  // broadcast landed; upstream answered 503 exact_settlement_recovery_required with no PAYMENT-RESPONSE and the handler never ran.
  const { srv, hits } = flakyUpstream([]); const U = await up(srv); const cfg = validateConfig({ ...exactRaw(), upstream: U });
  const a = await start(cfg, { settleReplayDelaysMs: [30, 30] });
  const { DirectModeServer } = await import("@kaspa-x402/server");
  const orig = DirectModeServer.prototype.handlePaidRequest; let injected = 0;
  DirectModeServer.prototype.handlePaidRequest = async function (req, h) {
    if (req.headers["payment-signature"] && injected++ === 0) return { status: 503, headers: {}, body: { error: "exact_settlement_recovery_required" } };
    return orig.call(this, req, h); };
  const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000", allowedPayTo: [PAY], fetch: createDevLoopbackFetch({ [O]: a.base }), pendingRetryDelaysMs: [] });
  try {
    const r = await w.fetch(`${O}/weather/brisbane`);
    assert.equal(r.response.status, 200, "data returned despite the uncertain settlement"); assert.ok(r.settlement?.response?.transaction);
    assert.equal(injected >= 2, true); assert.equal(a.gw.ledger.entries.filter((e) => e.outcome === "exact-settle-replayed").length, 1);
    assert.equal(a.gw.ledger.summary().paidRequests, 1); assert.equal(w.report().spentTodaySompi, "10000000", "paid once");
    assert.equal(hits.length, 1, "origin fetched once");
  } finally { DirectModeServer.prototype.handlePaidRequest = orig; }
});
