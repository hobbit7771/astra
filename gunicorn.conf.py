"""Gunicorn configuration - loaded AUTOMATICALLY from the repo root by
gunicorn itself (its `--config` option defaults to `./gunicorn.conf.py`),
with no CLI flags or extra Start Command needed.

Why this file exists: Render's Python auto-detect guessed a Start Command
of `gunicorn app:app` when the service was created (it saw a Flask-shaped
app.py). That Start Command is saved as an explicit override in the Render
service and does not update itself when Procfile or render.yaml changes -
so the fix has to work FROM WITHIN that fixed `gunicorn app:app`
invocation, not by trying to change it.

Three problems that alone would each break `gunicorn app:app`:
  1. gunicorn's default worker is a synchronous WSGI worker. Astra
     (astra_app.py) is an ASGI app (FastAPI) - a bare WSGI worker cannot
     call it correctly. Fixed below by setting `worker_class` to
     Uvicorn's ASGI-capable gunicorn worker.
  2. `app:app` needs `app.py` at the repo root to expose a working `app`
     object - see app.py's own docstring for how that's wired to Astra.
  3. Astra starts its engine from a FastAPI lifespan hook. Uvicorn's
     worker runs lifespan events; gunicorn's own workers do not, so
     without `worker_class` the process would come up with no engine
     even if the import succeeded.
"""

import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"
worker_class = "uvicorn.workers.UvicornWorker"
workers = int(os.environ.get("WEB_CONCURRENCY", "1"))
