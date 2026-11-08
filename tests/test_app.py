"""Tests for the Flask app and for parity with the JS port (github-pages/).

Default tests run offline on recorded PVGIS responses. Tests marked 'live'
call the real PVGIS API:   pytest -m live
"""

import calendar
import copy
import json
import shutil
import subprocess

import pytest

from conftest import ROOT, app_module
from pvgis_mock import CASES, FakeResponse

DAYS = [calendar.monthrange(2023, m + 1)[1] for m in range(12)]


def calc(client, body):
    r = client.post("/api/calculate", json=body)
    return r.status_code, r.get_json()


# ---------------------------------------------------------------- Flask, offline

def test_monthly_energy_comes_from_pvcalc(client, pvgis):
    status, d = calc(client, CASES["three_sections"])
    assert status == 200
    south = d["sections"][0]
    pvcalc = pvgis.fixtures[
        "PVcalc?angle=35&aspect=0&lat=48.08&lon=11.41&loss=14&mountingplace=free&peakpower=4&pvtechchoice=crystSi"]
    assert south["monthly_kwh"] == [m["E_m"] for m in pvcalc["outputs"]["monthly"]["fixed"]]
    assert d["years"] == "2005-2023"


def test_hourly_profile_adds_up_to_monthly_energy(client, pvgis):
    _, d = calc(client, CASES["three_sections"])
    for s in d["sections"]:
        for m in range(12):
            assert sum(s["month_hour_wh"][m]) * DAYS[m] / 1000 == pytest.approx(s["monthly_kwh"][m])
        assert s["annual_kwh"] == pytest.approx(sum(s["monthly_kwh"]))


def test_totals_are_sum_of_sections(client, pvgis):
    _, d = calc(client, CASES["three_sections"])
    assert d["total_annual_kwh"] == pytest.approx(sum(s["annual_kwh"] for s in d["sections"]))
    for m in range(12):
        for h in range(24):
            assert d["total_month_hour_wh"][m][h] == pytest.approx(
                sum(s["month_hour_wh"][m][h] for s in d["sections"]))


def test_hours_are_shifted_to_local_solar_time(client, pvgis):
    _, d = calc(client, CASES["three_sections"])
    assert d["tz_offset"] == 1  # lon 11.41 -> UTC+1
    south = d["sections"][0]["month_hour_wh"]
    june_peak = max(range(24), key=lambda h: south[5][h])
    assert 11 <= june_peak <= 13
    assert south[5][0] == 0 and south[11][17] == 0  # night


def test_east_section_produces_in_the_morning(client, pvgis):
    _, d = calc(client, CASES["three_sections"])
    east = d["sections"][1]["month_hour_wh"][5]
    assert sum(east[:12]) > sum(east[12:])


def test_tech_and_mounting_are_sent_with_defaults(client, pvgis):
    calc(client, CASES["three_sections"])
    pvcalc = [p for ep, p in pvgis.calls if ep == "PVcalc"]
    assert [(p["pvtechchoice"], p["mountingplace"]) for p in pvcalc] == [
        ("crystSi", "free"), ("CIS", "building"), ("crystSi", "free")]


def test_azimuth_is_converted_to_pvgis_aspect(client, pvgis):
    calc(client, CASES["three_sections"])
    aspects = [p["aspect"] for ep, p in pvgis.calls if ep == "PVcalc"]
    assert aspects == [0, -90, 20]  # 180 (S) -> 0, 90 (E) -> -90, 200 -> 20


def test_user_horizon_goes_to_both_calls(client, pvgis):
    status, d = calc(client, CASES["user_horizon"])
    assert status == 200
    assert d["horizon_source"] == "user-supplied"
    sent = {ep: p.get("userhorizon") for ep, p in pvgis.calls if ep in ("PVcalc", "DRcalc")}
    assert sent == {"PVcalc": "0,0,30,30,30,30,0,0", "DRcalc": "0,0,30,30,30,30,0,0"}


def test_empty_user_horizon_is_not_sent(client, pvgis):
    calc(client, CASES["three_sections"])
    assert all("userhorizon" not in p for _, p in pvgis.calls)


