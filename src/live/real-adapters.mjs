// REAL Testnet-10 adapters.
// Seller side: upstream @kaspa-x402/adapters (VerifiedExactTransactionVerifier,
//   VerifiedExactSettlementReconciler, VerifiedKaspaChainProvider over KaspaRestClient).
// Payer side: a hot-wallet ExactFundingProvider built with the rusty-kaspa WASM SDK,
//   following upstream protocol/scripts/live-adapter-reference.mjs (buildStandardExactTransaction).
// Testnet-10 only: every adapter is constructed without allowMainnet.
import { KaspaRestClient, NativeAddressCodec, ScriptAddressBook, VerifiedExactSettlementReconciler,
  VerifiedExactTransactionVerifier, VerifiedKaspaChainProvider } from "@kaspa-x402/adapters";
import { exactRequestAuthorizationDigest, bytesToHex, hexToBytes } from "@kaspa-x402/core";
import { KIP10_EXACT_TRANSACTION_ENCODING, calculateKaspaStorageMass } from "@kaspa-x402/covenant";
import { createRequire } from "node:module";
import { sdk, NETWORK_ID } from "./sdk.mjs";
const { schnorr } = createRequire(import.meta.url)("@noble/curves/secp256k1");

export const DEFAULT_REST_URL = "https://api-tn10.kaspa.org";
export const FEE_SOMPI = 100_000n; // incentive audit: floor 0.001 KAS; real fee = mass x node feerate (was a flat 0.02 floor)
/** RR-L4: sanity cap on a node-estimated fee: absolute 0.05 KAS and at most 10% of the paid amount. */
export const FEE_CAP_SOMPI = 5_000_000n; export const FEE_CAP_PCT = 10n;          // fee FLOOR (upstream reference default); actual fee = max(floor, mass x feerate)
const MIN_CHANGE = 10_000_000n;               // upstream reference change policy (KIP-9 storage mass)
const NATIVE_SUBNETWORK_ID = "00".repeat(20);

export function createRealSellerDeps({ restUrl = DEFAULT_REST_URL } = {}) {
  const rest = new KaspaRestClient(restUrl, { acceptanceTimeoutMs: 90_000 });
  const book = new ScriptAddressBook("kaspa:testnet-10");
  return {
    addressCodec: new NativeAddressCodec(book),
    chainProvider: new VerifiedKaspaChainProvider(rest, book, "0", { network: "kaspa:testnet-10" }),
    exactTransactionVerifier: new VerifiedExactTransactionVerifier(rest, { network: "kaspa:testnet-10" }),
    exactSettlementReconciler: new VerifiedExactSettlementReconciler(rest, { network: "kaspa:testnet-10" }),
    rest,
  };
}

export function createRealPayerAddressCodec() { return new NativeAddressCodec(new ScriptAddressBook("kaspa:testnet-10")); }

function spkFromEntry(entry) {
  const s = entry.scriptPublicKey;
  if (s instanceof sdk.ScriptPublicKey) return s;
  if (typeof s === "string") { const b = hexToBytes(s); return new sdk.ScriptPublicKey((b[0] << 8) | b[1], bytesToHex(b.slice(2))); }
  return new sdk.ScriptPublicKey(s.version, s.script);
}

/** M3: change must be 0 or >= MIN_CHANGE; anything in between would be burned into the fee, so it's refused. */
export const changeOk = (utxoAmount, amount, fee) => { const c = BigInt(utxoAmount) - BigInt(amount) - BigInt(fee); return c === 0n || c >= MIN_CHANGE; };
/** M3 limits. Compute mass (when it dominates): node standard limit from the SDK (100,000 g). Storage mass: the per-tx standard
 *  limit on TN10 is NOT verified (a ~100k-gram storage-mass tx was accepted), so it's a configurable bound
 *  (default 500,000 g = block mass limit) rather than an assumed-safe value. */
export const MASS_LIMITS = { maxComputeMass: () => BigInt(sdk.maximumStandardTransactionMass()), maxStorageMass: 500_000n };

/** Build + sign a standard-native exact payment transaction (no broadcast — the seller broadcasts).
 *  fee: max(feeFloorSompi, ceil(max(computeMass, storageMass) x feerate)); two passes because change affects mass. */
