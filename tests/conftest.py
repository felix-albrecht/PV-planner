import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app as app_module  # noqa: E402
from pvgis_mock import FakePVGIS  # noqa: E402


def _clear_caches():
    for fn in (app_module.pvgis_monthly, app_module.pvgis_daily_profile, app_module.pvgis_horizon):
        fn.cache_clear()


@pytest.fixture
def pvgis(monkeypatch):
    """Serve PVGIS from recorded fixtures; exposes .calls for inspection."""
    fake = FakePVGIS()
    monkeypatch.setattr(app_module.requests, "get", fake)
    _clear_caches()
    yield fake
    _clear_caches()


@pytest.fixture
def client():
    return app_module.app.test_client()


@pytest.fixture
def live():
    """Real PVGIS calls (only for tests marked 'live')."""
    _clear_caches()
    yield
    _clear_caches()
