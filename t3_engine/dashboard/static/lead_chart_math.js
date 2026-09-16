/* Deterministic chart data model. No DOM, network, LLM or wall clock. */
(function (global) {
  'use strict';
  var PERIODS = [9, 18, 50, 200];
  function valid(c) {
    return c && Number.isFinite(c.time) && c.time > 0 &&
      ['open', 'high', 'low', 'close'].every(function (k) {
        return Number.isFinite(c[k]) && c[k] > 0;
      }) && Number.isFinite(c.volume) && c.volume >= 0 &&
      c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close) && c.high >= c.low;
  }
  function ema(values, period) {
    var out = [], previous = null, seed = 0, alpha = 2 / (period + 1);
    values.forEach(function (v, i) {
      if (i < period) seed += v;
      if (i === period - 1) previous = seed / period;
      else if (i >= period) previous = alpha * v + (1 - alpha) * previous;
      out.push(previous);
    });
    return out;
  }
  function CandleModel(limit) { this.rows = []; this.limit = limit || 1500; this.updates = 0; }
  CandleModel.prototype.load = function (rows) {
    var byTime = new Map();
    rows.forEach(function (c) { if (valid(c)) byTime.set(c.time, Object.assign({}, c)); });
    this.rows = Array.from(byTime.values()).sort(function (a, b) { return a.time - b.time; });
    var closes = this.rows.map(function (c) { c.ema = {}; return c.close; });
    var self = this;
    PERIODS.forEach(function (period) {
      ema(closes, period).forEach(function (v, i) { self.rows[i].ema[period] = v; });
    });
    this.rows = this.rows.slice(-this.limit);
  };
  CandleModel.prototype.upsert = function (c) {
    if (!valid(c) || !this.rows.length) return null;
    var last = this.rows[this.rows.length - 1], replacing = c.time === last.time;
    if (c.time < last.time || (replacing && last.closed && !c.closed) ||
        (replacing && last.exchangeMs && c.exchangeMs < last.exchangeMs)) return null;
    var previous = this.rows[this.rows.length - (replacing ? 2 : 1)];
    var next = Object.assign({}, c, { ema: {} }), self = this;
    PERIODS.forEach(function (period) {
      var prior = previous && previous.ema[period];
      if (prior !== null && prior !== undefined) {
        next.ema[period] = 2 / (period + 1) * c.close + (1 - 2 / (period + 1)) * prior;
      } else {
        var history = self.rows.slice(0, replacing ? -1 : undefined).slice(-(period - 1));
        next.ema[period] = history.length === period - 1
          ? (history.reduce(function (sum, row) { return sum + row.close; }, 0) + c.close) / period : null;
      }
    });
    if (replacing) this.rows[this.rows.length - 1] = next;
    else this.rows.push(next);
    if (this.rows.length > this.limit) this.rows.shift();
    this.updates += 1;
    return next;
  };
  function fromKline(item, stamp) {
    var c = { time: Number(item.start) / 1000, open: Number(item.open), high: Number(item.high),
      low: Number(item.low), close: Number(item.close), volume: Number(item.volume),
      closed: item.confirm === true, exchangeMs: Number(stamp) };
    return valid(c) ? c : null;
  }
  global.LeadChartMath = { ema: ema, valid: valid, CandleModel: CandleModel, fromKline: fromKline, PERIODS: PERIODS };
})(typeof window === 'undefined' ? globalThis : window);
