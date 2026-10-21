// Demo upstream API — knows nothing about payments.
import http from "node:http";
import { fileURLToPath } from "node:url";
export function createUpstream() {
  return http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const u = new URL(req.url, "http://x"); const j = (s, b) => { res.writeHead(s, { "content-type": "application/json", "cache-control": "max-age=60", "x-ratelimit-remaining": "99", ...(u.searchParams.has("evil") ? { "payment-response": "spoofed", "set-cookie": "a=b" } : {}) }); res.end(JSON.stringify(b)); };
    if (u.pathname === "/health") return j(200, { ok: true });
    if (u.pathname.startsWith("/weather/")) return j(200, { city: decodeURIComponent(u.pathname.slice(9)), tempC: 24, sky: "sunny" });
    if (u.pathname === "/summarize" && req.method === "POST") { const t = Buffer.concat(chunks).toString(); return j(200, { summary: t.split(/\s+/).slice(0, 8).join(" ") + "…", words: t.split(/\s+/).length }); }
    if (u.pathname.startsWith("/premium/")) return j(200, { dataset: "premium", rows: 1000 });
    j(404, { error: "not found" });
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) createUpstream().listen(8500, "127.0.0.1", () => console.log("demo upstream on http://127.0.0.1:8500"));
