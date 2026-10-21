import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpstream } from "../src/demo-upstream.mjs";
import { createGateway } from "../src/gateway.mjs";
import { validateConfig } from "../src/config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "../src/agent-wallet.mjs";

const O = "https://api.demo.test";
test("replaying a captured PAYMENT-SIGNATURE does not buy a second upstream call", async () => {
  let upstreamHits = 0;
  const up = createUpstream(); up.on("request", () => upstreamHits++);
  up.listen(0, "127.0.0.1"); await new Promise((r) => up.once("listening", r));
  const cfg = validateConfig({ network: "kaspa:testnet-10", defaultScheme: "exact", publicOrigin: O, payTo: "kaspatest:merchant", upstream: `http://127.0.0.1:${up.address().port}`,
    listen: {}, dashboard: { path: "/_x402/dashboard", token: "t" }, routes: [{ match: "GET /weather/*", priceSompi: "10000000" }] });
  const gw = createGateway(cfg); const gs = await gw.listen(0, "127.0.0.1"); const local = `http://127.0.0.1:${gs.address().port}`;
  let captured; const base = createDevLoopbackFetch({ [O]: local });
  const spy = async (url, init = {}) => { const h = init.headers ?? {}; const sig = h["PAYMENT-SIGNATURE"] ?? h["payment-signature"] ?? (h.get?.("payment-signature"));
    if (sig) captured = sig; return base(url, init); };
  Object.defineProperty(spy, Symbol.for("kaspa-x402:bound-paid-fetch:v1"), { value: true });
  const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "50000000", dailyCapSompi: "100000000", fetch: spy });
  const r = await w.fetch(`${O}/weather/brisbane`); assert.equal(r.response.status, 200);
  assert.ok(captured, "payment signature captured"); assert.equal(upstreamHits, 1);
  const paidBefore = gw.ledger.summary().paidRequests;

  // 1) identical replay: served from the upstream SDK's idempotent cache at most — never a new upstream call or new revenue
  const same = await fetch(`${local}/weather/brisbane`, { headers: { "payment-signature": captured } });
  console.log(`identical replay -> ${same.status}`);
  // 2) same payment against a different resource: must be refused
  const other = await fetch(`${local}/weather/sydney`, { headers: { "payment-signature": captured } });
  console.log(`cross-resource replay -> ${other.status}`); assert.notEqual(other.status, 200, "payment bound to one resource");
  assert.equal(upstreamHits, 1, "upstream must not be called again by replays");
  assert.equal(gw.ledger.summary().paidRequests - paidBefore, 0, "replay must not count as new revenue");
  assert.equal(gw.ledger.summary().byRoute["GET /weather/*"].count <= 2, true);
  gs.close(); up.close();
});
