// Power planner: calculation core (no DOM). Used by planner-ui.js in the
// browser and imported directly by tests/planner.test.mjs in Node.
//
// Time base: one calendar year (2025, matching the bundled price data) in
// 15-minute steps, 35040 steps. Arrays are indexed by UTC quarter-hour unless
// a name says "local". Energies are kWh per step, prices EUR per kWh.

export const YEAR = 2025;
export const STEPS_PER_DAY = 96;
export const DAYS = 365;
export const STEPS = DAYS * STEPS_PER_DAY;
export const DT = 0.25;  // hours per step
const T0 = Date.UTC(YEAR, 0, 1);
const MS_STEP = 15 * 60 * 1000;

/* ------------------------------------------------------------------ time */

// Month (0-11) of every UTC step.
export const STEP_MONTH = (() => {
  const a = new Uint8Array(STEPS);
  for (let q = 0; q < STEPS; q++) a[q] = new Date(T0 + q * MS_STEP).getUTCMonth();
  return a;
})();

function lastSundayUtc(month) {  // 01:00 UTC on the last Sunday of the month
  const d = new Date(Date.UTC(YEAR, month + 1, 0, 1));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
}
const DST_START = (lastSundayUtc(2) - T0) / MS_STEP;   // last Sunday in March
const DST_END = (lastSundayUtc(9) - T0) / MS_STEP;     // last Sunday in October

// Local clock time: UTC + round(lon/15) h, plus EU summer time inside Europe.
export function timeZone(lat, lon) {
  return { base: Math.round(lon / 15), dst: lat > 34 && lat < 72 && lon > -32 && lon < 45 };
}
export function utcOffsetHours(q, tz) {
  return tz.base + (tz.dst && q >= DST_START && q < DST_END ? 1 : 0);
}
// Convert an array indexed by local quarter-hour into one indexed by UTC.
export function localToUtc(local, tz) {
  const out = new Float64Array(STEPS);
  for (let q = 0; q < STEPS; q++) {
    const l = (q + 4 * utcOffsetHours(q, tz) + STEPS) % STEPS;
    out[q] = local[l];
  }
  return out;
}

// Day of year (0-364) for month (1-12) / day; null for Feb 29.
const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
export function dayOfYear(month, day) {
  if (month === 2 && day === 29) return null;
  return CUM_DAYS[month - 1] + day - 1;
}

/* ---------------------------------------------------------------- demand */

// Typical annual consumption of a house without electric heating or hot
// water (rounded, in line with German "Stromspiegel" averages). Flats use
// roughly a quarter less.
export const HOUSEHOLD_KWH = { 1: 2000, 2: 2900, 3: 3500, 4: 4000 };

// Relative power per local hour (0-23) for each day type. Not normalised:
// a family day at home uses more than a work day away.
export const DAY_TYPES = {
  work: {
    label: 'Work (away 8–17 h)',
    shape: [0.45, 0.4, 0.38, 0.38, 0.4, 0.5, 1.1, 1.4, 0.9, 0.55, 0.5, 0.5,
            0.55, 0.5, 0.5, 0.55, 0.75, 1.3, 1.8, 1.9, 1.7, 1.4, 1.0, 0.65],
  },
  homeoffice: {
    label: 'Home office',
    shape: [0.45, 0.4, 0.38, 0.38, 0.4, 0.5, 0.8, 1.1, 1.0, 0.95, 0.95, 1.1,
            1.6, 1.2, 0.95, 0.95, 1.0, 1.3, 1.7, 1.8, 1.6, 1.3, 0.95, 0.65],
  },
  family: {
    label: 'Family / weekend at home',
    shape: [0.5, 0.42, 0.4, 0.4, 0.4, 0.45, 0.6, 0.9, 1.3, 1.5, 1.4, 1.6,
            1.9, 1.5, 1.2, 1.1, 1.2, 1.5, 1.9, 1.9, 1.7, 1.4, 1.1, 0.75],
  },
};

// Day type for Monday..Sunday: work days first, then home-office days, the
// rest (normally the weekend) are family days.
export function weekPlan(workDays, homeofficeDays) {
  const w = Math.max(0, Math.min(7, Math.round(workDays) || 0));
  const h = Math.max(0, Math.min(7 - w, Math.round(homeofficeDays) || 0));
  return Array.from({ length: 7 }, (_, i) => (i < w ? 'work' : i < w + h ? 'homeoffice' : 'family'));
}

