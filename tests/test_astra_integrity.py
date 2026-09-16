"""Regressions found in the Astra audit. All inputs are deterministic."""
import math
import pytest
from t3_engine.lead_engine.normalize import normalized_delta, Normalizer
from t3_engine.lead_engine.orderbook_engine import OrderBook
from t3_engine.lead_engine.health import StreamHealth, assess
from t3_engine.lead_engine.config import Thresholds, LeadEngineConfig
from t3_engine.lead_engine.engine import LeadEngine
from t3_engine.lead_engine.trade_flow import Trade
from t3_engine.lead_engine.signal_machine import SignalInputs, SignalMachine
from t3_engine.lead_engine.paper_trading import PaperLedger, PaperConfig, fill_price
from t3_engine.lead_engine.rolling import TimeSeries
from t3_engine.lead_engine.smc_engine import SmcEngine, Candle, candle_from_kline
from t3_engine.lead_engine.btc_leadlag import ReturnGrid


def bookmsg(u=1, bid=10, ask=11, stamp=1000, kind='snapshot'):
    return {'type':kind,'ts':stamp,'data':{'u':u,'b':[[str(bid),'10']],'a':[[str(ask),'5']]}}


@pytest.mark.parametrize('buy,sell,expected',[(.9,0,1),(0,.9,-1),(4,4,0),(1e308,1e308,0),(float('inf'),1,0),(float('nan'),1,0)])
def test_delta_cannot_overflow(buy,sell,expected):
    assert normalized_delta(buy,sell)==pytest.approx(expected)


def test_snapshot_reset_invalidates_sorted_cache_even_at_identical_version():
    b=OrderBook('INJUSDT');b.apply(bookmsg()); assert b.top_bids()[0][0]==10
    b.apply(bookmsg(bid=20,ask=21)); assert b.top_bids()[0][0]==20
    b.reset();b.apply(bookmsg()); assert b.top_bids()[0][0]==10


def test_transport_loss_requires_snapshot_but_nonconsecutive_ids_are_valid():
    b=OrderBook('INJUSDT');b.apply(bookmsg(u=100))
    assert b.apply(bookmsg(u=250,kind='delta',stamp=1100))
    b.reset('transport loss')
    assert not b.apply(bookmsg(u=300,kind='delta',stamp=1200))
    assert not b.synced
    assert b.apply(bookmsg(u=1,stamp=1300))


@pytest.mark.parametrize('bad',[float('nan'),float('inf'),-1])
def test_bad_book_values_force_resync(bad):
    b=OrderBook('INJUSDT');b.apply(bookmsg()); m=bookmsg(2,stamp=1100,kind='delta');m['data']['b'][0][1]=bad
    assert not b.apply(m) and not b.synced


def test_actual_exchange_age_disables_signals_despite_recent_arrival():
    h=StreamHealth('INJUSDT',ws_connected=True,orderbook_synced=True,last_book_ms=1000,last_book_receive_ms=4900,last_trade_ms=4900)
    assert h.as_dict(5000)['book_age_ms']==4000
    assert h.as_dict(5000)['book_message_age_ms']==100
    assert not assess(h,Thresholds(),5000).signals_enabled
    h.last_book_ms=4900;h.processing_backlog=True
    assert not assess(h,Thresholds(),5000).signals_enabled


def test_quiet_windows_expire_against_current_clock():
    s=TimeSeries();s.add(1000,3);s.reference_ms=10000
    assert s.window(5000)==[]


def test_duplicate_trade_id_and_out_of_order_trade_do_not_double_cvd():
    e=LeadEngine(LeadEngineConfig(enabled=True,symbols=['INJUSDT']))
    s=e.states['INJUSDT']; t=Trade(1000,10,2,True)
    s.on_trade(t,1000,'same');s.on_trade(t,1001,'same');s.on_trade(Trade(900,10,5,False),1001,'old')
    assert s.flow.flow(5000).buy_volume==2
    assert s.flow.flow(5000).sell_volume==0


def test_normalizer_samples_once_per_calculation_bucket():
    n=Normalizer("X");n.sample_key=1
    for _ in range(100):n.update('x',2,'zscore')
    assert len(n.feature('x').samples)==1


def test_returns_do_not_treat_a_gap_as_one_second():
    g=ReturnGrid('X');g.observe(1000,10);g.observe(10000,11)
    assert g.returns()=={}


