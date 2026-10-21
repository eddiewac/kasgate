// Real upstream: proxies the free Open-Meteo APIs (https://open-meteo.com, no key; CC BY 4.0).
//   GET /weather/:city -> current temperature, conditions, wind, source, timestamp
//   GET /health
// Knows nothing about payments; sits behind the x402 gateway.
import http from "node:http";
import { fileURLToPath } from "node:url";
const GEO = "https://geocoding-api.open-meteo.com/v1/search", FC = "https://api.open-meteo.com/v1/forecast";
// WMO weather interpretation codes (Open-Meteo docs).
const WMO = { 0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle", 56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain", 66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains", 80: "Slight rain showers", 81: "Moderate rain showers",
  82: "Violent rain showers", 85: "Slight snow showers", 86: "Heavy snow showers", 95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail" };
const getJson = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`); return r.json(); };
export async function lookupWeather(city) {
  const g = await getJson(`${GEO}?${new URLSearchParams({ name: city, count: "1", language: "en", format: "json" })}`);
  const place = g.results?.[0]; if (!place) return null;
  const q = new URLSearchParams({ latitude: String(place.latitude), longitude: String(place.longitude), timezone: "auto",
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m" });
  const f = await getJson(`${FC}?${q}`); const c = f.current;
  return { city: place.name, region: place.admin1, country: place.country, latitude: place.latitude, longitude: place.longitude,
    current: { time: c.time, timezone: f.timezone, temperatureC: c.temperature_2m, apparentTemperatureC: c.apparent_temperature,
      humidityPct: c.relative_humidity_2m, weatherCode: c.weather_code, conditions: WMO[c.weather_code] ?? `WMO code ${c.weather_code}`,
      windSpeedKmh: c.wind_speed_10m, windDirectionDeg: c.wind_direction_10m, windGustsKmh: c.wind_gusts_10m },
    source: { name: "Open-Meteo", url: "https://open-meteo.com", license: "CC BY 4.0", forecastUrl: `${FC}?${q}` },
    fetchedAt: new Date().toISOString() };
}
export function createWeatherUpstream() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"); const j = (s, b) => { res.writeHead(s, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(b)); };
    try {
      if (u.pathname === "/health") return j(200, { ok: true, source: "open-meteo" });
      const m = u.pathname.match(/^\/weather\/([^/]{1,80})$/);
      if (m && req.method === "GET") { const t0 = Date.now(); const w = await lookupWeather(decodeURIComponent(m[1]));
        console.log(`${new Date().toISOString()} GET ${u.pathname} -> ${w ? 200 : 404} in ${Date.now() - t0}ms`); return w ? j(200, w) : j(404, { error: "city not found" }); }
      j(404, { error: "not found" });
    } catch (e) { j(502, { error: "upstream weather source failed", detail: String(e.message ?? e).slice(0, 200) }); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8501);
  createWeatherUpstream().listen(port, "127.0.0.1", () => console.log(`open-meteo weather upstream on http://127.0.0.1:${port}`));
}
