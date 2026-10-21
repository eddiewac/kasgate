import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** Append-only JSONL log of paid requests (seller side). */
export class Ledger {
  /** @param path JSONL file path, or null. @param db optional better-sqlite3 handle (src/store.mjs openDb) -> SQLite-backed. */
  constructor(path, db = null, { runId } = {}) { this.path = db ? null : path; this.db = db; this.entries = []; this.runId = runId;
    if (db) { this.entries = db.prepare("SELECT entry FROM ledger ORDER BY id").all().map((r) => JSON.parse(r.entry));
      this.ins = db.prepare("INSERT INTO ledger (at, outcome, txid, entry) VALUES (?, ?, ?, ?)"); return; }
    if (path) { mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) this.entries = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } }
  record(e) { const entry = { at: new Date().toISOString(), ...(this.runId ? { runId: this.runId } : {}), ...e }; this.entries.push(entry);
    if (this.ins) this.ins.run(entry.at, entry.outcome ?? null, entry.txid ?? null, JSON.stringify(entry));
    if (this.path) appendFileSync(this.path, JSON.stringify(entry) + "\n"); return entry; }
  /** @param runId optional: only entries from that gateway run (L2). */
  summary({ runId } = {}) {
    const entries = runId ? this.entries.filter((e) => e.runId === runId) : this.entries;
    const paid = entries.filter((e) => e.outcome === "paid");
    const byRoute = {};
    for (const e of paid) { const r = (byRoute[e.route] ??= { count: 0, revenueSompi: 0n });
      r.count++; r.revenueSompi += BigInt(e.amountSompi); }
    const total = paid.reduce((a, e) => a + BigInt(e.amountSompi), 0n);
    const claimRows = entries.filter((e) => e.outcome === "claim");
    const claimed = claimRows.reduce((a, e) => a + BigInt(e.amountSompi), 0n);
    const claimedNet = claimRows.reduce((a, e) => a + BigInt(e.netSompi ?? e.amountSompi), 0n);
    const batchAccrued = paid.filter((e) => e.scheme === "batch-settlement").reduce((a, e) => a + BigInt(e.amountSompi), 0n);
    return { paidRequests: paid.length, batchAccruedSompi: batchAccrued.toString(), batchClaimedSompi: claimed.toString(),
      batchUnclaimedSompi: (batchAccrued - claimed).toString(), batchClaimedNetSompi: claimedNet.toString(), claimFeesSompi: (claimed - claimedNet).toString(),
      runs: [...new Set(this.entries.map((e) => e.runId).filter(Boolean))], challenges: entries.filter((e) => e.outcome === "challenge").length,
      rejected: entries.filter((e) => e.outcome === "rejected").length,
      revenueSompi: total.toString(), revenueKas: sompiToKas(total),
      byRoute: Object.fromEntries(Object.entries(byRoute).map(([k, v]) => [k, { count: v.count, revenueSompi: v.revenueSompi.toString(), revenueKas: sompiToKas(v.revenueSompi) }])),
      recent: entries.slice(-50).reverse() };
  }
}
export const sompiToKas = (s) => { const n = BigInt(s); return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`; };
