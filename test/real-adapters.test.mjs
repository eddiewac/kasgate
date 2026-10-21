// Offline checks of the REAL payer transaction builder (no network), plus opt-in live TN10 checks (LIVE=1).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { hexToBytes } from "@kaspa-x402/core";
// Clean clone (R5-L4): without the rusty-kaspa WASM SDK these tests are SKIPPED with a reason instead of failing.
// Install it with scripts/bootstrap.sh or point KASPA_WASM_SDK at an unpacked nodejs/kaspa build.
let sdk, buildStandardExactPayment, createRealSellerDeps, NO_SDK = null;
try { ({ sdk } = await import("../src/live/sdk.mjs")); ({ buildStandardExactPayment, createRealSellerDeps } = await import("../src/live/real-adapters.mjs")); }
catch (e) { NO_SDK = `Kaspa WASM SDK not available (${String(e?.message ?? e).split("\n")[0].slice(0, 120)}); run scripts/bootstrap.sh or set KASPA_WASM_SDK`; }
const T = (n, o, f) => (typeof o === "function" ? test(n, { skip: NO_SDK ?? false }, o) : test(n, { ...o, skip: NO_SDK ?? o.skip }, f));
const { schnorr } = createRequire(import.meta.url)("@noble/curves/secp256k1");

