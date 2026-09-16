# Market Lead Engine: audit at 03182b4

Base: `claude/t3-elliott-wave-engine-gw2gm1`, inspected 2026-09-15.
This records the implementation **before this patch**. Older round-1 audit
documents under `docs/lead-engine/` describe an earlier version.

## Existing boundaries

| Responsibility | Existing implementation |
|---|---|
| WS ingestion | `lead_engine/bybit_ws.py`: socket thread, 12,000-frame queue, ingestion thread, reconnect/resubscribe |
| Book reconstruction | `orderbook_engine.py`: snapshot/delta dictionaries, OBI 1/5/10/25/50, weighted OBI, walls and estimated pulling |
| Flow / CVD / microprice | `trade_flow.py`, `cvd.py`, `microprice.py`, exchange-time `rolling.TimeSeries` |
| Derivatives | `oi_engine.py`: 5-minute REST OI buckets; `liquidation_engine.py`: allLiquidation; ticker funding |
| BTC lead | `btc_leadlag.py`: 1-second returns, correlation and lag 0–8 seconds |
| Structure / Elliott | `smc_engine.py`, `elliott_state.py`: isolated deterministic context; closed bars only |
| PRE-BREAK | `prebreak_engine.py`: fractal support/resistance, tests, compression and flow/book inputs |
| Pressure / calibration | `normalize.py`, `layers.py`, `pressure_engine.py`, `calibration.py`; five layers already exist |
| Signal/state lifecycle | `state.py`: cached, mutating snapshot; `engine.py`: facade; `signal_machine.py`: transitions |
| Recording | `storage.py`: separate lead_engine_* tables, recorder every 15 seconds |
| HTTP / external access | `api.py`, `api_v1.py`, `snapshot.py`, `auth.py`, separate `lead_engine_mcp/` |
| Frontend | Plain JavaScript, **no React/Vue**. `lead_panel.js` coalesces paints at 300 ms, `lead_blocks.js` creates panels |
| Workspace | `/lead-engine/{SYMBOL}`, `lead_workspace.*`, Lightweight Charts 4.1.3; `lead_fib.js` |

All Python paths above are under `t3_engine/lead_engine/`; browser assets
are under `t3_engine/dashboard/static/`. The existing application mounts
these routes/assets. Older analysis, AI, execution and trading modules
remain outside the repair boundary. No LLM is called by this engine.

## Verified defects and consequences

1. Workspace `applyTick()` invents bars from HTTP-polled price and browser
   time. It never consumes Bybit kline OHLC, volume or `confirm`; history
   may race a TF change. `extendEmas()` recalculates the entire close
   history each tick and reseeds after trimming the candle buffer.
2. Fib `setChart()` saves an empty array on first boot, overwriting saved
   drawings before loading. Pending points/visibility cross TF boundaries;
   ratio defaults disagree with checked controls; drawings are unbounded.
3. `allLiquidation.S` is interpreted backwards: Bybit defines Buy as a
   liquidated long position, not a taker buy. NaN and malformed data can
   pass several ingestion checks.
4. Book reconstruction assumes `u` must increment by exactly one; Bybit
   documents update order, not that guarantee. Snapshot replacement can
   reuse a stale sorted-book cache. Empty books can remain `synced`.
5. Ingestion mutates book/state while HTTP/recorder snapshots iterate them.
   Per-symbol WS connected state is never cleared on disconnect. Trade
   receive time is processing time, concealing queued old trades. Missing
   trades, processing backlog and delayed exchange timestamps do not all
   fail the signal gate.
6. CVD slope and microprice use mean-centred z-scores as direction: positive
   buying below its historical mean can score bearish. Transient wall
   weights cancel in the directional ratio (one tiny transient = +1).
   Absorption can score positively with no replenishment. Derivatives
   still use fixed raw thresholds despite normalisation claims.
7. `score_structure()` adds an unsigned range-position term as directional
   evidence. `SmcEngine.state()` mutates trend on every read, turning CHoCH
   into BOS without a new bar. Elliott context increments reset counters
   during reads and may anchor on an old completed sequence.
8. Signal inputs contain confidence but decisions ignore it. Reversal
   precedes conflict checks. Same-state direction/level changes overwrite
   the current object also held in history, retaining the old timestamp.
9. Calibration opens cases before checking health; outage gaps can become
   false outcomes. Overlapping cases are not independent calibration.
   Replay artificially marks missing streams fresh and drops custom layer
   weights. Existing capture has no independently verified live provenance.
10. Engine calculation depends on API viewers; without them the recorder
    calculates once per 15 s. Recording only the current transition misses
    intervening events. Poll requests can overlap and apply obsolete symbol
    responses. Header fields are collected from the wrong DOM root.

## Repair and verification scope

Preserve the existing module and UI design. Fix ingestion/normalisation/
causality first, then connect the existing workspace to real Bybit klines,
make EMA updates incremental and fix drawing persistence. Add regression
tests for observed failures, retain the existing suite, and provide measured
replay/browser results. A 30-minute **live** pass requires a successful real
Bybit connection; replay or a synthetic stream must never be labelled live.

API semantics checked against [Bybit orderbook](https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook),
[klines](https://bybit-exchange.github.io/docs/v5/websocket/public/kline), and
[allLiquidation](https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation).
