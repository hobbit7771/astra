"""Standalone Astra entrypoint; legacy Analysis/AI startup is never imported."""
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from t3_engine.lead_engine.api import router
from t3_engine.lead_engine.engine import get_engine
from t3_engine.lead_engine.paper_trading import PaperConfig, PaperLedger

STATIC = Path(__file__).parent / 't3_engine' / 'dashboard' / 'static'


@asynccontextmanager
async def lifespan(app):
    engine = get_engine()
    ledger = None
    if engine.config.enabled:
        ledger = PaperLedger(PaperConfig.from_env(), os.getenv('ASTRA_PAPER_DB', 'astra-data/paper.sqlite3'))
        engine.paper = ledger
        if not engine.start():
            ledger.close()
            raise RuntimeError(engine.start_error or 'Astra engine did not start')
    try:
        yield
    finally:
        engine.stop()
        if ledger:
            ledger.close()


app = FastAPI(title='Astra Market Lead Engine', lifespan=lifespan)
app.include_router(router)
app.mount('/static', StaticFiles(directory=STATIC), name='static')


@app.get('/api/health')
def health():
    return {'status':'ok','application':'Astra','build':'ASTRA-001', 'engine_enabled':get_engine().config.enabled}


@app.get('/')
def home():
    return FileResponse(STATIC / 'astra.html', headers={'Cache-Control':'no-store'})


@app.get('/lead-engine/{symbol}')
def workspace(symbol: str):
    if symbol.upper() not in get_engine().states:
        raise HTTPException(404, 'Symbol is not tracked by Astra')
    return FileResponse(STATIC / 'lead_workspace.html', headers={'Cache-Control':'no-store'})


@app.get('/paper')
def journal():
    return FileResponse(STATIC / 'astra_paper.html', headers={'Cache-Control':'no-store'})