def signal(**kw):
    d=dict(long_pressure=80,short_pressure=5,conflict=0,prebreak_long=80,prebreak_short=0,long_level=11,short_level=9,liquidation_state='NEUTRAL',healthy=True,price=10)
    d.update(kw);return SignalInputs(**d)


def test_history_preserves_price_time_and_score_when_current_signal_refreshes():
    m=SignalMachine('X');first=m.update(signal(),1000); frozen=m.history[-1].as_dict()
    m.update(signal(price=12,prebreak_long=78),1001)
    assert m.history[-1].as_dict()==frozen
    assert m.current.changed_at==first.changed_at and m.current.price==10
    m.update(signal(long_pressure=5,short_pressure=80,prebreak_long=0,prebreak_short=80),1002)
    assert m.current.changed_at==1002 and m.current.direction=='short'


def test_conflict_and_missing_coverage_block_reversal_and_strong_states():
    m=SignalMachine('X')
    assert m.update(signal(conflict_level='CONFLICT_HIGH',liquidation_state='EXHAUSTION'),1000).direction==''
    assert m.update(signal(confidence=.1),1001).state=='WATCH'
    assert m.update(signal(healthy=False),1002).confidence==0


def paper_signal(at=100000,direction='long'):
    return {'symbol':'INJUSDT','generated_at':at/1000,'health':{'signals_enabled':True},'signal':{'state':'PRE_BREAK_LONG' if direction=='long' else 'PRE_BREAK_SHORT','direction':direction,'level':100,'changed_at':at/1000,'model_score':70}}


def test_paper_requires_next_quote_not_signal_or_old_price():
    p=PaperLedger(PaperConfig(slippage_bps=0));p.observe_signal(paper_signal())
    p.on_quote('INJUSDT',100000,[(99,100)],[(100,100)])
    assert not p.positions
    p.on_quote('INJUSDT',100001,[(100,100)],[(101,100)])
    assert p.positions['INJUSDT']['entry']==101
    p.observe_signal(paper_signal());assert not p.pending


@pytest.mark.parametrize('direction,exit_price',[('long',102),('short',98)])
def test_paper_net_profit_subtracts_both_commissions(direction,exit_price):
    p=PaperLedger(PaperConfig(slippage_bps=0,fee_rate=.001));p.observe_signal(paper_signal(direction=direction))
    p.on_quote('INJUSDT',100001,[(100,10)],[(100,10)])
    p.on_quote('INJUSDT',100002,[(exit_price,10)],[(exit_price,10)])
    t=p.closed[-1]
    assert t['gross_pnl']==2
    assert t['net_pnl']==pytest.approx(2-.1-exit_price*.001)
    assert p.snapshot(100003)['equity']==pytest.approx(10000+t['net_pnl'])
    assert p.closed_count==1


def test_paper_depth_fill_and_missing_liquidity():
    assert fill_price([(100,1),(102,1)],2,True,0)==101
    assert fill_price([(100,1)],2,True,0) is None
    assert fill_price([(100,2)],2,True,1)>100
    assert fill_price([(100,2)],2,False,1)<100


def test_paper_gap_exits_at_observed_quote_not_favourable_stop():
    p=PaperLedger(PaperConfig(slippage_bps=0));p.observe_signal(paper_signal());p.on_quote('INJUSDT',100001,[(100,10)],[(100,10)])
    p.on_quote('INJUSDT',100002,[],[],False)
    assert p.snapshot(100003)['unrealized_net_pnl'] is None
    p.on_quote('INJUSDT',110000,[(90,10)],[(91,10)])
    t=p.closed[-1];assert t['exit']==90 and t['data_gap'] and t['exit_reason']=='STOP'
    assert t['net_pnl'] < -10


def test_paper_journal_recovers_totals_without_reopening_old_signal(tmp_path):
    path=tmp_path/'paper.sqlite3';cfg=PaperConfig(slippage_bps=0)
    p=PaperLedger(cfg,path);p.observe_signal(paper_signal());p.on_quote('INJUSDT',100001,[(100,10)],[(100,10)]);p.on_quote('INJUSDT',100002,[(102,10)],[(102,10)]);result=p.realized;p.close()
    q=PaperLedger(cfg,path)
    try:
        assert q.realized==result and q.closed_count==1
        q.observe_signal(paper_signal());assert not q.pending
    finally:q.close()


def test_forming_or_malformed_kline_cannot_create_closed_structure():
    m={'start':1000,'open':10,'high':11,'low':9,'close':10,'volume':1,'confirm':False}
    assert candle_from_kline(m,"1").closed is False
    m['close']=12;assert candle_from_kline(m,"1") is None
