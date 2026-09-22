/** Operator dashboard served at `/`: runtime settings (models), usage & spend, status and jobs. Plain HTML + fetch, no build step. */
export function dashboardHtml(prefix: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${prefix}/">
<title>Holo Card Agent</title>
<style>
:root{--fg:#111;--muted:#666;--line:#e6e6e6;--bg:#fff;--ok:#1a7f37;--bad:#b42318;--warn:#b26a00;--accent:#111}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 28px;border-bottom:1px solid var(--line)}
header h1{font-size:18px;margin:0;font-weight:600}header nav a{margin-left:18px;color:var(--muted);text-decoration:none}header nav a:hover{color:var(--fg)}
main{max-width:1180px;margin:0 auto;padding:24px 28px;display:grid;gap:24px}
section{border:1px solid var(--line);border-radius:12px;padding:20px}
h2{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 14px;display:flex;justify-content:space-between;align-items:center;gap:12px}
h2 .sub{font-weight:400;text-transform:none;letter-spacing:0;font-size:12px}
h3{font-size:13px;color:var(--muted);font-weight:500;margin:18px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.kv{display:flex;flex-direction:column;gap:4px;font-size:13px}.kv b{color:var(--muted);font-weight:500}.kv span{font-family:ui-monospace,Menlo,monospace;word-break:break-all}
.kv .big{font-size:22px;font-weight:600;font-family:inherit}
form.models{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted)}
input,select{font:inherit;padding:9px 10px;border:1px solid var(--line);border-radius:8px;color:var(--fg);background:#fff}
input:focus,select:focus{outline:2px solid #bbb;outline-offset:1px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
button{font:inherit;padding:9px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.ghost{background:#fff;color:var(--fg);border-color:var(--line)}button.small{padding:4px 10px;font-size:12px}button:disabled{opacity:.5;cursor:default}
.hint{font-size:12px;color:var(--muted)}.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.pill.ok{color:var(--ok);border-color:#bfe3c8}.pill.bad{color:var(--bad);border-color:#f3c2bd}.pill.warn{color:var(--warn);border-color:#f0d9a8}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
td.mono,th.num,td.num{font-family:ui-monospace,Menlo,monospace;font-size:12px}th.num,td.num{text-align:right;white-space:nowrap}td a{color:var(--fg)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:24px}
#msg{min-height:18px;font-size:13px}#msg.ok{color:var(--ok)}#msg.bad{color:var(--bad)}
.override,.price{font-size:11px;color:var(--warn)}.price{color:var(--muted)}
.combo{position:relative;display:block}.combo input{width:100%}.panel{position:absolute;z-index:10;left:0;right:0;top:100%;margin-top:4px;max-height:340px;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.08)}
.panel .grp{position:sticky;top:0;background:#fafafa;color:var(--muted);font-size:11px;padding:6px 10px;border-bottom:1px solid var(--line)}.panel .it{padding:7px 10px;cursor:pointer;display:flex;flex-direction:column;gap:2px}.panel .it:hover,.panel .it.sel{background:#f2f2f2}
.panel .it .id{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--fg)}.panel .it .lb{font-size:11px;color:var(--muted)}.panel .none{padding:10px;font-size:12px;color:var(--muted)}
</style></head><body>
<header><h1>Holo Card Agent</h1><nav><a href="cards/">Gallery</a><a href="api/usage">Usage JSON</a><a href="api/jobs">Jobs JSON</a><a href="health">Health</a></nav></header>
<main>
<section><h2>Status</h2><div class="grid" id="status"></div></section>
<section><h2><span>Models — switch at runtime (applies to new sessions immediately)</span><span class="sub" id="catalog"></span></h2>
<form class="models" id="models">
  <label>Card-building model (pi, tool use)<span class="combo"><input name="buildModel" data-list="llm" autocomplete="off" spellcheck="false" placeholder="type to search…"><div class="panel" hidden></div></span><span class="price" data-price="buildModel"></span><span class="override" data-for="buildModel"></span></label>
  <label>Buyer-chat model (pi)<span class="combo"><input name="chatModel" data-list="llm" autocomplete="off" spellcheck="false" placeholder="type to search…"><div class="panel" hidden></div></span><span class="price" data-price="chatModel"></span><span class="override" data-for="chatModel"></span></label>
  <label>Image model (relay, OpenAI Images API)<span class="combo"><input name="imageModel" data-list="image" autocomplete="off" spellcheck="false" placeholder="type to search…"><div class="panel" hidden></div></span><span class="price" data-price="imageModel"></span><span class="override" data-for="imageModel"></span></label>
  <label>Thinking level<select name="thinking"><option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option></select><span class="override" data-for="thinking"></span></label>
</form>
<div class="row"><button id="save">Save</button><button class="ghost" id="reset" type="button">Reset to .env defaults</button><button class="ghost" id="refresh" type="button">Refresh model list</button><input id="token" type="password" placeholder="admin token (remote only)" style="max-width:240px"><span id="msg"></span></div>
<p class="hint">The list comes live from the relay catalog (<code>GET /v1/models</code> on <code>RELAY_BASE_URL</code>; the relay publishes no prices, see its pricing page) plus any other provider pi has credentials for. Type to filter; any id on the list works, including models newer than pi's built-in table. Remote callers need the <code>ADMIN_TOKEN</code> from .env; loopback needs nothing.</p>
</section>
<section><h2><span>Usage &amp; spend</span><span class="sub" id="spendsub"></span></h2>
<div class="grid" id="spend"></div>
<div class="cols">
 <div><h3>This agent, by model (local ledger)</h3><table><thead><tr><th>Model</th><th class="num">Calls</th><th class="num">In</th><th class="num">Out</th><th class="num">Cached</th><th class="num">USD</th></tr></thead><tbody id="lmodel"></tbody></table></div>
</div>
<div class="cols">
 <div><h3>This agent, by day</h3><table><thead><tr><th>Day</th><th class="num">Calls</th><th class="num">In</th><th class="num">Out</th><th class="num">USD</th></tr></thead><tbody id="lday"></tbody></table></div>
</div>
<p class="hint">"Relay bill" is what the relay reports for this key (<code>/v1/dashboard/billing/usage</code> on <code>RELAY_BASE_URL</code>); it is the authoritative number. "This agent" is the local ledger (<code>DATA_DIR/usage.jsonl</code>): token counts are exact, but the relay publishes no prices, so relay models show $0 here (pi's own estimate applies only to models pi knows prices for). Check the relay's pricing page for per-model rates.</p>
</section>
<section><h2>Jobs</h2><table><thead><tr><th>Job</th><th>Order</th><th>Status</th><th class="num">Tokens in / out</th><th class="num">Cost</th><th>Updated</th><th>Links</th></tr></thead><tbody id="jobs"></tbody></table></section>
</main>
<script>
const $=s=>document.querySelector(s);const token=()=>$('#token').value||localStorage.getItem('adminToken')||'';
const headers=()=>({'content-type':'application/json',...(token()?{'x-admin-token':token()}:{})});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const usd=n=>n==null?'—':n===0?'$0':n<0.01?'$'+n.toFixed(5):'$'+n.toFixed(3);
const num=n=>n==null?'—':n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e4?(n/1e3).toFixed(0)+'k':String(n);
let OPTIONS={llm:[],image:[]};
async function loadStatus(){const s=await fetch('api/status').then(r=>r.json());
 $('#status').innerHTML=[['Chain',s.chain],['Hosted agent',s.agentId||'— not set'],['Wallet',s.walletConfigured?'key mode':'WALLET_KEY missing'],['Image provider',s.imageProvider],['Listing',s.service.title+' · '+s.service.price+' '+s.service.currency+' · '+s.service.deliveryDays+'d'],['Jobs',s.jobs.total+' total · '+s.jobs.active+' active · '+s.jobs.failed+' failed'],['Uptime',Math.round(s.uptimeSeconds/60)+' min']]
 .map(([k,v])=>'<div class="kv"><b>'+k+'</b><span>'+esc(v)+'</span></div>').join('');}
function showPrice(){const f=$('#models');for(const k of ['buildModel','chatModel','imageModel']){const v=f.elements[k].value;const list=k==='imageModel'?OPTIONS.image:OPTIONS.llm;const o=list.find(x=>x.id===v);
 f.querySelector('[data-price='+k+']').textContent=o?o.label:(v?'not in the catalog — will be tried as typed':'');}}
async function loadOptions(refresh){const q=refresh?'?refresh=1':'';OPTIONS=await fetch('api/models/options'+q).then(r=>r.json()).catch(()=>({llm:[],image:[]}));
 document.querySelectorAll('.combo .panel:not([hidden])').forEach(p=>renderPanel(p.previousElementSibling));
 $('#catalog').textContent=OPTIONS.catalogError?OPTIONS.catalogError:((OPTIONS.llm||[]).length+' text · '+(OPTIONS.image||[]).length+' image models · catalog '+(OPTIONS.catalogFetchedAt?new Date(OPTIONS.catalogFetchedAt).toLocaleTimeString():'—'));showPrice();}
async function loadModels(){const m=await fetch('api/models').then(r=>r.json());const f=$('#models');
 for(const k of ['buildModel','chatModel','imageModel','thinking']){f.elements[k].value=m[k];const o=f.querySelector('[data-for='+k+']');o.textContent=m.overrides[k]?'runtime override (default: '+m.defaults[k]+')':'';}
 showPrice();}
async function loadUsage(){const u=await fetch('api/usage').then(r=>r.json()).catch(()=>null);if(!u)return;const g=u.relay,l=u.local;
 const cells=[];cells.push(['Relay bill, this key, last 30 d','<span class="big">'+usd(g.totalUsed)+'</span>']);cells.push(['Relay remaining quota',g.remaining==null?'unlimited / not reported':usd(g.remaining)]);
 cells.push(['This agent today',usd(l.today.cost)+' · '+l.today.calls+' calls']);cells.push(['This agent, last 7 d',usd(l.last7d.cost)+' · '+l.last7d.calls+' calls']);cells.push(['This agent, all time',usd(l.allTime.cost)+' · '+num(l.allTime.input)+' in / '+num(l.allTime.output)+' out']);
 const k=l.byKind;cells.push(['By kind (all time)',['build','chat','image'].filter(x=>k[x]).map(x=>x+' '+usd(k[x].cost)).join(' · ')||'—']);
 $('#spend').innerHTML=cells.map(([a,b])=>'<div class="kv"><b>'+a+'</b><span>'+b+'</span></div>').join('');
 $('#spendsub').textContent=g.error?('relay: '+g.error):('relay '+g.baseUrl+' · '+g.startDate+' → '+g.endDate+', refreshed '+new Date(g.fetchedAt).toLocaleTimeString());
 $('#lmodel').innerHTML=l.byModel.slice(0,12).map(r=>'<tr><td class="mono">'+esc(r.model)+'</td><td class="num">'+r.calls+'</td><td class="num">'+num(r.input)+'</td><td class="num">'+num(r.output)+'</td><td class="num">'+num(r.cacheRead)+'</td><td class="num">'+usd(r.cost)+'</td></tr>').join('')||'<tr><td colspan="6" class="hint">No calls recorded yet.</td></tr>';
 $('#lday').innerHTML=l.byDay.slice(0,10).map(r=>'<tr><td class="mono">'+esc(r.day)+'</td><td class="num">'+r.calls+'</td><td class="num">'+num(r.input)+'</td><td class="num">'+num(r.output)+'</td><td class="num">'+usd(r.cost)+'</td></tr>').join('')||'<tr><td colspan="5" class="hint">—</td></tr>';}
async function loadJobs(){const jobs=await fetch('api/jobs').then(r=>r.json());
 $('#jobs').innerHTML=jobs.length?jobs.map(j=>{const cls=j.status==='failed'?'bad':['delivered','settled','built'].includes(j.status)?'ok':'warn';
  const links=[];if(['built','delivering','delivered','settled'].includes(j.status)){links.push('<a href="jobs/'+esc(j.id)+'/renders/hero.png" target="_blank">render</a>');if(j.prunedAt){links.push('<span title="old order: dist/web removed, renders + metadata kept">pruned</span>');}else{links.push('<a href="cards/'+esc(j.id)+'/" target="_blank">viewer</a>');links.push('<a href="jobs/'+esc(j.id)+'/dist/'+esc(j.id)+'-holo-card.zip">zip</a>');}}
  if(j.shareUrl)links.push('<a href="'+esc(j.shareUrl)+'" target="_blank" rel="noopener">share page</a>');
  const u=j.usage;return '<tr><td class="mono">'+esc(j.id)+'</td><td class="mono">'+esc(j.orderId)+'</td><td><span class="pill '+cls+'">'+esc(j.status)+'</span>'+(j.error?'<div class="hint">'+esc(j.error.slice(0,140))+'</div>':'')+'</td><td class="num">'+(u?num(u.input)+' / '+num(u.output)+'<div class="hint">'+u.calls+' calls</div>':'—')+'</td><td class="num">'+(u?usd(u.cost):'—')+'</td><td class="mono">'+esc(j.updatedAt.replace('T',' ').slice(0,19))+'</td><td>'+links.join(' · ')+'</td></tr>';}).join(''):'<tr><td colspan="7" class="hint">No jobs yet.</td></tr>';}
async function save(patch){const r=await fetch('api/models',{method:'POST',headers:headers(),body:JSON.stringify(patch)});const m=$('#msg');
 if(r.status===403){m.className='bad';m.textContent='Forbidden: enter the ADMIN_TOKEN (saved in this browser).';return;}
 if(!r.ok){m.className='bad';m.textContent=await r.text();return;}if(token())localStorage.setItem('adminToken',token());m.className='ok';m.textContent='Saved — new sessions use these models.';await loadModels();}
$('#models').addEventListener('submit',e=>e.preventDefault());$('#models').addEventListener('input',showPrice);
// Searchable picker: shows the whole catalog when the box is focused, filters by every word typed (id + label), click to choose.
function groupOf(id){const p=id.split('/');return p.length>2?p[0]+' / '+p[1]:p[0];}
function renderPanel(inp){const panel=inp.nextElementSibling;const list=OPTIONS[inp.dataset.list]||[];const words=inp.value.toLowerCase().split(/\s+/).filter(Boolean);
 const hits=list.filter(o=>{const h=(o.id+' '+o.label).toLowerCase();return words.every(w=>h.includes(w));});
 let html='',g='';for(const o of hits.slice(0,600)){const gg=groupOf(o.id);if(gg!==g){g=gg;html+='<div class="grp">'+esc(g)+'</div>';}html+='<div class="it" data-id="'+esc(o.id)+'"><span class="id">'+esc(o.id)+'</span><span class="lb">'+esc(o.label)+'</span></div>';}
 panel.innerHTML=html||'<div class="none">No match in the catalog'+(inp.value?' — the id will be used as typed.':'')+'</div>';panel.hidden=false;}
for(const inp of document.querySelectorAll('.combo input')){const panel=inp.nextElementSibling;
 inp.addEventListener('focus',()=>renderPanel(inp));inp.addEventListener('input',()=>renderPanel(inp));
 inp.addEventListener('keydown',e=>{if(e.key==='Escape'){panel.hidden=true;}if(e.key==='Enter'){e.preventDefault();const f=panel.querySelector('.it');if(f&&!panel.hidden){inp.value=f.dataset.id;panel.hidden=true;showPrice();}}});
 inp.addEventListener('blur',()=>setTimeout(()=>{panel.hidden=true;},150));
 panel.addEventListener('mousedown',e=>{const it=e.target.closest('.it');if(!it)return;e.preventDefault();inp.value=it.dataset.id;panel.hidden=true;showPrice();});}

$('#save').onclick=()=>{const f=$('#models');save({buildModel:f.elements.buildModel.value,chatModel:f.elements.chatModel.value,imageModel:f.elements.imageModel.value,thinking:f.elements.thinking.value});};
$('#reset').onclick=()=>save({buildModel:'',chatModel:'',imageModel:'',thinking:''});
$('#refresh').onclick=async()=>{const b=$('#refresh');b.disabled=true;b.textContent='Refreshing…';try{await loadOptions(true);}finally{b.disabled=false;b.textContent='Refresh model list';}};
loadStatus();loadModels().then(()=>loadOptions(false));loadUsage();loadJobs();setInterval(()=>{loadStatus();loadJobs();loadUsage();},15000);
</script></body></html>`;
}
