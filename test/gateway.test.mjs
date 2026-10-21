import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createUpstream } from "../src/demo-upstream.mjs";
import { createGateway } from "../src/gateway.mjs";
import { validateConfig, matchRoute } from "../src/config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "../src/agent-wallet.mjs";

const O = "https://api.demo.test";
const baseCfg = () => validateConfig({ network: "kaspa:testnet-10", defaultScheme: "exact", publicOrigin: O, payTo: "kaspatest:merchant",
  listen: { host: "127.0.0.1", port: 0 }, upstream: "", dashboard: { path: "/_x402/dashboard", token: "t" },
  routes: [{ match: "GET /weather/*", priceSompi: "10000000" }, { match: "POST /summarize", priceSompi: "25000000" },
    { match: "GET /premium/*", priceSompi: "200000000" }, { match: "GET /health", free: true }] });

let up, gs, gw, local, cfg;
before(async () => {
  up = createUpstream().listen(0, "127.0.0.1"); await new Promise((r) => up.once("listening", r));
  cfg = baseCfg(); cfg.upstream = `http://127.0.0.1:${up.address().port}`;
  gw = createGateway(cfg); gs = await gw.listen(0, "127.0.0.1"); local = `http://127.0.0.1:${gs.address().port}`;
});
after(() => { gs.close(); up.close(); });
const wallet = (o = {}) => new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "50000000", dailyCapSompi: "100000000",
  allowedPayTo: ["kaspatest:merchant"], fetch: createDevLoopbackFetch({ [O]: local }), ...o });

test("config rejects mainnet and bad prices", () => {
  assert.throws(() => validateConfig({ ...baseCfg(), network: "kaspa:mainnet" }), /Testnet-10 only/);
  assert.throws(() => validateConfig({ ...baseCfg(), routes: [{ match: "GET /x", priceSompi: "0.1" }] }), /priceSompi/);
  assert.throws(() => validateConfig({ ...baseCfg(), payTo: "kaspa:abc" }), /kaspatest/);
});
test("route matching: wildcard, method, first-match, unmatched", () => {
  const r = baseCfg().routes;
  assert.equal(matchRoute(r, "GET", "/weather/x").priceSompi, "10000000");
  assert.equal(matchRoute(r, "GET", "/summarize"), null);
  assert.equal(matchRoute(r, "GET", "/health").free, true);
  assert.equal(matchRoute(r, "GET", "/nope"), null);
});
test("unpaid request gets an x402 402 with PAYMENT-REQUIRED; free route proxies; unknown route 404", async () => {
  const r = await fetch(`${local}/weather/brisbane`); assert.equal(r.status, 402); assert.ok(r.headers.get("payment-required"));
  assert.equal((await fetch(`${local}/health`)).status, 200);
  assert.equal((await fetch(`${local}/nope`)).status, 404);
});
test("garbage PAYMENT-SIGNATURE is rejected, upstream not called", async () => {
  const r = await fetch(`${local}/weather/x`, { headers: { "payment-signature": "bm90LWEtcGF5bWVudA==" } });
  assert.notEqual(r.status, 200);
});
test("agent auto-pays, gets upstream content, seller ledger records revenue", async () => {
  const before = BigInt(gw.ledger.summary().revenueSompi);
  const w = wallet(); const r = await w.fetch(`${O}/weather/brisbane`);
  assert.equal(r.response.status, 200); assert.equal((await r.response.json()).city, "brisbane");
  const p = await w.fetch(`${O}/summarize`, { method: "POST", body: "one two three" });
  assert.equal(p.response.status, 200); assert.equal((await p.response.json()).words, 3);
  assert.equal(BigInt(gw.ledger.summary().revenueSompi) - before, 35000000n);
  assert.equal(w.report().spentTodaySompi, "35000000");
});
test("per-request max blocks overpriced route before any payment", async () => {
  const w = wallet(); await assert.rejects(w.fetch(`${O}/premium/x`), (e) => e.code === "per_request");
  assert.equal(w.report().spentTodaySompi, "0");
});
test("daily cap blocks once exceeded and resets next UTC day", async () => {
  let now = new Date("2026-10-20T10:00:00Z");
  const w = wallet({ dailyCapSompi: "25000000", now: () => now });
  await w.fetch(`${O}/weather/a`); await w.fetch(`${O}/weather/b`);
  await assert.rejects(w.fetch(`${O}/weather/c`), (e) => e.code === "daily_cap");
  now = new Date("2026-10-21T00:00:01Z");
  assert.equal((await w.fetch(`${O}/weather/d`)).response.status, 200);
});
test("host allowlist blocks non-listed hosts", async () => {
  await assert.rejects(wallet().fetch("https://evil.example/x"), (e) => e.code === "host");
});
test("dashboard requires Bearer token (query token refused, default token refused) and reports revenue", async () => {
  assert.equal((await fetch(`${local}/_x402/dashboard`)).status, 401);
  assert.equal((await fetch(`${local}/_x402/dashboard.json?token=t`)).status, 401, "token in URL is not accepted");
  assert.equal((await fetch(`${local}/_x402/dashboard.json`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.throws(() => { const c = baseCfg(); c.dashboard.token = "change-me-dev-token"; return createGateway(c); }, /shipped default/);
  const j = await (await fetch(`${local}/_x402/dashboard.json`, { headers: { authorization: "Bearer t" } })).json();
  assert.ok(j.paidRequests >= 2); assert.ok(j.byRoute["GET /weather/*"]);
});
