// Runs the browser calculation engine from github-pages/index.html in Node.
//
//   node tests/run_engine.mjs            -> PVGIS answered from tests/fixtures/pvgis.json
//   node tests/run_engine.mjs --live     -> PVGIS called directly (no CORS in Node)
//
// Prints {caseName: result} for every case in tests/cases.json as JSON.
// Used by test_app.py to check that the JS port matches the Flask app.

import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const live = process.argv.includes("--live");
const PVGIS_BASE = "https://re.jrc.ec.europa.eu/api/v5_3/";

// --- extract the engine <script> (the one defining calculate) ---
const html = readFileSync(new URL("github-pages/index.html", root), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const engine = scripts.find(s => s.includes("async function calculate("));
if (!engine) throw new Error("calculation engine not found in github-pages/index.html");

// --- same request key as tests/pvgis_mock.py ---
const norm = v => (/^-?\d+(\.\d+)?$/.test(v) ? String(Number(v)) : v);
function requestKey(url) {
  const u = new URL(url);
  const endpoint = u.pathname.replace(/\/+$/, "").split("/").pop();
  const items = [...u.searchParams].filter(([k]) => k !== "outputformat")
    .map(([k, v]) => [k, norm(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return endpoint + "?" + items.map(([k, v]) => `${k}=${v}`).join("&");
}

const fixtures = live ? null : JSON.parse(readFileSync(new URL("tests/fixtures/pvgis.json", root), "utf8"));

async function fakeFetch(url) {
  const u = new URL(url);
  if (u.hostname.includes("nominatim")) throw new Error("geocoding is not tested");
  const endpoint = u.pathname.replace(/\/+$/, "").split("/").pop();
  if (live) return fetch(PVGIS_BASE + endpoint + u.search);  // bypass the proxy
  const key = requestKey(url);
  if (!(key in fixtures)) throw new Error(`no recorded PVGIS response for ${key}`);
  return new Response(JSON.stringify(fixtures[key]), { status: 200 });
}

const ctx = vm.createContext({ fetch: fakeFetch, URL, URLSearchParams, console });
vm.runInContext(engine, ctx, { filename: "github-pages/index.html#engine" });

const cases = JSON.parse(readFileSync(new URL("tests/cases.json", root), "utf8"));
const out = {};
for (const [name, body] of Object.entries(cases)) out[name] = await ctx.calculate(body);
process.stdout.write(JSON.stringify(out));
