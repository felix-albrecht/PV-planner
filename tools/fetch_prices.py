"""Download one year of day-ahead prices for the power planner.

Writes github-pages/data/prices_<zone>_<year>.json: one value per 15 minutes
(UTC, non-leap year layout, 35040 values) in EUR/MWh. Hourly prices (before
the switch to 15-minute products on 2025-10-01) are repeated for each quarter.

Source: api.energy-charts.info (Fraunhofer ISE), data CC BY 4.0 from
Bundesnetzagentur | SMARD.de.

    python tools/fetch_prices.py            # DE-LU 2025
    python tools/fetch_prices.py 2026 DE-LU
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

STEPS = 365 * 96
OUT_DIR = Path(__file__).resolve().parents[1] / "github-pages" / "data"


def main(year=2025, zone="DE-LU"):
    r = requests.get(
        "https://api.energy-charts.info/price",
        params={"bzn": zone, "start": f"{year}-01-01T00:00Z", "end": f"{year + 1}-01-01T00:00Z"},
        timeout=60,
    )
    r.raise_for_status()
    d = r.json()
    t, p = d["unix_seconds"], d["price"]
    t0 = datetime(year, 1, 1, tzinfo=timezone.utc).timestamp()
    leap = (year % 4 == 0 and year % 100 != 0) or year % 400 == 0
    feb29 = datetime(year, 2, 29, tzinfo=timezone.utc).timestamp() if leap else None

    values = [None] * STEPS
    ends = t[1:] + [t0 + (366 if leap else 365) * 86400]
    for start, end, price in zip(t, ends, p):
        if price is None:
            continue
        for s in range(int(start), int(end), 900):
            if feb29 and feb29 <= s < feb29 + 86400:
                continue  # drop Feb 29 to keep a 365-day layout
            q = int((s - t0) // 900) - (96 if feb29 and s >= feb29 + 86400 else 0)
            if 0 <= q < STEPS:
                values[q] = round(price, 2)

    missing = sum(v is None for v in values)
    if missing > 96:
        sys.exit(f"{missing} quarters without price data")
    last = next(v for v in values if v is not None)
    for i, v in enumerate(values):  # fill rare gaps with the previous value
        values[i] = last = v if v is not None else last

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"prices_{zone}_{year}.json"
    out.write_text(json.dumps({
        "zone": zone, "year": year, "unit": "EUR/MWh", "step_minutes": 15, "time": "UTC",
        "source": "Day-ahead auction prices via api.energy-charts.info",
        "license": d.get("license_info", "CC BY 4.0 Bundesnetzagentur | SMARD.de"),
        "values": values,
    }, separators=(",", ":")))
    mean = sum(values) / len(values)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB), mean {mean:.1f} EUR/MWh, {missing} gaps filled")


if __name__ == "__main__":
    args = sys.argv[1:]
    main(int(args[0]) if args else 2025, args[1] if len(args) > 1 else "DE-LU")
