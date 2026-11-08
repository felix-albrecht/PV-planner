"""Re-record tests/fixtures/pvgis.json from the live PVGIS API.

Runs every case in cases.json through the Flask app with real HTTP calls and
saves each PVGIS response. Run after changing cases.json or the PVGIS calls:

    python tests/record_fixtures.py
"""

import json
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app  # noqa: E402
from pvgis_mock import CASES, FIXTURES, request_key, strip_meta  # noqa: E402


def main():
    recorded = {}
    real_get = requests.get

    def recording_get(url, params=None, **kwargs):
        r = real_get(url, params=params, **kwargs)
        if url.startswith(app.PVGIS_BASE) and r.status_code == 200:
            recorded[request_key(url, params or {})] = strip_meta(r.json())
        return r

    app.requests.get = recording_get
    client = app.app.test_client()
    for name, body in CASES.items():
        resp = client.post("/api/calculate", json=body)
        if resp.status_code != 200:
            sys.exit(f"{name}: {resp.status_code} {resp.get_json()}")
        print(f"{name}: {resp.get_json()['total_annual_kwh']:.2f} kWh/yr")

    FIXTURES.parent.mkdir(exist_ok=True)
    FIXTURES.write_text(json.dumps(recorded, indent=0, sort_keys=True))
    print(f"wrote {len(recorded)} responses to {FIXTURES}")


if __name__ == "__main__":
    main()
