"""Run actual live stability, or explicit accelerated replay (never called live).

python -m tools.astra_stability --mode live --seconds 1800 --out result.json
python -m tools.astra_stability --mode replay --out result.json
"""
import argparse
import gzip
import json
import resource
import statistics
import time
from pathlib import Path

from t3_engine.lead_engine.config import LeadEngineConfig
from t3_engine.lead_engine.engine import LeadEngine


def summary(values):
    if not values:
        return None
    ordered=sorted(values)
    return {'p50':statistics.median(ordered),'p95':ordered[min(len(ordered)-1,int(len(ordered)*.95))],'max':max(ordered)}


def run(args):
    engine=LeadEngine(LeadEngineConfig(enabled=True,symbols=['BTCUSDT','INJUSDT']))
    report={'mode':args.mode,'requested_seconds':args.seconds,'acceptance_passed':False}
    started=time.monotonic();cpu=[];calc=[];memory=[];states=[]
    if args.mode=='live':
        engine.start()
        try:
            while time.monotonic()-started < args.seconds:
                status=engine.status();stream=status.get('stream',{})
                states.append({'elapsed':round(time.monotonic()-started,3),'stream':stream,'symbols':status.get('symbols',[])})
                memory.append(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
                if time.monotonic()-started > 20 and stream.get('messages',0)==0:
                    report['blocked_reason']='No live Bybit frames received; opening connection unavailable'
                    break
                time.sleep(.5)
            report['last_status']=states[-1] if states else None
            report['live_duration_passed']=(args.seconds >= 1800 and
                time.monotonic()-started >= args.seconds and bool(engine.stream.stats.messages))
            # A transport sampler cannot certify scrolling, touch, chart
            # reconnects or the absence of memory leaks. Keep the full gate
            # open until those independent acceptance checks are recorded.
            report['acceptance_passed']=False
            report['note']='Live backend samples only; browser stability and memory-leak acceptance require separate evidence.'
            report['samples']=states
        finally: engine.stop()
    else:
        fixture=Path('tests/fixtures/bybit_capture_injusdt.jsonl.gz')
        with gzip.open(fixture,'rt') as source: messages=[json.loads(line) for line in source if line.strip()]
        begin=messages[0]['ts'];end=messages[-1]['ts'];duration=end-begin;clock=begin;count=0;next_calc=0
        cvd_start=engine.states['INJUSDT'].cvd.cumulative
        # Feed 30 minutes of exchange time, preserving source order per cycle.
        while clock-begin < args.seconds*1000:
            cycle=count//len(messages);m=json.loads(json.dumps(messages[count%len(messages)]));offset=cycle*(duration+1)
            m['ts']+=offset;m['_received_at_ms']=m['ts'];clock=m['ts']
            data=m.get('data');
            if isinstance(data,list):
                for item in data:
                    for key in ('T','start','end','timestamp'):
                        if key in item:item[key]=int(item[key])+offset
            t=time.perf_counter();engine.handle_message(m['topic'],m);cpu.append((time.perf_counter()-t)*1000);count+=1
            if clock>=next_calc:
                t=time.perf_counter();engine.calculate_once(clock/1000);calc.append((time.perf_counter()-t)*1000);next_calc=clock+250
            if count%1000==0:memory.append(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        report.update({'exchange_seconds':(clock-begin)/1000,'messages':count,'ingest_ms':summary(cpu),'calculation_ms':summary(calc),'cvd_change':engine.states['INJUSDT'].cvd.cumulative-cvd_start,'book_synced':{s:state.book.synced for s,state in engine.states.items()},'maximum_feature_rows':max(len(s.feature_history) for s in engine.states.values()),'network_latency_ms':None,'note':'Accelerated replay of repository fixture; capture provenance is unverified. Not a live stability test.'})
    report['wall_seconds']=round(time.monotonic()-started,3)
    report['peak_rss_kib']=max(memory) if memory else None
    report['rss_samples_kib']=memory
    Path(args.out).parent.mkdir(parents=True,exist_ok=True);Path(args.out).write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k not in ('samples','rss_samples_kib','last_status')}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--mode',choices=['live','replay'],default='live');p.add_argument('--seconds',type=int,default=1800);p.add_argument('--out',default='astra-results.json');run(p.parse_args())
