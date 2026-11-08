// Mode switch (Basic / Expert / Power planner) and the power planner UI.
// Shared by the Flask page (static/index.html) and the GitHub Pages page.
// The host page provides: readSections(), the #secBody table, #lat/#lon/
// #userhorizon inputs, #calc/#status/#error/#results/#tooltip elements and
// window.PVGIS_PROXY (base URL that serves PVGIS /seriescalc).

import * as P from './planner-core.js';

const $ = id => document.getElementById(id);
const SER = i => `var(--s${(i % 8) + 1})`;
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const TYPE_COLOR = { work: 'var(--s1)', homeoffice: 'var(--s7)', family: 'var(--s2)' };
const PV_YEARS = Array.from({ length: 19 }, (_, i) => 2005 + i);
const fmt = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const eur = v => `${v < 0 ? '−' : ''}${fmt(Math.abs(v))} €`;
const pct = v => `${fmt(v * 100, 0)} %`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ================================================================ styles */

document.head.insertAdjacentHTML('beforeend', `<style>
  .seg { display: inline-flex; border: 1px solid var(--baseline); border-radius: 8px; overflow: hidden; }
  .seg button { border: 0; border-radius: 0; background: transparent; padding: 6px 12px; color: var(--text-secondary); }
  .seg button + button { border-left: 1px solid var(--baseline); }
  .seg button.active { background: var(--s1); color: #fff; font-weight: 600; }
  .seg.small button { padding: 3px 10px; font-size: 12px; }
  #modeSeg { margin: 0 0 18px; }
  body.mode-basic .expert-only { display: none; }
  body:not(.mode-planner) .planner-only { display: none !important; }
  body.mode-planner #calc, body.mode-planner #results { display: none !important; }
  .pl-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0 18px; }
  .pl-sub { margin-top: 12px; }
  .pl-note { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .pl-btns, .row > div.pl-btns { display: flex; flex-direction: row; gap: 6px; flex-wrap: wrap; align-items: center; }
  .pl-btns button { padding: 3px 10px; font-size: 12px; background: transparent; }
  .pl-btns button.active { border-color: var(--s1); font-weight: 600; }
  .week { display: flex; gap: 4px; margin-top: 8px; }
  .week span { flex: 1; text-align: center; border-radius: 6px; padding: 4px 0; font-size: 11px; color: #fff; font-weight: 600; }
  .bat { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; background: var(--page); }
  .bat .head { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .bat .head input { flex: 1; font-weight: 600; }
  .schips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .schip { border-radius: 999px; padding: 3px 10px; font-size: 12px; border: 1.5px solid; background: transparent; }
  .schip.on { color: #fff; }
  .schip.taken { opacity: 0.45; }
  table.pl { border-collapse: collapse; width: 100%; font-size: 13px; }
  table.pl th { text-align: right; font-size: 12px; color: var(--muted); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--grid); }
  table.pl td { text-align: right; padding: 5px 8px; border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; }
  table.pl th:first-child, table.pl td:first-child { text-align: left; }
  table.pl tr.best td { font-weight: 650; }
  .pl-scroll { overflow-x: auto; }
  .tile .d { font-size: 12px; color: var(--s3); font-weight: 600; }
  #planResults { display: none; margin-top: 20px; }
  .pl-legend span { display: inline-flex; align-items: center; }
  textarea.pl { width: 100%; font-family: ui-monospace, monospace; font-size: 12px; }
</style>`);

/* ================================================================= state */

const DEFAULT_PLANNER = () => ({
  demand: { type: 'schedule', annualKwh: P.HOUSEHOLD_KWH[3], workDays: 3, homeofficeDays: 2 },
  buy: { type: 'fixed', ct: 35, feesCt: 18, vatPct: 19, customKind: 'daily',
         customText: '28,27,26,26,27,30,36,40,38,33,29,27,26,26,27,30,35,42,45,44,40,36,32,30' },
  sell: { type: 'fixed', ct: 7.8 },
  batteries: [{ name: 'Home battery', capacityKwh: 5, powerKw: 2.5, efficiencyPct: 90, sids: 'all' }],
  pvYear: 2023,
  feedInLimitKw: '',
});

let mode = 'basic';
let pl = DEFAULT_PLANNER();
let demandUpload = null;   // {name, values (local), coverage, intervalMin}  (not saved in config)
let priceUpload = null;    // same, ct/kWh
let nextSid = 1;
let spotPromise = null;
const pvCache = new Map();
let lastPv = null;         // {key, pv: [Float64Array], names}
let lastRun = null;        // simulation results for rendering
let weekIdx = 25;

/* ============================================================ mode switch */

const modeSeg = document.createElement('div');
modeSeg.id = 'modeSeg';
modeSeg.className = 'seg';
modeSeg.innerHTML = `<button data-mode="basic">Basic</button><button data-mode="expert">Expert</button><button data-mode="planner">Power planner</button>`;
document.querySelector('.sub').after(modeSeg);
modeSeg.addEventListener('click', e => { if (e.target.dataset.mode) setMode(e.target.dataset.mode); });

function setMode(m) {
  mode = ['basic', 'expert', 'planner'].includes(m) ? m : 'basic';
  document.body.classList.remove('mode-basic', 'mode-expert', 'mode-planner');
  document.body.classList.add('mode-' + mode);
  modeSeg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  if (mode === 'planner') renderBatteries();
}

/* ============================================================== sections */

function sectionRows() { return [...$('secBody').children]; }
function syncSids() {
  for (const tr of sectionRows()) if (!tr.dataset.sid) tr.dataset.sid = String(nextSid++);
  const all = sectionRows().map(tr => tr.dataset.sid);
  for (const b of pl.batteries) if (b.sids === 'all') b.sids = [...all];
}
function sectionList() {
  syncSids();
  return sectionRows().map((tr, i) => ({
    sid: tr.dataset.sid, index: i, color: SER(i),
    name: tr.querySelector('.s-name')?.value || `Section ${i + 1}`,
  }));
}

/* ========================================================== planner inputs */

