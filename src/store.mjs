// SQLite durability layer (better-sqlite3, WAL). One file holds: the seller ledger, server channel
// snapshots, wallet channel/attempt snapshots, wallet spend history + reservations, and dashboard sessions.
//
// Upstream's Memory*Store classes keep the protocol state machines (CAS, leases, attempt rules).
// We do not re-implement them. We subclass them and write a snapshot through to SQLite after every
// successful mutating call, then rehydrate through their public constructors on start.
// What survives a restart: channels (server + client, incl. accrued vouchers) and client funding/refund
// attempts. What doesn't: in-flight leases, idempotency/commitment caches, exact-attempt records (process-local
// in upstream's memory store; a restart mid-request fails that request closed).
import Database from "better-sqlite3";
import { mkdirSync, chmodSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { MemoryServerChannelStore } from "@kaspa-x402/server";
import { MemoryChannelStore } from "@kaspa-x402/client";

const big = (_k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v);
const unbig = (_k, v) => (v && typeof v === "object" && "$big" in v && Object.keys(v).length === 1 ? BigInt(v.$big) : v);
export const enc = (v) => JSON.stringify(v, big);
export const dec = (s) => JSON.parse(s, unbig);

/** P0-1: DB files hold payment state (never keys) but are still private: dir 0700, db/-wal/-shm 0600. */
export function tightenDbFiles(path) {
  if (path === ":memory:") return;
  try { chmodSync(dirname(path), 0o700); } catch {}
  for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) if (existsSync(f)) chmodSync(f, 0o600);
}
export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const prevMask = process.umask(0o077);
  let db; try { db = new Database(path); db.pragma("journal_mode = WAL"); } finally { process.umask(prevMask); }
  tightenDbFiles(path); db.pragma("synchronous = FULL"); db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (ns, k));
    CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, outcome TEXT, txid TEXT, entry TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ledger_txid ON ledger(txid);
    CREATE TABLE IF NOT EXISTS spends (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL, amount_sompi TEXT NOT NULL, entry TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS spends_day ON spends(wallet, day);
    CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  `);
  return db;
}
export function kvReplace(db, ns, rows) {
  db.transaction(() => { db.prepare("DELETE FROM kv WHERE ns = ?").run(ns);
    const ins = db.prepare("INSERT INTO kv (ns, k, v) VALUES (?, ?, ?)"); for (const [k, v] of rows) ins.run(ns, k, enc(v)); })();
}
export const kvAll = (db, ns) => db.prepare("SELECT k, v FROM kv WHERE ns = ? ORDER BY k").all(ns).map((r) => [r.k, dec(r.v)]);

const READ = /^(load|list|durableStateStats|constructor)/;
function writeThrough(instance, Proto, persist, before = () => {}) {
  for (const name of Object.getOwnPropertyNames(Proto.prototype)) {
    const fn = Proto.prototype[name];
    if (typeof fn !== "function" || READ.test(name)) continue;
    instance[name] = async (...a) => { const r = await fn.apply(instance, a); before(name, a); await persist(); return r; };
  }
}

/**
 * Seller-side upstream ServerChannelStore, durable via an append-only SQLite journal (P0-3 / P1 "exact state
 * memory-only", RR-M4, RR-M6). Upstream's MemoryServerChannelStore keeps every state machine (CAS, leases,
 * batch + exact settlement attempts, payment-identifier reservations, exact heads, claim attempts). After each
 * successful mutating call we append ONE row (method, args, wall-clock ms) synchronously (synchronous=FULL),
 * before the call resolves to upstream; writes are O(1). If the append fails the process exits (fail closed):
 * upstream must never observe a transition that would be lost on restart.
 * On start a fresh MemoryServerChannelStore is rebuilt by replaying the journal through upstream's own
 * validated transitions with the clock frozen at each row's timestamp, so exact attempts (accepted, handler
 * started/recorded/recovery-required, committed replays) and batch/claim state survive a restart.
 * Legacy snapshot rows (pre-journal) are the baseline. Compaction is deferred (FIXES.md).
 */
export function createPersistentServerStore(db, ns = "server-channels", { onFatal = (e) => { console.error(`[x402-store] FATAL journal write failed, exiting: ${e?.message}`); process.exit(70); } } = {}) {
  db.exec("CREATE TABLE IF NOT EXISTS store_journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT NOT NULL, at INTEGER NOT NULL, method TEXT NOT NULL, args TEXT NOT NULL)");
  const rows = new Map(kvAll(db, ns));
  const channels = [...rows].filter(([k]) => k.startsWith("channel:")).map(([, v]) => v);
  let frozen = null; const clock = () => frozen ?? Date.now();
  const store = new MemoryServerChannelStore(channels, { now: clock });
  const ins = db.prepare("INSERT INTO store_journal (ns, at, method, args) VALUES (?, ?, ?, ?)");
  const scrub = (a) => a.map((x) => (x instanceof AbortSignal || typeof x === "function" ? null : x));
  let replaying = true; const pending = [];
  for (const name of Object.getOwnPropertyNames(MemoryServerChannelStore.prototype)) {
    const fn = MemoryServerChannelStore.prototype[name];
    if (typeof fn !== "function" || READ.test(name)) continue;
    store[name] = async (...a) => {
      if (replaying) await store.ready; // no live transition before the journal is replayed
      const at = Date.now(); const r = await fn.apply(store, a);
      try { ins.run(ns, at, name, enc(scrub(a))); } catch (e) { onFatal(e); throw e; }
      return r;
    };
  }
  // P0-3: upstream 1.0.1 requires an atomic "claim exact settlement + persist its PNN evidence receipt" when the
  // verifier is node-backed (DirectModeServer #claimExactSettlement; demo-gateway GatewayLedger). The journal row
  // and the pnn_evidence row commit in ONE SQLite transaction, so a restart sees both or neither.
  db.exec("CREATE TABLE IF NOT EXISTS pnn_evidence (txid TEXT PRIMARY KEY, record TEXT NOT NULL, at TEXT NOT NULL)");
  const insEv = db.prepare("INSERT OR IGNORE INTO pnn_evidence (txid, record, at) VALUES (?, ?, ?)");
  const claimTx = db.transaction((at, attempt, receipt) => { ins.run(ns, at, "claimExactSettlement", enc(scrub([attempt]))); insEv.run(receipt.transactionId, enc(receipt), new Date(at).toISOString()); });
  store.claimExactSettlementWithEvidence = async (attempt, receipt, signal) => {
    signal?.throwIfAborted?.();
    if (!receipt || receipt.transactionId !== attempt?.transactionId) throw new Error("PNN evidence does not match exact settlement claim");
    if (replaying) await store.ready;
    const at = Date.now(); const r = await MemoryServerChannelStore.prototype.claimExactSettlement.call(store, attempt);
    try { claimTx(at, attempt, receipt); } catch (e) { onFatal(e); throw e; }
    return r;
  };
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate { constructor(...a) { super(...(a.length ? a : [frozen ?? RealDate.now()])); } static now() { return frozen ?? RealDate.now(); } }
  const replayErrors = [];
  store.ready = (async () => {
    // Baseline from the legacy snapshot: open leases + claim attempt history.
    for (const [k, lease] of rows) if (k.startsWith("lease:") && !db.prepare("SELECT 1 FROM store_journal WHERE ns = ? LIMIT 1").get(ns)) {
      try { await MemoryServerChannelStore.prototype.claimChannelOperation.call(store, { ...lease, status: "reserved" });
        for (const r of rows.get(`claim:${lease.channelId}`) ?? []) await MemoryServerChannelStore.prototype.saveClaimAttempt.call(store, r); }
      catch (e) { replayErrors.push({ channelId: lease.channelId, error: `legacy baseline: ${e.message}` }); }
    }
    let n = 0;
    for (const r of db.prepare("SELECT seq, at, method, args FROM store_journal WHERE ns = ? ORDER BY seq").iterate(ns)) pending.push(r);
    for (const r of pending) {
      frozen = r.at; globalThis.Date = FrozenDate;
      try { await MemoryServerChannelStore.prototype[r.method].apply(store, dec(r.args)); n++; }
      catch (e) { replayErrors.push({ seq: r.seq, method: r.method, error: e.message }); }
      finally { frozen = null; globalThis.Date = RealDate; }
    }
    pending.length = 0; replaying = false;
    return { replayed: n, errors: replayErrors };
  })();
  // Open claim attempts after replay (H1 restart recovery input), incl. claimAmount for correct booking (N-M3).
  store.restored = store.ready.then(async () => {
    const out = replayErrors.filter((e) => e.channelId).map((e) => ({ ...e }));
    for (const c of await MemoryServerChannelStore.prototype.listChannels.call(store)) {
      const id = c.channelId ?? c.id; const att = await MemoryServerChannelStore.prototype.loadOpenClaimAttempt.call(store, id);
      if (att) out.push({ channelId: id, attemptId: att.attemptId, status: att.status, transactionId: att.transactionId, claimAmount: att.claimAmount ?? att.amount });
    }
    return out;
  });
  store.journalStats = () => db.prepare("SELECT COUNT(*) n FROM store_journal WHERE ns = ?").get(ns).n;
  return store;
}

const PROJECT_ROOT = resolve(new URL("..", import.meta.url).pathname);
/**
 * P0-1 / N-H1: channel private keys never enter SQLite. Each key is written once to its own 0600 file
 * (exclusive create) under a 0700 keystore dir; SQLite rows carry only { $keyref: sha256(key)[:32] }.
 * In-memory DBs get an in-memory keystore (nothing on disk).
 */
export class Keystore {
  #mem = new Map();
  constructor(dir = null) { this.dir = dir; if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 }), chmodSync(dir, 0o700); }
  static forDb(db) {
    if (db.memory || db.name === ":memory:") return new Keystore(null);
    const tag = createHash("sha256").update(resolve(db.name)).digest("hex").slice(0, 12);
    const inProject = resolve(db.name).startsWith(PROJECT_ROOT + "/");
    // project DBs -> gitignored .secrets/keystore/<tag>; scratch DBs (tests, /tmp) -> a private dir beside them
    return new Keystore(process.env.X402_KEYSTORE_DIR ? join(process.env.X402_KEYSTORE_DIR, tag)
      : inProject ? join(PROJECT_ROOT, ".secrets", "keystore", tag) : join(dirname(resolve(db.name)), ".keystore"));
  }
  put(key) {
    const ref = createHash("sha256").update(String(key)).digest("hex").slice(0, 32);
    if (this.#mem.has(ref)) return ref;
    if (this.dir) { const f = join(this.dir, `${ref}.key`);
      try { writeFileSync(f, String(key) + "\n", { mode: 0o600, flag: "wx" }); } catch (e) { if (e.code !== "EEXIST") throw e; } }
    this.#mem.set(ref, String(key)); return ref;
  }
  get(ref) {
    if (this.#mem.has(ref)) return this.#mem.get(ref);
    if (!this.dir) throw new Error(`keystore: missing key ${ref}`);
    const k = readFileSync(join(this.dir, `${ref}.key`), "utf8").trim(); this.#mem.set(ref, k); return k;
  }
}
const KEY_FIELDS = new Set(["clientPrivateKey", "privateKey", "serverPrivateKey"]);
/** Deep copy with every key field replaced by a keystore reference. */
export function stripKeys(v, ks) {
  if (Array.isArray(v)) return v.map((x) => stripKeys(x, ks));
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    const o = {}; for (const [k, x] of Object.entries(v)) o[k] = KEY_FIELDS.has(k) && typeof x === "string" ? { $keyref: ks.put(x) } : stripKeys(x, ks);
    return o;
  }
  return v;
}
export function restoreKeys(v, ks) {
  if (Array.isArray(v)) return v.map((x) => restoreKeys(x, ks));
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    if (Object.keys(v).length === 1 && typeof v.$keyref === "string") return ks.get(v.$keyref);
    const o = {}; for (const [k, x] of Object.entries(v)) o[k] = restoreKeys(x, ks); return o;
  }
  return v;
}
/** True if any persisted value still contains a raw key field (used by tests and the purge script). */
export function hasRawKeys(db) {
  return db.prepare("SELECT v FROM kv").all().some((r) => /"(clientPrivateKey|privateKey|serverPrivateKey)":"/.test(r.v));
}

/** Wallet-side upstream ChannelStore with SQLite write-through (channels + funding/refund attempts). Keys go to the Keystore, not SQLite. */
export function createPersistentClientStore(db, ns = "client-channels", keystore = Keystore.forDb(db)) {
  // legacy rows may still carry raw keys: move them into the keystore and rewrite the rows key-free
  const raw = kvAll(db, ns); kvReplace(db, ns, raw.map(([k, v]) => [k, stripKeys(v, keystore)]));
  const rows = raw.map(([k, v]) => [k, restoreKeys(v, keystore)]); const pick = (kind) => rows.filter(([k]) => k.startsWith(kind + ":")).map(([, v]) => v);
  // Upstream's constructor only accepts an *applied* funding attempt for an ACTIVE channel; once a channel is refunded
  // the applied attempt is history, so it is not handed back (found in the TN10 regression: wallet failed to open).
  const terminal = new Set(pick("channel").filter((c) => c.status !== "active").map((c) => String(c.id).toLowerCase()));
  const funding = pick("funding").filter((f) => !(f.status === "applied" && terminal.has(String(f.channelId).toLowerCase())));
  const store = new MemoryChannelStore(pick("channel"), pick("refund"), funding);
  writeThrough(store, MemoryChannelStore, async () => {
    const out = [];
    for (const c of await store.loadChannels({})) {
      out.push([`channel:${c.id}`, c]);
      const f = await store.loadFundingTransitionAttempt(c.id); if (f) out.push([`funding:${c.id}`, f]);
      const r = await store.loadRefundAttempt(c.id); if (r) out.push([`refund:${c.id}`, r]);
    }
    kvReplace(db, ns, out.map(([k, v]) => [k, stripKeys(v, keystore)]));
  });
  return store;
}