def test_user_horizon_reduces_yield(client, pvgis):
    _, with_terrain = calc(client, CASES["three_sections"])
    _, with_user = calc(client, CASES["user_horizon"])
    assert with_user["sections"][0]["annual_kwh"] < 0.9 * with_terrain["sections"][0]["annual_kwh"]


def test_same_orientation_reuses_daily_profile(client, pvgis):
    body = copy.deepcopy(CASES["three_sections"])
    body["sections"] = [body["sections"][0], {**body["sections"][0], "name": "copy"}]
    calc(client, body)
    assert sum(1 for ep, _ in pvgis.calls if ep == "DRcalc") == 1


@pytest.mark.parametrize("field,value", [("pvtech", "perovskite"), ("mounting", "roof")])
def test_invalid_tech_or_mounting_is_rejected(client, pvgis, field, value):
    body = copy.deepcopy(CASES["user_horizon"])
    body["sections"][0][field] = value
    status, d = calc(client, body)
    assert status == 400
    assert "South roof" in d["error"]
    assert pvgis.calls == []


def test_pvgis_error_is_reported_per_section(client, monkeypatch):
    monkeypatch.setattr(app_module.requests, "get",
                        lambda *a, **k: FakeResponse(400, text='{"message":"Location over the sea"}'))
    app_module.pvgis_monthly.cache_clear()
    status, d = calc(client, CASES["user_horizon"])
    assert status == 502
    assert d["error"].startswith("South roof: PVGIS PVcalc error 400")
    assert "over the sea" in d["error"]


def test_horizon_profile_is_returned(client, pvgis):
    _, d = calc(client, CASES["three_sections"])
    assert len(d["horizon"]) > 8
    assert all(len(p) == 2 for p in d["horizon"])


def test_geocode_requires_query(client):
    r = client.get("/api/geocode?q=")
    assert r.status_code == 400


# ---------------------------------------------------------------- Flask vs JS

def run_js_engine(*args):
    if not shutil.which("node"):
        pytest.skip("node not installed")
    out = subprocess.run(["node", str(ROOT / "tests" / "run_engine.mjs"), *args],
                         check=True, capture_output=True, text=True, timeout=300)
    return json.loads(out.stdout)


def assert_same_result(flask, js):
    for key in ("lat", "lon", "tz_offset", "years", "horizon_source"):
        assert js[key] == flask[key], key
    assert js["horizon"] == [list(p) for p in flask["horizon"]]
    assert len(js["sections"]) == len(flask["sections"])
    for f, j in zip(flask["sections"], js["sections"]):
        for key in ("name", "pvtech", "mounting"):
            assert j[key] == f[key]
        assert j["monthly_kwh"] == pytest.approx(f["monthly_kwh"])
        for m in range(12):
            assert j["month_hour_wh"][m] == pytest.approx(f["month_hour_wh"][m])
    assert js["total_annual_kwh"] == pytest.approx(flask["total_annual_kwh"])


def test_js_engine_matches_flask(client, pvgis):
    js = run_js_engine()
    for name, body in CASES.items():
        status, flask = calc(client, body)
        assert status == 200
        assert_same_result(flask, js[name])


# ---------------------------------------------------------------- live PVGIS

@pytest.mark.live
def test_live_js_engine_matches_flask(client, live):
    js = run_js_engine("--live")
    for name, body in CASES.items():
        status, flask = calc(client, body)
        assert status == 200, flask
        assert_same_result(flask, js[name])


@pytest.mark.live
def test_live_results_are_plausible(client, live):
    """Catches PVGIS API changes; bounds are wide so data updates don't break it."""
    status, d = calc(client, CASES["three_sections"])
    assert status == 200, d
    south = d["sections"][0]
    assert 900 < south["annual_kwh"] / south["kwp"] < 1400  # kWh/kWp in southern Bavaria
    building = d["sections"][1]
    assert building["pvtech"] == "CIS" and building["mounting"] == "building"
    assert d["horizon"], "printhorizon returned no profile"