const inputs = document.createElement('div');
inputs.className = 'planner-only';
inputs.innerHTML = `
<div class="pl-grid">
  <div class="card">
    <h2>Household demand</h2>
    <div class="seg small" id="pl-dtype">
      <button data-v="constant">Constant</button><button data-v="schedule">Daily schedule</button><button data-v="upload">Upload profile</button>
    </div>
    <div class="pl-sub" id="pl-annual-wrap">
      <label for="pl-annual">Annual consumption (kWh)</label>
      <div class="row">
        <div><input id="pl-annual" size="7"></div>
        <div class="pl-btns" id="pl-persons">
          ${[1, 2, 3, 4].map(n => `<button data-n="${n}" title="${P.HOUSEHOLD_KWH[n]} kWh/yr">${n} person${n > 1 ? 's' : ''}</button>`).join('')}
        </div>
      </div>
      <div class="pl-note">Typical values for a house without electric heating or hot water; flats use about a quarter less. Heat pump or EV: add their consumption.</div>
    </div>
    <div class="pl-sub" id="pl-sched">
      <div class="row">
        <div><label for="pl-work">Work days / week</label><input id="pl-work" type="number" min="0" max="7" style="width:80px"></div>
        <div><label for="pl-ho">Home-office days</label><input id="pl-ho" type="number" min="0" max="7" style="width:80px"></div>
        <div><label>Family days</label><div id="pl-fam" style="padding:6px 0"></div></div>
      </div>
      <div class="week" id="pl-week"></div>
      <div id="pl-dayprev"></div>
    </div>
    <div class="pl-sub" id="pl-upload">
      <input type="file" id="pl-dfile" accept=".csv,.txt,text/csv">
      <button class="ghost" id="pl-dex" style="margin-left:6px">Download example CSV</button>
      <div class="pl-note">CSV with local timestamp and kWh per interval (15 min or 1 h) for one year, e.g. <code>2025-01-01 00:00,0.214</code>. Smart-meter exports with semicolons and decimal commas (<code>01.01.2025 00:00;0,214</code>) work too; the year is ignored. Uploaded files are not saved in the config.</div>
      <div class="pl-note" id="pl-dstat"></div>
    </div>
  </div>

  <div class="card">
    <h2>Electricity prices</h2>
    <label>Purchase price</label>
    <div class="seg small" id="pl-btype">
      <button data-v="fixed">Fixed</button><button data-v="dynamic">Dynamic (spot)</button><button data-v="custom">Custom</button>
    </div>
    <div class="pl-sub" id="pl-bfixed"><label for="pl-bct">ct/kWh (incl. VAT)</label><input id="pl-bct" size="6"></div>
    <div class="pl-sub" id="pl-bdyn">
      <div class="row">
        <div><label for="pl-fees">Fees on top of spot (ct/kWh, net)</label><input id="pl-fees" size="6"></div>
        <div><label for="pl-vat">VAT %</label><input id="pl-vat" size="4"></div>
      </div>
      <div class="pl-note">Real German day-ahead prices of 2025 (hourly, 15-minute from October) plus grid fees, levies and supplier margin, then VAT. <span id="pl-dynavg"></span></div>
    </div>
    <div class="pl-sub" id="pl-bcustom">
      <div class="seg small" id="pl-ckind"><button data-v="daily">Daily curve</button><button data-v="csv">CSV upload</button></div>
      <div class="pl-sub" id="pl-cdaily">
        <label for="pl-ctext">24 values in ct/kWh, local hours 0–1 … 23–24</label>
        <textarea class="pl" id="pl-ctext" rows="2"></textarea>
      </div>
      <div class="pl-sub" id="pl-ccsv">
        <input type="file" id="pl-pfile" accept=".csv,.txt,text/csv">
        <button class="ghost" id="pl-pex" style="margin-left:6px">Download example CSV</button>
        <div class="pl-note">Local timestamp and price in ct/kWh, 15 min or 1 h resolution, e.g. <code>2025-01-01 00:00,31.2</code>.</div>
        <div class="pl-note" id="pl-pstat"></div>
      </div>
    </div>
    <label style="margin-top:16px">Feed-in reward</label>
    <div class="seg small" id="pl-stype"><button data-v="fixed">Fixed</button><button data-v="spot">Spot market value</button></div>
    <div class="pl-sub" id="pl-sfixed">
      <label for="pl-sct">ct/kWh</label><input id="pl-sct" size="6">
      <div class="pl-note">German EEG feed-in tariff for new systems up to 10 kWp with self-consumption: about 7.8 ct/kWh (falls every six months). Balcony systems usually get nothing: enter 0.</div>
    </div>
    <div class="pl-sub" id="pl-sspot"><div class="pl-note">Paid the 2025 day-ahead price of each quarter hour; nothing when the price is negative.</div></div>
  </div>
</div>

<div class="card">
  <h2>Batteries</h2>
  <div class="pl-note" style="margin:-4px 0 10px">Click the sections that charge each battery. A battery stores only the surplus of its own sections (e.g. a balcony storage on its balcony panels, a home battery on the roof) and discharges into the house.</div>
  <div id="pl-bats"></div>
  <div class="pl-btns">
    <button id="pl-addhome">+ Home battery (10 kWh)</button>
    <button id="pl-addbalc">+ Balcony storage (2 kWh / 800 W)</button>
    <button id="pl-addcustom">+ Battery</button>
  </div>
  <div class="pl-note" id="pl-unassigned"></div>
  <div class="row" style="margin-top:14px">
    <div><label for="pl-year">Weather year (PVGIS hourly data)</label>
      <select id="pl-year">${PV_YEARS.map(y => `<option>${y}</option>`).join('')}</select></div>
    <div><label for="pl-limit">Feed-in limit (kW, empty = none)</label><input id="pl-limit" size="8" placeholder="none"></div>
  </div>
</div>`;
$('calc').before(inputs);

const runBtn = document.createElement('button');
runBtn.id = 'planRun';
runBtn.className = 'primary planner-only';
runBtn.textContent = 'Run power planner';
$('calc').before(runBtn);
runBtn.addEventListener('click', () => run());

