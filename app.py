"""PV production prediction webapp.

Multiple panel sections (each with own kWp / tilt / azimuth / loss /
PV technology / mounting type) are
simulated via the PVGIS v5.3 API (hourly seriescalc, SARAH3 satellite data,
terrain horizon shadowing from DEM by default, optional custom horizon).

Run with:  python app.py   then open http://127.0.0.1:5001
"""

import calendar
from functools import lru_cache

import requests
from flask import Flask, jsonify, request, send_from_directory

PVGIS_URL = "https://re.jrc.ec.europa.eu/api/v5_3/seriescalc"
HORIZON_URL = "https://re.jrc.ec.europa.eu/api/v5_3/printhorizon"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

START_YEAR = 2005
END_YEAR = 2023
N_YEARS = END_YEAR - START_YEAR + 1

# PVGIS pvtechchoice / mountingplace values
PV_TECHS = {"crystSi", "CIS", "CdTe", "Unknown"}
MOUNTINGS = {"free", "building"}

app = Flask(__name__, static_folder="static")


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


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


@lru_cache(maxsize=256)
def pvgis_series(lat, lon, kwp, tilt, aspect, loss, userhorizon, pvtech, mounting):
    """One PVGIS seriescalc call. Returns list of (month, hour_utc, power_W)."""
    params = {
        "lat": lat,
        "lon": lon,
        "pvcalculation": 1,
        "peakpower": kwp,
        "loss": loss,
        "angle": tilt,
        "aspect": aspect,
        "pvtechchoice": pvtech,
        "mountingplace": mounting,
        "startyear": START_YEAR,
        "endyear": END_YEAR,
        "outputformat": "json",
    }
    if userhorizon:
        params["userhorizon"] = userhorizon
    r = requests.get(PVGIS_URL, params=params, timeout=120)
    if r.status_code != 200:
        raise RuntimeError(f"PVGIS error {r.status_code}: {r.text[:300]}")
    data = r.json()
    out = []
    for rec in data["outputs"]["hourly"]:
        t = rec["time"]  # e.g. "20230101:0010" (UTC)
        month = int(t[4:6])
        hour = int(t[9:11])
        out.append((month, hour, rec["P"]))
    return out


@lru_cache(maxsize=64)
def pvgis_horizon(lat, lon):
    r = requests.get(
        HORIZON_URL,
        params={"lat": lat, "lon": lon, "outputformat": "json"},
        timeout=60,
    )
    r.raise_for_status()
    prof = r.json()["outputs"]["horizon_profile"]
    return [(p["A"], p["H_hor"]) for p in prof]


@app.route("/api/calculate", methods=["POST"])
def calculate():
    body = request.get_json(force=True)
    lat = round(float(body["lat"]), 4)
    lon = round(float(body["lon"]), 4)
    userhorizon = (body.get("userhorizon") or "").strip()
    tz_offset = round(lon / 15.0)  # crude solar time zone, no DST

    sections_out = []
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
            series = pvgis_series(lat, lon, kwp, tilt, aspect, loss, userhorizon,
                                  pvtech, mounting)
        except RuntimeError as e:
            return jsonify({"error": f"{name}: {e}"}), 502

        # Sum energy per (month, local hour); each sample is 1 h -> P in W == Wh
        sums = [[0.0] * 24 for _ in range(12)]
        for month, hour_utc, p in series:
            h_local = (hour_utc + tz_offset) % 24
            sums[month - 1][h_local] += p

        month_hour = [
            [sums[m][h] / (N_YEARS * calendar.monthrange(2023, m + 1)[1]) for h in range(24)]
            for m in range(12)
        ]
        monthly_kwh = [sum(row) * calendar.monthrange(2023, m + 1)[1] / 1000.0
                       for m, row in enumerate(month_hour)]

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
        "years": f"{START_YEAR}-{END_YEAR}",
        "horizon": horizon,
        "horizon_source": "user-supplied" if userhorizon else "DEM-calculated (PVGIS)",
        "sections": sections_out,
        "total_monthly_kwh": total_monthly,
        "total_month_hour_wh": total_month_hour,
        "total_annual_kwh": sum(total_monthly),
    })


if __name__ == "__main__":
    app.run(debug=True, port=5001)
