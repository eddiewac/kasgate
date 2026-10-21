#!/usr/bin/env node
// CLI entry. Testnet-10 only (config validation refuses any other network).
//   x402-gateway serve [--config config/routes.yaml] [--db data/gateway.sqlite] [--chain mock|real] [--port N] [--host H]
//   x402-gateway hash-password            # reads the password from stdin, prints an scrypt hash for X402_DASHBOARD_PASSWORD_HASH
//   x402-gateway check-config --config F  # validate a routes file
//   x402-gateway refunds [--db F] [--txid T --refund-tx R]  # list expired pending payments due a refund / record a refund you sent
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);
const { values: a } = parseArgs({ args: rest, options: {
  config: { type: "string", default: process.env.X402_CONFIG ?? path.join(ROOT, "config/routes.yaml") },
  db: { type: "string", default: process.env.X402_DB ?? path.join(ROOT, "data/gateway.sqlite") },
  chain: { type: "string", default: process.env.X402_CHAIN ?? "mock" },
  port: { type: "string" }, host: { type: "string" }, txid: { type: "string" }, "refund-tx": { type: "string" } }, allowPositionals: false });

async function readStdin() { const c = []; for await (const x of process.stdin) c.push(x); return Buffer.concat(c).toString("utf8").replace(/\r?\n$/, ""); }

if (cmd === "hash-password") {
  const { hashPassword } = await import("../src/auth.mjs");
  if (process.stdin.isTTY) process.stderr.write("Reading password from stdin (end with Ctrl-D). Prefer: read -rs P && printf %s \"$P\" | x402-gateway hash-password\n");
  console.log(hashPassword(await readStdin()));
} else if (cmd === "check-config") {
  const cfg = loadConfig(a.config); console.log(`ok: ${cfg.routes.length} routes, network ${cfg.network}`);
} else if (cmd === "serve") {
  const cfg = loadConfig(a.config);
  if (a.port) cfg.listen.port = Number(a.port); if (a.host) cfg.listen.host = a.host;
  const { openDb } = await import("../src/store.mjs"); const { createGateway } = await import("../src/gateway.mjs");
  const db = openDb(a.db); const opts = { chain: a.chain, db };
  // M5: real chain requires password login; mock may use a Bearer token from X402_DASHBOARD_TOKEN (dev only).
  if (!process.env.X402_DASHBOARD_PASSWORD_HASH) {
    if (a.chain === "real") { console.error("[x402] refusing --chain real without X402_DASHBOARD_PASSWORD_HASH (run: x402-gateway hash-password)"); process.exit(2); }
    console.warn("[x402] X402_DASHBOARD_PASSWORD_HASH not set: dashboard accepts only Authorization: Bearer $X402_DASHBOARD_TOKEN (dev only)");
  }
  if (a.chain === "real" && cfg.routes.some((r) => r.scheme === "batch-settlement")) {
    const { connectTn10 } = await import("../src/live/sdk.mjs"); const { createLiveBatchKit } = await import("../src/live/batch-kit.mjs");
    const { rpc, via } = await connectTn10(); const kit = await createLiveBatchKit({ rpc });
    opts.liveKit = kit; opts.nowDaa = await kit.virtualDaa(); // H2: per-channel timeout = open DAA + delta (rotating)
    console.log(`[x402] TN10 via ${via}; batch refund timeout = channel-open DAA + ${cfg.batch.refundTimeoutDeltaDaa}`);
  }
  const gw = createGateway(cfg, opts); await gw.listen();
  const rec = await gw.recovered; if (rec.length) console.log(`[x402] claim recovery on start: ${JSON.stringify(rec)}`);
  console.log(`x402 gateway (TN10, ${a.chain.toUpperCase()} chain, db ${a.db}) on http://${cfg.listen.host}:${cfg.listen.port} -> ${cfg.upstream}`);
  const stop = () => { gw.close(); db.close(); process.exit(0); }; process.on("SIGINT", stop); process.on("SIGTERM", stop);
} else if (cmd === "refunds") {
  // R5-L3 refund path (operator-approved): the gateway moves pending payments past exactPendingTtlMs to 'exact-refund-due'.
  // Send the refund yourself (TN10 wallet), then record its txid here. Nothing is broadcast by this command.
  const { openDb } = await import("../src/store.mjs"); const db = openDb(a.db);
  if (a.txid) { const row = db.prepare("SELECT v FROM kv WHERE ns='exact-refund-due' AND k=?").get(a.txid.toLowerCase());
    if (!row) { console.error(`no refund-due entry for ${a.txid}`); process.exit(1); }
    if (!/^[0-9a-f]{64}$/i.test(a["refund-tx"] ?? "")) { console.error("--refund-tx <64-hex txid> required"); process.exit(2); }
    db.prepare("UPDATE kv SET v=? WHERE ns='exact-refund-due' AND k=?").run(JSON.stringify({ ...JSON.parse(row.v), status: "refunded", refundTxid: a["refund-tx"].toLowerCase(), refundedAt: new Date().toISOString() }), a.txid.toLowerCase());
    console.log(`recorded refund ${a["refund-tx"]} for ${a.txid}`); }
  for (const r of db.prepare("SELECT k, v FROM kv WHERE ns='exact-refund-due'").all()) console.log(JSON.stringify({ txid: r.k, ...JSON.parse(r.v) }));
  db.close();
} else {
  console.error("usage: x402-gateway <serve|hash-password|check-config|refunds> [--config F] [--db F] [--chain mock|real] [--port N] [--host H]"); process.exit(2);
}
