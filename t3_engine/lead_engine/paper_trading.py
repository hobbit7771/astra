"""Astra paper executions: causal quotes, explicit costs, durable own journal.

This module never sends an exchange order. Fixed-size, unlevered simulations
use depth-weighted fills on the next observed quote, never the signal price.
The SQLite writer runs separately from market ingestion/calculation.
"""
from __future__ import annotations

import copy
import json
import math
import os
import queue
import sqlite3
import threading
import uuid
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

ACTIONABLE = {"PRE_BREAK_LONG", "PRE_BREAK_SHORT", "HIGH_PROBABILITY", "A_PLUS"}


@dataclass(frozen=True)
class PaperConfig:
    capital: float = 10000.0
    notional: float = 100.0
    fee_rate: float = 0.00055  # simulation assumption, not an account fee lookup
    slippage_bps: float = 1.0
    stop_pct: float = 0.005
    reward_risk: float = 1.5
    max_hold_ms: int = 900000
    entry_expiry_ms: int = 2000
    cooldown_ms: int = 60000

    def __post_init__(self):
        for name, value in asdict(self).items():
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"invalid paper setting {name}")
        if self.capital <= 0 or self.notional <= 0 or not 0 < self.stop_pct < 1:
            raise ValueError("paper capital/notional/stop must be positive")
        if self.fee_rate >= 1 or self.slippage_bps >= 100 or self.reward_risk <= 0:
            raise ValueError("invalid paper costs or reward/risk")

    @classmethod
    def from_env(cls):
        defaults = asdict(cls())
        return cls(**{key: type(value)(os.getenv('ASTRA_PAPER_' + key.upper(), value))
                      for key, value in defaults.items()})


def fill_price(levels, quantity: float, buy: bool, slippage_bps: float) -> Optional[float]:
    remaining, cost = quantity, 0.0
    if not math.isfinite(quantity) or quantity <= 0:
        return None
    for price, size in levels:
        taken = min(remaining, size)
        cost += taken * price
        remaining -= taken
        if remaining <= quantity * 1e-10:
            return cost / quantity * (1 + (1 if buy else -1) * slippage_bps / 10000)
    return None  # insufficient displayed liquidity: never invent the rest


