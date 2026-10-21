import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry, retryReads } from "../src/retry.mjs";
const fast = { baseMs: 1, sleep: async () => {} };
test("withRetry retries transient errors then succeeds", async () => {
  let n = 0; const r = await withRetry(async () => { if (++n < 3) throw new Error("selected-chain rollback lacks a confirmed replacement"); return "ok"; }, fast);
  assert.equal(r, "ok"); assert.equal(n, 3);
});
test("withRetry does not retry non-transient errors (e.g. corrective 402 auth)", async () => {
  let n = 0; await assert.rejects(withRetry(async () => { n++; throw new Error("corrective 402 requires a new explicit payment authorization"); }, fast)); assert.equal(n, 1);
});
test("withRetry gives up after retries", async () => {
  let n = 0; await assert.rejects(withRetry(async () => { n++; throw new Error("socket closed"); }, { ...fast, retries: 2 })); assert.equal(n, 3);
});
test("retryReads only retries read methods, never sendTransaction", async () => {
  let reads = 0, sends = 0;
  const p = retryReads({ async discoverCovenantLineage() { if (++reads < 2) throw new Error("timeout"); return 1; },
    async sendTransaction() { sends++; throw new Error("timeout"); } }, fast);
  assert.equal(await p.discoverCovenantLineage(), 1); assert.equal(reads, 2);
  await assert.rejects(p.sendTransaction()); assert.equal(sends, 1);
});
import { AgentWallet } from "../src/agent-wallet.mjs";
test("AgentWallet retries funding-provider lineage reads but never sendTransaction", async () => {
  let reads = 0, sends = 0;
  const fp = { async discoverCovenantLineage() { if (++reads < 3) throw new Error("selected-chain rollback lacks a confirmed replacement"); return "lineage"; },
    async sendTransaction() { sends++; throw new Error("timeout"); } };
  const w = new AgentWallet({ allowedOrigins: ["https://api.demo.test"], perRequestMaxSompi: "10000000", dailyCapSompi: "100000000",
    fundingProvider: fp, retryReads: true, retry: { baseMs: 1, sleep: async () => {} }, fetch: async () => new Response("x") });
  const f = w.client.fundingProvider ?? w.client.options?.fundingProvider ?? w.fundingForTest;
  assert.ok(f, "wallet exposes its funding provider");
  assert.equal(await f.discoverCovenantLineage(), "lineage"); assert.equal(reads, 3);
  await assert.rejects(f.sendTransaction()); assert.equal(sends, 1);
});
test("M2: retryReads uses an explicit allowlist (a read-looking broadcast name is NOT retried)", async () => {
  let n = 0; const p = retryReads({ async getAndBroadcast() { n++; throw new Error("timeout"); } }, fast);
  await assert.rejects(p.getAndBroadcast()); assert.equal(n, 1);
});
