/** Operator dashboard served at `/`: runtime settings (models), status and jobs. Plain HTML + fetch, no build step. */
export function dashboardHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Holo Card Agent</title>
<style>
:root{--fg:#111;--muted:#666;--line:#e6e6e6;--bg:#fff;--ok:#1a7f37;--bad:#b42318;--warn:#b26a00;--accent:#111}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 28px;border-bottom:1px solid var(--line)}
header h1{font-size:18px;margin:0;font-weight:600}header nav a{margin-left:18px;color:var(--muted);text-decoration:none}header nav a:hover{color:var(--fg)}
main{max-width:1180px;margin:0 auto;padding:24px 28px;display:grid;gap:24px}
section{border:1px solid var(--line);border-radius:12px;padding:20px}
h2{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.kv{display:flex;flex-direction:column;gap:4px;font-size:13px}.kv b{color:var(--muted);font-weight:500}.kv span{font-family:ui-monospace,Menlo,monospace;word-break:break-all}
form.models{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted)}
input,select{font:inherit;padding:9px 10px;border:1px solid var(--line);border-radius:8px;color:var(--fg);background:#fff}
input:focus,select:focus{outline:2px solid #bbb;outline-offset:1px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
button{font:inherit;padding:9px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.ghost{background:#fff;color:var(--fg);border-color:var(--line)}button:disabled{opacity:.5;cursor:default}
.hint{font-size:12px;color:var(--muted)}.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.pill.ok{color:var(--ok);border-color:#bfe3c8}.pill.bad{color:var(--bad);border-color:#f3c2bd}.pill.warn{color:var(--warn);border-color:#f0d9a8}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
td.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}td a{color:var(--fg)}
#msg{min-height:18px;font-size:13px}#msg.ok{color:var(--ok)}#msg.bad{color:var(--bad)}
.override{font-size:11px;color:var(--warn)}
</style></head><body>
<header><h1>Holo Card Agent</h1><nav><a href="/cards/">Gallery</a><a href="/api/jobs">Jobs JSON</a><a href="/health">Health</a></nav></header>
<main>
<section><h2>Status</h2><div class="grid" id="status"></div></section>
<section><h2>Models — switch at runtime (applies to new sessions immediately)</h2>
<form class="models" id="models">
  <label>Card-building model (pi, tool use)<input name="buildModel" list="llm" autocomplete="off" spellcheck="false"><span class="override" data-for="buildModel"></span></label>
  <label>Buyer-chat model (pi)<input name="chatModel" list="llm" autocomplete="off" spellcheck="false"><span class="override" data-for="chatModel"></span></label>
  <label>Image model (Vercel AI Gateway)<input name="imageModel" list="img" autocomplete="off" spellcheck="false"><span class="override" data-for="imageModel"></span></label>
  <label>Thinking level<select name="thinking"><option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option></select><span class="override" data-for="thinking"></span></label>
</form>
<datalist id="llm"></datalist><datalist id="img"></datalist>
<div class="row"><button id="save">Save</button><button class="ghost" id="reset" type="button">Reset to .env defaults</button><input id="token" type="password" placeholder="admin token (remote only)" style="max-width:240px"><span id="msg"></span></div>
<p class="hint">Model ids: <code>vercel-ai-gateway/google/gemini-3-flash</code>, <code>vercel-ai-gateway/openai/gpt-5-mini</code>, <code>anthropic/claude-sonnet-4-5</code> … Image: <code>openai/gpt-image-1-mini</code>, <code>google/gemini-3.1-flash-lite-image</code>. Remote callers need the <code>ADMIN_TOKEN</code> from .env; loopback needs nothing.</p>
</section>
<section><h2>Jobs</h2><table><thead><tr><th>Job</th><th>Order</th><th>Status</th><th>Updated</th><th>Links</th></tr></thead><tbody id="jobs"></tbody></table></section>
</main>
<script>
const $=s=>document.querySelector(s);const token=()=>$('#token').value||localStorage.getItem('adminToken')||'';
const headers=()=>({'content-type':'application/json',...(token()?{'x-admin-token':token()}:{})});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function loadStatus(){const s=await fetch('/api/status').then(r=>r.json());
 const pill=(ok,t)=>'<span class="pill '+(ok?'ok':'bad')+'">'+esc(t)+'</span>';
 $('#status').innerHTML=[['Chain',s.chain],['Hosted agent',s.agentId||'— not set'],['Wallet',s.walletConfigured?'key mode':'WALLET_KEY missing'],['Image provider',s.imageProvider],['Listing',s.service.title+' · '+s.service.price+' '+s.service.currency+' · '+s.service.deliveryDays+'d'],['Public URL',s.publicBaseUrl||'—'],['Jobs',s.jobs.total+' total · '+s.jobs.active+' active · '+s.jobs.failed+' failed'],['Uptime',Math.round(s.uptimeSeconds/60)+' min']]
 .map(([k,v])=>'<div class="kv"><b>'+k+'</b><span>'+esc(v)+'</span></div>').join('');}
async function loadModels(){const m=await fetch('/api/models').then(r=>r.json());const f=$('#models');
 for(const k of ['buildModel','chatModel','imageModel','thinking']){f.elements[k].value=m[k];const o=f.querySelector('[data-for='+k+']');o.textContent=m.overrides[k]?'runtime override (default: '+m.defaults[k]+')':'';}
 const opt=await fetch('/api/models/options').then(r=>r.json()).catch(()=>({llm:[],image:[]}));
 $('#llm').innerHTML=opt.llm.map(x=>'<option value="'+esc(x)+'">').join('');$('#img').innerHTML=opt.image.map(x=>'<option value="'+esc(x)+'">').join('');}
async function loadJobs(){const jobs=await fetch('/api/jobs').then(r=>r.json());
 $('#jobs').innerHTML=jobs.length?jobs.map(j=>{const cls=j.status==='failed'?'bad':['delivered','settled','built'].includes(j.status)?'ok':'warn';
  const links=[];if(['built','delivering','delivered','settled'].includes(j.status)){links.push('<a href="/cards/'+esc(j.id)+'/" target="_blank">viewer</a>');links.push('<a href="/jobs/'+esc(j.id)+'/renders/hero.png" target="_blank">render</a>');links.push('<a href="/jobs/'+esc(j.id)+'/dist/'+esc(j.id)+'-holo-card.zip">zip</a>');}
  return '<tr><td class="mono">'+esc(j.id)+'</td><td class="mono">'+esc(j.orderId)+'</td><td><span class="pill '+cls+'">'+esc(j.status)+'</span>'+(j.error?'<div class="hint">'+esc(j.error.slice(0,140))+'</div>':'')+'</td><td class="mono">'+esc(j.updatedAt.replace('T',' ').slice(0,19))+'</td><td>'+links.join(' · ')+'</td></tr>';}).join(''):'<tr><td colspan="5" class="hint">No jobs yet.</td></tr>';}
async function save(patch){const r=await fetch('/api/models',{method:'POST',headers:headers(),body:JSON.stringify(patch)});const m=$('#msg');
 if(r.status===403){m.className='bad';m.textContent='Forbidden: enter the ADMIN_TOKEN (saved in this browser).';return;}
 if(!r.ok){m.className='bad';m.textContent=await r.text();return;}if(token())localStorage.setItem('adminToken',token());m.className='ok';m.textContent='Saved — new sessions use these models.';await loadModels();}
$('#models').addEventListener('submit',e=>e.preventDefault());
$('#save').onclick=()=>{const f=$('#models');save({buildModel:f.elements.buildModel.value,chatModel:f.elements.chatModel.value,imageModel:f.elements.imageModel.value,thinking:f.elements.thinking.value});};
$('#reset').onclick=()=>save({buildModel:'',chatModel:'',imageModel:'',thinking:''});
loadStatus();loadModels();loadJobs();setInterval(()=>{loadStatus();loadJobs();},15000);
</script></body></html>`;
}