class Journal:
    """Single writer; each commit contains totals, open positions and closed trades."""
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.error = ''
        self.queue = queue.Queue(maxsize=64)
        self.stop = threading.Event()
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS astra_paper_account (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS astra_paper_trades (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            row = db.execute('SELECT payload FROM astra_paper_account WHERE id=1').fetchone()
            self.restored = json.loads(row[0]) if row else None
        self.thread = threading.Thread(target=self.run, name='astra-paper-journal', daemon=True)
        self.thread.start()

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute('PRAGMA journal_mode=WAL')
        return db

    def enqueue(self, state, trade=None):
        try:
            self.queue.put_nowait((copy.deepcopy(state), copy.deepcopy(trade)))
        except queue.Full:
            self.error = 'journal backlog; paper entries paused'

    def run(self):
        with self.connect() as db:
            while not self.stop.is_set() or not self.queue.empty():
                try:
                    state, trade = self.queue.get(timeout=0.1)
                except queue.Empty:
                    continue
                try:
                    with db:
                        db.execute('INSERT OR REPLACE INTO astra_paper_account VALUES (1,?)', (json.dumps(state, allow_nan=False),))
                        if trade:
                            db.execute('INSERT OR REPLACE INTO astra_paper_trades VALUES (?,?)', (trade['id'], json.dumps(trade, allow_nan=False)))
                except Exception as exc:
                    self.error = f'journal write failed: {type(exc).__name__}; paper entries paused'
                finally:
                    self.queue.task_done()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=6)
        if self.thread.is_alive():
            self.error = 'journal shutdown incomplete'


class PaperLedger:
    def __init__(self, config=None, journal_path=None):
        self.config = config or PaperConfig()
        self.lock = threading.RLock()
        self.journal = Journal(journal_path) if journal_path else None
        self.positions, self.pending, self.last_signal, self.last_exit = {}, {}, {}, {}
        self.closed = deque(maxlen=200)
        self.marks, self.quality = {}, {}
        self.realized = self.fees = 0.0
        self.closed_count = self.wins = self.losses = 0
        self.initial_capital = self.config.capital
        self.session_id = uuid.uuid4().hex
        if self.journal and self.journal.restored:
            data = self.journal.restored
            for key in ('positions','last_signal','last_exit','realized','fees','closed_count','wins','losses','initial_capital','session_id'):
                if key in data:
                    setattr(self, key, data[key])
            self.closed.extend(data.get('closed', []))
            for position in self.positions.values():
                position['data_gap'] = True
        self._persist()

    def _persist(self, trade=None):
        if self.journal:
            data = {key: getattr(self,key) for key in ('positions','last_signal','last_exit','realized','fees','closed_count','wins','losses','initial_capital','session_id')}
            data['closed'] = list(self.closed)
            data['config'] = asdict(self.config)
            self.journal.enqueue(data, trade)

    def observe_signal(self, frame):
        with self.lock:
            symbol, signal = frame['symbol'], frame.get('signal', {})
            if not frame.get('health', {}).get('signals_enabled'):
                self.pending.pop(symbol, None)
                self.quality[symbol] = False
                if symbol in self.positions:
                    self.positions[symbol]['data_gap'] = True
                return
            self.quality[symbol] = True
            identity = f"{signal.get('state')}:{signal.get('direction')}:{signal.get('level')}:{signal.get('changed_at')}"
            if self.last_signal.get(symbol) == identity:
                return
            self.last_signal[symbol] = identity
            self.pending.pop(symbol, None)
            now = int(frame['generated_at'] * 1000)
            at = int(float(signal.get('changed_at') or 0) * 1000)
            if (signal.get('state') not in ACTIONABLE or signal.get('direction') not in ('long','short')
                    or symbol in self.positions or now - at > self.config.entry_expiry_ms
                    or now - self.last_exit.get(symbol, 0) < self.config.cooldown_ms
                    or (self.journal and self.journal.error)):
                return
            self.pending[symbol] = {'signal_id': identity, 'signal_at': at,
                'signal_state': signal['state'], 'direction': signal['direction'],
                'decision_at': now, 'model_score': signal.get('model_score',signal.get('break_probability',0))}

    def on_quote(self, symbol, stamp_ms, bids, asks, healthy=True):
        with self.lock:
            if not healthy or not bids or not asks:
                self.quality[symbol] = False
                self.pending.pop(symbol, None)
                if symbol in self.positions:
                    self.positions[symbol]['data_gap'] = True
                return
            self.quality[symbol] = True
            position = self.positions.get(symbol)
            if position:
                buy = position['direction'] == 'short'
                mark = fill_price(asks if buy else bids, position['quantity'], buy, self.config.slippage_bps)
                if mark is None:
                    self.quality[symbol] = False
                    return
                if stamp_ms <= position['entry_at']:
                    return
                self.marks[symbol] = (stamp_ms, mark)
                sign = 1 if position['direction'] == 'long' else -1
                move = sign * (mark - position['entry']) / position['entry']
                reason = ('STOP' if move <= -position['stop_pct'] else 'TARGET' if move >= position['target_pct']
                          else 'TIMEOUT' if stamp_ms - position['entry_at'] >= self.config.max_hold_ms else '')
                if reason:
                    self._close(symbol, mark, stamp_ms, reason)
                return
            pending = self.pending.get(symbol)
            if not pending or stamp_ms <= pending['decision_at']:
                return
            if stamp_ms - pending['decision_at'] > self.config.entry_expiry_ms:
                self.pending.pop(symbol, None)
                return
            if self.journal and self.journal.error:
                return
            used = sum(p['entry']*p['quantity'] for p in self.positions.values())
            opening_fees = sum(p['entry_fee'] for p in self.positions.values())
            if self.initial_capital + self.realized - used - opening_fees < self.config.notional * (1+self.config.fee_rate)*1.01:
                self.pending.pop(symbol, None)
                return
            buy = pending['direction'] == 'long'
            levels = asks if buy else bids
            quantity = self.config.notional / levels[0][0]
            entry = fill_price(levels, quantity, buy, self.config.slippage_bps)
            if entry is None:
                return
            self.positions[symbol] = {**pending, 'id':uuid.uuid4().hex, 'symbol':symbol,
                'entry_at':stamp_ms, 'entry':entry, 'quantity':quantity,
                'entry_fee':entry*quantity*self.config.fee_rate, 'fee_rate':self.config.fee_rate,
                'stop_pct':self.config.stop_pct, 'target_pct':self.config.stop_pct*self.config.reward_risk,
                'stop':entry*(1+(-1 if buy else 1)*self.config.stop_pct),
                'target':entry*(1+(1 if buy else -1)*self.config.stop_pct*self.config.reward_risk),
                'data_gap':False}
            self.pending.pop(symbol, None)
            self._persist()

    def _close(self, symbol, price, stamp, reason):
        p = self.positions.pop(symbol)
        sign = 1 if p['direction'] == 'long' else -1
        exit_fee = price*p['quantity']*p['fee_rate']
        gross = sign*(price-p['entry'])*p['quantity']
        fees = p['entry_fee']+exit_fee
        trade = {**p,'exit_at':stamp,'exit':price,'exit_reason':reason,'gross_pnl':gross,
                 'fees':fees,'net_pnl':gross-fees}
        self.realized += gross-fees
        self.fees += fees
        self.closed_count += 1
        self.wins += int(gross-fees > 0)
        self.losses += int(gross-fees < 0)
        self.closed.append(trade)
        self.last_exit[symbol] = stamp
        self.marks.pop(symbol, None)
        self._persist(trade)

    def snapshot(self, now_ms, symbol=None):
        with self.lock:
            positions, unrealized = [], 0.0
            all_fresh = True
            for sym, p in self.positions.items():
                mark = self.marks.get(sym)
                fresh = bool(mark and 0 <= now_ms-mark[0] <= 1500 and self.quality.get(sym))
                value = None
                if fresh:
                    sign = 1 if p['direction']=='long' else -1
                    value = sign*(mark[1]-p['entry'])*p['quantity']-p['entry_fee']-mark[1]*p['quantity']*p['fee_rate']
                    unrealized += value
                else:
                    all_fresh = False
                if symbol is None or sym == symbol:
                    positions.append({**p,'mark':mark[1] if fresh else None,'unrealized_net_pnl':value,'mark_fresh':fresh})
            return {'mode':'PAPER','session_id':self.session_id,'initial_capital':self.initial_capital,
                'realized_net_pnl':self.realized,'unrealized_net_pnl':unrealized if all_fresh else None,
                'equity':self.initial_capital+self.realized+unrealized if all_fresh else None,
                'fees_paid':self.fees+sum(p['entry_fee'] for p in self.positions.values()),
                'closed_count':self.closed_count,'wins':self.wins,'losses':self.losses,
                'open_count':len(self.positions),'positions':copy.deepcopy(positions),
                'closed':copy.deepcopy([t for t in self.closed if symbol is None or t['symbol']==symbol][-50:]),
                'config':asdict(self.config),'journal_error':self.journal.error if self.journal else '',
                'persistence':'sqlite' if self.journal else 'memory',
                'funding_included':False,
                'note':'Simulated depth fills; fees and slippage are configured assumptions. Funding excluded. Gap trades are flagged.'}

    def close(self):
        if self.journal:
            self._persist()
            self.journal.close()
