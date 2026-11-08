"""PV production prediction webapp.

Multiple panel sections (each with own kWp / tilt / azimuth / loss /
PV technology / mounting type) are simulated via the PVGIS v5.3 API
(SARAH3 satellite data 2005-2023, terrain horizon shadowing from DEM by
default, optional custom horizon). Per section, two small PVGIS calls:

  PVcalc  -> average energy per month (kWh), including all PV losses
  DRcalc  -> average daily irradiance profile per month on the panel plane

Each month's daily profile is scaled so it sums to that month's energy,
giving the mean production per (month, hour).

Run with:  python app.py   then open http://127.0.0.1:5001
"""

import calendar
from functools import lru_cache
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_from_directory

PVGIS_BASE = "https://re.jrc.ec.europa.eu/api/v5_3/"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

# PVGIS pvtechchoice / mountingplace values
PV_TECHS = {"crystSi", "CIS", "CdTe", "Unknown"}
MOUNTINGS = {"free", "building"}

app = Flask(__name__, static_folder="static")


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


# Files shared with the static GitHub Pages version (power planner)
SHARED_DIR = Path(__file__).parent / "github-pages"
SHARED_FILES = {
    "planner-core.js", "planner-ui.js", "site.webmanifest", "favicon.ico",
    "favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png",
    "android-chrome-192x192.png", "android-chrome-512x512.png",
}


@app.route("/shared/<path:name>")
def shared(name):
    if name not in SHARED_FILES and not (name.startswith("data/") and name.endswith(".json")):
        return jsonify({"error": "not found"}), 404
    return send_from_directory(SHARED_DIR, name)


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(SHARED_DIR, "favicon.ico")


@lru_cache(maxsize=64)
def pvgis_seriescalc(query):
    r = requests.get(PVGIS_BASE + "seriescalc", params=dict(query), timeout=120)
    return r.status_code, r.content


@app.route("/api/pvgis/seriescalc")
def seriescalc_proxy():
    """Hourly PV output for ONE year (power planner). Same rules as the worker."""
    args = request.args
    if not args.get("startyear") or args.get("startyear") != args.get("endyear"):
        return jsonify({"error": "startyear and endyear must be the same single year"}), 400
    status, content = pvgis_seriescalc(tuple(sorted(args.items())))
    if status != 200:
        pvgis_seriescalc.cache_clear()  # don't keep errors
    return app.response_class(content, status=status, mimetype="application/json")


@app.route("/api/geocode")
def geocode():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"error": "missing query"}), 400
    r = requests.get(
        NOMINATIM_URL,
        params={"q": q, "format": "json", "limit": 5},
        headers={"User-Agent": "pv-production-webapp/1.0"},
        timeout=15,
    )
    r.raise_for_status()
    results = [
        {"name": hit["display_name"], "lat": float(hit["lat"]), "lon": float(hit["lon"])}
        for hit in r.json()
    ]
    return jsonify({"results": results})


def pvgis_get(endpoint, params):
    if params.get("userhorizon") == "":
        params = {k: v for k, v in params.items() if k != "userhorizon"}
    r = requests.get(PVGIS_BASE + endpoint, params={**params, "outputformat": "json"}, timeout=60)
    if r.status_code != 200:
        raise RuntimeError(f"PVGIS {endpoint} error {r.status_code}: {r.text[:300]}")
    return r.json()


@lru_cache(maxsize=256)
def pvgis_monthly(lat, lon, kwp, tilt, aspect, loss, userhorizon, pvtech, mounting):
    """PVcalc: average energy per month in kWh (12 values) and the data period."""
    data = pvgis_get("PVcalc", {
        "lat": lat, "lon": lon, "peakpower": kwp, "loss": loss,
        "angle": tilt, "aspect": aspect, "pvtechchoice": pvtech,
        "mountingplace": mounting, "userhorizon": userhorizon,
    })
    meteo = data["inputs"]["meteo_data"]
    monthly = [rec["E_m"] for rec in data["outputs"]["monthly"]["fixed"]]
    return monthly, f"{meteo['year_min']}-{meteo['year_max']}"


