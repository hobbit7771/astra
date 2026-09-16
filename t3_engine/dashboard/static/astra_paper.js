(function(){
  'use strict';
  var latest=null, timer=null, stopped=false;
  function fmt(v){return v===null || v===undefined?'—':Number(v).toFixed(4);}
  function set(id,value){var n=document.getElementById(id);if(n.textContent!==String(value))n.textContent=value;}
  function table(id,items,values){
    var body=document.getElementById(id), old=new Map(Array.from(body.children).map(function(row){return [row.dataset.id,row];}));
    items.forEach(function(item){
      var row=old.get(item.id);
      if(!row){row=document.createElement('tr');row.dataset.id=item.id;values(item).forEach(function(){row.appendChild(document.createElement('td'));});}
      old.delete(item.id);
      values(item).forEach(function(value,i){if(row.children[i].textContent!==String(value))row.children[i].textContent=value;});
      // Insert/move only when ordering changed; stable ticks leave the DOM in place.
      if(body.children[items.indexOf(item)]!==row)body.insertBefore(row,body.children[items.indexOf(item)]||null);
    });
    old.forEach(function(row){row.remove();});
  }
  function poll(){
    if(stopped)return;
    fetch('/api/lead-engine/paper',{cache:'no-store',signal:AbortSignal.timeout(3000)}).then(function(r){if(!r.ok)throw Error(r.status);return r.json();}).then(function(data){
      if(!data.enabled){set('paperStatus',data.detail||'Журнал выключен');return;}
      latest=data;
      set('paperStatus',data.journal_error || 'PAPER · '+data.open_count+' открыто · сессия '+data.session_id.slice(0,8));
      set('paperRealized',fmt(data.realized_net_pnl));set('paperOpen',fmt(data.unrealized_net_pnl));set('paperEquity',fmt(data.equity));set('paperFees',fmt(data.fees_paid));set('paperCount',data.closed_count+' / '+data.wins);
      var c=data.config;
      set('paperRules','На сделку '+c.notional+' USDT · комиссия '+(c.fee_rate*100).toFixed(3)+'% за сторону · проскальзывание '+c.slippage_bps+' bps · стоп '+(c.stop_pct*100).toFixed(2)+'% · цель '+c.reward_risk+'R · срок '+c.max_hold_ms/60000+' мин.');
      table('paperPositions',data.positions,function(p){return [p.symbol,p.direction,fmt(p.entry),fmt(p.stop),fmt(p.target),fmt(p.unrealized_net_pnl)];});
      table('paperClosed',data.closed.slice().reverse(),function(t){return [t.symbol,new Date(t.signal_at).toISOString().replace('T',' ').slice(0,19),t.direction,fmt(t.entry),fmt(t.exit),t.exit_reason+(t.data_gap?' · GAP':''),fmt(t.fees),fmt(t.net_pnl)];});
    }).catch(function(){set('paperStatus','Связь с сервером потеряна — данные устарели');set('paperOpen','—');set('paperEquity','—');}).finally(function(){if(!stopped)timer=setTimeout(poll,1000);});
  }
  document.getElementById('paperExport').addEventListener('click',function(){
    if(!latest)return;
    var a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(latest,null,2)],{type:'application/json'}));
    a.href=url;a.download='Astra-paper-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
  });
  window.addEventListener('pagehide',function(){stopped=true;clearTimeout(timer);});
  window.addEventListener('pageshow',function(e){if(e.persisted){stopped=false;poll();}});
  poll();
})();