export function constantDemand(annualKwh) {
  return new Float64Array(STEPS).fill(annualKwh / STEPS);
}

// Demand per LOCAL quarter-hour from a weekly schedule, scaled to annualKwh.
// seasonal: relative winter/summer swing (lighting, being indoors).
export function scheduleDemandLocal({ annualKwh, workDays, homeofficeDays, seasonal = 0.15 }) {
  const plan = weekPlan(workDays, homeofficeDays);
  const out = new Float64Array(STEPS);
  let total = 0;
  for (let day = 0; day < DAYS; day++) {
    const weekday = (new Date(T0 + day * 86400000).getUTCDay() + 6) % 7;  // Mon = 0
    const shape = DAY_TYPES[plan[weekday]].shape;
    const season = 1 + seasonal * Math.cos(2 * Math.PI * (day - 15) / DAYS);
    for (let s = 0; s < STEPS_PER_DAY; s++) {
      const v = shape[s >> 2] * season;
      out[day * STEPS_PER_DAY + s] = v;
      total += v;
    }
  }
  const k = annualKwh / total;
  for (let i = 0; i < STEPS; i++) out[i] *= k;
  return out;
}

/* ------------------------------------------------------------------- CSV */

const TS_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/;
const TS_DE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})[ ,T]+(\d{1,2}):(\d{2})/;

function parseTimestamp(s) {
  s = s.trim().replace(/^"|"$/g, '');
  let m = TS_ISO.exec(s);
  if (m) return { month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] };
  m = TS_DE.exec(s);
  if (m) return { month: +m[2], day: +m[1], hour: +m[4], minute: +m[5] };
  return null;
}

// Parse "timestamp,value" rows (ISO or German dd.mm.yyyy; comma, semicolon or
// tab separated; decimal comma allowed with semicolons). Timestamps are local
// clock time; the year is ignored.
export function parseTimeSeriesCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('file is empty');
  const sep = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const points = [];
  let bad = 0;
  for (const line of lines) {
    const cols = line.split(sep);
    const ts = parseTimestamp(cols[0] || '');
    if (!ts) { bad++; continue; }  // header or junk
    const raw = (cols[1] || '').trim().replace(/^"|"$/g, '');
    // "1.234,5" / "0,123" (decimal comma) vs "1234.5" / "0.123"
    const v = Number(raw.includes(',') && sep !== ',' ? raw.replace(/\./g, '').replace(',', '.') : raw);
    if (!Number.isFinite(v)) { bad++; continue; }
    points.push({ ...ts, value: v });
  }
  if (points.length < 24) throw new Error('fewer than 24 rows with "timestamp,value" found');
  if (bad > 1 + points.length * 0.01) throw new Error(`${bad} rows could not be read`);

  // Interval = most common gap between consecutive rows.
  const minuteOfYear = p => {
    const d = dayOfYear(p.month, p.day);
    return d === null ? null : d * 1440 + p.hour * 60 + p.minute;
  };
  const gaps = new Map();
  for (let i = 1; i < points.length; i++) {
    const a = minuteOfYear(points[i - 1]), b = minuteOfYear(points[i]);
    if (a !== null && b !== null && b > a) gaps.set(b - a, (gaps.get(b - a) || 0) + 1);
  }
  const intervalMin = [...gaps].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 60;
  if (![15, 30, 60].includes(intervalMin)) throw new Error(`unsupported interval of ${intervalMin} min (use 15 or 60)`);
  return { points, intervalMin };
}

// Map parsed points onto local quarter-hours.
//   kind 'energy': value is kWh per interval (split over its quarters)
//   kind 'rate':   value is a price, repeated for each quarter
// Missing quarters are filled with the mean; throws below 80 % coverage.
export function toLocalSteps({ points, intervalMin }, kind) {
  const per = intervalMin / 15;
  const out = new Float64Array(STEPS);
  const seen = new Uint8Array(STEPS);
  for (const p of points) {
    const d = dayOfYear(p.month, p.day);
    if (d === null) continue;
    const q0 = d * STEPS_PER_DAY + p.hour * 4 + Math.floor(p.minute / 15);
    for (let k = 0; k < per && q0 + k < STEPS; k++) {
      out[q0 + k] = kind === 'energy' ? p.value / per : p.value;
      seen[q0 + k] = 1;
    }
  }
  let n = 0, sum = 0;
  for (let q = 0; q < STEPS; q++) if (seen[q]) { n++; sum += out[q]; }
  const coverage = n / STEPS;
  if (coverage < 0.8) throw new Error(`file covers only ${Math.round(coverage * 100)} % of a year`);
  const mean = sum / n;
  for (let q = 0; q < STEPS; q++) if (!seen[q]) out[q] = mean;
  return { values: out, coverage, intervalMin };
}