export function buildStandardExactPayment({ request, keyHex, payerAddress, utxo, feerate = 0, feeFloorSompi = FEE_SOMPI, maxStorageMass = MASS_LIMITS.maxStorageMass }) {
  let fee = BigInt(feeFloorSompi), out;
  for (let pass = 0; pass < 3; pass++) {
    out = buildWithFee({ request, keyHex, payerAddress, utxo, fee });
    // feerate >= 1 sompi/g (Kaspa minimum relay fee 1000 sompi/kg), even if the estimator is unavailable
    const want = (() => { const f = BigInt(Math.ceil(Number(out.mass) * Math.max(1, Number(feerate)))); return f > BigInt(feeFloorSompi) ? f : BigInt(feeFloorSompi); })();
    if (want <= fee) break; fee = want;
  }
  const cap = (() => { const pct = BigInt(request.amount) * FEE_CAP_PCT / 100n; const c = pct < FEE_CAP_SOMPI ? pct : FEE_CAP_SOMPI; return c > BigInt(feeFloorSompi) ? c : BigInt(feeFloorSompi); })();
  if (fee > cap) throw new Error(`fee ${fee} sompi exceeds the sanity cap ${cap} (feerate ${feerate} from the node looks wrong); refusing to sign`);
  if (out.computeMass > MASS_LIMITS.maxComputeMass()) throw new Error(`compute mass ${out.computeMass} exceeds standard limit ${MASS_LIMITS.maxComputeMass()}`);
  if (out.storageMass > BigInt(maxStorageMass)) throw new Error(`storage mass ${out.storageMass} exceeds configured limit ${maxStorageMass}`);
  return { ...out.result, feerate: Number(feerate), storageMassGrams: out.storageMass.toString() };
}
function buildWithFee({ request, keyHex, payerAddress, utxo, fee }) {
  const key = new sdk.PrivateKey(keyHex);
  const amount = BigInt(request.amount); const needed = amount + fee;
  const utxoAmount = BigInt(utxo.amount);
  if (utxoAmount < needed) throw new Error(`funding UTXO ${utxoAmount} < required ${needed}`);
  const outputs = [{ value: amount, scriptPublicKey: sdk.payToAddressScript(request.payTo) }];
  const change = utxoAmount - needed;
  if (change !== 0n && change < MIN_CHANGE) throw new Error(`change ${change} would be below ${MIN_CHANGE} sompi and burned; pick another UTXO`);
  if (change > 0n) outputs.push({ value: change, scriptPublicKey: sdk.payToAddressScript(payerAddress) });
  const op = { transactionId: utxo.outpoint.transactionId ?? utxo.outpoint.txid, index: utxo.outpoint.index };
  const inputBase = { previousOutpoint: op, sequence: 0n, sigOpCount: 1,
    utxo: { outpoint: op, amount: utxoAmount, scriptPublicKey: spkFromEntry(utxo), blockDaaScore: 0n, isCoinbase: false } };
  const shape0 = { version: 0, outputs, lockTime: 0n, subnetworkId: NATIVE_SUBNETWORK_ID, gas: 0n, payload: "", storageMass: 0n };
  // Commit the contextual KIP-9 storage mass (Toccata "storageMass"); upstream verifier recomputes and requires equality.
  const draft = JSON.parse(new sdk.Transaction({ ...shape0, inputs: [{ ...inputBase, signatureScript: "" }] }).serializeToSafeJSON());
  const storageMass = calculateKaspaStorageMass({
    inputs: draft.inputs.map((i) => ({ amount: i.utxo.amount, scriptPublicKey: i.utxo.scriptPublicKey, hasCovenant: false })),
    outputs: draft.outputs.map((o) => ({ amount: o.value, scriptPublicKey: o.scriptPublicKey, hasCovenant: false })) });
  const shape = { ...shape0, storageMass: BigInt(storageMass) };
  const unsigned = new sdk.Transaction({ ...shape, inputs: [{ ...inputBase, signatureScript: "" }] });
  const signatureScript = sdk.createInputSignature(unsigned, 0, key, sdk.SighashType.All);
  const tx = new sdk.Transaction({ ...shape, inputs: [{ ...inputBase, signatureScript }] });
  // SDK returns the overall mass = max(compute, storage). If it equals the storage mass, compute is <= it and
  // storage dominates (checked against maxStorageMass); otherwise compute dominates and must fit the standard limit.
  const mass = BigInt(sdk.calculateTransactionMass(NETWORK_ID, tx, 1));
  const computeMass = mass > BigInt(storageMass) ? mass : 0n;
  const digest = exactRequestAuthorizationDigest({ network: request.network, profile: request.profile, transactionId: tx.id,
    paymentOutputIndex: 0, amount: request.amount, payTo: request.payTo, payToScriptPublicKey: request.payToScriptPublicKey,
    paymentRequirementsHash: request.paymentRequirementsHash, requestHash: request.requestHash,
    paymentIdentifier: request.paymentIdentifier, challengeId: undefined, inputIndex: 0, expiresAt: request.authorizationExpiresAt });
  return { computeMass, storageMass: BigInt(storageMass), mass, fee, result: { transaction: tx.serializeToSafeJSON(), transactionEncoding: KIP10_EXACT_TRANSACTION_ENCODING, paymentOutputIndex: 0,
    transactionId: tx.id, inputOutpoints: [{ txid: op.transactionId, index: op.index }],
    authorization: { version: "kaspa-x402-exact-request-authorization-v2", inputIndex: 0, expiresAt: request.authorizationExpiresAt,
      digest, signature: bytesToHex(schnorr.sign(hexToBytes(digest, { expectedLength: 32 }), hexToBytes(keyHex, { expectedLength: 32 }))) },
    payerAddress, fundingSource: "hot-wallet", feeSompi: fee.toString(), massGrams: mass.toString() } };
}

