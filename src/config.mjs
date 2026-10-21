import { readFileSync } from "node:fs";
import YAML from "yaml";

export const EXACT_MIN_SOMPI = 10_000_000n;
/** Incentive audit: on a real chain an exact call should be >= 1 KAS (one on-chain tx + fee per call); cheaper
 *  calls belong on batch-settlement. A route may opt out with allowSmallExact: true (documented testnet use). */
export const EXACT_MIN_REAL_SOMPI = 100_000_000n;
export const DEFAULT_SCHEME = "batch-settlement";

/** Real-chain policy (H2): refund delta must leave time to claim; >= 36,000 DAA (~1 h at 10 DAA/s) unless explicitly overridden. */
export const MIN_REAL_REFUND_DELTA_DAA = 36_000n;
/** RR-H3 claim/refund race: the seller must claim at least ~1 h (36,000 DAA) before a channel's refund timeout. */
export const MIN_REAL_CLAIM_MARGIN_DAA = 36_000n;
export function assertRealChainPolicy(cfg) {
  for (const r of cfg.routes ?? []) if (!r.free && r.scheme === "exact" && BigInt(r.priceSompi) < EXACT_MIN_REAL_SOMPI && !r.allowSmallExact)
    throw new Error(`route ${r.match}: real-chain exact price must be >= ${EXACT_MIN_REAL_SOMPI} sompi (1 KAS) or set allowSmallExact: true; use batch-settlement for cheaper calls`);
  if (cfg.batch && !cfg.batch.allowShortRefundTimeout && BigInt(cfg.batch.claimMarginDaa ?? 0) < MIN_REAL_CLAIM_MARGIN_DAA && cfg.batch.claimMarginDaa != null)
    throw new Error(`batch.claimMarginDaa must be >= ${MIN_REAL_CLAIM_MARGIN_DAA} (~1 h) on a real chain`);
  if (cfg.batch && !cfg.batch.allowShortRefundTimeout && BigInt(cfg.batch.refundTimeoutDeltaDaa) < MIN_REAL_REFUND_DELTA_DAA)
    throw new Error(`batch.refundTimeoutDeltaDaa must be >= ${MIN_REAL_REFUND_DELTA_DAA} on a real chain (set batch.allowShortRefundTimeout for short test runs)`);
}
export function loadConfig(path) { return validateConfig(YAML.parse(readFileSync(path, "utf8"))); }