const results = document.createElement('div');
results.id = 'planResults';
results.className = 'planner-only';
results.innerHTML = `
  <div class="tiles" id="pl-tiles"></div>
  <div class="card"><h2>Comparison per year</h2><div class="pl-scroll" id="pl-compare"></div></div>
  <div class="card">
    <h2>Monthly energy balance (kWh) — left bar: where the demand comes from, right bar: where the PV goes</h2>
    <div id="pl-monthly"></div><div class="legend pl-legend" id="pl-mlegend"></div>
  </div>
  <div class="card">
    <h2>Week view (hourly, local time)</h2>
    <div class="row" style="align-items:center">
      <input type="range" id="pl-wk" min="0" max="50" style="flex:1; min-width:200px">
      <div class="pl-btns"><button data-w="1">Winter</button><button data-w="14">Spring</button><button data-w="25">Summer</button><button data-w="40">Autumn</button></div>
    </div>
    <div id="pl-weekchart"></div><div class="legend pl-legend" id="pl-wlegend"></div>
  </div>
  <div class="card" id="pl-batcard"><h2>Batteries</h2><div class="pl-scroll" id="pl-battab"></div></div>
  <button class="ghost" id="pl-dlsim">Download simulation (CSV, hourly)</button>
  <div class="note" id="pl-notes"></div>`;
$('error').after(results);

/* -------------------------------------------------------- input binding */

function segInit(id, get, set) {
  const el = $(id);
  el.addEventListener('click', e => {
    if (!e.target.dataset.v) return;
    set(e.target.dataset.v);
    syncInputs();
    changed();
  });
  el._get = get;
}
segInit('pl-dtype', () => pl.demand.type, v => { pl.demand.type = v; });
segInit('pl-btype', () => pl.buy.type, v => { pl.buy.type = v; });
segInit('pl-ckind', () => pl.buy.customKind, v => { pl.buy.customKind = v; });
segInit('pl-stype', () => pl.sell.type, v => { pl.sell.type = v; });

const num = (id, obj, key) => $(id).addEventListener('input', () => {
  const v = parseFloat($(id).value.replace(',', '.'));
  if (Number.isFinite(v)) obj()[key] = v;
  syncInputs(false);
  changed();
});
num('pl-annual', () => pl.demand, 'annualKwh');
num('pl-work', () => pl.demand, 'workDays');
num('pl-ho', () => pl.demand, 'homeofficeDays');
num('pl-bct', () => pl.buy, 'ct');
num('pl-fees', () => pl.buy, 'feesCt');
num('pl-vat', () => pl.buy, 'vatPct');
num('pl-sct', () => pl.sell, 'ct');
$('pl-ctext').addEventListener('input', () => { pl.buy.customText = $('pl-ctext').value; changed(); });
$('pl-limit').addEventListener('input', () => { pl.feedInLimitKw = $('pl-limit').value.trim(); changed(); });
$('pl-year').addEventListener('change', () => { pl.pvYear = +$('pl-year').value; changed(); });
$('pl-persons').addEventListener('click', e => {
  const n = e.target.dataset.n;
  if (!n) return;
  pl.demand.annualKwh = P.HOUSEHOLD_KWH[n];
  syncInputs();
  changed();
});

function syncInputs(writeFields = true) {
  const d = pl.demand;
  for (const id of ['pl-dtype', 'pl-btype', 'pl-ckind', 'pl-stype']) {
    $(id).querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === $(id)._get()));
  }
  const show = (id, on) => { $(id).style.display = on ? '' : 'none'; };
  show('pl-annual-wrap', d.type !== 'upload');
  show('pl-sched', d.type === 'schedule');
  show('pl-upload', d.type === 'upload');
  show('pl-bfixed', pl.buy.type === 'fixed');
  show('pl-bdyn', pl.buy.type === 'dynamic');
  show('pl-bcustom', pl.buy.type === 'custom');
  show('pl-cdaily', pl.buy.customKind === 'daily');
  show('pl-ccsv', pl.buy.customKind === 'csv');
  show('pl-sfixed', pl.sell.type === 'fixed');
  show('pl-sspot', pl.sell.type === 'spot');
  if (writeFields) {
    $('pl-annual').value = d.annualKwh;
    $('pl-work').value = d.workDays;
    $('pl-ho').value = d.homeofficeDays;
    $('pl-bct').value = pl.buy.ct;
    $('pl-fees').value = pl.buy.feesCt;
    $('pl-vat').value = pl.buy.vatPct;
    $('pl-sct').value = pl.sell.ct;
    $('pl-ctext').value = pl.buy.customText;
    $('pl-limit').value = pl.feedInLimitKw;
    $('pl-year').value = pl.pvYear;
  }
  $('pl-persons').querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', P.HOUSEHOLD_KWH[b.dataset.n] === d.annualKwh));
  renderWeekPlan();
  if (pl.buy.type === 'dynamic') showDynamicAverage();
}

function renderWeekPlan() {
  const plan = P.weekPlan(pl.demand.workDays, pl.demand.homeofficeDays);
  $('pl-fam').textContent = plan.filter(t => t === 'family').length;
  $('pl-week').innerHTML = plan.map((t, i) =>
    `<span style="background:${TYPE_COLOR[t]}" title="${P.DAY_TYPES[t].label}">${WEEKDAYS[i]}</span>`).join('');
  // mini chart of the three day types (kW for the chosen annual consumption)
  const local = P.scheduleDemandLocal({ ...pl.demand, seasonal: 0 });
  const avg = { work: new Array(24).fill(0), homeoffice: new Array(24).fill(0), family: new Array(24).fill(0) };
  const used = new Set(plan);
  // first week of the year: day d has weekday (d + 2) % 7 (2025-01-01 is a Wednesday)
  for (let day = 0; day < 7; day++) {
    const t = plan[(day + 2) % 7];
    for (let h = 0; h < 24; h++) avg[t][h] = (local[day * 96 + h * 4] * 4);  // kWh/quarter -> kW
  }
  const W = 480, H = 110, mL = 34, mB = 16, mT = 6;
  const maxV = Math.max(0.1, ...Object.values(avg).flat()) * 1.1;
  const x = h => mL + (W - mL - 6) * h / 24, y = v => mT + (H - mT - mB) * (1 - v / maxV);
  let s = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;margin-top:8px">`;
  for (const v of [0, maxV / 2]) s += `<line x1="${mL}" x2="${W - 6}" y1="${y(v)}" y2="${y(v)}" stroke="${css('--grid')}"/><text x="${mL - 4}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`;
  for (const h of [0, 6, 12, 18, 24]) s += `<text x="${x(h)}" y="${H - 3}" text-anchor="${h ? h === 24 ? 'end' : 'middle' : 'start'}">${h}h</text>`;
  for (const t of Object.keys(avg)) {
    if (!used.has(t)) continue;
    const pts = [];
    avg[t].forEach((v, h) => { pts.push(`${x(h)},${y(v)}`, `${x(h + 1)},${y(v)}`); });
    s += `<polyline points="${pts.join(' ')}" fill="none" stroke="${TYPE_COLOR[t]}" stroke-width="2"/>`;
  }
  s += `</svg><div class="legend" style="margin-top:2px">${[...used].map(t =>
    `<span><span class="chip" style="background:${TYPE_COLOR[t]}"></span>${P.DAY_TYPES[t].label}</span>`).join('')}<span>kW, January</span></div>`;
  $('pl-dayprev').innerHTML = s;
}

