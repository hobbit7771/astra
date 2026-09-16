/* Market Workspace: one symbol, a real chart, and the Lead Engine panel.
 *
 * The three rules that keep it fast:
 *
 *  HISTORY ONCE   candles are fetched once per (symbol, timeframe) and
 *                 `setData` is called once. After that only `update()`
 *                 runs, on the one bar that is forming. Re-sending 500
 *                 candles every tick is the mistake this avoids.
 *  INCREMENTAL    a tick mutates the live bar; a bar closing appends a
 *                 new one. EMAs extend by one point rather than being
 *                 recomputed over the whole series.
 *  THROTTLED      the panel repaints through LeadPanel at ~300ms while
 *                 state is fetched at 500ms — calculation rate and
 *                 display rate are separate, as the brief requires.
 *
 * Markers use the signal's OWN timestamp. A marker is never moved to a
 * better pivot after the fact: that would make every backtest built on
 * this chart a lie, which is why `changed_at` is taken from the engine
 * and never recomputed here.
 */
(function (global) {
  'use strict';

  var TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];
  var TF_SECONDS = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
                     '1h': 3600, '4h': 14400, '1d': 86400 };
  var FETCH_MS = 500;
  var REFRESH_MS = 300;
  var EMA_COLORS = { 9: '#38bdf8', 18: '#34d399', 50: '#fbbf24', 200: '#f472b6' };
  var PREFS_KEY = 'lead_ws_prefs';

  var ws = {
    symbol: null, timeframe: '5m', chart: null, series: null, volume: null,
    emaSeries: {}, candles: [], closes: [], panel: null, fib: null,
    frame: null, timer: null, markers: [], uiLatencyMs: null,
    epoch: 0, socket: null, reconnect: null, ping: null, stopped: false, loading: false,
    buffered: new Map(), chartMessages: 0, reconnects: 0, lastCandleAt: 0,
    restAbort: null, frameAbort: null, observer: null, model: new global.LeadChartMath.CandleModel(1500),
    prefs: { ema: { 9: false, 18: false, 50: true, 200: true },
             volume: true, signals: true },
    fetches: 0, updates: 0, setDataCalls: 0
  };
  global.leadWorkspace = ws;

  function el(id) { return document.getElementById(id); }
  function LP() { return global.LeadPanel; }

  /* ---- preferences -------------------------------------------------- */

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.ema) ws.prefs = parsed;
      }
    } catch (e) { /* defaults are fine */ }
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(ws.prefs)); } catch (e) {}
  }

  /* ---- chart -------------------------------------------------------- */

  function buildChart() {
    var container = el('wsChart');
    ws.chart = LightweightCharts.createChart(container, {
      layout: { background: { color: '#0e1117' }, textColor: '#c7cbd3' },
      grid: { vertLines: { color: '#161b24' }, horzLines: { color: '#161b24' } },
      rightPriceScale: { borderColor: '#232733', scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: '#232733', timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true,
                      vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      localization: { priceFormatter: function (p) { return global.LeadFib.formatPrice(p); } }
    });
    ws.series = ws.chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350'
    });
    ws.volume = ws.chart.addHistogramSeries({
      priceFormat: { type: 'volume' }, priceScaleId: 'vol',
      color: '#233043'
    });
    ws.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    ws.observer = new ResizeObserver(function () {
      if (container.clientWidth) {
        ws.chart.resize(container.clientWidth, container.clientHeight);
      }
      if (ws.events) ws.events.schedule();
    });
    ws.observer.observe(container);
    ws.events = new global.LeadEvents(ws.chart, ws.series, container);

    ws.fib = new global.LeadFib.FibTool({
      chart: ws.chart, series: ws.series, container: container,
      symbol: ws.symbol, timeframe: ws.timeframe,
      ratios: global.LeadFib.RETRACEMENTS,
      onChange: renderFibState
    });
  }

  function emaLine(period) {
    if (ws.emaSeries[period]) return ws.emaSeries[period];
    ws.emaSeries[period] = ws.chart.addLineSeries({
      color: EMA_COLORS[period], lineWidth: period >= 50 ? 2 : 1,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
      title: 'EMA ' + period
    });
    return ws.emaSeries[period];
  }

  ws.ema = global.LeadChartMath.ema;
  function drawEmas() {
    Object.keys(EMA_COLORS).forEach(function (period) {
      var line = ws.emaSeries[period];
      if (!ws.prefs.ema[period]) {
        if (line) { ws.chart.removeSeries(line); delete ws.emaSeries[period]; }
        return;
      }
      emaLine(period).setData(ws.model.rows.filter(function (c) {
        return c.ema[period] !== null && c.ema[period] !== undefined;
      }).map(function (c) { return { time: c.time, value: c.ema[period] }; }));
    });
  }
  function volumePoint(c) {
    return { time: c.time, value: c.volume, color: c.close >= c.open ? '#1d4b45' : '#4b2020' };
  }
  function drawVolume() {
    ws.volume.setData(ws.prefs.volume ? ws.model.rows.map(volumePoint) : []);
  }
  function candlePoint(c) {
    return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
  }
  function get(path, signal) {
    return fetch(path, { signal: signal, cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function note(text) { var n = el('wsChartNote'); if (n.textContent !== text) n.textContent = text; }
  function chartStatus(text, ok) {
    var n = el('wsChartHealth');
    if (n.textContent !== text) n.textContent = text;
    n.className = 'le-chip ' + (ok ? 'ok' : 'bad');
  }
  function applyCandle(c) {
    var last = ws.model.rows[ws.model.rows.length - 1];
    // Missing an entire interval means history needs repair, not a fabricated bar.
    if (last && c.time > last.time + TF_SECONDS[ws.timeframe]) {
      ws.buffered.set(c.time, c); loadHistory(ws.epoch); return;
    }
    var current = ws.model.upsert(c);
    if (!current) return;
    ws.candles = ws.model.rows;
    ws.series.update(candlePoint(current));
    if(last && current.time > last.time) ws.appendedSinceRebase = (ws.appendedSinceRebase || 0) + 1;
    // Bound the chart library's own retained bars as well as our model.
    // Rebase at most once per 300 new bars, never per live tick.
    if(ws.candles.length >= 1500 && ws.appendedSinceRebase >= 300) {
      ws.series.setData(ws.candles.map(candlePoint)); ws.setDataCalls += 1;
      drawVolume(); drawEmas(); ws.appendedSinceRebase = 0;
    }
    if (ws.prefs.volume) ws.volume.update(volumePoint(current));
    Object.keys(ws.emaSeries).forEach(function (period) {
      if (current.ema[period] !== null) ws.emaSeries[period].update({time:current.time, value:current.ema[period]});
    });
    ws.updates += 1;
    ws.events.schedule();
  }
  // One history request at selection/reconnect/gap. Live messages received while
  // REST is in flight are coalesced by candle time, then merged after the response.
  function loadHistory(epoch) {
    if (ws.loading || epoch !== ws.epoch || ws.stopped) return;
    ws.loading = true;
    ws.restAbort = new AbortController();
    var request = ws.restAbort, tf = ws.timeframe;
    var timeout = setTimeout(function () { request.abort(); }, 20000);
    note('Loading ' + ws.symbol + ' ' + tf + '…');
    return get('/api/lead-engine/candles/' + encodeURIComponent(ws.symbol) + '?timeframe=' + tf + '&limit=1000', request.signal)
      .then(function (data) {
        if (epoch !== ws.epoch || ws.stopped) return;
        if (!data.candles || !data.candles.length) throw new Error(data.detail || 'No candles returned');
        ws.model.load(data.candles); ws.appendedSinceRebase = 0;
        Array.from(ws.buffered.values()).sort(function(a,b){return a.time-b.time;}).forEach(function(c){ws.model.upsert(c);});
        ws.buffered.clear(); ws.candles = ws.model.rows;
        ws.series.setData(ws.candles.map(candlePoint)); ws.setDataCalls += 1;
        drawVolume(); drawEmas();
        if (!ws.hasView) { ws.chart.timeScale().fitContent(); ws.hasView = true; }
        note(ws.candles.length + ' candles · ' + tf + ' · Bybit');
        updateMarkers(ws.frame || {});
      }).catch(function (e) {
        if (epoch !== ws.epoch || ws.stopped) return;
        note('History unavailable: ' + e.message);
        chartStatus('CHART RESYNC', false);
        if (ws.socket) ws.socket.close(); // reconnect has bounded backoff
      }).finally(function () {
        clearTimeout(timeout);
        if (epoch === ws.epoch) ws.loading = false;
      });
  }
  function closeStream() {
    clearTimeout(ws.reconnect); clearInterval(ws.ping);
    if (ws.restAbort) ws.restAbort.abort();
    if (ws.socket) { ws.socket.onclose = null; ws.socket.close(); ws.socket = null; }
  }
  function connectStream(epoch, attempt) {
    if (ws.stopped || epoch !== ws.epoch) return;
    chartStatus('CHART CONNECTING', false);
    var topic = 'kline.' + ({'1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','1h':'60','4h':'240','1d':'D'}[ws.timeframe]) + '.' + ws.symbol;
    var socket = new WebSocket(ws.wsUrl);
    ws.socket = socket;
    var receivedAt = Date.now(), openedAt = Date.now();
    socket.onopen = function () {
      if (epoch !== ws.epoch) return socket.close();
      socket.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
      if(ws.connectedEpoch === epoch) loadHistory(epoch);
      ws.connectedEpoch = epoch;
      clearInterval(ws.ping);
      ws.ping = setInterval(function () {
        if (Date.now() - receivedAt > 70000) return socket.close();
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({op:'ping'}));
      }, 20000);
    };
    socket.onmessage = function (event) {
      if (epoch !== ws.epoch || ws.stopped) return;
      receivedAt = Date.now();
      var message;
      try { message = JSON.parse(event.data); } catch(e) { return; }
      if (message.op === 'subscribe') {
        if (message.success === false) { note(message.ret_msg || 'Subscription rejected'); return socket.close(); }
        return;
      }
      if (message.topic !== topic || !Array.isArray(message.data)) return;
      ws.lastCandleAt = Date.now(); ws.chartMessages += 1;
      chartStatus('CHART LIVE', true);
      message.data.forEach(function (item) {
        var c = global.LeadChartMath.fromKline(item, message.ts);
        if (!c) return;
        if (ws.loading || !ws.model.rows.length) {
          var prior = ws.buffered.get(c.time);
          if (!prior || !(prior.closed && !c.closed)) ws.buffered.set(c.time, c);
          if (ws.buffered.size > 8) { ws.buffered.delete(ws.buffered.keys().next().value); }
        } else applyCandle(c);
      });
    };
    socket.onerror = function () { if(epoch === ws.epoch) chartStatus('CHART CONNECTION ERROR', false); };
    socket.onclose = function () {
      clearInterval(ws.ping);
      if (ws.stopped || epoch !== ws.epoch) return;
      chartStatus('CHART DISCONNECTED', false);
      ws.reconnects += 1;
      var next = Date.now() - openedAt > 30000 ? 0 : Math.min(attempt + 1, 5);
      ws.reconnect = setTimeout(function () { connectStream(epoch, next); }, Math.min(30000, 1000 * Math.pow(2, next)));
    };
  }
  function selectChart() {
    ws.epoch += 1; closeStream(); ws.loading = false; ws.hasView = false;
    ws.buffered.clear(); ws.model.load([]); ws.candles = [];
    ws.series.setData([]); ws.volume.setData([]); drawEmas();
    var epoch = ws.epoch;
    get('/api/lead-engine/chart-config').then(function (data) {
      if (epoch !== ws.epoch || ws.stopped) return;
      if (!data.enabled) { chartStatus('ENGINE OFF', false); return; }
      if (!/^wss:\/\//.test(data.ws_url || '')) throw new Error('Invalid chart stream URL');
      ws.wsUrl = data.ws_url; loadHistory(epoch); connectStream(epoch, 0);
    }).catch(function(e){ if(epoch===ws.epoch) note('Chart unavailable: ' + e.message); });
  }
  function updateMarkers(frame) {
    ws.markers = (frame.events || []).slice(-200);
    ws.events.set(ws.prefs.signals ? ws.markers : [], TF_SECONDS[ws.timeframe]);
  }

  /* ---- panel -------------------------------------------------------- */

  function mountPanel() {
    var body = el('wsPanelBody');
    if (ws.panel) return;
    // Parenthesised deliberately: `new LP().Panel(...)` parses as
    // `(new LP()).Panel(...)`, which calls Panel as a method instead of a
    // constructor and quietly yields undefined.
    ws.panel = new (LP().Panel)(body, { refreshMs: REFRESH_MS });
    ws.panel.paint = function (frame) {
      global.LeadBlocks.applyFrame(ws.panel, frame, { uiLatencyMs: ws.uiLatencyMs + (ws.panel.displayLatencyMs || 0) });
    };
    body.innerHTML = global.LeadBlocks.buildBlocks(ws.panel);
    ws.panel.collect();
  }

  function signalsOff(reason) {
    renderHeader({ health: {status: reason, signals_enabled:false}, signal: {state:'SIGNALS OFF'} });
    if (ws.frame && ws.panel) {
      var stale = Object.assign({}, ws.frame, {health: {status:reason,signals_enabled:false,reasons:[reason]},
        signal: {state:'SIGNALS OFF',reason:reason}, long_pressure:0,short_pressure:0});
      ws.panel.push(stale);
    }
  }
  function loadFrame() {
    if (ws.stopped) return;
    ws.frameAbort = new AbortController();
    var controller = ws.frameAbort, began = performance.now();
    var timeout = setTimeout(function(){signalsOff('SERVER UNREACHABLE');controller.abort();}, 2000);
    return get('/api/lead-engine/state/' + encodeURIComponent(ws.symbol), controller.signal)
      .then(function (data) {
        if (ws.stopped) return;
        ws.uiLatencyMs = performance.now() - began; ws.fetches += 1;
        if (!data || data.enabled === false) { signalsOff('ENGINE OFF'); return; }
        ws.frame = data; mountPanel(); ws.panel.push(data); renderHeader(data); updateMarkers(data);
      }).catch(function (e) { if (!ws.stopped) signalsOff('SERVER UNREACHABLE'); })
      .finally(function () {
        clearTimeout(timeout);
        if (!ws.stopped) ws.timer = setTimeout(loadFrame, Math.max(0, FETCH_MS - (performance.now() - began)));
      });
  }

  function renderHeader(frame) {
    var health = frame.health || {};
    var signal = health.signals_enabled ? (frame.signal || {}) : {state: 'SIGNALS OFF'};
    var price = el('wsPrice');
    var text = frame.price ? global.LeadFib.formatPrice(Number(frame.price)) : '—';
    if (price.textContent !== text) price.textContent = text;
    var state = el('wsState');
    if (state.textContent !== signal.state) {
      state.textContent = signal.state || 'IDLE';
      state.className = 'le-state ' + global.LeadBlocks.stateClass(signal.state);
    }
    var quality = el('wsQuality');
    var qualityText = 'feed ' + (health.status || '—');
    if (quality.textContent !== qualityText) {
      quality.textContent = qualityText;
      quality.className = 'le-chip ' + (health.status === 'OK' ? 'ok' : 'bad');
    }
  }

  /* ---- controls ----------------------------------------------------- */

  function renderTimeframes() {
    var row = el('wsTimeframes');
    row.innerHTML = TIMEFRAMES.map(function (tf) {
      return '<button data-tf="' + tf + '"' + (tf === ws.timeframe ? ' class="active"' : '') +
        '>' + tf + '</button>';
    }).join('');
    Array.prototype.forEach.call(row.querySelectorAll('[data-tf]'), function (btn) {
      btn.addEventListener('click', function () { setTimeframe(btn.getAttribute('data-tf')); });
    });
  }

  function setTimeframe(tf) {
    if (tf === ws.timeframe) return;
    ws.timeframe = tf;
    ws.events.set([], TF_SECONDS[tf]);
    renderTimeframes();
    // Drawings are per symbol AND timeframe: switching swaps the set on
    // screen, it never mixes them.
    ws.fib.setChart(ws.symbol, ws.timeframe);
    buildFibRatios();
    history.replaceState(null, '', '?tf=' + tf);
    selectChart();
  }

  function renderFibState() {
    var hint = el('wsFibHint');
    if (!hint || !ws.fib) return;
    var state = ws.fib.state();
    hint.textContent = state.armed
      ? (state.pending ? 'Now tap the END of the move.' : 'Tap the START of the move.')
      : state.drawings + ' drawing(s) on ' + state.symbol + ' ' + state.timeframe +
        (state.hidden ? ' (hidden)' : '') +
        '. Tap Draw, then two points on the chart.';
    var button = el('wsFib');
    if (button) button.classList.toggle('active', state.armed);
  }

  function buildFibRatios() {
    var box = el('wsFibRatios');
    box.innerHTML = global.LeadFib.ALL.map(function (r) {
      var on = ws.fib.ratios.indexOf(r) !== -1;
      return '<label><input type="checkbox" data-ratio="' + r + '"' +
        (on ? ' checked' : '') + ' /> ' + r + '</label>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-ratio]'), function (input) {
      input.addEventListener('change', function () {
        var chosen = [];
        Array.prototype.forEach.call(box.querySelectorAll('[data-ratio]'), function (node) {
          if (node.checked) chosen.push(Number(node.getAttribute('data-ratio')));
        });
        ws.fib.setRatios(chosen);
      });
    });
  }

  function bindControls() {
    var indicators = el('wsIndicators');
    var menu = el('wsIndicatorMenu');
    indicators.addEventListener('click', function () {
      menu.hidden = !menu.hidden;
      el('wsFibMenu').hidden = true;
    });
    Array.prototype.forEach.call(menu.querySelectorAll('[data-ema]'), function (input) {
      var period = input.getAttribute('data-ema');
      input.checked = !!ws.prefs.ema[period];
      input.addEventListener('change', function () {
        ws.prefs.ema[period] = input.checked;
        savePrefs();
        drawEmas();
      });
    });
    el('wsShowVolume').checked = ws.prefs.volume;
    el('wsShowVolume').addEventListener('change', function () {
      ws.prefs.volume = el('wsShowVolume').checked;
      savePrefs();
      drawVolume();
    });
    el('wsShowSignals').checked = ws.prefs.signals;
    el('wsShowSignals').addEventListener('change', function () {
      ws.prefs.signals = el('wsShowSignals').checked;
      savePrefs();
      updateMarkers(ws.frame || {});
    });

    var fibButton = el('wsFib');
    var fibMenu = el('wsFibMenu');
    fibButton.addEventListener('click', function () {
      fibMenu.hidden = !fibMenu.hidden;
      menu.hidden = true;
      renderFibState();
    });
    el('wsFibDraw').addEventListener('click', function () { ws.fib.arm(true); renderFibState(); });
    el('wsFibHide').addEventListener('click', function () { ws.fib.toggleHidden(); });
    el('wsFibDelete').addEventListener('click', function () { ws.fib.deleteLast(); });
    el('wsFibReset').addEventListener('click', function () { ws.fib.reset(); });

    el('wsFullscreen').addEventListener('click', function () {
      document.body.classList.toggle('ws-fullscreen');
      setTimeout(function () {
        var container = el('wsChart');
        ws.chart.resize(container.clientWidth, container.clientHeight);
      }, 60);
    });

    Array.prototype.forEach.call(document.querySelectorAll('#wsMobileTabs button'),
      function (button) {
        button.addEventListener('click', function () {
          var pane = button.getAttribute('data-pane');
          Array.prototype.forEach.call(document.querySelectorAll('#wsMobileTabs button'),
            function (b) { b.classList.toggle('active', b === button); });
          el('wsChartPane').classList.toggle('hidden', pane !== 'chart');
          el('wsPanel').classList.toggle('hidden', pane !== 'panel');
          if (pane === 'chart') {
            var container = el('wsChart');
            ws.chart.resize(container.clientWidth, container.clientHeight);
          }
        });
      });
  }

  /* ---- boot --------------------------------------------------------- */

  function start() {
    var parts = location.pathname.split('/').filter(Boolean);
    ws.symbol = (parts[parts.length - 1] || 'INJUSDT').toUpperCase();
    var query = new URLSearchParams(location.search);
    ws.timeframe = TIMEFRAMES.indexOf(query.get('tf')) >= 0 ? query.get('tf') : ws.timeframe;
    document.title = ws.symbol + ' — Astra';
    el('wsSymbol').textContent = ws.symbol;

    loadPrefs();
    buildChart();
    ws.fib.setChart(ws.symbol, ws.timeframe);
    buildFibRatios();
    renderTimeframes();
    bindControls();
    selectChart();
    loadFrame();
  }

  ws.stats = function () {
    return { fetches: ws.fetches, chartUpdates: ws.updates, setDataCalls: ws.setDataCalls,
             candles: ws.candles.length, chartMessages:ws.chartMessages, reconnects:ws.reconnects, buffered:ws.buffered.size,
             panel: ws.panel ? ws.panel.stats() : null };
  };

  global.addEventListener('pagehide', function () {
    ws.stopped = true; ws.epoch += 1; closeStream(); clearTimeout(ws.timer);
    if(ws.frameAbort) ws.frameAbort.abort();
    if(ws.panel) ws.panel.dispose();
    if(ws.observer) ws.observer.disconnect();
    if(ws.events) ws.events.dispose();
    if(ws.chart) ws.chart.remove();
  });
  global.addEventListener('pageshow', function(e){if(e.persisted && ws.stopped) location.reload();});
  document.addEventListener('DOMContentLoaded', start);
})(window);
