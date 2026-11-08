# PV Planner

There are some very nice calculation tools for yearly/monthly/daily PV production, e.g.:
- https://globalsolaratlas.info
- https://re.jrc.ec.europa.eu/pvg_tools

However, none of them are able to create multiple sections with different azimuth, tilt etc. like it is the case for a complex house setup.

This web app lets you create these different sections, then fetch data from the PVGIS v5.3 API and display them nicely. Also, it allows for planning of a PV installation with electricity consumption battery storage and savings prediction.

Try it out at https://felix-albrecht.github.io/PV-planner/

# Installation

Launch a local python webserver:
```python
pip install -r requirements.txt
python app.py
```

Then open the web app:
```
http://localhost:5001
```

## Static version (GitHub Pages)

`github-pages/` contains a server-less version that runs the calculation in the browser and reaches PVGIS through a small Cloudflare Worker. See [github-pages/README.md](github-pages/README.md) for deployment.

# Usage

An example config is stored in `configs/pv_config_example_Berlin.json`.

Search for your location and enter details about the PV system, like peak power, azimuth and tilt.

![Data input](screenshots/input.png)

Then get the solar irradiation data and calculate monthly production, and daily profiles.

## How it is calculated

For each section, two small PVGIS calls (2005–2023 SARAH3 data, terrain horizon):

- `PVcalc` gives the average energy per month (kWh), including temperature, angle-of-incidence and spectral effects for the chosen PV technology and mounting.
- `DRcalc` gives the average daily irradiance profile per month on the panel plane.

Each month's daily profile is scaled so it adds up to that month's energy. Compared with summing 19 years of hourly `seriescalc` data (~15 MB per section), the hourly shares differ by under 0.5 percentage points, at ~25 KB per section.

![PV production histogram](screenshots/histogram.png)

![PV production profile](screenshots/profile.png)

Download the calculated data for further analysis as csv, and the PV config as json.

# Modes

- **Basic**: sections with kWp, tilt, azimuth and losses.
- **Expert**: adds PV technology and mounting type per section.
- **Power planner**: PV + battery planning for a household. Simulates one year in 15-minute steps from PVGIS hourly data (one weather year per run) and gives autarky, self-consumption, grid import, feed-in and money saved, with and without batteries.
  - Demand: constant, a weekly schedule of work / home-office / family days (typical consumption for 1–4 persons), or an uploaded load profile CSV (example download in the app).
  - Batteries: any number, each charged by the sections you click (e.g. a balcony storage on the balcony panels, a home battery on the roof).
  - Prices: fixed, dynamic (real 2025 German day-ahead prices, 15-minute from October, plus fees and VAT), or a custom daily curve / CSV; feed-in fixed or at spot market value.

![Consumption, battery and price settings](screenshots/settings.png)

Generate metrics for how much savings are expected.

![PV savings](screenshots/metrics.png)

View hourly power breakdown based on a year you choose.

![Energy breakdown](screenshots/results.png)

The planner code is shared by both versions: `github-pages/planner-core.js` (calculations) and `github-pages/planner-ui.js` (interface); Flask serves them under `/shared/`. Price data: Bundesnetzagentur | SMARD.de (CC BY 4.0) via energy-charts.info; regenerate with `python tools/fetch_prices.py`.

# Tests

```bash
pip install -r requirements-dev.txt
pytest                                 # Flask app + Flask/JS parity, offline (recorded PVGIS responses)
pytest -m live                         # same parity check against the live PVGIS API
node --test tests/worker.test.mjs tests/planner.test.mjs   # worker rules; planner demand, CSV, prices, battery simulation
```

After changing `tests/cases.json` or the PVGIS calls, re-record the responses with `python tests/record_fixtures.py`.

