/* Price/time anchored events. LWC bar markers quantise seconds to a bar;
   this overlay interpolates the event's real timestamp within that bar. */
(function (global) {
  'use strict';
  function Events(chart, series, container) {
    this.chart = chart; this.series = series; this.container = container;
    this.events = []; this.seconds = 300; this.handle = null;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'le-event-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(this.canvas);
    this.redraw = this.schedule.bind(this);
    chart.timeScale().subscribeVisibleLogicalRangeChange(this.redraw);
    chart.subscribeCrosshairMove(this.redraw);
    ['wheel', 'pointermove', 'touchmove'].forEach(function (event) {
      container.addEventListener(event, this.redraw, { passive: true });
    }, this);
  }
  Events.prototype.set = function (events, seconds) { this.events = events || []; this.seconds = seconds; this.schedule(); };
  Events.prototype.schedule = function () {
    if (this.handle !== null) return;
    var self = this;
    this.handle = requestAnimationFrame(function () { self.handle = null; self.draw(); });
  };
  Events.prototype.draw = function () {
    var canvas = this.canvas, width = this.container.clientWidth, height = this.container.clientHeight;
    var dpr = global.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr; canvas.height = height * dpr;
      canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    }
    var ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    var self = this, scale = this.chart.timeScale(), spacing = scale.options().barSpacing;
    this.events.forEach(function (event) {
      var stamp = Number(event.timestamp), bucket = Math.floor(stamp / self.seconds) * self.seconds;
      var x = scale.timeToCoordinate(bucket), y = self.series.priceToCoordinate(Number(event.price));
      if (x === null || y === null) return;
      x += (stamp - bucket) / self.seconds * spacing;
      if (x < 0 || x > width - 65 || y < 0 || y > height) return;
      var up = event.direction === 'long' || event.direction === 'bullish';
      ctx.fillStyle = up ? '#34d399' : '#f87171';
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.font = '10px sans-serif';
      var label = new Date(stamp * 1000).toISOString().slice(11, 19) + ' ' + event.type;
      ctx.fillText(label, Math.min(x + 6, Math.max(0, width - 75 - ctx.measureText(label).width)), y - 8);
    });
  };
  Events.prototype.dispose = function () {
    if(this.handle !== null) cancelAnimationFrame(this.handle);
    this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.redraw);
    this.chart.unsubscribeCrosshairMove(this.redraw);
    ['wheel','pointermove','touchmove'].forEach(function(event){this.container.removeEventListener(event,this.redraw);},this);
    this.canvas.remove();
  };
  global.LeadEvents = Events;
})(window);
