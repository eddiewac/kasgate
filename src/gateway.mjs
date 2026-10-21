// Seller gateway: reverse proxy that puts any HTTP API behind Kaspa x402 (exact scheme).
// Protocol logic (402 offers, PAYMENT-SIGNATURE parsing, verification, replay) is
// entirely @kaspa-x402/server's DirectModeServer. This file only routes, prices, proxies, and logs.
import { withRetry, retryReads } from "./retry.mjs";
import http from "node:http";
import { createPersistentServerStore } from "./store.mjs";
import { createSessionManager } from "./auth.mjs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DirectModeServer, MemoryServerChannelStore, MemoryChannelLockManager, MemoryPublicBoundaryController } from "@kaspa-x402/server";
import { TESTNET_10_CONFIRMATION_THRESHOLD, decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@kaspa-x402/core";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { loadConfig, matchRoute, assertRealChainPolicy } from "./config.mjs";
import { Ledger, sompiToKas } from "./ledger.mjs";
import { createPnnExactDepsFactory } from "./live/pnn-deps.mjs";
import { createMockBatchWorld } from "./mock-batch.mjs";
import { MockAddressCodec, MockChainProvider, mockExactTransactionVerifier } from "./mock-chain.mjs";

/**
 * @param {"mock"|"real"} chain  mock = in-process fake chain (default, offline);
 *   real = Testnet-10. Exact payments are verified, broadcast and confirmed against a Kaspa node over wRPC
 *   (upstream 1.0.1 PNN adapters, src/live/pnn-deps.mjs); batch uses the live kit (node RPC).
 * @param {object|function} [realDeps]  override for the exact deps (object or per-request factory; tests)
 */
/** R2-P0-1: rate-limit key. IPv4 = address; IPv6 grouped by /64 (one end-user allocation); IPv4-mapped IPv6 -> IPv4. */
export function ipKey(ip) {
  let a = String(ip ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) return m[1];
  if (!a.includes(":")) return a;
  const [head, tail = ""] = a.split("::"); const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const full = a.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return full.slice(0, 4).map((x) => (parseInt(x || "0", 16) || 0).toString(16)).join(":") + "::/64";
}

/** payment-identifier id of a PAYMENT-SIGNATURE (stable across the payer's identical retries of one payment). */
export function sigPaymentId(h) { try { const p = JSON.parse(Buffer.from(String(h), "base64").toString("utf8"));
  const id = p?.extensions?.["payment-identifier"]?.info?.id; return typeof id === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(id) ? id : null; } catch { return null; } }

export function createGateway(cfg, { ledgerPath = null, db = null, passwordHash = process.env.X402_DASHBOARD_PASSWORD_HASH, secureCookie = !/^(1|true)$/i.test(process.env.X402_INSECURE_COOKIE ?? ""), chain = "mock", realDeps, mockWorld, liveKit, refundTimeoutDaa, nowDaa, runId = randomUUID().slice(0, 8), maxBodyBytes = cfg.maxBodyBytes ?? 1_048_576, adapterTimeoutMs, verifyFirst = true, exactRecovery = true, payerRateLimit = { perMinute: 30 }, upstreamTimeoutMs: upstreamTimeoutOpt, settleReplayDelaysMs = chain === "real" ? [2000, 3000, 4000, 5000, 6000, 8000, 10000] : [50, 100], depthPreflight } = {}) {
  if (!["mock", "real"].includes(chain)) throw new Error(`unknown chain mode ${chain}`);
  const hasBatch = cfg.routes.some((r) => r.scheme === "batch-settlement");
  if (hasBatch && chain === "real" && !liveKit) throw new Error("batch-settlement live adapters require liveKit (src/live/batch-kit.mjs createLiveBatchKit)");
  if (liveKit && !refundTimeoutDaa && nowDaa == null) throw new Error("real batch needs nowDaa (current virtual DAA) for per-channel refund timeouts");
  // M5: refuse the shipped dev token; token is only accepted via Authorization: Bearer and compared in constant time.
  if (cfg.dashboard?.token === "change-me-dev-token") throw new Error("dashboard.token is the shipped default; set your own or use X402_DASHBOARD_PASSWORD_HASH");
  if (passwordHash && !String(cfg.dashboard.path).startsWith("/_x402/")) throw new Error("dashboard.path must start with /_x402/ when login is enabled (session cookie path)");
  if (chain === "real") assertRealChainPolicy(cfg);
  const world = hasBatch ? (chain === "real" ? liveKit : (mockWorld ?? createMockBatchWorld())) : null;
  // Batch deps (live kit on TN10, mock world otherwise). Exact deps are built per request (below).
  const deps = chain === "real" ? (liveKit ? { addressCodec: liveKit.addressCodec, chainProvider: liveKit.chain } : {})
    : { addressCodec: world?.addressCodec ?? new MockAddressCodec(), chainProvider: world?.chainProvider ?? new MockChainProvider() };
  // P0-4: confirmation threshold is configurable; real chain default 100 selected-chain confirmations (~10 s at 10 BPS).
  const confirmations = Number(cfg.confirmations ?? (chain === "real" ? 100 : TESTNET_10_CONFIRMATION_THRESHOLD));
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error("confirmations must be a positive integer");
  if (chain === "real" && confirmations < 30 && !cfg.allowLowConfirmations) throw new Error("real chain: confirmations must be >= 30");
  const claimFee0 = BigInt(liveKit?.feeSompi ?? cfg.batch?.claimReserveSompi ?? 0), minNet0 = BigInt(cfg.settlement?.minClaimNetSompi ?? (chain === "real" ? 11_000_000 : 0));
  // R2-P0-1: a channel must be able to reach a minable claim: deposit >= claim minimum (minNet + claim fee).
  if ((mockWorld || liveKit) && chain === "real" && cfg.batch?.minDepositSompi != null && BigInt(cfg.batch.minDepositSompi) < minNet0 + claimFee0 && !cfg.batch.allowSmallDeposit)
    throw new Error(`batch.minDepositSompi (${cfg.batch.minDepositSompi}) must be >= claim minimum ${minNet0 + claimFee0} (minClaimNet + claim fee)`);
  const hasExact = cfg.routes.some((r) => !r.free && r.scheme !== "batch-settlement");
  const retryOpts = { ...(cfg.retry ?? {}), onRetry: (m, e, n, ms) => console.error(`[x402-retry] ${m} attempt ${n} in ${ms}ms: ${e?.message}`) };
  if (chain === "real" && deps.chainProvider) deps.chainProvider = retryReads(deps.chainProvider, retryOpts);
  if (process.env.X402_DEBUG) for (const k of ["exactTransactionVerifier", "chainProvider", "exactSettlementReconciler"]) {
    const o = deps[k]; if (!o) continue;
    deps[k] = new Proxy(o, { get(t, p) { const v = t[p]; if (typeof v !== "function") return v;
      return async (...a) => { try { return await v.apply(t, a); } catch (e) { console.error(`[x402-debug] ${k}.${String(p)}: ${e?.message}`); throw e; } }; } });
  }
  const store = db ? createPersistentServerStore(db) : new MemoryServerChannelStore();
  const exactFinality = cfg.exactFinality ?? "accepted";
  // P0-3: node-verified exact deps (fresh per request: upstream PnnChainEvidence holds per-request state).
  const exactDeps = !hasExact ? null : chain === "real"
    ? (typeof realDeps === "function" ? realDeps : realDeps ? () => realDeps
      : createPnnExactDepsFactory({ endpoints: cfg.pnnEndpoints, trust: cfg.pnnTrust, finality: cfg.exactFinality ?? "accepted", db, confirmations, owner: async (txid) => !!(await store.loadExactSettlementAttempt(txid)) }))
    : () => ({ addressCodec: world?.addressCodec ?? new MockAddressCodec(), chainProvider: world?.chainProvider ?? new MockChainProvider(), exactTransactionVerifier: mockExactTransactionVerifier });
  // R3-M3: in depth-gated mode (exactFinality "confirmed") the node must be able to serve evidence BEFORE we let
  // upstream broadcast. Default preflight = PNN health (real chain); tests inject their own.
  const preflight = exactFinality !== "confirmed" ? null : (depthPreflight ?? (exactDeps?.health ? () => exactDeps.health() : null));
  // R3-M3: payments broadcast but not yet provable at depth are HELD as pending (durable) and delivered on a retry of
  // the same payment, instead of ending as paid-without-data.
  const pendingMem = new Map(), payIdMem = new Map();
  const payIds = db ? { set: (k, v) => db.prepare("INSERT OR REPLACE INTO kv (ns,k,v) VALUES ('exact-payid',?,?)").run(k, v), get: (k) => k ? db.prepare("SELECT v FROM kv WHERE ns='exact-payid' AND k=?").get(k)?.v : undefined }
    : { set: (k, v) => payIdMem.set(k, v), get: (k) => payIdMem.get(k) };
  const pending = db ? { set: (k, v) => db.prepare("INSERT OR REPLACE INTO kv (ns,k,v) VALUES ('exact-pending',?,?)").run(k, JSON.stringify(v)),
      get: (k) => { const r = db.prepare("SELECT v FROM kv WHERE ns='exact-pending' AND k=?").get(k); return r ? JSON.parse(r.v) : undefined; },
      delete: (k) => db.prepare("DELETE FROM kv WHERE ns='exact-pending' AND k=?").run(k),
      list: () => db.prepare("SELECT k, v FROM kv WHERE ns='exact-pending'").all().map((r) => ({ txid: r.k, ...JSON.parse(r.v) })) }
    : { set: (k, v) => pendingMem.set(k, v), get: (k) => pendingMem.get(k), delete: (k) => pendingMem.delete(k), list: () => [...pendingMem].map(([txid, v]) => ({ txid, ...v })) };
  // In-memory store (no db): claim + evidence save are trivially "atomic" (single process, nothing durable).
  if (!store.claimExactSettlementWithEvidence) store.claimExactSettlementWithEvidence = async (attempt, receipt) => {
    if (receipt?.transactionId !== attempt?.transactionId) throw new Error("PNN evidence does not match exact settlement claim");
    const r = await store.claimExactSettlement(attempt); await exactDeps?.evidenceStore?.savePnnEvidence?.(receipt); return r; };
  if (liveKit?.batchRecovery) liveKit.batchRecovery.serverStore = store;
  // Diagnostics: trace exact settlement-attempt transitions (X402_DEBUG) to explain any paid-without-response case.
  if (process.env.X402_DEBUG) for (const m of ["claimExactSettlement", "claimExactSettlementWithEvidence", "recordExactSettlementBroadcast", "acceptExactSettlement", "beginExactHandler",
    "resetExactHandlerBeforeExecution", "recordExactHandlerResult", "markExactHandlerRecoveryRequired", "abandonExactSettlement", "commitExactPayment"]) {
    const f = store[m]; if (typeof f !== "function") continue;
    store[m] = async (...a) => { const t0 = Date.now(); const id = typeof a[0] === "string" ? a[0].slice(0, 12) : (a[0]?.transactionId ?? a[0]?.payment?.transactionId ?? "").slice?.(0, 12);
      try { const r = await f.apply(store, a); console.error(`[x402-trace] ${new Date().toISOString()} ${m}(${id}${m === "markExactHandlerRecoveryRequired" ? ", " + a[1] : ""}) -> ${typeof r === "boolean" ? r : "ok"} ${Date.now() - t0}ms`); return r; }
      catch (e) { console.error(`[x402-trace] ${new Date().toISOString()} ${m}(${id}) THREW ${e?.message}`); throw e; } };
  }
  const lockManager = new MemoryChannelLockManager(); // shared across rotated server instances
  // H2: refund timeout is computed per channel open = currentDaa + delta. The DirectModeServer advertises one
  // absolute timeout, so we rotate the instance (same store + lock manager) as DAA advances and enable upstream's
  // rolling-timeout mode so channels opened under an earlier instance stay valid. minimumRefundLeadDaa (claim
  // margin) makes upstream refuse vouchers on channels too close to their timeout.
  const b = cfg.batch ?? {}; const delta = BigInt(b.refundTimeoutDeltaDaa ?? 0);
  const margin = BigInt(b.claimMarginDaa ?? (delta / 4n || 1n)); const rotateEvery = BigInt(b.rotateEveryDaa ?? (delta / 10n || 1n));
  const fixedTimeout = refundTimeoutDaa != null;
  const daaNow = async () => liveKit ? await liveKit.virtualDaa() : BigInt(world.chainProvider.daa);
  let lastDaa = world ? (nowDaa != null ? BigInt(nowDaa) : (liveKit ? 0n : BigInt(world.chainProvider.daa))) : 0n;
  const finality = b.acceptedFinality ?? (liveKit ? "confirmed" : undefined); // M7
  // RR-M5: one public-boundary controller shared by every server instance (rotation + per-request exact servers).
  const boundaryTimeout = adapterTimeoutMs ?? (liveKit ? 180_000 : chain === "real" ? 120_000 : undefined);
  const publicBoundaryController = new MemoryPublicBoundaryController(boundaryTimeout ? { adapterTimeoutMs: boundaryTimeout } : {});
  /** Exact server for one request; its verifier runs `onVerified` after node verification and before settlement. */
  const dbg = (name, o) => !process.env.X402_DEBUG || !o ? o : new Proxy(o, { get(t, p) { const v = t[p]; if (typeof v !== "function") return v;
    return async (...a) => { const t0 = Date.now(); try { const r = await v.apply(t, a); console.error(`[x402-debug] ${new Date().toISOString()} ${name}.${String(p)} ok ${Date.now() - t0}ms`); return r; }
      catch (e) { console.error(`[x402-debug] ${new Date().toISOString()} ${name}.${String(p)} THREW after ${Date.now() - t0}ms: ${e?.code ?? ""} ${e?.message}`); throw e; } }; } });
  const buildExact = (onVerified) => { const d0 = exactDeps(); const d = { ...d0, chainProvider: dbg("chain", d0.chainProvider), exactSettlementReconciler: dbg("settleRec", d0.exactSettlementReconciler), exactHeadReconciler: dbg("headRec", d0.exactHeadReconciler) }; const inner = d.exactTransactionVerifier;
    return new DirectModeServer({ network: cfg.network, payTo: cfg.payTo, amount: "10000000", confirmationThreshold: confirmations, store, lockManager,
      exactProfile: "standard-native", addressCodec: d.addressCodec, chainProvider: d.chainProvider,
      exactTransactionVerifier: { verifyExactPayment: async (req) => { let v;
        const tv = Date.now(); try { v = await inner.verifyExactPayment(req); if (process.env.X402_DEBUG) console.error(`[x402-debug] verify ok ${Date.now() - tv}ms`); } catch (e) { console.error(`[x402-verify] exact verification failed: ${e?.code ?? ""} ${e?.message}`); throw e; }
        const to = Date.now(); await onVerified(v); if (process.env.X402_DEBUG) console.error(`[x402-debug] onVerified ok ${Date.now() - to}ms`); return v; } },
      ...(d.persistOwnedExactEvidence ? { persistOwnedExactEvidence: d.persistOwnedExactEvidence } : {}),
      ...(d.exactSettlementReconciler ? { exactSettlementReconciler: d.exactSettlementReconciler } : {}),
      ...(d.exactHeadReconciler ? { exactHeadReconciler: d.exactHeadReconciler } : {}),
      ...(d.acceptedFinality ? { acceptedFinality: d.acceptedFinality } : {}), publicBoundaryController }); };
  const build = (timeout) => new DirectModeServer({
    network: cfg.network, payTo: cfg.payTo, amount: "10000000",
    confirmationThreshold: confirmations, store, lockManager, exactProfile: "standard-native",
    addressCodec: deps.addressCodec ?? new MockAddressCodec(), chainProvider: deps.chainProvider ?? new MockChainProvider(),
    ...(world ? { batch: { ...world.serverBatch({ ...cfg.batch, refundTimeoutDaa: timeout.toString() }), minimumRefundLeadDaa: margin.toString(),
      ...(fixedTimeout ? {} : { allowRollingRefundTimeoutDaa: true, maximumRefundHorizonDaa: (delta + 2n * rotateEvery).toString() }) } } : {}),
    ...(finality ? { acceptedFinality: finality } : {}),
    publicBoundaryController,
  });
  let currentTimeout = world ? (fixedTimeout ? BigInt(refundTimeoutDaa) : lastDaa + delta) : 0n;
  // Restart continuity: upstream clients only reuse a channel whose refundTimeoutDaa equals the advertised one
  // (client channelMatchesRequirement). Re-advertise the persisted rolling timeout after a restart while it is
  // still within one rotation step, so a restart does not force every payer to open (and fund) a new channel.
  const TKEY = ["batch-advertised-timeout", String(cfg.payTo)];
  const saveTimeout = () => { if (db && world && !fixedTimeout) db.prepare("INSERT OR REPLACE INTO kv (ns, k, v) VALUES (?, ?, ?)").run(...TKEY, currentTimeout.toString()); };
  if (db && world && !fixedTimeout && lastDaa > 0n) { const row = db.prepare("SELECT v FROM kv WHERE ns = ? AND k = ?").get(...TKEY);
    const prev = row ? BigInt(row.v) : null; if (prev != null && prev > lastDaa + margin && lastDaa + delta - prev < rotateEvery && prev <= lastDaa + delta) currentTimeout = prev; }
  saveTimeout();
  let server = build(currentTimeout);
  async function rotateIfNeeded() {
    if (!world || fixedTimeout) return;
    try { lastDaa = await daaNow(); } catch { return; }
    if (lastDaa + delta - currentTimeout >= rotateEvery) { currentTimeout = lastDaa + delta; saveTimeout(); server = build(currentTimeout); }
  }
  const seenExact = db ? { has: (k) => !!db.prepare("SELECT 1 FROM kv WHERE ns='exact-seen' AND k=?").get(k), add: (k) => db.prepare("INSERT OR IGNORE INTO kv (ns,k,v) VALUES ('exact-seen',?,?)").run(k, JSON.stringify({ at: new Date().toISOString(), runId })) } : null;
  const ledger = new Ledger(ledgerPath, db, { runId });
  const sessions = createSessionManager({ passwordHash, db, secureCookie });
  const claimFee = BigInt(liveKit?.feeSompi ?? cfg.batch?.claimReserveSompi ?? 0);
  const minNet = BigInt(cfg.settlement?.minClaimNetSompi ?? (chain === "real" ? 11_000_000 : 0));
  const pendingOpens = new Map(); // ipKey -> in-flight channel opens (R2-P0-1 race)
  // R3 (economic, risk R3-M3): the request that OPENS a batch channel is charged at least the claim minimum up front,
  // so every channel is claimable from its first call and "free below the minimum" is gone. Real chain default:
  // minNet + claim fee; mock/tests: opt-in via batch.openChargeSompi.
  const openCharge = cfg.batch?.openChargeSompi != null ? BigInt(cfg.batch.openChargeSompi) : (chain === "real" && world ? minNet + claimFee : null);
  const maxSubMinPerIp = cfg.batch?.maxSubMinimumChannelsPerClient != null ? Number(cfg.batch.maxSubMinimumChannelsPerClient) : (chain === "real" ? 1 : null);
  // Hop-by-hop + framing headers are never forwarded; payment-* / set-cookie from upstream are dropped so the
  // origin cannot spoof x402 headers or set cookies on the gateway's origin.
  const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization",
    "content-length", "content-encoding", "set-cookie", "payment-required", "payment-response", "payment-signature", "www-authenticate", "host"]);
  // M6: request headers to the origin: same drop set + credentials/cookies + client-supplied forwarding headers.
  const REQ_DROP = new Set([...DROP, "cookie", "authorization", "forwarded", "x-real-ip", "expect"]);
  const reqPass = cfg.passRequestHeaders ? new Set(cfg.passRequestHeaders.map((h) => h.toLowerCase())) : null;
  const passList = cfg.passHeaders ? new Set(cfg.passHeaders.map((h) => h.toLowerCase())) : null;
  const upstreamHeaders = (h) => { const out = {}; for (const [k, v] of h) { const n = k.toLowerCase();
    if (DROP.has(n) || n.startsWith("x-x402-") || (passList ? (!passList.has(n) && n !== "content-type") : n.startsWith("access-control-"))) continue; out[n] = v; } return out; };

  async function proxy(req, path, body, signal) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) { const n = k.toLowerCase();
      if (REQ_DROP.has(n) || n.startsWith("x-forwarded-") || n.startsWith("x-x402-") || (reqPass && !reqPass.has(n) && n !== "content-type" && n !== "accept")) continue; headers[n] = v; }
    headers["x-forwarded-for"] = req.socket.remoteAddress ?? ""; headers["x-forwarded-proto"] = new URL(cfg.publicOrigin).protocol.replace(":", "");
    const r = await fetch(new URL(path, cfg.upstream), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, ...(signal ? { signal } : {}) });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, contentType: r.headers.get("content-type") ?? "application/octet-stream", headers: upstreamHeaders(r.headers), body: parsed };
  }

  const IDEMPOTENT = new Set(["GET", "HEAD"]);
  // RR-L: client IP for admission/rate keys. X-Forwarded-For is honoured only from configured trusted proxies.
  const trustedProxies = new Set(cfg.trustedProxies ?? []);
  const clientIp = (req) => { const peer = req.socket.remoteAddress ?? "";
    if (trustedProxies.has(peer)) { const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean); if (xff.length) return xff.at(-1); }
    return peer; };
  const upstreamTimeoutMs = Number(upstreamTimeoutOpt ?? cfg.upstreamTimeoutMs ?? 20_000);
  // Verified-first origin results, keyed by the node-verified txid (LRU-bounded; RR-L2).
  const lru = (max) => { const m = new Map(); return { get: (k) => { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
    set: (k, v) => { m.delete(k); m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); }, has: (k) => m.has(k), get size() { return m.size; } }; };
  const resultByTxid = lru(2000);
  // Per-payer (verified request-authorization key) limit on verified-first origin fetches.
  const payerHits = lru(10_000);
  const payerAllowed = (key) => { if (!payerRateLimit || !key) return true; const now = Date.now(), w = (payerHits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (w.length >= Number(payerRateLimit.perMinute)) { payerHits.set(key, w); return false; } w.push(now); payerHits.set(key, w); return true; };
  const isRecoveryRequired = (r) => (r.status === 500 || r.status === 503) && !Object.keys(r.headers ?? {}).some((h) => h.toLowerCase() === "payment-response") &&
    (r.body == null || r.body?.error === "exact_settlement_recovery_required");
  /** Origin fetch with a timeout and one retry; ok only for a non-5xx answer. */
  async function fetchOrigin(req, u, body) {
    let last;
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      let timer;
      try { const p = await Promise.race([proxy(req, u.pathname + u.search, body, AbortSignal.timeout(upstreamTimeoutMs)),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`origin timed out after ${upstreamTimeoutMs}ms`)), upstreamTimeoutMs); timer.unref?.(); })]).finally(() => clearTimeout(timer));
        if (p.status < 500) return { ok: true, ...p, ms: Date.now() - t0 };
        last = `origin status ${p.status}`;
      } catch (e) { last = String(e?.message ?? e); }
    }
    return { ok: false, error: last };
  }

  /** Seller settlement: claim every channel's voucher-authorized amount on-chain (upstream executeClaim). */
  async function claimAll({ minClaimSompi = "0", channelIds, nearTimeout = false } = {}) {
    if (!world) return { claims: [] };
    const claims = [];
    for (const ch of await server.listClaimableChannels()) {
      if (channelIds && !channelIds.includes(ch.channelId)) continue;
      const open = await store.loadOpenClaimAttempt(ch.channelId);
      if (open) { claims.push({ channelId: ch.channelId, pending: true, status: open.status, txid: open.transactionId, note: "open claim attempt; recover before claiming again" }); continue; }
      const preview = await withRetry(() => server.previewClaim(ch.channelId), retryOpts).catch((e) => ({ error: e.message }));
      // Storage-mass guard (KIP-9): keep the merchant claim output well clear of ~0.1 KAS, where storage mass reaches
      // ~100,000 g. (N-L2: claim aac05708..., 0.10 net, compute mass 4,222 g, WAS eventually accepted on TN10; the guard
      // is a safety margin against slow/non-standard inclusion, not evidence that such claims fail.)
      if (!preview.error && preview.claimAmount && minNet > 0n && BigInt(preview.claimAmount) - claimFee < minNet) {
        // P0-5: a channel that reaches its refund window below the minable claim minimum is a (bounded) loss: those
        // calls were served but cannot be claimed. Book it explicitly (once per channel) instead of hiding it.
        if (nearTimeout && db && !db.prepare("SELECT 1 FROM kv WHERE ns='batch-accepted-loss' AND k=?").get(ch.channelId)) {
          db.prepare("INSERT OR IGNORE INTO kv (ns,k,v) VALUES ('batch-accepted-loss',?,?)").run(ch.channelId, JSON.stringify({ at: new Date().toISOString(), unclaimedSompi: preview.claimAmount }));
          ledger.record({ outcome: "accepted-loss", scheme: "batch-settlement", route: "(settlement)", path: "-", amountSompi: "0", unclaimedSompi: preview.claimAmount, channelId: ch.channelId, error: `below minable claim minimum ${minNet} + fee ${claimFee}` });
        }
        claims.push({ channelId: ch.channelId, skipped: `net payout ${BigInt(preview.claimAmount) - claimFee} below storage-mass-safe minimum ${minNet}` }); continue; }
      if (!preview.error && preview.claimAmount && BigInt(preview.claimAmount) < BigInt(minClaimSompi)) { claims.push({ channelId: ch.channelId, skipped: `below minClaimSompi (${preview.claimAmount})` }); continue; }
      if (preview.error || !preview.claimAmount || preview.claimAmount === "0") { claims.push({ channelId: ch.channelId, skipped: preview.error ?? "nothing claimable" }); continue; }
      // M2: executeClaim broadcasts, so it is never retried. On failure we report the persisted attempt (if any) as pending.
      let r;
      try { r = await server.executeClaim(ch.channelId, preview.claimAmount); }
      catch (e) {
        const att = await store.loadOpenClaimAttempt(ch.channelId).catch(() => null);
        if (att) { ledger.record({ outcome: "claim-pending", scheme: "batch-settlement", route: "(settlement)", path: "-", amountSompi: "0", txid: att.transactionId, channelId: ch.channelId, error: e.message });
          claims.push({ channelId: ch.channelId, pending: true, status: att.status, txid: att.transactionId, error: e.message }); continue; }
        claims.push({ channelId: ch.channelId, error: e.message }); continue;
      }
      const txid = r.transactionId ?? r.claim?.transactionId ?? r.transaction;
      claims.push({ channelId: ch.channelId, claimAmount: preview.claimAmount, ...bookClaim(ch.channelId, preview.claimAmount, txid) });
    }
    return { claims };
  }
  // L1: book gross, fee and net (claim fee is deducted from the claimed amount on-chain).
  function bookClaim(channelId, gross, txid, extra = {}) {
    const fee = claimFee < BigInt(gross) ? claimFee : 0n; const net = (BigInt(gross) - fee).toString();
    // N-M3: never book the same claim txid twice (e.g. recovered after a crash that happened after booking).
    if (txid && ledger.entries.some((e) => e.outcome === "claim" && e.txid === txid)) return { txid, feeSompi: fee.toString(), netSompi: net, alreadyBooked: true };
    ledger.record({ outcome: "claim", scheme: "batch-settlement", route: "(settlement)", path: "-", amountSompi: gross, feeSompi: fee.toString(), netSompi: net, txid, channelId, ...extra });
    return { txid, feeSompi: fee.toString(), netSompi: net };
  }
  // H1 / P-M3 / RR-H3: on start, recover open claim attempts restored from the journal. Booking uses the attempt's
  // own claimAmount (N-M3). Attempts that cannot be recovered yet (node lagging, continuation not yet visible) are
  // retried periodically instead of staying stuck until the payer can refund.
  const recovery = [];
  async function recoverOne(a) {
    try { const r = await server.recoverAcceptedClaim(a.channelId, { transactionId: a.transactionId });
      const gross = a.claimAmount ?? (BigInt(r.claimAmount ?? r.channel?.claimedCumulativeAmount ?? 0)).toString();
      return { ...a, status: "recovered", error: undefined, ...bookClaim(a.channelId, gross, r.transactionId ?? a.transactionId, { recovered: true }) };
    } catch (e) {
      // the attempt may have been resolved meanwhile (e.g. applied by an identical later call)
      const still = await store.loadOpenClaimAttempt(a.channelId).catch(() => null);
      if (!still) return { ...a, status: "resolved", error: undefined };
      return { ...a, status: "recovery-required", error: e.message, tries: (a.tries ?? 0) + 1 };
    }
  }
  const recovered = (async () => {
    const restored = (await store.restored) ?? [];
    for (const a of restored) recovery.push(a.error && !a.attemptId ? { ...a, status: "recovery-required" } : await recoverOne(a));
    return recovery;
  })();
  const recoveryTimer = world ? setInterval(async () => { await recovered;
    for (let i = 0; i < recovery.length; i++) if (recovery[i].status === "recovery-required" && recovery[i].attemptId) {
      recovery[i] = await recoverOne(recovery[i]);
      if (recovery[i].status === "recovery-required" && recovery[i].tries % 10 === 0) console.error(`[x402-claim] ALERT claim ${recovery[i].transactionId} on ${recovery[i].channelId} still recovery-required: ${recovery[i].error}`);
    } }, Number(b.recoveryRetryMs ?? 60_000)) : null; recoveryTimer?.unref?.();
  // Periodic seller settlement: claim every N paid batch calls and/or every T minutes (non-overlapping).
  const st = cfg.settlement ?? {}; let sinceClaim = 0, claiming = null, timer = null; const autoClaims = [];
  const autoClaim = (reason) => {
    if (claiming || !world) return claiming;
    sinceClaim = 0;
    claiming = claimAll({ minClaimSompi: st.minClaimSompi ?? (chain === "real" ? "13000000" : "10000000") })
      .then((r) => { autoClaims.push({ at: new Date().toISOString(), reason, ...r }); return r; })
      .catch((e) => { autoClaims.push({ at: new Date().toISOString(), reason, error: e.message }); console.error(`[x402-claim] ${reason}: ${e.message}`); })
      .finally(() => { claiming = null; });
    return claiming;
  };
  if (st.claimEveryMinutes && world) { timer = setInterval(() => autoClaim("interval"), Number(st.claimEveryMinutes) * 60_000); timer.unref(); }
  // H2: claim any channel whose refund timeout is within 2x the claim margin, before the payer can refund.
  async function claimNearTimeout() {
    if (!world || claiming) return null;
    await rotateIfNeeded();
    const due = (await server.listClaimableChannels()).filter((c) => BigInt(c.channelConfig?.refundTimeoutDaa ?? c.config?.refundTimeoutDaa ?? 2n ** 62n) - lastDaa <= 2n * margin).map((c) => c.channelId);
    if (!due.length) return null;
    claiming = claimAll({ channelIds: due, nearTimeout: true }).then((r) => { autoClaims.push({ at: new Date().toISOString(), reason: "refund-timeout-near", ...r }); return r; })
      .catch((e) => { autoClaims.push({ at: new Date().toISOString(), reason: "refund-timeout-near", error: e.message }); }).finally(() => { claiming = null; });
    return claiming;
  }
  const nearTimer = world ? setInterval(() => claimNearTimeout().catch(() => {}), Number(b.timeoutCheckMs ?? 15_000)) : null; nearTimer?.unref();
  const tokenDigest = cfg.dashboard?.token ? createHash("sha256").update(String(cfg.dashboard.token)).digest() : null;
  const bearerOk = (req) => { if (!tokenDigest) return false; const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? ""); if (!m) return false;
    return timingSafeEqual(createHash("sha256").update(m[1]).digest(), tokenDigest); };
  const authed = (req) => sessions.enabled ? sessions.check(req) : bearerOk(req);

  const handler = async (req, res) => {
    const send = (status, headers, payload) => {
      const isStr = typeof payload === "string";
      res.writeHead(status, { "content-type": isStr ? "text/html; charset=utf-8" : "application/json", ...headers });
      res.end(isStr ? payload : JSON.stringify(payload ?? null));
    };
    // M6: bounded body.
    if (Number(req.headers["content-length"] ?? 0) > maxBodyBytes) { res.setHeader("connection", "close"); return send(413, {}, { error: "request body too large" }); }
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > maxBodyBytes) { res.setHeader("connection", "close"); send(413, {}, { error: "request body too large" }); req.destroy(); return; } chunks.push(c); }
    const body = Buffer.concat(chunks).toString("utf8");
    const u = new URL(req.url, cfg.publicOrigin);
    try {
      if (u.pathname === "/_x402/login") {
        if (!sessions.enabled) return send(404, {}, { error: "login disabled: set X402_DASHBOARD_PASSWORD_HASH" });
        if (req.method === "GET") return send(200, {}, loginHtml());
        if (req.method !== "POST") return send(405, {}, { error: "method" });
        let pw; try { pw = req.headers["content-type"]?.includes("json") ? JSON.parse(body).password : new URLSearchParams(body).get("password"); } catch {}
        const r = await sessions.login(pw, req.socket.remoteAddress);
        if (!r.ok) return send(r.status, {}, { error: r.error });
        res.writeHead(303, { "set-cookie": r.setCookie, location: cfg.dashboard.path }); return res.end();
      }
      if (u.pathname === "/_x402/logout" && req.method === "POST") { res.writeHead(303, { "set-cookie": sessions.logout(req), location: "/_x402/login" }); return res.end(); }
      if (u.pathname.startsWith(cfg.dashboard.path)) {
        if (!authed(req)) { if (sessions.enabled && !u.pathname.endsWith(".json")) { res.writeHead(303, { location: "/_x402/login" }); return res.end(); }
          return send(401, {}, { error: sessions.enabled ? "login required" : "dashboard token required" }); }
        const s = { ...ledger.summary({ runId: u.searchParams.get("run") ?? undefined }), chain, runId, autoClaims: autoClaims.slice(-20), recovery, pendingExact: pending.list(), refundTimeoutDaa: currentTimeout.toString() };
        return u.pathname.endsWith(".json") ? send(200, {}, s) : send(200, {}, dashboardHtml(s, { refreshSec: Math.min(60, Math.max(0, Number.parseInt(u.searchParams.get("refresh") ?? "0", 10) || 0)) }));
      }
      if (u.pathname === "/_x402/claim" && req.method === "POST") {
        if (!authed(req)) return send(401, {}, { error: sessions.enabled ? "login required" : "token required" });
        return send(200, {}, await claimAll());
      }
      const route = matchRoute(cfg.routes, req.method, u.pathname);
      if (!route) return send(404, {}, { error: "no route configured" });
      if (route.free) { const p = await proxy(req, u.pathname + u.search, body); return send(p.status, { ...p.headers, "content-type": p.contentType }, p.body); }

      let upstreamStatus, upHeaders = {};
      await rotateIfNeeded();
      const paidExact = route.scheme !== "batch-settlement" && !!req.headers["payment-signature"];
      let handlerTxid = null;
      const paidRequest = {
        routeAccess: "public", method: req.method,
        admissionKey: createHash("sha256").update(`ip:${clientIp(req)}`).digest("hex"), url: u.href,
        headers: req.headers, body: body || null,
        resource: { url: u.href, description: route.description ?? route.match, mimeType: "application/json" },
        paymentAmount: route.priceSompi, paymentScheme: route.scheme,
      };
      // P0-2 verify-first (exact): the origin is called only AFTER the node verified the payment (signature, live
      // UTXO inputs, payTo/amount, request-bound authorization) and BEFORE settlement. If the origin fails we
      // throw out of verification, nothing is claimed or broadcast, and the payer gets 503 + retry-same-payment.
      // Order: verify -> fetch origin -> settle (broadcast + confirmations) -> handler returns the fetched result.
      const ctx = { txid: null, originFailed: null, consumed: false, limited: false };
      const onVerified = async (v) => {
        const txid = String(v.transactionId).toLowerCase(); ctx.txid = txid;
        // R3-M3: remember payment-identifier -> txid, so a retry whose node re-verification fails can still be matched to its held payment
        const pid = sigPaymentId(req.headers["payment-signature"]); if (pid) payIds.set(pid, txid);
        const attempt = await store.loadExactSettlementAttempt(txid), committed = await store.loadExactPayment(txid);
        // RR-H2 / P1 replay guard keyed on the verified txid (not on header text); only for txids this store does not know.
        if (!attempt && !committed && seenExact?.has(txid)) { ctx.consumed = true; throw new Error("payment already consumed (previous run)"); }
        // R3-M3: verify-first for depth. A NEW payment is only allowed to proceed to broadcast if the node can serve evidence now.
        if (preflight && !attempt && !committed) { try { await preflight(); } catch (e) { ctx.preflightFailed = String(e?.message ?? e); throw new Error(`depth evidence unavailable: ${ctx.preflightFailed}`); } }
        if (!verifyFirst || !IDEMPOTENT.has(req.method) || attempt || committed || resultByTxid.has(txid)) return;
        if (!payerAllowed(v.requestAuthorization?.publicKey ?? v.payerAddress ?? clientIp(req))) { ctx.limited = true; throw new Error("payer rate limit"); }
        ctx.originPending = true; const r = await fetchOrigin(req, u, body); ctx.originPending = false;
        if (!r.ok) { ctx.originFailed = r.error; throw new Error(`origin unavailable: ${r.error}`); }
        resultByTxid.set(txid, r);
      };
      // P0-5: bound free calls below the claim minimum. Upstream vouchers charge exactly the route price per call,
      // so a channel whose total stays under (minNet + claim fee) can never be claimed profitably. Limit how many
      // such "sub-minimum" open channels one client (IP) may hold; a new channel open beyond that is refused.
      let openingBatch = null, openIpk = null, openBefore = null, payAmount = route.priceSompi;
      const batchIpk = ipKey(clientIp(req));
      /** active channels recorded for this client key, and how many are below the claim minimum */
      const ipChannels = async (ipk) => { let all = 0, sub = 0;
        if (!db) return { all, sub };
        for (const r of db.prepare("SELECT k, v FROM kv WHERE ns='batch-open-ip'").all()) { const v = JSON.parse(r.v); if ((v.ipKey ?? ipKey(v.ip)) !== ipk) continue;
          const c = await store.loadChannel(r.k); if (!c || c.status !== "active") continue;
          // channels already inside the claim margin take no more vouchers (their loss, if any, is booked) -> not counted
          if (BigInt(c.channelConfig?.refundTimeoutDaa ?? 2n ** 62n) - lastDaa <= margin) continue;
          all++; if (BigInt(c.chargedCumulativeAmount ?? 0) - BigInt(c.claimedCumulativeAmount ?? 0) < minNet + claimFee) sub++; }
        return { all, sub }; };
      const openPrice = openCharge != null && openCharge > BigInt(route.priceSompi) ? openCharge.toString() : null;
      if (route.scheme === "batch-settlement" && !req.headers["payment-signature"] && openPrice && (await ipChannels(batchIpk)).all === 0) payAmount = openPrice; // challenge to a client with no channel
      if (route.scheme === "batch-settlement" && req.headers["payment-signature"]) {
        // R2-P0-1: "new channel" is decided from SERVER state (channel id unknown to the store), not from whether the
        // client chose to include fundingTransaction. Unparseable / id-less payloads count as new (fail closed).
        let id = null, signed = null; try { const p = JSON.parse(Buffer.from(String(req.headers["payment-signature"]), "base64").toString("utf8"));
          signed = p?.accepted?.amount ?? null;
          id = p?.payload?.channelId ?? p?.payload?.voucher?.channelId ?? p?.payload?.channel?.id ?? null; } catch {}
        id = id ? String(id).toLowerCase() : `unknown:${randomUUID()}`;
        const isNew = !(await store.loadChannel(id));
        if (openPrice) payAmount = isNew ? openPrice : (signed === openPrice ? openPrice : route.priceSompi);
        if (isNew && db && (maxSubMinPerIp != null || openPrice)) {
          const ipk = batchIpk;
          if (maxSubMinPerIp != null) { const sub = (pendingOpens.get(ipk) ?? 0) + (await ipChannels(ipk)).sub;
            if (sub >= maxSubMinPerIp) { ledger.record({ outcome: "rejected", scheme: "batch-settlement", route: route.match, path: u.pathname, amountSompi: "0", error: "sub-minimum channel limit" });
              return send(429, { "retry-after": "3600" }, { error: "batch_channel_limit", detail: `at most ${maxSubMinPerIp} open channel(s) below the claim minimum per client; keep using the existing channel` }); } }
          // reserve the slot BEFORE calling upstream so parallel opens from one client cannot race past the cap;
          // released only after the channel (if any) is recorded below, whatever the response (R3-M1).
          openingBatch = id; openIpk = ipk; pendingOpens.set(ipk, (pendingOpens.get(ipk) ?? 0) + 1);
          openBefore = new Set((await store.listChannels()).map((c) => String(c.channelId ?? c.id).toLowerCase()));
        }
      }
      paidRequest.paymentAmount = payAmount;
      /** R3-M1 (risk): record every channel this open created against the client key from STORE state, even when the
       *  response carried no PAYMENT-RESPONSE (origin hang/failure, expired presentation, thrown handler). */
      const recordOpen = async () => {
        if (!openingBatch) return;
        try { const now = (await store.listChannels()).map((c) => String(c.channelId ?? c.id).toLowerCase());
          const ids = (await store.loadChannel(openingBatch)) ? [openingBatch] : now.filter((x) => !openBefore.has(x));
          for (const cid of ids) db.prepare("INSERT OR REPLACE INTO kv (ns,k,v) VALUES ('batch-open-ip',?,?)").run(cid, JSON.stringify({ ip: clientIp(req), ipKey: openIpk, at: new Date().toISOString() }));
        } finally { const n = (pendingOpens.get(openIpk) ?? 1) - 1; if (n > 0) pendingOpens.set(openIpk, n); else pendingOpens.delete(openIpk); openingBatch = null; }
      };
      const srv = route.scheme === "exact" ? buildExact(onVerified) : server;
      const protectedHandler = async (args) => {
        handlerTxid = args?.payment?.transactionId?.toLowerCase?.() ?? null;
        // Live restart-mid-flow regression hook (TN10 only): die after settle + beginExactHandler, before any response.
        if (process.env.X402_TEST_CRASH_IN_EXACT_HANDLER === "1" && chain === "real" && cfg.network === "kaspa:testnet-10" && handlerTxid) { console.error(`[x402-test] SIGKILL in exact handler txid=${handlerTxid}`); process.kill(process.pid, "SIGKILL"); }
        const t0 = Date.now();
        try {
          const p = (handlerTxid && resultByTxid.get(handlerTxid)) ?? await proxy(req, u.pathname + u.search, body);
          upstreamStatus = p.status; upHeaders = { ...p.headers, "content-type": p.contentType };
          return { status: p.status, body: p.body, chargedAmount: paidRequest.paymentAmount };
        } catch (e) { console.error(`[x402] protected handler (upstream proxy) failed for ${u.pathname} after ${Date.now() - t0}ms: ${e?.stack ?? e}`); throw e; }
      };
      let resp; try { resp = await srv.handlePaidRequest(paidRequest, protectedHandler); } finally { await recordOpen(); }
      const hasPR = (r) => Object.keys(r.headers ?? {}).some((h) => h.toLowerCase() === "payment-response");
      if (paidExact && !hasPR(resp) && ctx.preflightFailed) {
        ledger.record({ outcome: "depth-unavailable", route: route.match, path: u.pathname, amountSompi: "0", txid: ctx.txid, error: ctx.preflightFailed });
        return send(503, { "retry-after": "10" }, { error: "depth_verification_unavailable", detail: "node cannot prove depth right now; payment verified but NOT broadcast - retry the same payment", retryable: true });
      }
      if (paidExact && !hasPR(resp) && (ctx.consumed || ctx.originFailed || ctx.limited || ctx.originPending)) {
        // originPending: the verifier (and our origin fetch inside it) hit upstream's adapter timeout; nothing was settled.
        if (ctx.originPending && !ctx.originFailed) ctx.originFailed = "origin exceeded the verification time budget";
        if (ctx.consumed) { ledger.record({ outcome: "rejected", route: route.match, path: u.pathname, amountSompi: route.priceSompi, txid: ctx.txid, error: "payment already consumed (previous run)" });
          return send(402, {}, { error: "payment already consumed" }); }
        if (ctx.limited) { ledger.record({ outcome: "rate-limited", route: route.match, path: u.pathname, amountSompi: "0", txid: ctx.txid });
          return send(429, { "retry-after": "60" }, { error: "payer_rate_limited", detail: "payment NOT settled", retryable: true }); }
        ledger.record({ outcome: "upstream-unavailable", route: route.match, path: u.pathname, amountSompi: "0", txid: ctx.txid, error: ctx.originFailed });
        return send(503, { "retry-after": "5" }, { error: "upstream_unavailable", detail: "origin did not answer; payment verified but NOT settled - retry the same payment", retryable: true });
      }
      // Upstream's recovery for "settled but handler outcome uncertain": recoverExactHandler(txid, result) then the
      // identical retry. Done automatically for idempotent requests.
      if (exactRecovery && paidExact && isRecoveryRequired(resp)) {
        // after a crash the handler is never re-entered on replay, so fall back to the verified txid (onVerified)
        const vtx = handlerTxid ?? ctx.txid ?? null;
        // Only a handler that STARTED without a recorded result needs recoverExactHandler. A payment that is broadcast
        // but not yet at the required depth (R2-P0-2, exactFinality "confirmed") is settle-replayed until it is.
        const att = vtx ? await store.loadExactSettlementAttempt(vtx) : null;
        const txid = att?.handlerStartedAt && !att?.handlerResult ? vtx : null;
        console.error(`[x402] exact recovery required (status ${resp.status}) txid=${txid ?? ctx.txid ?? "unknown"} path=${u.pathname} body=${String(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body ?? null)).slice(0, 400)}`);
        if (txid && IDEMPOTENT.has(req.method)) {
          const fresh = resultByTxid.get(txid) ?? await fetchOrigin(req, u, body);
          if (fresh.ok) {
            try { await srv.recoverExactHandler(txid, { status: fresh.status, body: fresh.body, chargedAmount: route.priceSompi });
              ledger.record({ outcome: "exact-recovered", route: route.match, path: u.pathname, amountSompi: "0", txid }); }
            catch (e) { console.error(`[x402] recoverExactHandler(${txid}): ${e.message}`); }
            upstreamStatus = fresh.status; upHeaders = { ...fresh.headers, "content-type": fresh.contentType };
            resp = await buildExact(onVerified).handlePaidRequest(paidRequest, async () => { throw new Error("handler must not rerun after recovery"); });
          }
        } else if (!txid) {
          // Settlement outcome uncertain (e.g. broadcast landed, confirmations not yet reached): upstream will not
          // rebroadcast; an identical replay reconciles against the node and, once accepted, runs the handler.
          for (const ms of settleReplayDelaysMs) {
            await new Promise((r) => setTimeout(r, ms));
            resp = await buildExact(onVerified).handlePaidRequest(paidRequest, protectedHandler);
            if (!isRecoveryRequired(resp) && resp.status !== 402) { ledger.record({ outcome: "exact-settle-replayed", route: route.match, path: u.pathname, amountSompi: "0", txid: handlerTxid ?? ctx.txid, afterMs: ms }); break; }
          }
        }
      }
      // R3-M3: a paid exact request that ends without PAYMENT-RESPONSE (recovery-required, OR a 402 because re-verification
      // at depth failed after the broadcast) while this store holds a settlement attempt for its tx = money moved, data not
      // yet delivered. Hold it as pending (durable) and tell the payer to retry the SAME payment; never a 402 that would
      // make a client pay again.
      if (exactRecovery && paidExact && !hasPR(resp) && (resp.status === 402 || isRecoveryRequired(resp))) {
        const ptx = handlerTxid ?? ctx.txid ?? payIds.get(sigPaymentId(req.headers["payment-signature"]));
        const att = ptx ? await store.loadExactSettlementAttempt(ptx).catch(() => null) : null;
        if (att && !(await store.loadExactPayment(ptx).catch(() => null))) {
          const prev = pending.get(ptx); pending.set(ptx, { route: route.match, path: u.pathname, amountSompi: att.amount ?? route.priceSompi, firstAt: prev?.firstAt ?? new Date().toISOString(), lastAt: new Date().toISOString(), tries: (prev?.tries ?? 0) + 1, lastStatus: resp.status, lastError: resp.body?.error ?? null });
          ledger.record({ outcome: "payment-pending", route: route.match, path: u.pathname, amountSompi: "0", txid: ptx, error: resp.body?.error ?? `status ${resp.status}` });
          return send(503, { "retry-after": "10" }, { error: "payment_pending", txid: ptx, retryable: true,
            detail: "payment broadcast; held as pending until the node proves the required depth. Retry the SAME payment to receive the data - you will not be charged again" });
        }
      }
      const headerName = Object.keys(resp.headers ?? {}).find((h) => h.toLowerCase() === "payment-response");
      if (resp.status === 402) ledger.record({ outcome: req.headers["payment-signature"] ? "rejected" : "challenge", route: route.match, path: u.pathname, amountSompi: route.priceSompi, error: resp.body?.error, ...(process.env.X402_DEBUG ? { detail: String(JSON.stringify(resp.body ?? null)).slice(0, 1500), headers: Object.keys(resp.headers ?? {}) } : {}) });
      else if (headerName) {
        let txid; try { txid = decodePaymentResponseHeader(resp.headers[headerName]).transaction; } catch {}
        let decoded = {}; try { decoded = decodePaymentResponseHeader(resp.headers[headerName]) ?? {}; } catch {}
        if (route.scheme === "batch-settlement") {
          ledger.record({ outcome: "paid", scheme: "batch-settlement", route: route.match, path: u.pathname, amountSompi: paidRequest.paymentAmount, upstreamStatus,
            channelId: decoded.extensions?.kaspa?.channelId ?? decoded.channelId ?? null, settled: false });
          if (st.claimEveryCalls && ++sinceClaim >= Number(st.claimEveryCalls)) autoClaim(`every ${st.claimEveryCalls} calls`);
        } else if (txid && ledger.entries.some((e) => e.outcome === "paid" && e.txid === txid))
          ledger.record({ outcome: "replay-cached", route: route.match, path: u.pathname, amountSompi: "0", txid });
        else ledger.record({ outcome: "paid", route: route.match, path: u.pathname, amountSompi: route.priceSompi, upstreamStatus, txid });
        if (paidExact && (handlerTxid ?? ctx.txid)) { const t = handlerTxid ?? ctx.txid; seenExact?.add(t);
          if (pending.get(t)) { pending.delete(t); ledger.record({ outcome: "pending-delivered", route: route.match, path: u.pathname, amountSompi: "0", txid: t }); } }
      } else if (req.headers["payment-signature"]) {
        // Paid retry answered without PAYMENT-RESPONSE (e.g. settlement not confirmed in time): record it, never silently.
        ledger.record({ outcome: "unsettled", route: route.match, path: u.pathname, amountSompi: "0", upstreamStatus, error: `status ${resp.status}`,
          detail: String(JSON.stringify(resp.body ?? null)).slice(0, 600) });
      }
      return send(resp.status, resp.status === 402 ? resp.headers : { ...upHeaders, ...resp.headers }, resp.body);
    } catch (err) { const id = randomUUID().slice(0, 8); console.error(`[x402-error ${id}] ${err?.stack ?? err}`); return send(502, {}, { error: "gateway error", id }); } // L6
  };
  return { handler, ledger, confirmations, pendingExact: () => pending.list(), get server() { return server; }, store, chain, world, claimAll, claimNearTimeout, autoClaims, recovery, recovered, runId,
    refundTimeout: () => currentTimeout, rotate: rotateIfNeeded, settle: () => claiming, close: () => { if (timer) clearInterval(timer); if (nearTimer) clearInterval(nearTimer); if (recoveryTimer) clearInterval(recoveryTimer); }, listen: (port = cfg.listen.port, host = cfg.listen.host) =>
    new Promise((ok) => { const s = http.createServer(handler).listen(port, host, () => ok(s)); }) };
}