// CSV text for a local-time series (example files, exports).
export function seriesToCsv(local, header, perHour = 'sum', digits = 4) {
  let csv = header + '\n';
  for (let day = 0; day < DAYS; day++) {
    const date = new Date(T0 + day * 86400000).toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += local[day * STEPS_PER_DAY + h * 4 + k];
      if (perHour === 'mean') v /= 4;
      csv += `${date} ${String(h).padStart(2, '0')}:00,${v.toFixed(digits)}\n`;
    }
  }
  return csv;
}

/* ---------------------------------------------------------------- prices */

// Bundled day-ahead prices: {values: EUR/MWh per UTC quarter-hour}.
export function spotFromData(data) {
  if (!data || data.values?.length !== STEPS) throw new Error('price data must have 35040 values');
  return Float64Array.from(data.values);
}

// Purchase price in EUR/kWh per UTC step.
//   {type:'fixed', ct}
//   {type:'dynamic', feesCt, vatPct}   -> (spot + fees) * (1 + VAT)
//   {type:'custom', localCt: Float64Array (local quarter-hours, ct/kWh)}
export function buyPrices(cfg, { spot, tz }) {
  if (cfg.type === 'fixed') return new Float64Array(STEPS).fill(cfg.ct / 100);
  if (cfg.type === 'dynamic') {
    const vat = 1 + cfg.vatPct / 100;
    return spot.map(eurMwh => (eurMwh / 10 + cfg.feesCt) * vat / 100);
  }
  if (cfg.type === 'custom') return localToUtc(cfg.localCt, tz).map(ct => ct / 100);
  throw new Error(`unknown price type ${cfg.type}`);
}

// Feed-in reward in EUR/kWh per UTC step.
//   {type:'fixed', ct}
//   {type:'spot'} -> market value, nothing paid at negative prices
export function sellPrices(cfg, { spot }) {
  if (cfg.type === 'fixed') return new Float64Array(STEPS).fill(cfg.ct / 100);
  if (cfg.type === 'spot') return spot.map(eurMwh => Math.max(0, eurMwh) / 1000);
  throw new Error(`unknown feed-in type ${cfg.type}`);
}

// 24 comma-separated ct/kWh values (local hours) -> local quarter-hours.
export function dailyCurveLocal(text) {
  const v = text.split(/[,;\s]+/).filter(Boolean).map(Number);
  if (v.length !== 24 || !v.every(Number.isFinite)) throw new Error('enter exactly 24 numbers (ct/kWh for 0–1 h … 23–24 h)');
  const out = new Float64Array(STEPS);
  for (let q = 0; q < STEPS; q++) out[q] = v[(q % STEPS_PER_DAY) >> 2];
  return out;
}

/* -------------------------------------------------------------------- PV */

// PVGIS seriescalc JSON (one year, pvcalculation=1) -> kWh per UTC step.
export function pvFromSeriescalc(json) {
  const out = new Float64Array(STEPS);
  for (const rec of json.outputs.hourly) {
    const t = rec.time;  // "20230615:1210" (UTC)
    const d = dayOfYear(+t.slice(4, 6), +t.slice(6, 8));
    if (d === null) continue;
    const q0 = d * STEPS_PER_DAY + (+t.slice(9, 11)) * 4;
    const e = rec.P / 1000 * DT;  // W averaged over the hour -> kWh per quarter
    for (let k = 0; k < 4; k++) out[q0 + k] = e;
  }
  return out;
}

/* ------------------------------------------------------------ simulation */