/** Real Testnet-10 hot-wallet ExactFundingProvider (standard-native only). Key stays in memory, never logged. */
export class RealTn10FundingProvider {
  networkId = "kaspa:testnet-10"; sourceKind = "hot-wallet";
  #keyHex; #attempts = new Map(); #reserved = new Set(); #db;
  /** @param db optional better-sqlite3 handle: UTXO reservations persist across restarts (M4). */
  constructor({ rpc, keyHex, db = null, feeFloorSompi = FEE_SOMPI, maxStorageMass = MASS_LIMITS.maxStorageMass }) {
    this.rpc = rpc; this.#keyHex = keyHex; this.#db = db; this.feeFloorSompi = BigInt(feeFloorSompi); this.maxStorageMass = BigInt(maxStorageMass);
    if (db) for (const r of db.prepare("SELECT k FROM kv WHERE ns = 'payer-reserved'").all()) this.#reserved.add(r.k);
    const k = new sdk.PrivateKey(keyHex);
    this.address = k.toAddress(NETWORK_ID).toString();
    this.publicKey = bytesToHex(schnorr.getPublicKey(hexToBytes(keyHex, { expectedLength: 32 })));
  }
  async getPublicIdentity() { return { address: this.address, publicKey: this.publicKey }; }
  async spendableUtxos() {
    const { entries } = await this.rpc.getUtxosByAddresses({ addresses: [this.address] });
    return entries.filter((e) => !this.#reserved.has(`${e.outpoint.transactionId}:${e.outpoint.index}`));
  }
  async payExactTransaction(request) {
    if (request.network !== "kaspa:testnet-10") throw new Error("testnet-10 only");
    if (request.profile !== "standard-native") throw new Error("only standard-native exact is implemented");
    const key = request.attemptId.toLowerCase(); const prev = this.#attempts.get(key);
    if (prev) { if (prev.intentHash !== request.intentHash.toLowerCase()) throw new Error("exact payment attempt intent changed"); return structuredClone(prev.result); }
    const feerate = await this.feerate();
    const candidates = await this.spendableUtxos();
    // M4: everything below runs synchronously (no await) so selection + reservation is atomic in this process;
    // #reserved is re-checked here because other calls may have reserved after spendableUtxos() filtered.
    const k = (e) => `${e.outpoint.transactionId}:${e.outpoint.index}`;
    const amount = BigInt(request.amount); let result, utxo;
    for (const e of candidates.filter((e) => !this.#reserved.has(k(e)) && BigInt(e.amount) >= amount + this.feeFloorSompi)
      .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1))) {
      try { result = buildStandardExactPayment({ request, keyHex: this.#keyHex, payerAddress: this.address, utxo: e, feerate, feeFloorSompi: this.feeFloorSompi, maxStorageMass: this.maxStorageMass }); utxo = e; break; }
      catch (err) { if (!/change .* burned|funding UTXO/.test(err.message)) throw err; }
    }
    if (!utxo) throw new Error(`insufficient testnet funds: no UTXO covers ${amount} + fee with valid change at ${this.address}`);
    this.#reserved.add(k(utxo));
    this.#db?.prepare("INSERT OR REPLACE INTO kv (ns, k, v) VALUES ('payer-reserved', ?, ?)").run(k(utxo), JSON.stringify({ txid: result.transactionId, at: new Date().toISOString() }));
    this.#attempts.set(key, { intentHash: request.intentHash.toLowerCase(), result: structuredClone(result), utxo });
    return result;
  }
  async finalizeExactPaymentAttempt(request) {
    const a = this.#attempts.get(request.attemptId.toLowerCase()); if (!a) return;
    if (a.result.transactionId.toLowerCase() !== request.transactionId.toLowerCase()) throw new Error("exact transaction id does not match provider attempt");
    // P1 late broadcast: "absent" does not free the input; the seller still holds a valid signed tx spending it.
    // The UTXO stays reserved until invalidateAbsentAttempts() double-spends it back to this wallet.
    if (request.outcome === "absent") { const key = `${a.utxo.outpoint.transactionId}:${a.utxo.outpoint.index}`;
      this.#db?.prepare("INSERT OR REPLACE INTO kv (ns, k, v) VALUES ('payer-reserved', ?, ?)").run(key, JSON.stringify({ txid: a.result.transactionId, absent: true, at: new Date().toISOString() })); }
  }
  /**
   * Invalidate signed-but-absent exact artifacts by spending their reserved input back to this wallet (a later
   * broadcast of the old artifact then fails as a double spend), and drop reservations whose input is already spent.
   * Also prunes stale reservations (RR-L: payer-reserved growth). Returns [{ outpoint, action, txid? }].
   */
  async invalidateAbsentAttempts({ olderThanMs = 10 * 60_000, includeUnfinalized = false, sdkCreate = sdk.createTransactions } = {}) {
    const out = []; if (!this.#db) return out;
    const { entries } = await this.rpc.getUtxosByAddresses({ addresses: [this.address] });
    const live = new Map(entries.map((e) => [`${e.outpoint.transactionId}:${e.outpoint.index}`, e]));
    for (const r of this.#db.prepare("SELECT k, v FROM kv WHERE ns = 'payer-reserved'").all()) {
      const v = JSON.parse(r.v); const e = live.get(r.k);
      if (!e) { this.#db.prepare("DELETE FROM kv WHERE ns = 'payer-reserved' AND k = ?").run(r.k); this.#reserved.delete(r.k); out.push({ outpoint: r.k, action: "input-spent: reservation dropped" }); continue; }
      if ((!v.absent && !includeUnfinalized) || Date.now() - Date.parse(v.at) < olderThanMs) continue;
      const { transactions } = await sdkCreate({ entries: [e], outputs: [], changeAddress: this.address, priorityFee: 0n, networkId: NETWORK_ID });
      const pk = new sdk.PrivateKey(this.#keyHex); let txid;
      for (const t of transactions) { t.sign([pk]); txid = await t.submit(this.rpc); }
      out.push({ outpoint: r.k, action: "invalidated by self-spend", txid });
      // the old outpoint is now spent by our own tx; the next call drops the reservation row (input-spent branch)
    }
    return out;
  }
  /** sompi/gram from the node's fee estimator (priority bucket); 0 if unavailable (fee floor still applies). */
  /** sompi/gram from the node's fee estimator. Incentive audit: payments use the LOW bucket (priority only for
   *  near-timeout claims); 0 if unavailable (then >= 1 sompi/g min relay, and the fee floor apply). */
  async feerate() { try { const r = await this.rpc.getFeeEstimate({}); const e = r?.estimate ?? {};
    return Number(e.lowBuckets?.[0]?.feerate ?? e.normalBuckets?.[0]?.feerate ?? e.priorityBucket?.feerate ?? 0); } catch { return 0; } }
  async sendTransaction() { throw new Error("standard-native exact: the seller broadcasts"); }
}
