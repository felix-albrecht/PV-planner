// Security and behaviour tests for the Cloudflare Worker (github-pages/worker/worker.js).
// Runs with Node's built-in test runner:   node --test tests/
// Cloudflare's `caches` and upstream `fetch` are replaced with in-memory fakes.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../github-pages/worker/worker.js";

const PVGIS = "https://re.jrc.ec.europa.eu/api/v5_3/";
const ALLOWED = "https://felix-albrecht.github.io";
const env = { ALLOWED_ORIGINS: `${ALLOWED},http://localhost:8000` };

let upstreamCalls, upstreamStatus, cache, waits;
beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  cache = new Map();
  waits = [];
  globalThis.caches = {
    default: {
      match: async req => cache.get(req.url)?.clone(),
      put: async (req, resp) => { cache.set(req.url, resp); },
    },
  };
  globalThis.fetch = async url => {
    upstreamCalls.push(String(url));
    return new Response(JSON.stringify({ ok: upstreamStatus === 200 }), {
      status: upstreamStatus, headers: { "Content-Type": "application/json", "Set-Cookie": "jrc=secret" },
    });
  };
});

const ctx = { waitUntil: p => waits.push(p) };
async function call(path, { origin = ALLOWED, method = "GET", envOverride } = {}) {
  const headers = origin ? { Origin: origin } : {};
  const resp = await worker.fetch(new Request("https://proxy.example" + path, { method, headers }), envOverride ?? env, ctx);
  await Promise.all(waits);
  return resp;
}

test("forwards whitelisted endpoints to PVGIS with CORS header", async () => {
  for (const ep of ["PVcalc", "DRcalc", "printhorizon"]) {
    const r = await call(`/${ep}?lat=48.08&lon=11.41`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), ALLOWED);
  }
  assert.deepEqual(upstreamCalls, [
    `${PVGIS}PVcalc?lat=48.08&lon=11.41`,
    `${PVGIS}DRcalc?lat=48.08&lon=11.41`,
    `${PVGIS}printhorizon?lat=48.08&lon=11.41`,
  ]);
});

test("rejects other origins and requests without Origin", async () => {
  assert.equal((await call("/PVcalc?lat=1", { origin: "https://evil.example" })).status, 403);
  assert.equal((await call("/PVcalc?lat=1", { origin: "https://felix-albrecht.github.io.evil.example" })).status, 403);
  assert.equal((await call("/PVcalc?lat=1", { origin: null })).status, 403);
  assert.equal(upstreamCalls.length, 0);
});

test("rejects endpoints that are not whitelisted", async () => {
  for (const path of ["/", "/tmy", "/pvcalc", "/PVcalc/extra", "/api/v5_3/PVcalc", "/..%2fPVcalc"]) {
    assert.equal((await call(path + "?lat=1")).status, 404, path);
  }
  assert.equal(upstreamCalls.length, 0);
});

test("seriescalc is limited to a single year", async () => {
  const ok = await call("/seriescalc?lat=1&startyear=2023&endyear=2023");
  assert.equal(ok.status, 200);
  for (const q of ["", "?startyear=2005&endyear=2023", "?startyear=2023", "?endyear=2023", "?startyear=&endyear="]) {
    assert.equal((await call("/seriescalc" + q)).status, 400, q);
  }
  assert.equal(upstreamCalls.length, 1);
});

test("query string cannot change the upstream host or path", async () => {
  const tricky = [
    "/PVcalc?x=@evil.example/",
    "/PVcalc?url=https://evil.example",
    "/PVcalc/../PVcalc?lat=1",            // URL normalises this to /PVcalc
    "/PVcalc?%0d%0aHost:%20evil.example",
  ];
  for (const path of tricky) await call(path);
  for (const u of upstreamCalls) {
    const parsed = new URL(u);
    assert.equal(parsed.origin + parsed.pathname, `${PVGIS}PVcalc`, u);
  }
});

test("only GET and OPTIONS are allowed", async () => {
  const pre = await call("/PVcalc", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Methods"), "GET");
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.equal((await call("/PVcalc?lat=1", { method })).status, 405, method);
  }
  assert.equal(upstreamCalls.length, 0);
});

test("does not pass PVGIS cookies to the browser", async () => {
  const r = await call("/PVcalc?lat=1");
  assert.equal(r.headers.get("Set-Cookie"), null);
});

test("caches successful responses at the edge", async () => {
  const a = await call("/PVcalc?lat=1");
  const b = await call("/PVcalc?lat=1");
  assert.equal(upstreamCalls.length, 1);
  assert.deepEqual(await b.json(), await a.json());
  assert.match(b.headers.get("Cache-Control"), /max-age=\d+/);
  assert.equal(b.headers.get("Access-Control-Allow-Origin"), ALLOWED);
});

test("does not cache PVGIS errors", async () => {
  upstreamStatus = 400;
  assert.equal((await call("/PVcalc?lat=999")).status, 400);
  assert.equal((await call("/PVcalc?lat=999")).status, 400);
  assert.equal(upstreamCalls.length, 2);
});

test("ALLOWED_ORIGINS='*' allows any origin", async () => {
  const r = await call("/PVcalc?lat=1", { origin: "https://anything.example", envOverride: { ALLOWED_ORIGINS: "*" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
});
