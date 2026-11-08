/**
 * Cloudflare Worker: CORS proxy for the PVGIS 5.3 API.
 *
 * PVGIS sends no Access-Control-Allow-Origin header, so browsers block direct
 * calls from a static site. This worker forwards GET requests for the four
 * endpoints the app uses and adds the CORS header. It is NOT an open proxy:
 * only the whitelisted PVGIS endpoints are reachable, and only from the
 * origins listed in ALLOWED_ORIGINS (wrangler.toml).
 *
 *   https://<worker>.workers.dev/PVcalc?lat=..&lon=..       ->  PVGIS PVcalc
 *   https://<worker>.workers.dev/DRcalc?lat=..&lon=..       ->  PVGIS DRcalc
 *   https://<worker>.workers.dev/printhorizon?lat=..&lon=.. ->  PVGIS printhorizon
 *   https://<worker>.workers.dev/seriescalc?...             ->  PVGIS seriescalc,
 *       single year only (startyear == endyear, ~0.8 MB), for the power planner
 *
 * Responses are cached at the Cloudflare edge, because PVGIS results for the
 * same parameters never change.
 */

const PVGIS_BASE = "https://re.jrc.ec.europa.eu/api/v5_3/";
const ENDPOINTS = new Set(["PVcalc", "DRcalc", "printhorizon", "seriescalc"]);
const CACHE_TTL_S = 30 * 24 * 3600;

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
  if (allowed.includes("*")) return { "Access-Control-Allow-Origin": "*" };
  if (origin && allowed.includes(origin)) {
    return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);
    if (!cors) return new Response("Origin not allowed", { status: 403 });

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" },
      });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    const url = new URL(request.url);
    const endpoint = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!ENDPOINTS.has(endpoint)) {
      return new Response("Unknown endpoint", { status: 404, headers: cors });
    }

    if (endpoint === "seriescalc") {
      const sy = url.searchParams.get("startyear");
      if (!sy || sy !== url.searchParams.get("endyear")) {
        return new Response("seriescalc: startyear and endyear must be the same single year",
                            { status: 400, headers: cors });
      }
    }

    const upstream = PVGIS_BASE + endpoint + url.search;
    const cache = caches.default;
    const cacheKey = new Request(upstream);

    let resp = await cache.match(cacheKey);
    if (!resp) {
      const r = await fetch(upstream, { headers: { "User-Agent": "pv-production-webapp-proxy/1.0" } });
      resp = new Response(r.body, {
        status: r.status,
        headers: { "Content-Type": r.headers.get("Content-Type") || "application/json" },
      });
      if (r.ok) {
        resp.headers.set("Cache-Control", `public, max-age=${CACHE_TTL_S}`);
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      }
    }

    const out = new Response(resp.body, resp);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