function loginHtml() {
  return `<!doctype html><title>x402 dashboard login</title><style>body{font:14px system-ui;margin:4em}</style><h1>Seller dashboard</h1>
<form method="post" action="/_x402/login"><input type="password" name="password" autocomplete="current-password" autofocus required> <button>Log in</button></form>`;
}
function dashboardHtml(s, { refreshSec = 0 } = {}) {
  const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const routes = Object.entries(s.byRoute).map(([r, v]) => `<tr><td>${esc(r)}</td><td>${v.count}</td><td>${v.revenueKas}</td></tr>`).join("");
  const recent = s.recent.map((e) => `<tr><td>${esc(e.at)}</td><td>${esc(e.outcome)}</td><td>${esc(e.path)}</td><td>${sompiToKas(e.amountSompi)}</td><td><code>${esc(e.txid ?? "")}</code></td></tr>`).join("");
  return `<!doctype html>${refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : ""}<title>x402 seller dashboard</title><style>body{font:14px system-ui;margin:2em}td,th{padding:4px 10px;border-bottom:1px solid #ddd}.mock{background:#fee;padding:6px}</style>
<form method="post" action="/_x402/logout" style="float:right"><button>Log out</button></form><h1>Kaspa x402 seller dashboard</h1><p class="mock">TESTNET-10 · ${s.chain === "real" ? "REAL TN10 chain (test funds only)" : "MOCK CHAIN LAYER — no real payments"}</p>
${refreshSec ? `<p style="color:#666">Auto-refreshing every ${refreshSec}s · ${esc(new Date().toISOString())}</p>` : `<p><a href="?refresh=2">Auto-refresh every 2s</a></p>`}<p><b>Revenue:</b> ${s.revenueKas} KAS · <b>Paid requests:</b> ${s.paidRequests} · <b>402 challenges:</b> ${s.challenges} · <b>Rejected:</b> ${s.rejected}</p>
<h2>By route</h2><table><tr><th>Route</th><th>Paid</th><th>KAS</th></tr>${routes}</table>
<h2>Recent</h2><table><tr><th>Time (UTC)</th><th>Outcome</th><th>Path</th><th>KAS</th><th>Tx</th></tr>${recent}</table>`;
}

// RR-M5: no direct entry. `node src/gateway.mjs` used to start without a DB, password login or real-chain gates and
// printed a ?token= hint. The only supported entry is bin/x402-gateway.mjs serve (which enforces those gates).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.error("src/gateway.mjs is a library. Start the gateway with: node bin/x402-gateway.mjs serve --config <file> [--chain mock|real]");
  process.exit(2);
}
