// Agent client wallet with spending limits, auto-paying 402s via @kaspa-x402/client.
// Limits are enforced twice: upstream fundingPolicy (origin allowlist, per-request max,
// optional payTo allowlist) AND our authorizeExactPayment callback (per-day cap, host
// allowlist, network pin, spend log). Payment construction is the upstream DirectModeClient.
import { createPersistentClientStore } from "./store.mjs";
import { retryReads } from "./retry.mjs";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { DirectModeClient, MemoryChannelStore } from "@kaspa-x402/client";
import { TESTNET_10_CONFIRMATION_THRESHOLD } from "@kaspa-x402/core";
import { MockAddressCodec, MockFundingProvider } from "./mock-chain.mjs";

// H4: per-call state (current spends, denial) lives in an AsyncLocalStorage context, not on the instance.
const callCtx = new AsyncLocalStorage();
const BOUND = Symbol.for("kaspa-x402:bound-paid-fetch:v1");

export class SpendLimitError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

/**
 * DEV ONLY transport: maps approved public HTTPS origins to local http targets so the
 * upstream client's HTTPS/public-DNS rules can be exercised on one box. Production
 * must use createNodeBoundedFetch from "@kaspa-x402/client/node".
 */
export function createDevLoopbackFetch(map) {
  const f = async (input, init = {}) => {
    const u = new URL(input); const target = map[u.origin];
    if (!target) throw new Error(`dev loopback: origin ${u.origin} not mapped`);
    const t = new URL(target); if (!["127.0.0.1", "localhost"].includes(t.hostname)) throw new Error("dev loopback targets must be loopback");
    const { redirect, cache, ...rest } = init;
    const r = await fetch(new URL(u.pathname + u.search, target), { ...rest, redirect: "error" });
    // Present the response as coming from the public origin the client authorized.
    return { status: r.status, headers: r.headers, url: u.href, redirected: false,
      json: () => r.json(), text: () => r.text() };
  };
  Object.defineProperty(f, BOUND, { value: true });
  return f;
}

