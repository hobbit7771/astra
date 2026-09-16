// Execute the actual browser modules in a deterministic DOM/transport harness.
// This checks contracts and state; it does not claim visual/iPhone validation.
const assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
const root=path.resolve(__dirname,'../../t3_engine/dashboard/static');
const jobs=new Map(), storage=new Map(), listeners={}, nodes=new Map();let serial=0,clock=1000000;
class Node {
  constructor(){this.textContent='';this.style={};this.hidden=false;this.clientWidth=900;this.clientHeight=600;this.events={};this.children=[];this.classList={add(){},remove(){},toggle(){}};this.options=[];}
  addEventListener(e,fn){this.events[e]=fn;} removeEventListener(e){delete this.events[e];}
  setAttribute(k,v){this[k]=v;} getAttribute(k){return this[k];} appendChild(n){this.children.push(n);} remove(){}
  getBoundingClientRect(){return {left:0,top:0};}
  querySelectorAll(selector){
    if(selector==='[data-le]')return Array.from((this.innerHTML||'').matchAll(/data-le="([^"]+)"/g)).map(m=>{const n=new Node();n['data-le']=m[1];return n;});
    return [];
  }
  getContext(){return {setTransform(){},clearRect(){},beginPath(){},arc(){},fill(){},fillText(){},measureText(){return {width:50};}};}
}
const document={getElementById(id){if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},querySelectorAll(){return[];},addEventListener(e,fn){listeners[e]=fn;},createElement(){return new Node();},body:new Node()};
function series(){return {data:[],updates:[],setData(data){this.data=data;},update(c){this.updates.push(c);},createPriceLine(o){return o;},removePriceLine(){},coordinateToPrice(y){return 100-y/100;},priceToCoordinate(p){return (100-p)*100;}};}
const scale={subscribeVisibleLogicalRangeChange(){},unsubscribeVisibleLogicalRangeChange(){},coordinateToTime(x){return 1700000000+x;},timeToCoordinate(){return 10;},options(){return {barSpacing:8};},fitContent(){}};
const chart={addCandlestickSeries:series,addHistogramSeries:series,addLineSeries:series,priceScale(){return {applyOptions(){}};},timeScale(){return scale;},subscribeCrosshairMove(){},unsubscribeCrosshairMove(){},removeSeries(){},resize(){},remove(){}};
const sockets=[];
class Socket {static OPEN=1;constructor(url){this.url=url;this.readyState=1;sockets.push(this);}send(){}close(){this.readyState=3;if(this.onclose)this.onclose();}message(m){this.onmessage({data:JSON.stringify(m)});}}
function rows(n=250){return Array.from({length:n},(_,i)=>{let close=100+Math.sin(i/12);return {time:1700000100+i*300,open:100,high:102,low:98,close,volume:10+i,closed:i<n-1};});}
const initial=rows(), current=initial.at(-1), frame={enabled:true,symbol:'INJUSDT',price:99999,generated_at:clock/1000,health:{status:'OK',signals_enabled:true},signal:{state:'WATCH'},events:[{id:'e1',timestamp:current.time+3,price:100,type:'PRE_BREAK_LONG',direction:'long'}]};
const calls=[];
const context={document,console,Date,URLSearchParams,Map,Set,AbortController,AbortSignal,performance:{now:()=>clock},location:{pathname:'/lead-engine/INJUSDT',search:''},history:{replaceState(){}},devicePixelRatio:1,
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
 setTimeout:(fn,ms)=>{jobs.set(++serial,{fn,ms});return serial;},clearTimeout:id=>jobs.delete(id),setInterval:(fn,ms)=>{jobs.set(++serial,{fn,ms});return serial;},clearInterval:id=>jobs.delete(id),
 requestAnimationFrame:fn=>{jobs.set(++serial,{fn,ms:0});return serial;},cancelAnimationFrame:id=>jobs.delete(id),addEventListener(){},ResizeObserver:class{observe(){}disconnect(){}},WebSocket:Socket,
 LightweightCharts:{createChart:()=>chart,CrosshairMode:{Normal:0}},
 fetch:async url=>{calls.push(url);return {ok:true,json:async()=>url.endsWith('chart-config')?{enabled:true,ws_url:'wss://example.invalid'}:url.includes('/candles/')?{candles:initial}:frame};}
};context.window=context;vm.createContext(context);
for(const f of ['lead_panel.js','lead_blocks.js','lead_fib.js','lead_chart_math.js','lead_events.js','lead_workspace.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),context,{filename:f});
function reference(closes,p){let value=closes.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<closes.length;i++)value=2/(p+1)*closes[i]+(1-2/(p+1))*value;return value;}
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
async function run(){
 const {CandleModel}=context.LeadChartMath, m=new CandleModel(1500);m.load(initial);
 for(let i=0;i<100;i++)m.upsert({...current,close:100+i/200});
 for(const p of [9,18,50,200])assert.ok(Math.abs(m.rows.at(-1).ema[p]-reference(m.rows.map(c=>c.close),p))<1e-10);
 const confirmed={...current,closed:true,close:101};m.upsert(confirmed);assert.equal(m.upsert({...current,closed:false}),null);
 m.upsert({...current,time:current.time+300,closed:false,close:100});for(const p of [9,18,50,200])assert.ok(Math.abs(m.rows.at(-1).ema[p]-reference(m.rows.map(c=>c.close),p))<1e-10);
 assert.equal(context.LeadFib.levels(90,110,[.618])[0].price,97.64);
 assert.equal(context.LeadFib.levels(110,90,[.618])[0].price,102.36);
 const saved=[{id:'saved',start:{price:90,time:1},end:{price:110,time:2}}];storage.set('lead_fib:INJUSDT:5m',JSON.stringify(saved));
 listeners.DOMContentLoaded();await flush();
 const w=context.leadWorkspace;assert.equal(w.fib.drawings.length,1,'boot must not overwrite saved drawings');assert.equal(w.setDataCalls,1);assert.equal(w.candles.at(-1).close,current.close,'HTTP panel price must not fabricate OHLC');
 sockets[0].onopen();sockets[0].message({op:'subscribe',success:true});await flush();assert.equal(calls.filter(x=>x.includes('/candles/')).length,1);
 for(let i=0;i<20;i++)sockets[0].message({topic:'kline.5.INJUSDT',ts:current.time*1000+i,data:[{start:current.time*1000,open:'100',high:'102',low:'98',close:String(100+i/100),volume:String(80+i),confirm:false}]});
 assert.equal(w.updates,20);assert.equal(w.setDataCalls,1);assert.equal(w.candles.at(-1).volume,99);assert.equal(w.series.updates.length,20);
 for(const p of [9,18,50,200])assert.ok(Math.abs(w.candles.at(-1).ema[p]-reference(w.candles.map(c=>c.close),p))<1e-10);
 assert.equal(w.markers[0].timestamp,current.time+3);assert.equal(w.markers[0].price,100);
 w.fib.setChart('INJUSDT','1h');assert.equal(w.fib.drawings.length,0);w.fib.setChart('INJUSDT','5m');assert.equal(w.fib.drawings.length,1);
 const p=w.panel;for(let i=0;i<1000;i++)p.push({...frame,price:i});assert.equal(p.pending.price,999);assert.equal(p.stats().pendingFrames,1);
 // Drain the scheduled panel paint only, checking the real field renderer.
 clock+=500;
 for(const [id,job] of [...jobs])if(job.ms<=300){jobs.delete(id);job.fn();}
 for(const [id,job] of [...jobs])if(job.ms===0){jobs.delete(id);job.fn();}
 assert.ok(p.paints>=1);assert.equal(p.stats().pendingFrames,0);assert.equal(p.nodes['h:status'].textContent,'OK');
 p.dispose();p.push(frame);assert.equal(p.pending,null);
 console.log(JSON.stringify({result:'PASS',ema_periods:[9,18,50,200],ema_tolerance:1e-10,fib_directions:2,live_candle_updates:w.updates,history_requests:calls.filter(x=>x.includes('/candles/')).length,max_pending_panel_frames:1,signal_timestamp:w.markers[0].timestamp,visual_browser_test:false}));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