export function validateConfig(cfg) {
  cfg.dashboard = { path: "/_x402/dashboard", ...(cfg.dashboard ?? {}) };
  if (!cfg.dashboard.token && process.env.X402_DASHBOARD_TOKEN) cfg.dashboard.token = process.env.X402_DASHBOARD_TOKEN;
  if (cfg.dashboard.token != null && String(cfg.dashboard.token).length < 1) throw new Error("dashboard.token must be non-empty");
  if (cfg.network !== "kaspa:testnet-10") throw new Error("prototype is Testnet-10 only; network must be kaspa:testnet-10");
  const o = new URL(cfg.publicOrigin);
  if (o.protocol !== "https:" || o.pathname !== "/") throw new Error("publicOrigin must be a bare https origin");
  if (!cfg.payTo?.startsWith("kaspatest:")) throw new Error("payTo must be a kaspatest: address");
  cfg.routes = (cfg.routes ?? []).map((r) => {
    const [method, pattern] = String(r.match).trim().split(/\s+/);
    if (!method || !pattern) throw new Error(`bad route match: ${r.match}`);
    if (!r.free && !/^[1-9]\d*$/.test(String(r.priceSompi ?? ""))) throw new Error(`route ${r.match} needs priceSompi (decimal sompi string) or free: true`);
    const scheme = r.free ? "free" : (r.scheme ?? cfg.defaultScheme ?? DEFAULT_SCHEME); // incentive audit: batch is the default
    if (!["exact", "batch-settlement", "free"].includes(scheme)) throw new Error(`route ${r.match}: unknown scheme ${scheme}`);
    // Exact = one on-chain output per call; keep >= 0.1 KAS (upstream reference output policy, KIP-9 storage mass).
    if (!r.free && scheme === "exact" && BigInt(r.priceSompi) < EXACT_MIN_SOMPI)
      throw new Error(`route ${r.match}: exact price must be >= ${EXACT_MIN_SOMPI} sompi; use scheme: batch-settlement for cheaper calls`);
    return { ...r, scheme, method: method.toUpperCase(), pattern, priceSompi: r.free ? undefined : String(r.priceSompi) };
  });
  if (cfg.routes.some((r) => r.scheme === "batch-settlement")) {
    // kaspa-x402 runs batch (KIP-17/KIP-20 covenants, active since Toccata) on Testnet-10; no other network is allowed.
    const b = cfg.batch ?? {};
    for (const k of ["minDepositSompi", "claimReserveSompi"]) if (!/^[1-9]\d*$/.test(String(b[k] ?? ""))) throw new Error(`batch.${k} required (sompi string)`);
    if (!/^[1-9]\d*$/.test(String(b.refundTimeoutDeltaDaa ?? ""))) throw new Error("batch.refundTimeoutDeltaDaa required");
    if (b.network && b.network !== "kaspa:testnet-10") throw new Error("batch-settlement network must be kaspa:testnet-10 (kaspa-x402 docs); TN12/mainnet refused");
    for (const k of ["claimMarginDaa", "rotateEveryDaa"]) if (b[k] != null && !/^[1-9]\d*$/.test(String(b[k]))) throw new Error(`batch.${k} must be a positive integer`);
    if (b.claimMarginDaa != null && BigInt(b.claimMarginDaa) >= BigInt(b.refundTimeoutDeltaDaa)) throw new Error("batch.claimMarginDaa must be < refundTimeoutDeltaDaa");
    if (b.acceptedFinality != null && !["accepted", "confirmed"].includes(b.acceptedFinality)) throw new Error("batch.acceptedFinality must be accepted|confirmed");
    cfg.batch = { minDepositSompi: String(b.minDepositSompi), claimReserveSompi: String(b.claimReserveSompi), refundTimeoutDeltaDaa: String(b.refundTimeoutDeltaDaa),
      ...(b.claimMarginDaa != null ? { claimMarginDaa: String(b.claimMarginDaa) } : {}), ...(b.rotateEveryDaa != null ? { rotateEveryDaa: String(b.rotateEveryDaa) } : {}),
      ...(b.acceptedFinality ? { acceptedFinality: b.acceptedFinality } : {}), ...(b.allowShortRefundTimeout ? { allowShortRefundTimeout: true } : {}),
      ...(b.maxSubMinimumChannelsPerClient != null ? { maxSubMinimumChannelsPerClient: Number(b.maxSubMinimumChannelsPerClient) } : {}),
      ...(b.timeoutCheckMs != null ? { timeoutCheckMs: Number(b.timeoutCheckMs) } : {}),
      ...(b.openChargeSompi != null ? { openChargeSompi: String(b.openChargeSompi) } : {}) };
    if (b.openChargeSompi != null && !/^[1-9]\d*$/.test(String(b.openChargeSompi))) throw new Error("batch.openChargeSompi must be a positive sompi string");
  }
  if (cfg.settlement) { const st = cfg.settlement;
    for (const k of ["claimEveryCalls", "claimEveryMinutes"]) if (st[k] != null && !(Number(st[k]) > 0)) throw new Error(`settlement.${k} must be > 0`);
    for (const k of ["minClaimSompi", "minClaimNetSompi"]) if (st[k] != null && !/^\d+$/.test(String(st[k]))) throw new Error(`settlement.${k} must be a sompi string`);
    cfg.settlement = { ...st, ...(st.minClaimSompi != null ? { minClaimSompi: String(st.minClaimSompi) } : {}) }; }
  if (cfg.confirmations != null && !(Number.isSafeInteger(Number(cfg.confirmations)) && Number(cfg.confirmations) >= 1)) throw new Error("confirmations must be a positive integer");
  if (cfg.confirmations != null) cfg.confirmations = Number(cfg.confirmations);
  if (cfg.exactFinality != null && !["confirmed", "accepted"].includes(cfg.exactFinality)) throw new Error("exactFinality must be confirmed|accepted");
  if (cfg.pnnTrust != null && !["quorum", "single"].includes(cfg.pnnTrust.mode)) throw new Error("pnnTrust.mode must be quorum|single");
  if (cfg.pnnEndpoints != null && (!Array.isArray(cfg.pnnEndpoints) || cfg.pnnEndpoints.some((e) => !/^wss:\/\/.+testnet-10/.test(String(e))))) throw new Error("pnnEndpoints must be a list of wss:// testnet-10 node URLs");
  if (cfg.trustedProxies != null && !Array.isArray(cfg.trustedProxies)) throw new Error("trustedProxies must be a list of proxy IPs");
  if (cfg.passRequestHeaders != null && !Array.isArray(cfg.passRequestHeaders)) throw new Error("passRequestHeaders must be a list");
  if (cfg.maxBodyBytes != null && !(Number(cfg.maxBodyBytes) > 0)) throw new Error("maxBodyBytes must be > 0");
  if (cfg.passHeaders != null && !Array.isArray(cfg.passHeaders)) throw new Error("passHeaders must be a list of header names");
  return cfg;
}

/** First match wins. Pattern supports trailing "*" wildcard. Unmatched => null (gateway returns 404). */
export function matchRoute(routes, method, path) {
  for (const r of routes) {
    if (r.method !== "*" && r.method !== method.toUpperCase()) continue;
    if (r.pattern.endsWith("*") ? path.startsWith(r.pattern.slice(0, -1)) : path === r.pattern) return r;
  }
  return null;
}