T("real builder: signed TN10 tx pays exactly the price to payTo, change back, auth sig valid", () => {
  const keyHex = crypto.randomBytes(32).toString("hex"); const key = new sdk.PrivateKey(keyHex);
  const payer = key.toAddress("testnet-10").toString();
  const merchant = new sdk.PrivateKey(crypto.randomBytes(32).toString("hex")).toAddress("testnet-10").toString();
  const spk = sdk.payToAddressScript(payer);
  const utxo = { outpoint: { transactionId: "ab".repeat(32), index: 0 }, amount: 1_000_000_000n, scriptPublicKey: spk };
  const request = { network: "kaspa:testnet-10", profile: "standard-native", amount: "10000000", payTo: merchant,
    payToScriptPublicKey: "00", paymentRequirementsHash: "11".repeat(32), requestHash: "22".repeat(32),
    paymentIdentifier: "pay_test_1", authorizationExpiresAt: new Date(Date.now() + 60000).toISOString() };
  const a = buildStandardExactPayment({ request, keyHex, payerAddress: payer, utxo });
  const tx = sdk.Transaction.deserializeFromSafeJSON(a.transaction); const o = tx.serializeToObject();
  assert.equal(tx.id, a.transactionId);
  assert.equal(BigInt(o.outputs[0].value), 10_000_000n);
  assert.equal(BigInt(o.outputs[1].value), 1_000_000_000n - 10_000_000n - BigInt(a.feeSompi), "change = utxo - price - fee");
  assert.ok(schnorr.verify(hexToBytes(a.authorization.signature), hexToBytes(a.authorization.digest),
    schnorr.getPublicKey(hexToBytes(keyHex))));
  assert.match(a.transaction, /.+/); assert.ok(!a.transaction.includes(keyHex), "key never serialized");
});
T("real seller deps refuse mainnet-bound construction paths", () => {
  const d = createRealSellerDeps(); assert.equal(d.rest.network, "kaspa:testnet-10");
});
T("LIVE: real gateway issues 402 bound to the real merchant script; unfunded payer fails closed", { skip: !process.env.LIVE }, async () => {
  const { createUpstream } = await import("../src/demo-upstream.mjs");
  const { createGateway } = await import("../src/gateway.mjs");
  const { validateConfig } = await import("../src/config.mjs");
  const { AgentWallet, createDevLoopbackFetch } = await import("../src/agent-wallet.mjs");
  const { connectTn10 } = await import("../src/live/sdk.mjs");
  const { RealTn10FundingProvider, createRealPayerAddressCodec } = await import("../src/live/real-adapters.mjs");
  const { decodePaymentRequiredHeader } = await import("@kaspa-x402/core");
  const O = "https://api.demo.test";
  const merchant = new sdk.PrivateKey(crypto.randomBytes(32).toString("hex")).toAddress("testnet-10").toString();
  const up = createUpstream().listen(0, "127.0.0.1"); await new Promise((r) => up.once("listening", r));
  const cfg = validateConfig({ network: "kaspa:testnet-10", defaultScheme: "exact", publicOrigin: O, payTo: merchant, upstream: `http://127.0.0.1:${up.address().port}`,
    listen: {}, dashboard: { path: "/d", token: "t" }, routes: [{ match: "GET /weather/*", priceSompi: "10000000" }] });
  const gw = createGateway(cfg, { chain: "real" }); const gs = await gw.listen(0, "127.0.0.1"); const local = `http://127.0.0.1:${gs.address().port}`;
  const r = await fetch(`${local}/weather/x`); assert.equal(r.status, 402);
  const pr = decodePaymentRequiredHeader(r.headers.get("payment-required"));
  assert.equal(pr.accepts[0].payTo, merchant); assert.equal(pr.accepts[0].network, "kaspa:testnet-10");
  const { rpc } = await connectTn10(process.env.TN10_WRPC_URL);
  const payer = new RealTn10FundingProvider({ rpc, keyHex: crypto.randomBytes(32).toString("hex") }); // fresh, unfunded
  const w = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "50000000", dailyCapSompi: "100000000", allowedPayTo: [merchant],
    fetch: createDevLoopbackFetch({ [O]: local }), fundingProvider: payer, addressCodec: createRealPayerAddressCodec() });
  await assert.rejects(w.fetch(`${O}/weather/x`), /insufficient testnet funds/);
  assert.equal(gw.ledger.summary().paidRequests, 0);
  gs.close(); up.close(); await rpc.disconnect();
});
T("M3: fee = max(floor, mass x feerate); change below 0.1 KAS refused (not burned); storage-mass limit enforced", () => {
  const keyHex = crypto.randomBytes(32).toString("hex"); const payer = new sdk.PrivateKey(keyHex).toAddress("testnet-10").toString();
  const merchant = new sdk.PrivateKey(crypto.randomBytes(32).toString("hex")).toAddress("testnet-10").toString();
  const mk = (amount) => ({ outpoint: { transactionId: "cd".repeat(32), index: 0 }, amount, scriptPublicKey: sdk.payToAddressScript(payer) });
  const request = { network: "kaspa:testnet-10", profile: "standard-native", amount: "10000000", payTo: merchant, payToScriptPublicKey: "00",
    paymentRequirementsHash: "11".repeat(32), requestHash: "22".repeat(32), paymentIdentifier: "pay_t2", authorizationExpiresAt: new Date(Date.now() + 60000).toISOString() };
  const lo = buildStandardExactPayment({ request, keyHex, payerAddress: payer, utxo: mk(1_000_000_000n), feerate: 0 });
  // incentive audit: fee = mass x feerate (>= 1 sompi/g min relay) with a 0.001 KAS floor; no flat 0.02 KAS
  assert.equal(BigInt(lo.feeSompi), BigInt(Math.max(100_000, Number(lo.massGrams))), "idle network: mass x 1 sompi/g, floor 0.001 KAS");
  const hi = buildStandardExactPayment({ request, keyHex, payerAddress: payer, utxo: mk(1_000_000_000n), feerate: 5 });
  assert.equal(BigInt(hi.feeSompi), BigInt(Math.ceil(Number(hi.massGrams) * 5)), "fee scales with mass x feerate"); assert.equal(hi.feerate, 5);
  // RR-L4: a lying fee estimator cannot drain change: fee capped at min(0.05 KAS, 10% of amount)
  assert.throws(() => buildStandardExactPayment({ request, keyHex, payerAddress: payer, utxo: mk(1_000_000_000n), feerate: 50 }), /sanity cap/);
  assert.throws(() => buildStandardExactPayment({ request, keyHex, payerAddress: payer, utxo: mk(10_000_000n + BigInt(lo.feeSompi) + 5_000_000n) }), /burned/);
  // exact change (no change output) has a different mass, so find the utxo that leaves exactly 0 change
  let x = 10_000_000n + BigInt(lo.feeSompi), exact;
  for (let i = 0; i < 5 && !exact; i++) { try { exact = buildStandardExactPayment({ request, keyHex, payerAddress: payer, utxo: mk(x) }); } catch (e) { const m = /change (\d+) would/.exec(e.message); if (!m) throw e; x -= BigInt(m[1]); } }
  assert.equal(BigInt(sdk.Transaction.deserializeFromSafeJSON(exact.transaction).serializeToObject().outputs.length), 1n, "exact-change: no change output");
  assert.throws(() => buildStandardExactPayment({ request, keyHex, payerAddress: payer, utxo: mk(1_000_000_000n), maxStorageMass: 50_000n }), /storage mass/);
});
T("M4: concurrent payExactTransaction calls never select the same UTXO", async () => {
  const { RealTn10FundingProvider } = await import("../src/live/real-adapters.mjs");
  const keyHex = crypto.randomBytes(32).toString("hex"); const payer = new sdk.PrivateKey(keyHex).toAddress("testnet-10").toString();
  const merchant = new sdk.PrivateKey(crypto.randomBytes(32).toString("hex")).toAddress("testnet-10").toString();
  const entries = [0, 1].map((i) => ({ outpoint: { transactionId: String(i + 1).repeat(64).slice(0, 64), index: 0 }, amount: 1_000_000_000n, scriptPublicKey: sdk.payToAddressScript(payer) }));
  const rpc = { getUtxosByAddresses: async () => { await new Promise((r) => setTimeout(r, 5)); return { entries }; }, getFeeEstimate: async () => ({ estimate: { priorityBucket: { feerate: 1 } } }) };
  const p = new RealTn10FundingProvider({ rpc, keyHex });
  const req = (n) => ({ network: "kaspa:testnet-10", profile: "standard-native", amount: "10000000", payTo: merchant, payToScriptPublicKey: "00", attemptId: String(n).repeat(64), intentHash: "ef".repeat(32),
    paymentRequirementsHash: "11".repeat(32), requestHash: "22".repeat(32), paymentIdentifier: `pay_${n}`, authorizationExpiresAt: new Date(Date.now() + 60000).toISOString() });
  const [a, b] = await Promise.all([p.payExactTransaction(req(3)), p.payExactTransaction(req(4))]);
  assert.notEqual(a.inputOutpoints[0].txid, b.inputOutpoints[0].txid);
  await assert.rejects(p.payExactTransaction(req(5)), /insufficient/);
});