export class AgentWallet {
  /**
   * @param {object} o
   * @param {string[]} o.allowedOrigins  e.g. ["https://api.demo.test"]
   * @param {string}   o.perRequestMaxSompi
   * @param {string}   o.dailyCapSompi
   * @param {string[]} [o.allowedPayTo]
   * @param {Function} o.fetch           bound transport (dev loopback or createNodeBoundedFetch)
   * @param {() => Date} [o.now]
   */
  constructor(o) {
    this.o = o; this.now = o.now ?? (() => new Date()); this.spends = []; this.events = [];
    // Durable spend history + reservations (status "authorized" = reserved; still counts toward the daily cap after a restart).
    this.walletId = o.walletId ?? "default"; this.db = o.db ?? null;
    if (this.db) { this.spends = this.db.prepare("SELECT entry FROM spends WHERE wallet = ? ORDER BY rowid").all(this.walletId).map((r) => JSON.parse(r.entry));
      this.upsert = this.db.prepare("INSERT INTO spends (id, wallet, day, status, amount_sompi, entry) VALUES (@id, @wallet, @day, @status, @amountSompi, @entry) ON CONFLICT(id) DO UPDATE SET status = excluded.status, entry = excluded.entry"); }
    this.allowedHosts = new Set(o.allowedOrigins.map((x) => new URL(x).origin));
    const world = o.mockWorld ?? o.liveKit; // same shape: fundingProvider, addressCodec, clientBatch()
    const rawFunding = o.fundingProvider ?? world?.fundingProvider ?? new MockFundingProvider();
    // Read-only retry for escrow/lineage checks (discover*/get*/list*...). Signing, authorization,
    // and sendTransaction are NOT retried; corrective 402s still need explicit authorization.
    const baseFunding = (o.liveKit || o.retryReads) ? retryReads(rawFunding, { ...(o.retry ?? {}),
      onRetry: (m, e, n, ms) => { this.events.push({ kind: "retry", method: m, attempt: n }); console.error(`[wallet-retry] ${m} attempt ${n} in ${ms}ms: ${e?.message}`); } }) : rawFunding;
    // Batch spend limits: wrap the provider's explicit authorization boundary (called by the
    // upstream client before any deposit/top-up/voucher work) with our daily cap + logging.
    const props = {
      // H3: bind the signed txid to this call's reservation, and only release on upstream's trusted "absent" evidence.
      payExactTransaction: { value: async (req) => {
        const ctx = callCtx.getStore(); const sp = ctx?.spends.at(-1); if (sp) { sp.phase = "signing"; this.#save(sp); }
        let r; try { r = await baseFunding.payExactTransaction(req); }
        catch (e) { if (sp) { sp.phase = "authorized"; sp.error = String(e?.message ?? e).slice(0, 300); this.#save(sp); } throw e; } // nothing was signed
        if (sp) { sp.txid = r?.transactionId ?? r?.txid ?? sp.txid; sp.inputs = (r?.inputOutpoints ?? []).map((o) => `${o.txid ?? o.transactionId}:${o.index}`); if (r?.massGrams) { sp.massGrams = r.massGrams; sp.feeSompi = r.feeSompi; sp.feerate = r.feerate; } sp.phase = "signed"; this.#save(sp); }
        return r;
      } },
      finalizeExactPaymentAttempt: { value: async (req) => {
        const sp = this.spends.find((x) => x.txid && x.txid === req.transactionId);
        // P1 late-broadcast: "absent" now does NOT release. The signed artifact still exists (the seller holds it) and
        // could land later, so the spend stays counted ("absent-unspent") until its input is proven spent elsewhere
        // (or invalidated by the payer: RealTn10FundingProvider.invalidateAbsentAttempts()).
        if (sp && sp.status !== "settled") { sp.status = req.outcome === "absent" ? "absent-unspent" : "settled"; sp.evidence = req.outcome; this.#save(sp); }
        return baseFunding.finalizeExactPaymentAttempt?.(req);
      } },
    };
    if (o.batch) props.authorizeBatchPayment = { value: async (req) => {
      if (!this.#authorizeBatch(req.intent)) throw callCtx.getStore()?.denial ?? this.lastDenial;
      return baseFunding.authorizeBatchPayment ? baseFunding.authorizeBatchPayment(req) : { intentDigest: req.intentDigest };
    } };
    const funding = Object.create(baseFunding, typeof baseFunding.payExactTransaction === "function" ? props : (delete props.payExactTransaction, props));
    this.fundingForTest = funding;
    this.client = new DirectModeClient({
      // must equal the seller's threshold: lineage evidence carries the depth it was proven at (TN10 regression: 30 vs 100 blocked claims)
      confirmationThreshold: Number(o.confirmations ?? o.liveKit?.confirmations ?? TESTNET_10_CONFIRMATION_THRESHOLD),
      addressCodec: o.addressCodec ?? world?.addressCodec ?? new MockAddressCodec(), fundingProvider: funding,
      store: (() => { const st = this.db ? createPersistentClientStore(this.db, `client-channels:${this.walletId}`) : new MemoryChannelStore(); if (o.liveKit?.batchRecovery) o.liveKit.batchRecovery.clientStore = st; return st; })(), fetch: o.fetch, ...(o.liveKit ? { supportedNetworks: ["kaspa:testnet-10"] } : {}), supportedSchemes: o.batch ? ["exact", "batch-settlement"] : ["exact"],
      ...(o.batch ? { batch: world.clientBatch() } : {}),
      fundingPolicy: { requiredSource: "hot-wallet", allowedOrigins: o.allowedOrigins,
        allowedExactProfiles: ["standard-native"], maximumExactAmountSompi: o.perRequestMaxSompi,
        ...(o.allowedPayTo ? { allowedPayTo: o.allowedPayTo } : {}),
        ...(o.batch ? { batchPayment: {
          maximumBatchChargeSompi: o.perRequestMaxSompi,              // per-call cap applies to vouchers too
          maximumInitialDepositSompi: o.batch.maxDepositSompi,
          maximumTopUpSompi: o.batch.maxTopUpSompi ?? o.batch.maxDepositSompi,
          maximumCumulativeAuthorizationSompi: o.batch.maxCumulativeSompi ?? o.batch.maxDepositSompi, // per-channel lifetime; per-day cap is ours
          maximumTotalExposureSompi: o.batch.maxExposureSompi ?? o.batch.maxDepositSompi,
          minimumRefundLeadDaa: o.batch.minRefundLeadDaa ?? "600", maximumRefundHorizonDaa: o.batch.maxRefundHorizonDaa ?? "100000",
          allowedOrigins: o.allowedOrigins, allowedResources: o.batch.allowedResources,
          ...(o.allowedPayTo ? { allowedPayTo: o.allowedPayTo } : { allowedPayTo: o.batch.allowedPayTo }),
          allowedServerPublicKeys: o.batch.allowedServerPublicKeys, allowedFundingSources: ["hot-wallet"],
        } } : {}) },
      authorizeExactPayment: ({ intent, intentDigest }) => this.#authorize(intent) ? { intentDigest } : null,
    });
  }
  #push(spend) { spend.id ??= randomUUID(); this.spends.push(spend); callCtx.getStore()?.spends.push(spend); this.#save(spend); }
  #save(spend) { if (!spend || !this.upsert) return;
    this.upsert.run({ id: spend.id, wallet: this.walletId, day: spend.day, status: spend.status, amountSompi: String(spend.amountSompi), entry: JSON.stringify(spend) }); }
  /** Reservations = authorized/unknown: not proven settled or absent. They keep counting toward the caps. */
  reservations() { this.#reload(); return this.spends.filter((s) => s.status === "authorized" || s.status === "unknown" || s.status === "absent-unspent"); }
  /** RR-M1: spends are re-read from SQLite (shared by every process using this walletId) before each cap decision. */
  #reload() { if (!this.db) return; const live = new Map(this.spends.map((x) => [x.id, x]));
    this.spends = this.db.prepare("SELECT entry FROM spends WHERE wallet = ? ORDER BY rowid").all(this.walletId).map((r) => { const e = JSON.parse(r.entry); const m = live.get(e.id); return m && m.status === e.status ? m : e; }); }
  /**
   * H3: release a reservation only with on-chain proof it did not land.
   * @param lookupTx async (txid) => "accepted" | "absent" | "unknown"   e.g. GET api-tn10 /transactions/{txid}
   * Exact spends that never reached signing (phase "authorized") hold no signed tx and are released directly.
   * Batch vouchers are signed claims and are never released here.
   */
  async releaseReservation(id, { lookupTx, inputSpentElsewhere } = {}) {
    this.#reload();
    const s = this.spends.find((x) => x.id === id && (x.status === "authorized" || x.status === "unknown" || x.status === "absent-unspent")); if (!s) return { released: false, reason: "not a reservation" };
    if (s.scheme === "batch-settlement") return { released: false, reason: "batch vouchers/deposits are signed; settle via refund" };
    if (s.phase === "authorized") { s.status = "released"; s.evidence = "never-signed"; this.#save(s); return { released: true }; }
    if (!s.txid || !lookupTx) return { released: false, reason: "needs txid + on-chain lookup" };
    const v = await lookupTx(s.txid);
    if (v === "absent") {
      // P1: absent now is not enough - a late broadcast of the same signed tx could still land. Release only when a
      // signed input is proven spent by a DIFFERENT transaction (then this artifact can never be accepted).
      if (inputSpentElsewhere && s.inputs?.length && await inputSpentElsewhere(s.inputs, s.txid)) { s.status = "released"; s.evidence = "input-spent-elsewhere"; this.#save(s); return { released: true }; }
      s.status = "absent-unspent"; s.evidence = "absent-on-chain"; this.#save(s);
      return { released: false, reason: "absent but its input is unspent: the signed tx could still be broadcast; invalidate the input first" };
    }
    if (v === "accepted") { s.status = "settled"; s.evidence = "on-chain"; this.#save(s); return { released: false, settled: true }; }
    return { released: false, reason: "on-chain state unknown" };
  }
  /** Reconcile all reservations with a lookup function (see releaseReservation). */
  async reconcileReservations({ lookupTx, inputSpentElsewhere }) { const out = []; for (const s of this.reservations()) out.push({ id: s.id, ...(await this.releaseReservation(s.id, { lookupTx, inputSpentElsewhere })) }); return out; }
  dayKey(d = this.now()) { return d.toISOString().slice(0, 10); } // UTC day (rolls over 10:00 AEST)
  #today() { this.#reload(); const k = this.dayKey(); return this.spends.filter((s) => s.day === k && s.status !== "released"); }
  /** M1: daily cap = exact payments + batch deposits/top-ups locked today (money leaving the wallet). */
  spentToday() { return this.#today().reduce((a, s) => a + (s.scheme === "batch-settlement" ? BigInt(s.lockedSompi ?? 0) : BigInt(s.amountSompi)), 0n); }
  /** Voucher charges today (drawn from deposits); capped by dailyVoucherCapSompi (default: dailyCapSompi). */
  vouchersToday() { return this.#today().filter((s) => s.scheme === "batch-settlement").reduce((a, s) => a + BigInt(s.amountSompi), 0n); }
  /** RR-M1 / P1 non-atomic daily cap: check + reserve run inside one SQLite BEGIN IMMEDIATE transaction (cross-process). */
  #atomic(fn) { return this.db ? this.db.transaction(fn).immediate() : fn(); }
  #authorize(intent) { return this.#atomic(() => this.#authorizeNow(intent)); }
  #authorizeNow(intent) {
    const amt = BigInt(intent.amount); const origin = new URL(intent.resourceUrl).origin;
    const deny = (code, msg) => { const e = new SpendLimitError(code, msg); const c = callCtx.getStore(); if (c) c.denial = e; this.lastDenial = e; this.events.push({ at: this.now().toISOString(), denied: code, url: intent.resourceUrl, amountSompi: intent.amount }); return false; };
    if (intent.network !== "kaspa:testnet-10") return deny("network", `refusing network ${intent.network}`);
    if (!this.allowedHosts.has(origin)) return deny("host", `host ${origin} not allowlisted`);
    if (amt > BigInt(this.o.perRequestMaxSompi)) return deny("per_request", `price ${intent.amount} > per-request max ${this.o.perRequestMaxSompi}`);
    if (this.spentToday() + amt > BigInt(this.o.dailyCapSompi)) return deny("daily_cap", `daily cap ${this.o.dailyCapSompi} would be exceeded (spent ${this.spentToday()})`);
    this.#push({ day: this.dayKey(), amountSompi: intent.amount, url: intent.resourceUrl, payTo: intent.payTo, status: "authorized", phase: "authorized", at: this.now().toISOString() }); return true;
  }
  #authorizeBatch(intent) { return this.#atomic(() => this.#authorizeBatchNow(intent)); }
  #authorizeBatchNow(intent) {
    const deny = (code, msg) => { const e = new SpendLimitError(code, msg); const c = callCtx.getStore(); if (c) c.denial = e; this.lastDenial = e; this.events.push({ at: this.now().toISOString(), denied: code, url: intent.resource, op: intent.operation }); return false; };
    if (intent.network !== "kaspa:testnet-10") return deny("network", `refusing network ${intent.network}`);
    if (!this.allowedHosts.has(new URL(intent.resource).origin)) return deny("host", "host not allowlisted");
    const charge = BigInt(intent.fixedChargeSompi);
    if (charge > BigInt(this.o.perRequestMaxSompi)) return deny("per_request", `per-call charge ${charge} > per-request max`);
    if (BigInt(intent.initialDepositSompi) > BigInt(this.o.batch.maxDepositSompi) || BigInt(intent.topUpSompi) > BigInt(this.o.batch.maxTopUpSompi ?? this.o.batch.maxDepositSompi))
      return deny("deposit", `deposit/top-up exceeds max ${this.o.batch.maxDepositSompi}`);
    const locked = BigInt(intent.initialDepositSompi ?? 0) + BigInt(intent.topUpSompi ?? 0);
    const vCap = BigInt(this.o.dailyVoucherCapSompi ?? this.o.dailyCapSompi);
    if (this.vouchersToday() + charge > vCap) return deny("daily_cap", `daily voucher cap ${vCap} would be exceeded (spent ${this.vouchersToday()})`);
    if (locked > 0n && this.spentToday() + locked > BigInt(this.o.dailyCapSompi)) return deny("daily_cap", `daily cap ${this.o.dailyCapSompi} would be exceeded by deposit/top-up ${locked} (spent ${this.spentToday()})`);
    this.#push({ day: this.dayKey(), scheme: "batch-settlement", op: intent.operation, amountSompi: intent.fixedChargeSompi, lockedSompi: locked.toString(),
      url: intent.resource, payTo: intent.payTo, channelId: intent.channelId, status: "authorized", at: this.now().toISOString() });
    return true;
  }
  /** Open channels (escrow deposits) this wallet holds. */
  async channels() { return this.client.listChannels ? this.client.listChannels() : []; }
  /** Close: refund remaining escrow after its refund timeout (upstream refundChannel). */
  async refundAll(nowDaa, { timeoutMs = this.o.refundTimeoutMs ?? 180_000 } = {}) {
    const out = [];
    // Bounded: lineage discovery / refund broadcast must not hang silently (it once waited ~4 min on a node RPC).
    const bounded = (p, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => {
      const e = new Error(`refund ${what} timed out after ${timeoutMs / 1000}s (escrow lineage/chain RPC did not answer; funds stay in escrow and the refund can be retried)`);
      e.code = "REFUND_TIMEOUT"; rej(e); }, timeoutMs); t.unref?.(); })]).finally(() => clearTimeout(t)); };
    for (const ch of await bounded(this.client.listRefundableChannels(nowDaa), "listRefundableChannels")) { const r = await bounded(this.client.refundChannel(ch.id), `refundChannel(${ch.id})`);
      out.push({ channelId: ch.id, refundAmount: r.refundAmount ?? r.amount, txid: r.transactionId }); this.events.push({ at: this.now().toISOString(), refund: ch.id, amountSompi: r.refundAmount }); }
    return out;
  }
  /** fetch() that auto-pays a 402 within limits. Throws SpendLimitError when a limit blocks payment. */
  async fetch(url, init = {}) {
    const origin = new URL(url).origin;
    if (!this.allowedHosts.has(origin)) throw new SpendLimitError("host", `host ${origin} not allowlisted`);
    const ctx = { spends: [], denial: null };
    return callCtx.run(ctx, () => this.#fetch(url, init, ctx));
  }
  async #fetch(url, init, ctx) {
    try {
      // Upstream's intended exact recovery is the payer's *identical* retry: the same paymentIdentifier makes the
      // client re-present the same signed artifact (never a second payment), and the seller answers from the
      // committed/recovered result. Retry a PendingExactPaymentError a few times with backoff before giving up.
      const paymentIdentifier = init.paymentIdentifier ?? `pay_${randomUUID().replace(/-/g, "")}`;
      const delays = this.o.pendingRetryDelaysMs ?? [1500, 4000, 10000];
      let r;
      for (let attempt = 0; ; attempt++) {
        try { r = await this.client.paidFetch(url, { ...init, paymentIdentifier }); break; }
        catch (e) {
          if (e?.name !== "PendingExactPaymentError" || attempt >= delays.length) throw e;
          this.events.push({ at: this.now().toISOString(), kind: "pending-exact-retry", url, attempt: attempt + 1, reason: String(e.message).slice(0, 200) });
          await new Promise((res) => setTimeout(res, delays[attempt]));
        }
      }
      const settledTx = r.settlement?.response?.transaction;
      for (const sp of ctx.spends) {
        // H3: success => settled. >=400 => the payment may still have landed (exact) or the voucher is signed (batch):
        // keep it reserved as "unknown" until proven absent on-chain.
        if (r.response.status < 400 || sp.scheme === "batch-settlement") sp.status = "settled";
        else if (sp.status === "authorized") sp.status = sp.phase === "authorized" ? "released" : "unknown";
        if (r.response.status < 400 && settledTx && !sp.scheme) sp.txid = settledTx;
        this.#save(sp);
      }
      return r;
    } catch (e) {
      for (const sp of ctx.spends) if (sp.status === "authorized") {
        // Never-signed exact spends (denied/aborted before payExactTransaction) are released; anything signed stays reserved.
        sp.status = (!sp.scheme && sp.phase === "authorized") ? "released" : "unknown"; sp.error = String(e?.message ?? e).slice(0, 300); this.#save(sp);
      }
      if (ctx.denial) throw ctx.denial;
      if (/amount exceeds funding policy/.test(String(e?.message))) throw new SpendLimitError("per_request", `price exceeds per-request max ${this.o.perRequestMaxSompi} (enforced by upstream fundingPolicy)`);
      if (/maximum|exceeds|policy|not approved|allowed/i.test(String(e?.message))) throw new SpendLimitError("policy", e.message);
      throw e;
    }
  }
  report() { return { day: this.dayKey(), spentTodaySompi: this.spentToday().toString(), vouchersTodaySompi: this.vouchersToday().toString(), reservations: this.reservations().length, dailyCapSompi: this.o.dailyCapSompi, perRequestMaxSompi: this.o.perRequestMaxSompi, spends: this.spends, denials: this.events }; }
}