async function showDynamicAverage() {
  try {
    const spot = await loadSpot();
    const buy = P.buyPrices(pl.buy, { spot, tz: currentTz() });
    $('pl-dynavg').textContent = `Average 2025: ${fmt(buy.reduce((a, b) => a + b, 0) / buy.length * 100, 1)} ct/kWh.`;
  } catch (e) { $('pl-dynavg').textContent = ''; }
}

/* ------------------------------------------------------------ uploads */

async function readCsvUpload(file, kind) {
  const parsed = P.parseTimeSeriesCsv(await file.text());
  return { name: file.name, ...P.toLocalSteps(parsed, kind) };
}
$('pl-dfile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    demandUpload = await readCsvUpload(f, 'energy');
    const total = demandUpload.values.reduce((a, b) => a + b, 0);
    $('pl-dstat').textContent = `${f.name}: ${fmt(total)} kWh/yr, ${demandUpload.intervalMin}-min data, ${pct(demandUpload.coverage)} of the year covered${demandUpload.coverage < 1 ? ' (gaps filled with the average)' : ''}.`;
    changed();
  } catch (err) {
    demandUpload = null;
    $('pl-dstat').textContent = `Could not read ${f.name}: ${err.message}`;
  }
});
$('pl-pfile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    priceUpload = await readCsvUpload(f, 'rate');
    const avg = priceUpload.values.reduce((a, b) => a + b, 0) / P.STEPS;
    $('pl-pstat').textContent = `${f.name}: average ${fmt(avg, 1)} ct/kWh, ${priceUpload.intervalMin}-min data, ${pct(priceUpload.coverage)} covered.`;
    changed();
  } catch (err) {
    priceUpload = null;
    $('pl-pstat').textContent = `Could not read ${f.name}: ${err.message}`;
  }
});
$('pl-dex').addEventListener('click', () => {
  const local = P.scheduleDemandLocal({ ...pl.demand, annualKwh: pl.demand.annualKwh || 3500 });
  download('example_load_profile.csv', P.seriesToCsv(local, 'timestamp,kwh'));
});
$('pl-pex').addEventListener('click', async () => {
  const spot = await loadSpot();
  const tz = currentTz();
  const buy = P.buyPrices({ type: 'dynamic', feesCt: pl.buy.feesCt, vatPct: pl.buy.vatPct }, { spot, tz });
  // back to local time for the file
  const local = new Float64Array(P.STEPS);
  for (let q = 0; q < P.STEPS; q++) local[(q + 4 * P.utcOffsetHours(q, tz) + P.STEPS) % P.STEPS] = buy[q] * 100;
  download('example_price_curve.csv', P.seriesToCsv(local, 'timestamp,ct_per_kwh', 'mean', 2));
});

/* ----------------------------------------------------------- batteries */

function renderBatteries() {
  const secs = sectionList();
  const valid = new Set(secs.map(s => s.sid));
  for (const b of pl.batteries) b.sids = b.sids.filter(sid => valid.has(sid));
  const ownerOf = sid => pl.batteries.findIndex(b => b.sids.includes(sid));

  $('pl-bats').innerHTML = pl.batteries.map((b, bi) => `
    <div class="bat" data-bi="${bi}">
      <div class="head">
        <input data-k="name" value="${esc(b.name)}">
        <button class="ghost" data-act="del" title="Remove battery">✕</button>
      </div>
      <div class="row">
        <div><label>Capacity (kWh)</label><input data-k="capacityKwh" size="6" value="${b.capacityKwh}"></div>
        <div><label>Max. power (kW)</label><input data-k="powerKw" size="6" value="${b.powerKw}"></div>
        <div><label>Round-trip efficiency (%)</label><input data-k="efficiencyPct" size="5" value="${b.efficiencyPct}"></div>
      </div>
      <label style="margin-top:8px">Charged by</label>
      <div class="schips">${secs.length ? secs.map(s => {
        const on = b.sids.includes(s.sid), other = !on && ownerOf(s.sid) >= 0;
        return `<button class="schip ${on ? 'on' : ''} ${other ? 'taken' : ''}" data-sid="${s.sid}"
          style="border-color:${s.color};${on ? `background:${s.color}` : `color:${s.color}`}"
          title="${other ? `Currently charges ${esc(pl.batteries[ownerOf(s.sid)].name)} — click to move here` : on ? 'Click to disconnect' : 'Click to connect'}">${esc(s.name)}</button>`;
      }).join('') : '<span class="pl-note">Add PV sections above first.</span>'}</div>
    </div>`).join('') || '<div class="pl-note" style="margin-bottom:10px">No battery — all PV is used directly or fed in.</div>';

  const free = secs.filter(s => ownerOf(s.sid) < 0);
  $('pl-unassigned').innerHTML = pl.batteries.length && free.length
    ? `Not connected to a battery: ${free.map(s => `<span class="chip" style="background:${s.color}"></span>${esc(s.name)}`).join(', ')}`
    : '';
}

