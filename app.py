"""Entry point for process managers that hardcode `app:app`.

Render auto-detected this service's Start Command as `gunicorn app:app`
when the Astra service was created, and a saved Start Command does not
change itself when `Procfile` or `render.yaml` changes. So `app:app` has
to resolve to Astra - otherwise the deployed site is not Astra at all.

That is precisely what went wrong on the first deploy of this repository:
this file used to re-export the legacy T3 Elliott Wave dashboard
(`t3_engine/dashboard/server.py`), the application this repository exists
in order NOT to run. `gunicorn app:app` therefore served the old
Analysis/AI dashboard on the Astra URL, with the Lead Engine reduced to
one tab inside it reporting ENGINE OFF.

Every entry point here now names the same application: `Procfile`,
`render.yaml`, and this file all start `astra_app:app`. `gunicorn.conf.py`
(loaded automatically from the repo root) runs it under Uvicorn's ASGI
worker, because a bare ASGI app cannot be served by gunicorn's default
sync WSGI workers, and that worker also runs the lifespan hook that
starts the engine.

The legacy dashboard module stays importable - its tests still cover it -
it is simply not what any deployment of this repository starts.
"""

from astra_app import app  # noqa: F401
