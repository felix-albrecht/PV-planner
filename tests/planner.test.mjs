// Tests for the power planner core (github-pages/planner-core.js).
// Run with: node --test tests/planner.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "../github-pages/planner-core.js";

const close = (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), msg ?? `${a} != ${b}`);
const sum = a => a.reduce((x, y) => x + y, 0);
const TZ_DE = P.timeZone(48.1, 11.4);

// Synthetic PV: clear-sky-like bell between 6 and 18 UTC, peakKw at noon.
function synthPv(peakKw) {
  const a = new Float64Array(P.STEPS);
  for (let q = 0; q < P.STEPS; q++) {
    const h = (q % 96) / 4;
    if (h > 6 && h < 18) a[q] = peakKw * Math.sin(Math.PI * (h - 6) / 12) * P.DT;
  }
  return a;
}
const flat = (ct) => new Float64Array(P.STEPS).fill(ct / 100);

/* ---------------------------------------------------------------- time */

test("year layout has 365 days of 15-minute steps", () => {
  assert.equal(P.STEPS, 35040);
  assert.equal(P.STEP_MONTH[0], 0);
  assert.equal(P.STEP_MONTH[P.STEPS - 1], 11);
  assert.equal(P.dayOfYear(2, 29), null);
  assert.equal(P.dayOfYear(12, 31), 364);
});

test("local time: CET in winter, CEST in summer, solar offset elsewhere", () => {
  const q = (month, day, hour) => P.dayOfYear(month, day) * 96 + hour * 4;
  assert.equal(P.utcOffsetHours(q(1, 15, 12), TZ_DE), 1);
  assert.equal(P.utcOffsetHours(q(7, 15, 12), TZ_DE), 2);
  assert.equal(P.utcOffsetHours(q(3, 30, 0), TZ_DE), 1);   // 2025-03-30 00:00 UTC, before the switch
  assert.equal(P.utcOffsetHours(q(3, 30, 1), TZ_DE), 2);   // 01:00 UTC
  assert.equal(P.utcOffsetHours(q(10, 26, 1), TZ_DE), 1);  // back to CET on 2025-10-26 01:00 UTC
  const tokyo = P.timeZone(35.7, 139.7);
  assert.equal(P.utcOffsetHours(q(7, 15, 12), tokyo), 9);  // no EU summer time outside Europe
});

test("localToUtc shifts a local 18:00 event to 16:00 UTC in summer", () => {
  const local = new Float64Array(P.STEPS);
  const l = P.dayOfYear(7, 1) * 96 + 18 * 4;
  local[l] = 1;
  const utc = P.localToUtc(local, TZ_DE);
  assert.equal(utc[P.dayOfYear(7, 1) * 96 + 16 * 4], 1);
  close(sum(utc), 1);
});

/* -------------------------------------------------------------- demand */

test("constant demand adds up to the annual consumption", () => {
  close(sum(P.constantDemand(3500)), 3500);
});

test("schedule demand adds up to the annual consumption", () => {
  for (const [w, h] of [[5, 0], [3, 2], [0, 0], [0, 5]]) {
    close(sum(P.scheduleDemandLocal({ annualKwh: 2900, workDays: w, homeofficeDays: h })), 2900);
  }
});

test("week plan: work days first, then home office, rest family", () => {
  assert.deepEqual(P.weekPlan(3, 2), ["work", "work", "work", "homeoffice", "homeoffice", "family", "family"]);
  assert.deepEqual(P.weekPlan(0, 0), Array(7).fill("family"));
  assert.deepEqual(P.weekPlan(9, 9), Array(7).fill("work"));  // clamped
  assert.deepEqual(P.weekPlan(6, 3), [...Array(6).fill("work"), "homeoffice"]);
});

test("work days use less energy at midday than family days", () => {
  const d = P.scheduleDemandLocal({ annualKwh: 3500, workDays: 5, homeofficeDays: 0, seasonal: 0 });
  // 2025-01-06 is a Monday (work), 2025-01-11 a Saturday (family)
  const noon = day => sum(d.slice(day * 96 + 44, day * 96 + 56));
  assert.ok(noon(P.dayOfYear(1, 11)) > 2 * noon(P.dayOfYear(1, 6)));
});