$('pl-bats').addEventListener('input', e => {
  const bi = e.target.closest('.bat')?.dataset.bi, k = e.target.dataset.k;
  if (bi == null || !k) return;
  const b = pl.batteries[bi];
  if (k === 'name') b.name = e.target.value;
  else {
    const v = parseFloat(e.target.value.replace(',', '.'));
    if (Number.isFinite(v)) b[k] = v;
  }
  changed();
});
$('pl-bats').addEventListener('click', e => {
  const card = e.target.closest('.bat');
  if (!card) return;
  const b = pl.batteries[card.dataset.bi];
  if (e.target.dataset.act === 'del') {
    pl.batteries.splice(card.dataset.bi, 1);
  } else if (e.target.dataset.sid) {
    const sid = e.target.dataset.sid;
    if (b.sids.includes(sid)) b.sids = b.sids.filter(s => s !== sid);
    else {
      pl.batteries.forEach(o => { o.sids = o.sids.filter(s => s !== sid); });  // one battery per section
      b.sids.push(sid);
    }
  } else return;
  renderBatteries();
  changed();
});
function addBattery(name, capacityKwh, powerKw) {
  const secs = sectionList();
  // a new battery takes the sections no other battery uses
  const free = secs.filter(s => !pl.batteries.some(b => b.sids.includes(s.sid))).map(s => s.sid);
  pl.batteries.push({ name, capacityKwh, powerKw, efficiencyPct: 90, sids: free });
  renderBatteries();
  changed();
}
$('pl-addhome').addEventListener('click', () => addBattery('Home battery', 10, 5));
$('pl-addbalc').addEventListener('click', () => addBattery('Balcony storage', 2, 0.8));
$('pl-addcustom').addEventListener('click', () => addBattery(`Battery ${pl.batteries.length + 1}`, 5, 2.5));

// keep chips in sync with the sections table
new MutationObserver(() => { renderBatteries(); sectionsChanged(); }).observe($('secBody'), { childList: true });
let nameTimer;
$('secBody').addEventListener('input', e => {
  if (e.target.classList.contains('s-name')) { clearTimeout(nameTimer); nameTimer = setTimeout(renderBatteries, 200); }
  sectionsChanged();
});
for (const id of ['lat', 'lon', 'userhorizon']) $(id).addEventListener('input', sectionsChanged);

/* ================================================================== data */

function currentTz() { return P.timeZone(parseFloat($('lat').value), parseFloat($('lon').value)); }

function loadSpot() {
  if (!spotPromise) {
    spotPromise = fetch(new URL('./data/prices_DE-LU_2025.json', import.meta.url))
      .then(r => { if (!r.ok) throw new Error(`price data: HTTP ${r.status}`); return r.json(); })
      .then(P.spotFromData);
    spotPromise.catch(() => { spotPromise = null; });
  }
  return spotPromise;
}

function pvRequests() {
  const lat = Math.round(parseFloat($('lat').value) * 1e4) / 1e4;
  const lon = Math.round(parseFloat($('lon').value) * 1e4) / 1e4;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('invalid latitude/longitude');
  const userhorizon = $('userhorizon').value.trim();
  return window.readSections().map(s => {
    if (![s.kwp, s.tilt, s.azimuth].every(Number.isFinite)) throw new Error(`${s.name}: kWp, tilt and azimuth must be numbers`);
    const params = {
      lat, lon, peakpower: s.kwp, loss: Number.isFinite(s.loss) ? s.loss : 14, angle: s.tilt,
      aspect: s.azimuth - 180, pvtechchoice: s.pvtech || 'crystSi', mountingplace: s.mounting || 'free',
      pvcalculation: 1, startyear: pl.pvYear, endyear: pl.pvYear, outputformat: 'json',
    };
    if (userhorizon) params.userhorizon = userhorizon;
    return { name: s.name, url: `${window.PVGIS_PROXY}/seriescalc?${new URLSearchParams(params)}` };
  });
}

