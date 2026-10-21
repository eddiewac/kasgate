// P0-3: node (wRPC JSON / "PNN") verification for exact payments, wired like upstream kaspa-x402 1.0.1's hosted
// demo-gateway (packages/demo-gateway/src/gateway.ts:838-900, pnn-trust.ts; https://www.kaspa-x402.org/docs/rc2-release/).
// Replaces REST-only acceptance: inputs/outputs, acceptance and confirmations are read from a Kaspa node over
// wRPC, not from the REST indexer. Durable PNN receipts + discovery checkpoints live in SQLite (this file), so an
// exact payment accepted before a restart is re-verified from its stored receipt after it.
// PnnChainEvidence keeps per-request state, so a fresh evidence/server set is built per request (as upstream does).
import { KaspaPnnClient, selectPnnChainEvidenceClient, PnnChainEvidence, ScriptAddressBook, VerifiedKaspaChainProvider,
  PnnBroadcastChainProvider, NativeAddressCodec, VerifiedExactSettlementReconciler, VerifiedExactHeadReconciler } from "@kaspa-x402/adapters";
import { createNodeBoundedPnnWebSocket } from "@kaspa-x402/adapters/pnn-node";
import { enc, dec } from "../store.mjs";

export const DEFAULT_TN10_PNN_ENDPOINTS = [
  "wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/json",
  "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/json",
];
const TXID = /^[0-9a-f]{64}$/;

