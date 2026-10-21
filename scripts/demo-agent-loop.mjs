// Visual demo: an agent wallet calling paid routes slowly through the running gateway (MOCK chain, TN10 config).
// Includes blocked calls: over per-request cap, non-allowlisted host, and finally the daily cap.
// Usage: node scripts/demo-agent-loop.mjs [--gateway http://127.0.0.1:8402] [--interval 3000]
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.mjs";
import { AgentWallet, createDevLoopbackFetch } from "../src/agent-wallet.mjs";
import { sompiToKas } from "../src/ledger.mjs";
const { values: a } = parseArgs({ options: { gateway: { type: "string", default: "http://127.0.0.1:8402" }, interval: { type: "string", default: "3000" } } });
const cfg = loadConfig(new URL("../config/routes.yaml", import.meta.url).pathname), O = cfg.publicOrigin;
const PER_REQ = "30000000", DAILY = "150000000"; // 0.3 KAS per request, 1.5 KAS per day
const wallet = new AgentWallet({ allowedOrigins: [O], perRequestMaxSompi: PER_REQ, dailyCapSompi: DAILY, allowedPayTo: [cfg.payTo],
  fetch: createDevLoopbackFetch({ [O]: a.gateway }) });
const cities = ["brisbane", "sydney", "melbourne", "perth", "adelaide", "hobart", "darwin", "cairns", "canberra", "townsville"];
const calls = [];
for (let i = 0; i < 20; i++) {
  if (i === 4) calls.push(["GET", `${O}/premium/dataset`, null, "over per-request cap (2 KAS > 0.3 KAS)"]);
  else if (i === 8) calls.push(["GET", "https://evil.example/steal", null, "host not allowlisted"]);
  else if (i % 5 === 2) calls.push(["POST", `${O}/summarize`, "Kaspa is a proof-of-work blockDAG at ten blocks per second.", null]);
  else calls.push(["GET", `${O}/weather/${cities[i % cities.length]}`, null, null]);
}
const t = () => new Date().toLocaleTimeString("en-AU", { timeZone: "Australia/Brisbane", hour12: false });
console.log(`== Agent demo loop · MOCK chain (no real funds) · gateway ${a.gateway} · caps: ${sompiToKas(PER_REQ)} KAS/request, ${sompiToKas(DAILY)} KAS/day ==`);
let n = 0, prev = 0n; const blocked = {};
for (const [method, url, body, expect] of calls) {
  n++; const label = `[${t()} AEST] #${String(n).padStart(2)} ${method} ${url.replace(O, "")}`;
  try {
    const r = await wallet.fetch(url, { method, body, headers: body ? { "content-type": "text/plain" } : undefined });
    const spent = BigInt(wallet.report().spentTodaySompi); const paid = r.payment ? `PAID ${sompiToKas((spent - prev).toString())} KAS` : "free"; prev = spent;
    console.log(`${label} -> ${r.response.status} ${paid} · spent today ${sompiToKas(wallet.report().spentTodaySompi)} KAS`);
  } catch (e) {
    blocked[e.code ?? "error"] = (blocked[e.code ?? "error"] ?? 0) + 1;
    console.log(`${label} -> BLOCKED by wallet [${e.code ?? "error"}] ${e.message}${expect ? `  (expected: ${expect})` : ""}`);
  }
  if (n < calls.length) await new Promise((r) => setTimeout(r, Number(a.interval)));
}
const w = wallet.report();
console.log(`== done: spent ${sompiToKas(w.spentTodaySompi)} / ${sompiToKas(w.dailyCapSompi)} KAS; blocked: ${JSON.stringify(blocked)} ==`);