function fetchPv(url) {
  if (!pvCache.has(url)) {
    const p = fetch(url).then(async r => {
      if (!r.ok) throw new Error(`PVGIS error ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return P.pvFromSeriescalc(await r.json());
    });
    p.catch(() => pvCache.delete(url));
    pvCache.set(url, p);
  }
  return pvCache.get(url);
}

/* ============================================================ simulation */

async function run() {
  $('error').textContent = '';
  let reqs;
  try { reqs = pvRequests(); } catch (e) { $('error').textContent = e.message; return; }
  if (!reqs.length) { $('error').textContent = 'Add at least one PV section.'; return; }
  runBtn.disabled = true;
  $('status').textContent = `Fetching hourly PVGIS data for ${pl.pvYear}…`;
  try {
    const pv = await Promise.all(reqs.map(r => fetchPv(r.url).catch(e => { throw new Error(`${r.name}: ${e.message}`); })));
    lastPv = { key: reqs.map(r => r.url).join('|'), pv, names: reqs.map(r => r.name), year: pl.pvYear };
    await simulateAndRender();
    $('status').textContent = '';
  } catch (e) {
    $('error').textContent = 'Power planner failed: ' + e.message;
    $('status').textContent = '';
  } finally {
    runBtn.disabled = false;
  }
}

let simTimer;
function changed() {
  if (!lastPv) return;
  let key;
  try { key = pvRequests().map(r => r.url).join('|'); } catch (e) { return; }
  if (key !== lastPv.key) {  // sections or weather year changed: needs new PVGIS data
    $('status').textContent = 'PV inputs changed — press "Run power planner" to update.';
    return;
  }
  clearTimeout(simTimer);
  simTimer = setTimeout(() => simulateAndRender().catch(e => { $('error').textContent = e.message; }), 150);
}
function sectionsChanged() { if (mode === 'planner') changed(); }

async function buildInputs() {
  const tz = currentTz();
  const d = pl.demand;
  let demand;
  if (d.type === 'constant') demand = P.constantDemand(d.annualKwh);
  else if (d.type === 'schedule') demand = P.localToUtc(P.scheduleDemandLocal(d), tz);
  else {
    if (!demandUpload) throw new Error('Upload a load profile CSV (or choose another demand option).');
    demand = P.localToUtc(demandUpload.values, tz);
  }
  const needSpot = pl.buy.type === 'dynamic' || pl.sell.type === 'spot';
  const spot = needSpot ? await loadSpot() : null;
  let buyCfg = pl.buy;
  if (pl.buy.type === 'custom') {
    if (pl.buy.customKind === 'daily') buyCfg = { type: 'custom', localCt: P.dailyCurveLocal(pl.buy.customText) };
    else {
      if (!priceUpload) throw new Error('Upload a price curve CSV (or choose another price option).');
      buyCfg = { type: 'custom', localCt: priceUpload.values };
    }
  }
  const buy = P.buyPrices(buyCfg, { spot, tz });
  const sell = P.sellPrices(pl.sell, { spot });
  const secs = sectionList();
  const batteries = pl.batteries.map(b => ({
    ...b, sections: b.sids.map(sid => secs.findIndex(s => s.sid === sid)).filter(i => i >= 0),
  }));
  const limit = parseFloat(String(pl.feedInLimitKw).replace(',', '.'));
  return { tz, demand, buy, sell, batteries, feedInLimitKw: Number.isFinite(limit) ? limit : null };
}

async function simulateAndRender() {
  if (!lastPv) return;
  const inp = await buildInputs();
  const base = { pv: lastPv.pv, demand: inp.demand, buy: inp.buy, sell: inp.sell, feedInLimitKw: inp.feedInLimitKw };
  const withBat = P.simulate({ ...base, batteries: inp.batteries, keepSeries: true });
  const noBat = P.simulate({ ...base, batteries: [] });
  lastRun = { withBat, noBat, inp, names: lastPv.names, year: lastPv.year };
  $('error').textContent = '';
  if ($('status').textContent.startsWith('PV inputs changed')) $('status').textContent = '';
  renderResults();
}

/* ============================================================== results */

function renderResults() {
  const { withBat, noBat, inp } = lastRun;
  const t = withBat.totals, n = noBat.totals;
  const hasBat = inp.batteries.some(b => b.capacityKwh > 0 && b.sections.length);
  results.style.display = 'block';
  const delta = (a, b, f) => (hasBat ? `<div class="d">${f(a - b)} with battery</div>` : '');
  $('pl-tiles').innerHTML = `
    <div class="tile"><div class="v">${pct(t.autarky)}</div><div class="l">self-sufficiency (autarky)</div>${delta(t.autarky, n.autarky, v => `+${fmt(v * 100)} pp`)}</div>
    <div class="tile"><div class="v">${pct(t.selfConsumption)}</div><div class="l">of the PV used at home</div>${delta(t.selfConsumption, n.selfConsumption, v => `+${fmt(v * 100)} pp`)}</div>
    <div class="tile"><div class="v">${fmt(t.imported)} kWh</div><div class="l">bought from the grid (of ${fmt(t.demand)} kWh)</div></div>
    <div class="tile"><div class="v">${fmt(t.exported)} kWh</div><div class="l">fed in${t.curtailed > 0.5 ? `, ${fmt(t.curtailed)} kWh curtailed` : ''}</div></div>
    <div class="tile"><div class="v">${eur(t.savings)}</div><div class="l">saved per year vs. no PV</div>${delta(t.savings, n.savings, v => `+${eur(v)}`)}</div>`;

  const row = (label, r, cls = '') => `<tr class="${cls}"><td>${label}</td>
    <td>${fmt(r.imported)}</td><td>${fmt(r.exported)}</td><td>${pct(r.autarky)}</td><td>${r.pv ? pct(r.selfConsumption) : '–'}</td>
    <td>${eur(r.importCost)}</td><td>${eur(r.revenue)}</td><td>${eur(r.importCost - r.revenue)}</td><td>${eur(r.savings)}</td></tr>`;
  const noPv = { imported: t.demand, exported: 0, autarky: 0, pv: 0, importCost: t.costNoPv, revenue: 0, savings: 0 };
  const capTot = inp.batteries.reduce((a, b) => a + (b.sections.length ? b.capacityKwh : 0), 0);
  $('pl-compare').innerHTML = `<table class="pl">
    <tr><th></th><th>Grid import kWh</th><th>Feed-in kWh</th><th>Autarky</th><th>PV used at home</th><th>Electricity bill</th><th>Feed-in revenue</th><th>Net cost</th><th>Savings</th></tr>
    ${row('No PV', noPv)}${row('PV, no battery', n, hasBat ? '' : 'best')}${hasBat ? row(`PV + ${fmt(capTot, 1)} kWh battery`, t, 'best') : ''}
  </table><div class="pl-note">PV production ${fmt(t.pv)} kWh in weather year ${lastRun.year}; demand ${fmt(t.demand)} kWh. Bill = energy part only (no base fee).</div>`;

  renderMonthlyBalance(withBat.monthly);
  renderWeek();
  renderBatteryTable();
  $('pl-notes').innerHTML = `Simulated in 15-minute steps over one year: PV from PVGIS hourly data for ${lastRun.year} (SARAH3), calendar and prices 2025.
    Batteries charge only from the surplus of their own sections and discharge to cover the household's demand; no charging from the grid and no price-based optimisation.
    Hourly PV and smooth household profiles miss short load peaks and passing clouds, so autarky and self-consumption are upper estimates (typically a few percentage points high).
    Price data: Bundesnetzagentur | SMARD.de (CC BY 4.0), via energy-charts.info.`;
}

function renderMonthlyBalance(monthly) {
  const W = 960, H = 300, mL = 46, mB = 24, mT = 10;
  const maxV = Math.max(...monthly.map(m => Math.max(m.demand, m.pv))) * 1.08 || 1;
  const y = v => mT + (H - mT - mB) * (1 - v / maxV);
  const bw = (W - mL - 20) / 12;
  const step = niceStep(maxV);
  const C = { direct: css('--s3'), battery: css('--s4'), grid: css('--s8'), export: css('--s1'), curtailed: css('--baseline') };
  const segs = [];
  let g = '';
  for (let v = 0; v <= maxV; v += step) g += `<line x1="${mL}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" stroke="${css('--grid')}"/><text x="${mL - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  monthly.forEach((m, i) => {
    const bars = [
      [['direct', m.direct, 'Used directly'], ['battery', m.discharged, 'From battery'], ['grid', m.imported, 'From grid']],
      [['direct', m.direct, 'Used directly'], ['battery', m.charged, 'Into battery'], ['export', m.exported, 'Fed in'], ['curtailed', m.curtailed, 'Curtailed']],
    ];
    bars.forEach((parts, bi) => {
      let acc = 0;
      const x = mL + bw * i + bw * (bi ? 0.5 : 0.14);
      parts.forEach(([k, v, label]) => {
        if (v <= 0) return;
        segs.push({ x, w: bw * 0.36, y: y(acc + v), h: y(acc) - y(acc + v), fill: C[k],
          tip: `${MONTHS[i]} — ${bi ? 'PV' : 'demand'}\n${label}: ${fmt(v)} kWh\n(${bi ? `PV ${fmt(m.pv)}` : `demand ${fmt(m.demand)}`} kWh)` });
        acc += v;
      });
    });
    g += `<text x="${mL + bw * i + bw / 2}" y="${H - 6}" text-anchor="middle">${MONTHS[i]}</text>`;
  });
  const svg = svgEl(W, H, g + segs.map((s, i) => `<rect data-i="${i}" x="${s.x}" y="${s.y}" width="${s.w}" height="${Math.max(0, s.h - 0.5)}" fill="${s.fill}"/>`).join('')
    + `<line x1="${mL}" x2="${W - 10}" y1="${y(0)}" y2="${y(0)}" stroke="${css('--baseline')}"/>`);
  svg.addEventListener('mousemove', e => { const s = segs[e.target.dataset?.i]; if (s) showTip(e, s.tip); else hideTip(); });
  svg.addEventListener('mouseleave', hideTip);
  $('pl-monthly').replaceChildren(svg);
  $('pl-mlegend').innerHTML = [['Used directly', C.direct], ['Battery', C.battery], ['From grid', C.grid], ['Fed in', C.export], ['Curtailed', C.curtailed]]
    .map(([l, c]) => `<span><span class="chip" style="background:${c}"></span>${l}</span>`).join('');
}

function hourly(series, q0, hours, key, mode = 'sum') {
  const out = new Array(hours).fill(0);
  for (let h = 0; h < hours; h++) {
    for (let k = 0; k < 4; k++) {
      const q = q0 + h * 4 + k;
      if (q >= P.STEPS) break;
      const v = key ? series[key][q] : series[q];
      out[h] = mode === 'last' ? v : out[h] + (mode === 'mean' ? v / 4 : v);
    }
  }
  return out;
}

function renderWeek() {
  const { withBat, inp } = lastRun;
  const s = withBat.series;
  $('pl-wk').value = weekIdx;
  const tz = inp.tz;
  // weeks start on Monday (2025-01-06 is the first Monday), at local midnight
  const startDay = 5 + weekIdx * 7;
  const q0 = Math.max(0, startDay * 96 - 4 * P.utcOffsetHours(startDay * 96, tz));
  const H = 168;
  const pv = hourly(s, q0, H, 'pv'), dem = hourly(s, q0, H, 'demand'), imp = hourly(s, q0, H, 'imported'),
        exp = hourly(s, q0, H, 'exported'), soc = hourly(s, q0, H, 'soc', 'last'), buy = hourly(inp.buy, q0, H, null, 'mean');
  const cap = withBat.capacityKwh;
  const W = 960, Ht = 280, mL = 40, mR = cap > 0 ? 40 : 10, mB = 22, mT = 10;
  const maxV = Math.max(0.5, ...pv, ...dem) * 1.1;
  const x = h => mL + (W - mL - mR) * h / H, y = v => mT + (Ht - mT - mB) * (1 - v / maxV);
  const ys = f => mT + (Ht - mT - mB) * (1 - f);
  let g = '';
  const st = niceStep(maxV), dec = st < 0.1 ? 2 : st < 1 ? (st * 10 % 1 ? 2 : 1) : 0;
  for (let v = 0; v <= maxV; v += st) g += `<line x1="${mL}" x2="${W - mR}" y1="${y(v)}" y2="${y(v)}" stroke="${css('--grid')}"/><text x="${mL - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v, dec)}</text>`;
  g += `<text x="${mL - 6}" y="${mT - 1}" text-anchor="end">kW</text>`;
  if (cap > 0) for (const f of [0, 0.5, 1]) g += `<text x="${W - mR + 6}" y="${ys(f) + 4}">${f * 100}%</text>`;
  for (let d = 0; d <= 7; d++) {
    g += `<line x1="${x(d * 24)}" x2="${x(d * 24)}" y1="${mT}" y2="${Ht - mB}" stroke="${css('--grid')}"/>`;
    if (d < 7) {
      const date = new Date(Date.UTC(P.YEAR, 0, 1 + startDay + d));
      g += `<text x="${x(d * 24 + 12)}" y="${Ht - 6}" text-anchor="middle">${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</text>`;
    }
  }
  const line = arr => arr.map((v, h) => `${x(h)},${y(v)} ${x(h + 1)},${y(v)}`).join(' ');
  g += `<polygon points="${x(0)},${y(0)} ${line(pv)} ${x(H)},${y(0)}" fill="${css('--s4')}" opacity="0.35"/>`;
  g += `<polyline points="${line(pv)}" fill="none" stroke="${css('--s4')}" stroke-width="1.5"/>`;
  g += `<polygon points="${x(0)},${y(0)} ${line(imp)} ${x(H)},${y(0)}" fill="${css('--s8')}" opacity="0.35"/>`;
  g += `<polyline points="${line(dem)}" fill="none" stroke="${css('--text-primary')}" stroke-width="1.5"/>`;
  if (cap > 0) g += `<polyline points="${soc.map((v, h) => `${x(h + 1)},${ys(v / cap)}`).join(' ')}" fill="none" stroke="${css('--s3')}" stroke-width="2" stroke-dasharray="5 3"/>`;
  g += `<line id="pl-cursor" x1="0" x2="0" y1="${mT}" y2="${Ht - mB}" stroke="${css('--muted')}" visibility="hidden"/>`;
  const svg = svgEl(W, Ht, g);
  svg.addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect();
    const h = Math.floor(((e.clientX - r.left) * W / r.width - mL) / (W - mL - mR) * H);
    const cur = svg.querySelector('#pl-cursor');
    if (h < 0 || h >= H) { hideTip(); cur.setAttribute('visibility', 'hidden'); return; }
    cur.setAttribute('x1', x(h + 0.5)); cur.setAttribute('x2', x(h + 0.5)); cur.setAttribute('visibility', 'visible');
    const date = new Date(Date.UTC(P.YEAR, 0, 1 + startDay + Math.floor(h / 24)));
    showTip(e, `${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}, ${h % 24}:00–${h % 24 + 1}:00
PV ${fmt(pv[h], 2)} kWh · demand ${fmt(dem[h], 2)} kWh
grid import ${fmt(imp[h], 2)} · feed-in ${fmt(exp[h], 2)} kWh${cap > 0 ? `\nbattery ${fmt(soc[h], 1)} kWh (${fmt(soc[h] / cap * 100)} %)` : ''}
price ${fmt(buy[h] * 100, 1)} ct/kWh`);
  });
  svg.addEventListener('mouseleave', () => { hideTip(); svg.querySelector('#pl-cursor').setAttribute('visibility', 'hidden'); });
  $('pl-weekchart').replaceChildren(svg);
  $('pl-wlegend').innerHTML = [['PV', css('--s4')], ['Demand', css('--text-primary')], ['Grid import', css('--s8')]]
    .concat(cap > 0 ? [['Battery charge (right axis)', css('--s3')]] : [])
    .map(([l, c]) => `<span><span class="chip" style="background:${c}"></span>${l}</span>`).join('');
}
$('pl-wk').addEventListener('input', () => { weekIdx = +$('pl-wk').value; if (lastRun) renderWeek(); });
results.querySelector('.pl-btns').addEventListener('click', e => {
  if (e.target.dataset.w == null) return;
  weekIdx = +e.target.dataset.w;
  if (lastRun) renderWeek();
});

