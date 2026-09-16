"""Standalone deployment smoke tests, without opening exchange connections."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import astra_app
from t3_engine.lead_engine import api


@pytest.mark.parametrize('enabled', [False, True])
def test_standalone_startup_flag_routes_and_paper_journal(monkeypatch, tmp_path, enabled):
    engine = SimpleNamespace(config=SimpleNamespace(enabled=enabled),
        states={'INJUSDT': object()}, paper=None, start=Mock(return_value=True), stop=Mock())
    monkeypatch.setattr(astra_app, 'get_engine', lambda: engine)
    monkeypatch.setattr(api, 'get_engine', lambda: engine)
    monkeypatch.setenv('LEAD_ENGINE_ENABLED', str(enabled).lower())
    monkeypatch.setenv('ASTRA_PAPER_DB', str(tmp_path / 'paper.sqlite3'))
    with TestClient(astra_app.app) as client:
        assert client.get('/api/health').json()['engine_enabled'] == enabled
        assert 'Astra' in client.get('/').text
        assert client.get('/lead-engine/INJUSDT').status_code == 200
        assert client.get('/lead-engine/UNKNOWN').status_code == 404
        assert client.get('/paper').status_code == 200
        assert client.get('/static/lead_chart_math.js').status_code == 200
        payload = client.get('/api/lead-engine/paper').json()
        if enabled:
            engine.start.assert_called_once()
            assert payload['mode'] == 'PAPER'
            assert payload['closed_count'] == 0
            assert payload['equity'] == 10000
        else:
            engine.start.assert_not_called()
            assert payload['enabled'] is False
    engine.stop.assert_called_once()
    if enabled:
        assert not engine.paper.journal.thread.is_alive()


def test_app_module_entrypoint_serves_astra_not_the_legacy_dashboard():
    """`gunicorn app:app` is what the Render service actually runs.

    Its Start Command was auto-detected at service creation and does not
    follow Procfile or render.yaml, so `app:app` resolving to anything
    other than Astra means the deployed URL serves a different
    application - which is how the legacy Elliott dashboard ended up on
    the Astra domain with the engine reported as OFF."""
    import app as process_manager_entrypoint
    from t3_engine.dashboard.server import app as legacy_dashboard

    assert process_manager_entrypoint.app is astra_app.app
    assert process_manager_entrypoint.app is not legacy_dashboard
    assert process_manager_entrypoint.app.title == 'Astra Market Lead Engine'