// pv:        [Float64Array per section] kWh per step
// demand:    Float64Array kWh per step
// buy, sell: Float64Array EUR/kWh per step
// batteries: [{capacityKwh, powerKw, efficiencyPct, sections:[section index]}]
//            A battery is charged only from its own sections' surplus and
//            discharges into the house. Self-consumption first, no grid charging.
// feedInLimitKw: optional export cap; anything above is curtailed.
export function simulate({ pv, demand, buy, sell, batteries = [], feedInLimitKw = null, keepSeries = false }) {
  const nB = batteries.length;
  const owner = new Int16Array(pv.length).fill(-1);
  batteries.forEach((b, i) => b.sections.forEach(s => { if (s < pv.length) owner[s] = i; }));
  const cap = batteries.map(b => Math.max(0, b.capacityKwh));
  const pMax = batteries.map(b => Math.max(0, b.powerKw) * DT);
  const eta = batteries.map(b => Math.sqrt(Math.min(100, Math.max(1, b.efficiencyPct)) / 100));
  const soc = new Float64Array(nB);
  const pvB = new Float64Array(nB), surB = new Float64Array(nB);
  const exportCap = feedInLimitKw != null && feedInLimitKw >= 0 ? feedInLimitKw * DT : Infinity;

  const keys = ['demand', 'pv', 'direct', 'charged', 'discharged', 'imported', 'exported',
                'curtailed', 'costNoPv', 'importCost', 'revenue'];
  const zero = () => Object.fromEntries(keys.map(k => [k, 0]));
  const tot = zero();
  const monthly = Array.from({ length: 12 }, zero);
  const perBattery = batteries.map(() => ({ charged: 0, discharged: 0 }));
  const series = keepSeries ? {
    pv: new Float32Array(STEPS), demand: new Float32Array(STEPS), imported: new Float32Array(STEPS),
    exported: new Float32Array(STEPS), soc: new Float32Array(STEPS),
  } : null;
  const capTotal = cap.reduce((a, b) => a + b, 0);

  for (let q = 0; q < STEPS; q++) {
    pvB.fill(0);
    let pvFree = 0;
    for (let s = 0; s < pv.length; s++) {
      const e = pv[s][q];
      if (owner[s] >= 0) pvB[owner[s]] += e; else pvFree += e;
    }
    let pvGroups = 0;
    for (let b = 0; b < nB; b++) pvGroups += pvB[b];
    const D = demand[q];

    // 1. PV covers demand directly: unbatteried sections first, then battery groups
    const useFree = Math.min(pvFree, D);
    let rest = D - useFree;
    const useGroups = Math.min(pvGroups, rest);
    rest -= useGroups;
    const frac = pvGroups > 0 ? useGroups / pvGroups : 0;
    let surplus = pvFree - useFree;

    // 2. each battery charges from its own sections' surplus
    let charged = 0;
    for (let b = 0; b < nB; b++) {
      surB[b] = pvB[b] * (1 - frac);
      const c = Math.max(0, Math.min(surB[b], pMax[b], (cap[b] - soc[b]) / eta[b]));
      soc[b] += c * eta[b];
      surplus += surB[b] - c;
      charged += c;
      perBattery[b].charged += c;
    }

    // 3. batteries cover the remaining demand
    let discharged = 0;
    for (let b = 0; b < nB && rest > 1e-12; b++) {
      const d = Math.max(0, Math.min(rest, pMax[b], soc[b] * eta[b]));
      soc[b] -= d / eta[b];
      rest -= d;
      discharged += d;
      perBattery[b].discharged += d;
    }

    // 4. grid
    const exported = Math.min(surplus, exportCap);
    const curtailed = surplus - exported;
    const pvTot = pvFree + pvGroups;
    const m = monthly[STEP_MONTH[q]];
    const add = (k, v) => { tot[k] += v; m[k] += v; };
    add('demand', D); add('pv', pvTot); add('direct', useFree + useGroups);
    add('charged', charged); add('discharged', discharged);
    add('imported', rest); add('exported', exported); add('curtailed', curtailed);
    add('costNoPv', D * buy[q]); add('importCost', rest * buy[q]); add('revenue', exported * sell[q]);

    if (series) {
      series.pv[q] = pvTot; series.demand[q] = D; series.imported[q] = rest;
      series.exported[q] = exported;
      let s = 0; for (let b = 0; b < nB; b++) s += soc[b];
      series.soc[q] = s;
    }
  }

  const derive = t => ({
    ...t,
    costWithPv: t.importCost - t.revenue,
    savings: t.costNoPv - (t.importCost - t.revenue),
    autarky: t.demand > 0 ? 1 - t.imported / t.demand : 0,
    selfConsumption: t.pv > 0 ? (t.direct + t.charged) / t.pv : 0,
  });
  return {
    totals: derive(tot),
    monthly: monthly.map(derive),
    perBattery: perBattery.map((p, i) => ({
      ...p,
      cycles: cap[i] > 0 ? p.discharged / cap[i] : 0,
      losses: p.charged - p.discharged - soc[i],
    })),
    capacityKwh: capTotal,
    series,
  };
}