function renderBatteryTable() {
  const { withBat, inp } = lastRun;
  const secs = sectionList();
  const rows = inp.batteries.map((b, i) => {
    const pb = withBat.perBattery[i];
    const names = b.sections.map(si => `<span class="chip" style="background:${SER(si)}"></span>${esc(secs[si]?.name ?? '')}`).join(' ');
    return `<tr><td>${esc(b.name)}</td><td>${fmt(b.capacityKwh, 1)} kWh</td><td>${fmt(b.powerKw, 1)} kW</td>
      <td style="text-align:left">${names || '<span class="pl-note">no sections</span>'}</td>
      <td>${fmt(pb.charged)}</td><td>${fmt(pb.discharged)}</td><td>${fmt(pb.cycles)}</td><td>${fmt(pb.losses)}</td></tr>`;
  });
  $('pl-batcard').style.display = rows.length ? '' : 'none';
  $('pl-battab').innerHTML = `<table class="pl"><tr><th>Battery</th><th>Capacity</th><th>Power</th><th style="text-align:left">Charged by</th>
    <th>Charged kWh</th><th>Discharged kWh</th><th>Full cycles/yr</th><th>Losses kWh</th></tr>${rows.join('')}</table>`;
}

$('pl-dlsim').addEventListener('click', () => {
  if (!lastRun) return;
  const s = lastRun.withBat.series, buy = lastRun.inp.buy, sell = lastRun.inp.sell;
  let csv = 'utc_time,pv_kwh,demand_kwh,grid_import_kwh,feed_in_kwh,battery_kwh,buy_ct_per_kwh,sell_ct_per_kwh\n';
  for (let h = 0; h < P.STEPS / 4; h++) {
    const q = h * 4;
    let pv = 0, d = 0, im = 0, ex = 0, b = 0, se = 0;
    for (let k = 0; k < 4; k++) { pv += s.pv[q + k]; d += s.demand[q + k]; im += s.imported[q + k]; ex += s.exported[q + k]; b += buy[q + k] / 4; se += sell[q + k] / 4; }
    const t = new Date(Date.UTC(P.YEAR, 0, 1) + h * 3600000).toISOString().slice(0, 16).replace('T', ' ');
    csv += `${t},${pv.toFixed(4)},${d.toFixed(4)},${im.toFixed(4)},${ex.toFixed(4)},${s.soc[q + 3].toFixed(3)},${(b * 100).toFixed(2)},${(se * 100).toFixed(2)}\n`;
  }
  download(`power_planner_${lastRun.year}.csv`, csv);
});