test("winter demand is higher than summer demand", () => {
  const d = P.scheduleDemandLocal({ annualKwh: 3500, workDays: 3, homeofficeDays: 2 });
  const jan = sum(d.slice(0, 31 * 96)), jul = sum(d.slice(P.dayOfYear(7, 1) * 96, P.dayOfYear(8, 1) * 96));
  assert.ok(jan > 1.2 * jul);
});

/* ----------------------------------------------------------------- CSV */

const hourlyCsv = (fmt, sep = ",", dec = ".") => {
  let s = `timestamp${sep}kwh\n`;
  for (let d = 0; d < 365; d++) {
    const date = new Date(Date.UTC(2024, 0, 1) + d * 86400000);  // other year on purpose
    for (let h = 0; h < 24; h++) {
      const v = (0.1 + h / 100).toFixed(3).replace(".", dec);
      s += `${fmt(date, h)}${sep}${v}\n`;
    }
  }
  return s;
};
const iso = (d, h) => `${d.toISOString().slice(0, 10)} ${String(h).padStart(2, "0")}:00`;
const german = (d, h) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()} ${String(h).padStart(2, "0")}:00`;

test("CSV: hourly ISO timestamps, energy split over quarters", () => {
  const parsed = P.parseTimeSeriesCsv(hourlyCsv(iso));
  assert.equal(parsed.intervalMin, 60);
  const { values, coverage } = P.toLocalSteps(parsed, "energy");
  assert.ok(coverage > 0.99);
  close(values[0] * 4, 0.1);                 // 00:00 row split over 4 quarters
  close(values[13 * 4 + 2] * 4, 0.23);       // 13:30 belongs to the 13:00 row
});

test("CSV: German smart-meter format (semicolon, dd.mm.yyyy, decimal comma)", () => {
  const a = P.toLocalSteps(P.parseTimeSeriesCsv(hourlyCsv(iso)), "energy").values;
  const b = P.toLocalSteps(P.parseTimeSeriesCsv(hourlyCsv(german, ";", ",")), "energy").values;
  close(sum(a), sum(b));
  close(a[5000], b[5000]);
});

test("CSV: semicolon with decimal point is not mangled", () => {
  const parsed = P.parseTimeSeriesCsv(hourlyCsv(iso, ";", "."));
  close(parsed.points[1].value, 0.11);
});

test("CSV: 15-minute data and rate values", () => {
  let s = "time,price\n";
  for (let q = 0; q < P.STEPS; q++) {
    const t = new Date(Date.UTC(2025, 0, 1) + q * 900000).toISOString().slice(0, 16).replace("T", " ");
    s += `${t},${q % 96 < 48 ? 20 : 40}\n`;
  }
  const parsed = P.parseTimeSeriesCsv(s);
  assert.equal(parsed.intervalMin, 15);
  const { values } = P.toLocalSteps(parsed, "rate");
  assert.equal(values[10], 20);
  assert.equal(values[60], 40);
});

test("CSV: rejects too-short or partial files", () => {
  assert.throws(() => P.parseTimeSeriesCsv("a,b\n1,2\n"), /fewer than 24 rows/);
  let half = "";
  for (let d = 0; d < 150; d++) for (let h = 0; h < 24; h++) half += `${iso(new Date(Date.UTC(2025, 0, 1 + d)), h)},1\n`;
  assert.throws(() => P.toLocalSteps(P.parseTimeSeriesCsv(half), "energy"), /covers only/);
});

test("CSV round trip: example file reproduces the schedule profile", () => {
  const local = P.scheduleDemandLocal({ annualKwh: 3000, workDays: 5, homeofficeDays: 0 });
  const back = P.toLocalSteps(P.parseTimeSeriesCsv(P.seriesToCsv(local, "timestamp,kwh")), "energy").values;
  close(sum(back), 3000, 1e-3);
  close(sum(back.slice(96 * 10, 96 * 11)), sum(local.slice(96 * 10, 96 * 11)), 1e-3);
});

/* -------------------------------------------------------------- prices */

const priceData = JSON.parse(readFileSync(new URL("../github-pages/data/prices_DE-LU_2025.json", import.meta.url)));

test("bundled 2025 price data is complete and plausible", () => {
  const spot = P.spotFromData(priceData);
  assert.equal(spot.length, P.STEPS);
  assert.ok(spot.every(Number.isFinite));
  const mean = sum(spot) / spot.length;
  assert.ok(mean > 40 && mean < 200, `mean ${mean} EUR/MWh`);
  assert.ok(spot.some(v => v < 0), "2025 had negative prices");
});

test("dynamic price = (spot + fees) * (1 + VAT)", () => {
  const spot = new Float64Array(P.STEPS).fill(100);  // 100 EUR/MWh = 10 ct/kWh
  const buy = P.buyPrices({ type: "dynamic", feesCt: 18, vatPct: 19 }, { spot, tz: TZ_DE });
  close(buy[0], 0.3332);
});

test("spot feed-in pays nothing at negative prices", () => {
  const spot = new Float64Array(P.STEPS).fill(-50);
  spot[0] = 80;
  const sell = P.sellPrices({ type: "spot" }, { spot });
  close(sell[0], 0.08);
  assert.equal(sell[1], 0);
});

test("custom daily curve follows local time", () => {
  const curve = Array.from({ length: 24 }, (_, h) => (h === 18 ? 50 : 30)).join(",");
  const buy = P.buyPrices({ type: "custom", localCt: P.dailyCurveLocal(curve) }, { spot: null, tz: TZ_DE });
  const day = P.dayOfYear(7, 1) * 96;
  close(buy[day + 16 * 4], 0.5);  // 18:00 CEST = 16:00 UTC
  close(buy[day + 18 * 4], 0.3);
  assert.throws(() => P.dailyCurveLocal("1,2,3"), /24 numbers/);
});

/* ------------------------------------------------------------------ PV */

test("seriescalc hourly power maps to kWh per quarter, Feb 29 dropped", () => {
  const hourly = [
    { time: "20200101:0010", P: 400 },
    { time: "20200229:1210", P: 999 },
    { time: "20200301:1210", P: 1000 },
  ];
  const pv = P.pvFromSeriescalc({ outputs: { hourly } });
  close(pv[0], 0.1);
  close(pv[3], 0.1);
  close(pv[P.dayOfYear(3, 1) * 96 + 48], 0.25);
  close(sum(pv), 0.4 + 1.0);
});

/* ---------------------------------------------------------- simulation */

const base = (opts = {}) => ({
  pv: [synthPv(3), synthPv(1)],
  demand: P.constantDemand(3500),
  buy: flat(35), sell: flat(8),
  ...opts,
});

test("energy balance holds with and without batteries", () => {
  for (const batteries of [[], [{ capacityKwh: 5, powerKw: 2.5, efficiencyPct: 90, sections: [0, 1] }],
    [{ capacityKwh: 5, powerKw: 2.5, efficiencyPct: 90, sections: [0] }, { capacityKwh: 2, powerKw: 0.8, efficiencyPct: 85, sections: [1] }]]) {
    const r = P.simulate(base({ batteries, feedInLimitKw: 1.5 }));
    const t = r.totals;
    close(t.demand, t.direct + t.discharged + t.imported, 1e-9, "demand side");
    close(t.pv, t.direct + t.charged + t.exported + t.curtailed, 1e-9, "PV side");
    const lost = r.perBattery.reduce((a, b) => a + b.losses, 0);
    assert.ok(lost >= -1e-9);
    close(t.costWithPv, t.importCost - t.revenue);
    close(t.savings, t.costNoPv - t.costWithPv);
  }
});

test("no battery: autarky equals the directly used share", () => {
  const t = P.simulate(base()).totals;
  close(t.autarky, t.direct / t.demand);
  assert.equal(t.charged, 0);
});

test("battery raises autarky and savings; more capacity helps less and less", () => {
  const a = n => P.simulate(base({ batteries: n ? [{ capacityKwh: n, powerKw: 5, efficiencyPct: 90, sections: [0, 1] }] : [] })).totals;
  const [a0, a5, a10, a20] = [a(0), a(5), a(10), a(20)];
  assert.ok(a5.autarky > a0.autarky && a10.autarky > a5.autarky);
  assert.ok(a10.autarky - a5.autarky < a5.autarky - a0.autarky);
  assert.ok(a20.autarky - a10.autarky <= a10.autarky - a5.autarky + 1e-9);
  assert.ok(a5.savings > a0.savings);
});

test("battery charges only from its own sections", () => {
  // section 1 produces nothing; a battery on it never charges
  const r = P.simulate(base({
    pv: [synthPv(3), new Float64Array(P.STEPS)],
    batteries: [{ capacityKwh: 5, powerKw: 2.5, efficiencyPct: 90, sections: [1] }],
  }));
  assert.equal(r.perBattery[0].charged, 0);
  assert.ok(r.totals.exported > 0);
});

test("battery respects capacity and power limits", () => {
  const r = P.simulate(base({
    pv: [synthPv(8)],
    batteries: [{ capacityKwh: 3, powerKw: 0.8, efficiencyPct: 100, sections: [0] }],
    keepSeries: true,
  }));
  const eps = 1e-6;  // series are stored as float32
  assert.ok(Math.max(...r.series.soc) <= 3 + eps);
  assert.ok(Math.min(...r.series.soc) >= -eps);
  // never more than 0.8 kW * 0.25 h per step in or out
  for (let q = 1; q < P.STEPS; q++) assert.ok(Math.abs(r.series.soc[q] - r.series.soc[q - 1]) <= 0.2 + eps);
});

test("round-trip efficiency loses the expected share", () => {
  const r = P.simulate(base({ batteries: [{ capacityKwh: 5, powerKw: 5, efficiencyPct: 81, sections: [0, 1] }] }));
  const b = r.perBattery[0];
  // discharged ≈ 0.81 * charged (minus what is still stored at the end)
  close(b.discharged / b.charged, 0.81, 0.01);
});

test("feed-in limit curtails exports above the cap", () => {
  const r = P.simulate(base({ pv: [synthPv(8)], feedInLimitKw: 2, keepSeries: true }));
  assert.ok(r.totals.curtailed > 0);
  assert.ok(Math.max(...r.series.exported) <= 2 * P.DT + 1e-9);
});

test("monthly results add up to the annual totals", () => {
  const r = P.simulate(base({ batteries: [{ capacityKwh: 5, powerKw: 2.5, efficiencyPct: 90, sections: [0] }] }));
  for (const k of ["demand", "pv", "imported", "exported", "savings"]) {
    close(sum(r.monthly.map(m => m[k])), r.totals[k], 1e-9, k);
  }
});

test("battery usage metrics are consistent", () => {
  const r = P.simulate(base({ batteries: [{ capacityKwh: 5, powerKw: 2.5, efficiencyPct: 90, sections: [0, 1] }], keepSeries: true }));
  const b = r.perBattery[0];
  assert.equal(b.dailyPeak.length, P.DAYS);
  assert.ok(b.dailyPeak.every(v => v >= 0 && v <= 1 + 1e-6));
  assert.ok(b.meanCharge <= b.typicalDailyPeak + 1e-9 && b.typicalDailyPeak <= b.maxCharge + 1e-9);
  close(b.maxCharge, Math.max(...r.series.soc) / 5, 1e-5);
  close(b.meanCharge, sum(r.series.soc) / P.STEPS / 5, 1e-5);
  assert.ok(b.daysFull >= 0 && b.daysFull <= P.DAYS);
  assert.ok(b.daysUnused >= 0 && b.daysUnused <= P.DAYS);
});

test("an oversized battery is never full", () => {
  // 0.8 kW peak PV vs 0.4 kW constant demand: ~1-2 kWh midday surplus, used up every night
  const r = P.simulate(base({ pv: [synthPv(0.8)], batteries: [{ capacityKwh: 40, powerKw: 5, efficiencyPct: 90, sections: [0] }] }));
  const b = r.perBattery[0];
  assert.ok(b.maxCharge < 0.5, `max charge ${b.maxCharge}`);
  assert.equal(b.daysFull, 0);
});

test("a small battery on a big array is full most days", () => {
  const r = P.simulate(base({ pv: [synthPv(8)], batteries: [{ capacityKwh: 2, powerKw: 2, efficiencyPct: 90, sections: [0] }] }));
  const b = r.perBattery[0];
  close(b.maxCharge, 1, 1e-6);
  assert.ok(b.daysFull > 300, `days full ${b.daysFull}`);
  assert.ok(b.daysUnused < 10);
});

test("battery without sections stays empty and counts as unused", () => {
  const r = P.simulate(base({ batteries: [{ capacityKwh: 5, powerKw: 2.5, efficiencyPct: 90, sections: [] }] }));
  const b = r.perBattery[0];
  assert.equal(b.maxCharge, 0);
  assert.equal(b.daysUnused, P.DAYS);
});