/** SQLite PnnEvidenceStore (upstream interface; semantics follow demo-gateway GatewayLedger, state.ts:256-330). */
export class SqlitePnnEvidenceStore {
  #db; #mem = new Map(); #cps = []; #owner;
  /** @param owner optional (txid) => Promise<boolean>: evidence is only saved for a durable exact attempt owner. */
  constructor(db = null, { owner } = {}) {
    this.#db = db; this.#owner = owner;
    db?.exec(`CREATE TABLE IF NOT EXISTS pnn_evidence (txid TEXT PRIMARY KEY, record TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pnn_checkpoints (bucket TEXT NOT NULL, network TEXT NOT NULL, daa TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (network, bucket));`);
  }
  async loadPnnEvidence(txid) {
    if (!TXID.test(txid)) throw new Error("invalid PNN transaction id");
    if (!this.#db) return structuredClone(this.#mem.get(txid));
    const r = this.#db.prepare("SELECT record FROM pnn_evidence WHERE txid = ?").get(txid); return r ? dec(r.record) : undefined;
  }
  async savePnnEvidence(record, signal) {
    signal?.throwIfAborted();
    if (!TXID.test(record?.transactionId ?? "")) throw new Error("invalid PNN transaction id");
    if (this.#owner && !(await this.#owner(record.transactionId))) throw new Error("PNN evidence has no durable exact settlement owner");
    if (!this.#db) { this.#mem.set(record.transactionId, structuredClone(record)); return; }
    this.#db.prepare("INSERT OR REPLACE INTO pnn_evidence (txid, record, at) VALUES (?, ?, ?)").run(record.transactionId, enc(record), new Date().toISOString());
  }
  async recordPnnCheckpoint(cp, signal) {
    signal?.throwIfAborted();
    const network = cp.network ?? "kaspa:testnet-10", bucket = (BigInt(cp.daaScore) / 300n).toString();
    if (!this.#db) { if (!this.#cps.some((c) => (BigInt(c.daaScore) / 300n).toString() === bucket)) this.#cps.push(cp); this.#cps = this.#cps.slice(-128); return; }
    this.#db.transaction(() => {
      const prev = this.#db.prepare("SELECT daa FROM pnn_checkpoints WHERE network = ? AND bucket = ?").get(network, bucket);
      if (prev && BigInt(prev.daa) <= BigInt(cp.daaScore)) return; // keep the earliest observation per ~30 s bucket
      this.#db.prepare("INSERT OR REPLACE INTO pnn_checkpoints (bucket, network, daa, record) VALUES (?, ?, ?, ?)").run(bucket, network, cp.daaScore, enc(cp));
      this.#db.prepare("DELETE FROM pnn_checkpoints WHERE network = ? AND bucket NOT IN (SELECT bucket FROM pnn_checkpoints WHERE network = ? ORDER BY CAST(bucket AS INTEGER) DESC LIMIT 128)").run(network, network);
    })();
  }
  async findPnnCheckpointBefore(daaScore, network = "kaspa:testnet-10") {
    if (!this.#db) return structuredClone([...this.#cps].reverse().find((c) => BigInt(c.daaScore) < BigInt(daaScore)));
    for (const r of this.#db.prepare("SELECT daa, record FROM pnn_checkpoints WHERE network = ? ORDER BY CAST(daa AS INTEGER) DESC").all(network))
      if (BigInt(r.daa) < BigInt(daaScore)) return dec(r.record);
    return undefined;
  }
}

/**
 * Returns a factory: () => DirectModeServer deps for ONE exact request, node-verified.
 * confirmations = required selected-chain confirmations (P0-4; configurable).
 */
const LOCAL = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;
const checkEndpoint = (e) => { if (!(/^wss:\/\//.test(e) || LOCAL.test(e))) throw new Error(`PNN endpoint must be wss:// (or ws:// on loopback for a local node): ${e}`); };
/**
 * R2-P0-3: chain-evidence trust policy (upstream selectPnnChainEvidenceClient).
 * DEFAULT IS SINGLE SOURCE (R3-L1): with no cfg.pnnTrust, `endpoints` form ONE KaspaPnnClient (endpoint failover, not
 * agreement). Set cfg.pnnTrust.mode = "quorum", or env X402_PNN_DEFAULT_QUORUM=1 for a 2-of-N quorum over `endpoints`.
 *  - quorum (opt-in): every authority is a separate KaspaPnnClient in its own trust domain; evidence must
 *    agree across `required` (>= 2) of them (upstream CorroboratedKaspaPnnClient). Submission goes to `submission`
 *    (default: the first authority). A local node is just another authority: { trustDomain: "local", endpoints: ["ws://127.0.0.1:18210"] }
 *    (wRPC JSON, testnet port 18210; kaspad serves it only with --rpclisten-json).
 *  - single: one trusted source (e.g. your own node); explicit opt-in only.
 */
export function buildPnnPolicy({ trust, endpoints, timeoutMs, attempts }) {
  const mk = (eps) => { eps.forEach(checkEndpoint); return new KaspaPnnClient({ endpoints: eps, boundedWebSocketFactory: createNodeBoundedPnnWebSocket, timeoutMs, attempts }); };
  // Default: single trusted source. The 2-of-2 public-node quorum was implemented and tested live on TN10 (2026-10-21)
  // but upstream's per-request checkpoint pinning fails corroboration across the two public nodes (each rejects the
  // other's pinned checkpoint), which after broadcast means paid-without-data. Quorum is opt-in (cfg.pnnTrust).
  const t = trust ?? (process.env.X402_PNN_DEFAULT_QUORUM === "1" ? null : { mode: "single", endpoints }) ?? { mode: "quorum", authorities: (endpoints ?? DEFAULT_TN10_PNN_ENDPOINTS).map((e) => ({ trustDomain: new URL(e).hostname.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64).toLowerCase(), endpoints: [e] })), required: 2 };
  if (t.mode === "single") { const c = mk(t.endpoints ?? endpoints ?? DEFAULT_TN10_PNN_ENDPOINTS); return { client: c, mode: "single", pnn: selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: c }) }; }
  if (t.mode !== "quorum") throw new Error(`pnn trust mode must be quorum or single: ${t.mode}`);
  const authorities = t.authorities.map((a) => ({ trustDomain: a.trustDomain, client: mk(a.endpoints) }));
  if (process.env.X402_DEBUG) for (const a of authorities) for (const m of ["findAcceptedTransaction", "confirmAcceptedTransaction", "discoverCovenantLineage", "health"]) {
    const f = a.client[m]?.bind(a.client); if (!f) continue;
    a.client[m] = async (...x) => { try { return await f(...x); } catch (e) { console.error(`[x402-pnn] ${a.trustDomain}.${m} failed: ${e?.message}`); throw e; } }; }
  const required = Number(t.required ?? 2); if (!(required >= 2 && required <= authorities.length)) throw new Error("pnn quorum: required must be >= 2 and <= number of authorities");
  const submission = t.submission ? mk(t.submission) : authorities[0].client;
  const corr = selectPnnChainEvidenceClient({ mode: "independent-corroboration", submission, authorities, requiredAuthorities: required });
  return { client: submission, mode: "quorum", required, domains: authorities.map((a) => a.trustDomain), pnn: withMinDepth(corr, authorities, required) };
}

export function createPnnExactDepsFactory({ endpoints, trust, finality = "accepted", db = null, confirmations, timeoutMs = 15_000, attempts = 2, owner, pnnClient } = {}) {
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error("confirmations must be a positive integer");
  if (finality !== "confirmed" && finality !== "accepted") throw new Error("exactFinality must be confirmed or accepted");
  const policy = pnnClient ? { client: pnnClient, mode: "single", pnn: selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: pnnClient }) } : buildPnnPolicy({ trust, endpoints, timeoutMs, attempts });
  const client = policy.pnn; const pnn = policy.pnn;
  const evidenceStore = new SqlitePnnEvidenceStore(db, { owner });
  const factory = () => {
    const book = new ScriptAddressBook();
    const evidence = new PnnChainEvidence(pnn, book, evidenceStore, confirmations);
    const reads = new VerifiedKaspaChainProvider(evidence, book, "0");
    return {
      addressCodec: new NativeAddressCodec(book),
      chainProvider: new PnnBroadcastChainProvider(reads, book, pnn, confirmations),
      exactTransactionVerifier: evidence,
      persistOwnedExactEvidence: async (verified, claim, signal) => {
        if (claim.attempt.transactionId !== verified.transactionId) throw new Error("exact evidence owner does not match the verified transaction");
        await evidence.persistOwnedEvidence(verified.transactionId, verified.evidenceReceipt, signal);
      },
      exactSettlementReconciler: new VerifiedExactSettlementReconciler(evidence),
      exactHeadReconciler: new VerifiedExactHeadReconciler(evidence),
      // R2-P0-2 (DEFERRED; README Known limitations): "confirmed" (deliver only at `confirmations` depth) is supported via
      // cfg.exactFinality but failed live on TN10: re-verifying the broadcast tx at depth through the public PNN nodes
      // errors ("selected-chain positions ended before the pinned checkpoint"), so every attempt became paid-without-data.
      // Default stays "accepted" (node-proven acceptance, depth 0), which is live-proven to deliver.
      acceptedFinality: finality,
    };
  };
  // R5-M4: depth capability probe used by the depth-gated preflight: prove a known deep tx at `confirmations` on the
  // same (corroborated, min-depth) client that will verify the payment. Throws when depth cannot be proven.
  factory.probeDepth = async (txid) => {
    const f = await pnn.findAcceptedTransaction(String(txid).toLowerCase());
    if (!f?.evidence || f.evidence.status === "unknown" || !f.evidence.acceptingBlockHash) throw new Error(`depth probe: ${txid} not proven accepted`);
    const c = await pnn.confirmAcceptedTransaction(f.evidence, confirmations);
    if (c?.confirmationCount != null && BigInt(c.confirmationCount) < BigInt(confirmations)) throw new Error(`depth probe: ${c.confirmationCount} < ${confirmations} confirmations`);
    return c; };
  factory.health = () => client.health(); factory.evidenceStore = evidenceStore; factory.trust = { mode: policy.mode, required: policy.required, domains: policy.domains };
  return factory;
}

/**
 * R3-M1 / R5-M2 / R5-M3 (protocol): upstream corroboration strips confirmationCount before comparing and returns the
 * FIRST authority's answer, so one authority could overstate depth. Wrap the corroborated client: after it agrees on
 * the facts, ask every authority again and report the MINIMUM confirmationCount. At least `required` authorities must
 * answer the second round with a depth, otherwise the call FAILS CLOSED (a silent or failing honest authority can no
 * longer leave a deeper value standing). Depth is never raised, only lowered. discoverCovenantLineage (batch lineage
 * depth) is wrapped too: every transition / genesis acceptance gets the minimum over the authorities.
 */
export function withMinDepth(corr, authorities, required = 2) {
  const need = Math.max(1, Math.min(Number(required) || 1, authorities.length));
  const setCount = (ev, min) => { ev.confirmationCount = typeof ev.confirmationCount === "number" ? Number(min) : (typeof ev.confirmationCount === "bigint" ? BigInt(min) : String(min)); };
  const second = async (method, a) => {
    const all = await Promise.allSettled(authorities.map((x) => x.client[method](...a)));
    const ok = all.filter((s) => s.status === "fulfilled" && s.value).map((s) => s.value);
    return ok; };
  const wrap = (method, pick) => { const f = corr[method]?.bind(corr); if (!f) return;
    corr[method] = async (...a) => { const r = await f(...a); const ev = r ? pick(r) : null; if (!ev || ev.confirmationCount == null) return r;
      const counts = (await second(method, a)).map((v) => pick(v)?.confirmationCount).filter((c) => c != null);
      if (counts.length < need) throw new Error(`pnn quorum: only ${counts.length} of ${need} required authorities proved depth (${method}); failing closed`);
      let min = BigInt(ev.confirmationCount); for (const c of counts) if (BigInt(c) < min) min = BigInt(c);
      if (min >= BigInt(ev.confirmationCount)) return r;
      const out = structuredClone(r); setCount(pick(out), min); return out; }; };
  wrap("confirmAcceptedTransaction", (v) => v);
  wrap("findAcceptedTransaction", (v) => v?.evidence);
  wrap("findHashChainPayment", (v) => v?.evidence);
  // lineage: acceptances keyed by blockHash + transition index (genesis: blockHash + "g")
  const acceptances = (v) => { const m = new Map();
    for (const b of v?.addedChainBlocks ?? []) { if (b.genesisAcceptance) m.set(`${b.blockHash}:g`, b.genesisAcceptance);
      (b.transitions ?? []).forEach((t, i) => { if (t.acceptance) m.set(`${b.blockHash}:${i}`, t.acceptance); }); }
    return m; };
  const lf = corr.discoverCovenantLineage?.bind(corr);
  if (lf) corr.discoverCovenantLineage = async (...a) => {
    const r = await lf(...a); const mine = acceptances(r); if (![...mine.values()].some((e) => e.confirmationCount != null)) return r;
    const others = (await second("discoverCovenantLineage", a)).map(acceptances);
    const out = structuredClone(r); const outAcc = acceptances(out);
    for (const [k, ev] of outAcc) { if (ev.confirmationCount == null) continue;
      const counts = others.map((m) => m.get(k)?.confirmationCount).filter((c) => c != null);
      if (counts.length < need) throw new Error(`pnn quorum: only ${counts.length} of ${need} required authorities proved lineage depth; failing closed`);
      let min = BigInt(ev.confirmationCount); for (const c of counts) if (BigInt(c) < min) min = BigInt(c);
      setCount(ev, min); }
    return out; };
  corr.minDepthAcrossAuthorities = true;
  return corr;
}
