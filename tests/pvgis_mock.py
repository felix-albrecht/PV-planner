"""Offline stand-in for the PVGIS API, backed by recorded responses.

Responses live in fixtures/pvgis.json, keyed by request_key(). The same key
format is implemented in run_engine.mjs so the JS engine reads the same file.
"""

import json
import re
from pathlib import Path
from urllib.parse import urlparse

TESTS_DIR = Path(__file__).parent
FIXTURES = TESTS_DIR / "fixtures" / "pvgis.json"
CASES = json.loads((TESTS_DIR / "cases.json").read_text())

_NUM = re.compile(r"-?\d+(\.\d+)?")


def _norm(v):
    """Normalise numbers so Python's 4.0 and JS's 4 give the same key."""
    s = str(v)
    return format(float(s), "g") if _NUM.fullmatch(s) else s


def request_key(url, params):
    endpoint = urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]
    items = sorted((k, _norm(v)) for k, v in params.items() if k != "outputformat")
    return endpoint + "?" + "&".join(f"{k}={v}" for k, v in items)


def strip_meta(data):
    """Drop PVGIS's self-description block to keep fixtures small."""
    return {k: v for k, v in data.items() if k != "meta"}


class FakeResponse:
    def __init__(self, status_code, data=None, text=""):
        self.status_code = status_code
        self._data = data
        self.text = text or json.dumps(data)
        self.content = self.text.encode()

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakePVGIS:
    """Replacement for requests.get that serves recorded PVGIS responses."""

    def __init__(self, fixtures=None):
        self.fixtures = fixtures if fixtures is not None else json.loads(FIXTURES.read_text())
        self.calls = []  # (endpoint, params) for every request made

    def __call__(self, url, params=None, **kwargs):
        params = params or {}
        key = request_key(url, params)
        self.calls.append((key.split("?")[0], dict(params)))
        if key not in self.fixtures:
            raise AssertionError(f"no recorded PVGIS response for {key} "
                                 "(run: python tests/record_fixtures.py)")
        return FakeResponse(200, self.fixtures[key])