@lru_cache(maxsize=256)
def pvgis_daily_profile(lat, lon, tilt, aspect, userhorizon):
    """DRcalc: mean irradiance G(i) per (month, UTC hour) on the panel plane, W/m2."""
    data = pvgis_get("DRcalc", {
        "lat": lat, "lon": lon, "month": 0, "global": 1,
        "angle": tilt, "aspect": aspect, "userhorizon": userhorizon,
    })
    g = [[0.0] * 24 for _ in range(12)]
    for rec in data["outputs"]["daily_profile"]:
        g[rec["month"] - 1][int(rec["time"][:2])] = rec["G(i)"]
    return g


@lru_cache(maxsize=64)
def pvgis_horizon(lat, lon):
    prof = pvgis_get("printhorizon", {"lat": lat, "lon": lon})["outputs"]["horizon_profile"]
    return [(p["A"], p["H_hor"]) for p in prof]


@app.route("/api/calculate", methods=["POST"])
def calculate():
    body = request.get_json(force=True)
    lat = round(float(body["lat"]), 4)
    lon = round(float(body["lon"]), 4)
    userhorizon = (body.get("userhorizon") or "").strip()
    tz_offset = round(lon / 15.0)  # crude solar time zone, no DST

    sections_out = []
    years = ""
    # month_hour[m][h] = mean production in Wh for that hour of that month (local time)
    total_month_hour = [[0.0] * 24 for _ in range(12)]

    for sec in body["sections"]:
        name = sec.get("name") or "Section"
        kwp = float(sec["kwp"])
        tilt = float(sec["tilt"])
        azimuth = float(sec["azimuth"])  # compass: 180 = south
        loss = float(sec.get("loss", 14))
        aspect = azimuth - 180.0  # PVGIS convention: 0 = south, 90 = west
        pvtech = sec.get("pvtech", "crystSi")
        mounting = sec.get("mounting", "free")
        if pvtech not in PV_TECHS or mounting not in MOUNTINGS:
            return jsonify({"error": f"{name}: invalid pvtech/mounting"}), 400

        try:
            monthly_kwh, years = pvgis_monthly(lat, lon, kwp, tilt, aspect, loss,
                                               userhorizon, pvtech, mounting)
            g = pvgis_daily_profile(lat, lon, tilt, aspect, userhorizon)
        except RuntimeError as e:
            return jsonify({"error": f"{name}: {e}"}), 502

        # Distribute each month's mean daily energy over the hours in
        # proportion to the irradiance profile, shifted to local solar time.
        month_hour = [[0.0] * 24 for _ in range(12)]
        for m in range(12):
            g_sum = sum(g[m])
            if g_sum <= 0:
                continue
            wh_per_day = monthly_kwh[m] * 1000.0 / calendar.monthrange(2023, m + 1)[1]
            for h_utc, gv in enumerate(g[m]):
                month_hour[m][(h_utc + tz_offset) % 24] = wh_per_day * gv / g_sum

        for m in range(12):
            for h in range(24):
                total_month_hour[m][h] += month_hour[m][h]

        sections_out.append({
            "name": name,
            "kwp": kwp,
            "tilt": tilt,
            "azimuth": azimuth,
            "pvtech": pvtech,
            "mounting": mounting,
            "monthly_kwh": monthly_kwh,
            "month_hour_wh": month_hour,
            "annual_kwh": sum(monthly_kwh),
        })

    total_monthly = [sum(s["monthly_kwh"][m] for s in sections_out) for m in range(12)]

    try:
        horizon = pvgis_horizon(lat, lon)
    except Exception:
        horizon = []

    return jsonify({
        "lat": lat,
        "lon": lon,
        "tz_offset": tz_offset,
        "years": years,
        "horizon": horizon,
        "horizon_source": "user-supplied" if userhorizon else "DEM-calculated (PVGIS)",
        "sections": sections_out,
        "total_monthly_kwh": total_monthly,
        "total_month_hour_wh": total_month_hour,
        "total_annual_kwh": sum(total_monthly),
    })


if __name__ == "__main__":
    app.run(debug=True, port=5001)
