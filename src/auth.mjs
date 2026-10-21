// Dashboard login: scrypt password hash from env (X402_DASHBOARD_PASSWORD_HASH), random session ids,
// HttpOnly + SameSite=Strict cookie, sessions stored hashed (SQLite when available), per-IP login throttle.
import { scryptSync, scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
const scryptAsync = promisify(scrypt);

const N = 16384, r = 8, p = 1, KEYLEN = 32;
/** Format: scrypt$N$r$p$saltHex$hashHex */
export function hashPassword(password, salt = randomBytes(16)) {
  if (!password || password.length < 12) throw new Error("password must be at least 12 characters");
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${scryptSync(password, salt, KEYLEN, { N, r, p }).toString("hex")}`;
}
/** L3: async variant used on the request path (doesn't block the event loop). */
export async function verifyPasswordAsync(password, encoded) {
  const parts = String(encoded ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, rr, pp, saltHex, hashHex] = parts; const want = Buffer.from(hashHex, "hex");
  if (!want.length) return false;
  const got = await scryptAsync(String(password ?? ""), Buffer.from(saltHex, "hex"), want.length, { N: +n, r: +rr, p: +pp, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(got, want);
}
export function verifyPassword(password, encoded) {
  const parts = String(encoded ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, rr, pp, saltHex, hashHex] = parts; const want = Buffer.from(hashHex, "hex");
  const got = scryptSync(String(password ?? ""), Buffer.from(saltHex, "hex"), want.length, { N: +n, r: +rr, p: +pp });
  return want.length > 0 && timingSafeEqual(got, want);
}
const sha = (s) => createHash("sha256").update(s).digest("hex");
// L5: malformed cookie values are ignored instead of throwing.
export const parseCookies = (h = "") => Object.fromEntries(String(h).split(/;\s*/).filter((c) => c.includes("=")).map((c) => { const i = c.indexOf("=");
  let v = c.slice(i + 1); try { v = decodeURIComponent(v); } catch { v = ""; } return [c.slice(0, i).trim(), v]; }));

export function createSessionManager({ passwordHash, db = null, ttlMs = 12 * 3600_000, cookieName = "x402_session", secureCookie = true, now = Date.now, cookiePath = "/_x402", maxTracked = 10_000, globalMaxFailsPerMin = 50 } = {}) {
  const mem = new Map(); const fails = new Map(); const goodIps = new Map(); let global = { n: 0, windowStart: now(), until: 0 };
  const put = (h, exp) => db ? db.prepare("INSERT OR REPLACE INTO sessions (id_hash, expires_at) VALUES (?, ?)").run(h, exp) : mem.set(h, exp);
  const get = (h) => db ? db.prepare("SELECT expires_at e FROM sessions WHERE id_hash = ?").get(h)?.e : mem.get(h);
  const del = (h) => db ? db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(h) : mem.delete(h);
  const cookie = (v, maxAge) => `${cookieName}=${v}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? "; Secure" : ""}`;
  return {
    enabled: Boolean(passwordHash),
    async login(password, ip) {
      // L3: per-IP throttle (bounded LRU) + a global throttle so a shared proxy IP can't be the only control.
      if (now() - global.windowStart > 60_000) global = { n: 0, windowStart: now(), until: global.until };
      // N-L6: the global lockout no longer locks out the operator: IPs that logged in successfully in the last
      // 30 days are exempt (they keep the per-IP limit); existing sessions were never affected.
      const trusted = (goodIps.get(ip) ?? 0) > now() - 30 * 86_400_000;
      if (global.until > now() && !trusted) return { ok: false, status: 429, error: "too many attempts; try later" };
      const f = fails.get(ip) ?? { n: 0, until: 0 };
      if (f.until > now()) return { ok: false, status: 429, error: "too many attempts; try later" };
      if (!(await verifyPasswordAsync(password, passwordHash))) {
        f.n++; if (f.n >= 5) { f.until = now() + 60_000; f.n = 0; }
        fails.delete(ip); fails.set(ip, f); while (fails.size > maxTracked) fails.delete(fails.keys().next().value);
        if (++global.n >= globalMaxFailsPerMin) global.until = now() + 60_000;
        return { ok: false, status: 401, error: "invalid password" };
      }
      fails.delete(ip); goodIps.delete(ip); goodIps.set(ip, now()); while (goodIps.size > 1000) goodIps.delete(goodIps.keys().next().value);
      const id = randomBytes(32).toString("base64url"); put(sha(id), now() + ttlMs);
      return { ok: true, setCookie: cookie(id, Math.floor(ttlMs / 1000)) };
    },
    check(req) { const id = parseCookies(req.headers.cookie)[cookieName]; if (!id) return false;
      const e = get(sha(id)); if (!e) return false; if (e < now()) { del(sha(id)); return false; } return true; },
    logout(req) { const id = parseCookies(req.headers.cookie)[cookieName]; if (id) del(sha(id)); return cookie("", 0); },
  };
}
