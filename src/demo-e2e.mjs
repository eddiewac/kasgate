// End-to-end local demo: upstream API + seller gateway + agent wallet. MOCK chain, TN10 config.
import { createUpstream } from "./demo-upstream.mjs";
import { createGateway } from "./gateway.mjs";
import { loadConfig } from "./config.mjs";
import { AgentWallet, createDevLoopbackFetch, SpendLimitError } from "./agent-wallet.mjs";
import { sompiToKas } from "./ledger.mjs";

const cfg = loadConfig(new URL("../config/routes.yaml", import.meta.url).pathname);
cfg.dashboard.token ??= (await import("node:crypto")).randomBytes(16).toString("hex"); // demo-only ephemeral token
const up = createUpstream().listen(0, "127.0.0.1"); await new Promise((r) => up.once("listening", r));
cfg.upstream = `http://127.0.0.1:${up.address().port}`;
const gw = createGateway(cfg); const gs = await gw.listen(0, "127.0.0.1");
const local = `http://127.0.0.1:${gs.address().port}`;
const O = cfg.publicOrigin;

const wallet = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: "50000000", dailyCapSompi: "50000000",
  allowedPayTo: [cfg.payTo], fetch: createDevLoopbackFetch({ [O]: local }) });

const log = (...a) => console.log(...a);
log("== MOCK CHAIN LAYER: no Kaspa node, no keys, no funds. Network pinned to kaspa:testnet-10 ==\n");
const raw = await fetch(`${local}/weather/brisbane`); log(`raw GET /weather/brisbane -> ${raw.status}, PAYMENT-REQUIRED header present: ${!!raw.headers.get("payment-required")}`);
const steps = [
  ["GET", "/health"], ["GET", "/weather/brisbane"], ["POST", "/summarize", "Kaspa is a proof of work blockDAG running at ten blocks per second with fast confirmation"],
  ["GET", "/premium/dataset"], ["GET", "/weather/sydney"], ["GET", "/weather/perth"],
];
for (const [method, path, body] of steps) {
  try { const r = await wallet.fetch(O + path, { method, body });
    log(`${method} ${path} -> ${r.response.status} paid=${!!r.payment} ${JSON.stringify(await r.response.json())}`); }
  catch (e) { log(`${method} ${path} -> BLOCKED by wallet [${e.code ?? "error"}]: ${e.message}`); }
}
try { await wallet.fetch("https://evil.example/steal"); } catch (e) { log(`GET https://evil.example/steal -> BLOCKED [${e.code}]: ${e.message}`); }
const s = gw.ledger.summary(); const w = wallet.report();
log(`\nSeller dashboard: ${s.paidRequests} paid, ${s.challenges} challenges, revenue ${s.revenueKas} KAS`, JSON.stringify(s.byRoute));
log(`Agent wallet: spent today ${sompiToKas(w.spentTodaySompi)} / cap ${sompiToKas(w.dailyCapSompi)} KAS; denials: ${w.denials.map((d) => d.denied).join(", ") || "none"}`);
const dash = await fetch(`${local}${cfg.dashboard.path}`, { headers: { authorization: `Bearer ${cfg.dashboard.token}` } }); log(`dashboard HTML -> ${dash.status} (${(await dash.text()).length} bytes)`);
gs.close(); up.close();