/* =============================================================== helpers */

function svgEl(W, H, inner) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', `0 0 ${W} ${H}`);
  s.style.width = '100%';
  s.innerHTML = inner;
  return s;
}
function niceStep(max) { const raw = max / 5, p = Math.pow(10, Math.floor(Math.log10(raw))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p; return p * 10; }
function showTip(e, text) {
  const tip = $('tooltip');
  tip.style.display = 'block'; tip.textContent = text;
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = (e.clientY + 10) + 'px';
}
function hideTip() { $('tooltip').style.display = 'none'; }
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

/* ======================================================= config hooks */

window.pvExt = {
  getConfig() {
    const secs = sectionList();
    return {
      mode,
      planner: {
        ...pl,
        batteries: pl.batteries.map(({ sids, ...b }) => ({
          ...b, sections: sids.map(sid => secs.findIndex(s => s.sid === sid)).filter(i => i >= 0),
        })),
      },
    };
  },
  setConfig(cfg) {
    if (!cfg.planner) {
      // config from before the planner existed: defaults, battery on all (rebuilt) sections
      pl = DEFAULT_PLANNER();
      syncSids();
    } else {
      const d = DEFAULT_PLANNER();
      const p = cfg.planner;
      pl = {
        ...d, ...p,
        demand: { ...d.demand, ...p.demand }, buy: { ...d.buy, ...p.buy }, sell: { ...d.sell, ...p.sell },
        batteries: d.batteries,
      };
      if (Array.isArray(p.batteries)) {
        const secs = sectionList();
        pl.batteries = p.batteries.map(({ sections = [], ...b }) => ({
          name: 'Battery', capacityKwh: 5, powerKw: 2.5, efficiencyPct: 90, ...b,
          sids: sections.map(i => secs[i]?.sid).filter(Boolean),
        }));
      }
    }
    setMode(cfg.mode || 'basic');
    syncInputs();
    renderBatteries();
  },
};

syncInputs();
setMode('basic');
renderBatteries();
