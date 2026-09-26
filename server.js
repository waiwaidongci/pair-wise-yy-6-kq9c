import http from "node:http";
import { loadDb, saveDb } from "./lib/store.js";
import { allChains, appendSegment, chainSummary, correctSegment, validateSegmentInput } from "./lib/grind-chain.js";

const port = Number(process.env.PORT || 3037);
const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
const stages = ["待试磨","已试磨","重点观察"];
const statLabels = ["待试磨","已试磨","重点观察"];
const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "IS-" + Date.now(); }
function newSegmentId() { return "SG-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>墨锭试磨室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:10px 0 6px; font-size:15px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .seg { display:flex; gap:8px; align-items:center; justify-content:space-between; border-top:1px solid var(--line); padding-top:6px; font-size:13px; }
    .seg.off { opacity:.55; } .seg button { padding:4px 8px; font-size:12px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>墨锭试磨室</h1><div class="meta">墨锭建档、试磨记录、评分统计和续磨链</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存墨锭</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>创建试磨记录</h2><label>选择墨锭</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
      <form id="chainForm" style="margin-top:14px"><h2>续磨登记</h2><label>砚台</label><input name="inkstone" required><label>研墨分钟</label><input name="minutes" type="number" min="1" required><label>残墨量（克）</label><input name="residualInk" type="number" min="0" step="0.1" required><label>研磨人</label><input name="grinder" required><button>接上续磨段</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>选择墨锭后录入试磨记录，系统会保留多次试磨结果并更新评分状态。</h2><div class="grid" id="cards"></div></div>
      <div class="panel" id="detailPanel" style="display:none;margin-top:14px"></div>
      <div class="panel" style="margin-top:14px"><h2>续磨链</h2><div class="meta">同一块砚的新段接在未结算的前一段后面，前段随之结算，同砚同时只挂一段；累计研墨超40分钟或残墨不足2克时提示换砚；改正前段后，后续段先停用。</div><div class="grid" id="chains" style="margin-top:10px"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
    const stages = ["待试磨","已试磨","重点观察"];
    const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-detail]').forEach(btn => btn.onclick = async () => { const item = await api('/api/items/'+btn.dataset.detail); showDetail(item); });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><button class="secondary" data-detail="'+(item.id || item.code)+'">试磨详情</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function showDetail(item) {
      const panel = document.querySelector('#detailPanel');
      const tests = (item.tests || []).map(t => '<div>'+t.at+' · '+(t.paper || '试纸')+' · 评分'+(t.score ?? '')+'</div>').join('');
      const logs = (item.logs || []).map(l => '<div>'+l.at+' · '+l.step+'：'+l.note+'</div>').join('');
      panel.innerHTML = '<h2>'+(item.code || item.id)+' · 旧试磨详情</h2><div class="meta">当前状态 '+item.status+'</div><h3>试磨记录</h3><div class="logs meta">'+(tests || '暂无试磨记录')+'</div><h3>日志</h3><div class="logs meta">'+(logs || '暂无日志')+'</div><button class="secondary" id="closeDetail">关闭</button>';
      panel.style.display = 'block';
      document.querySelector('#closeDetail').onclick = () => { panel.style.display = 'none'; };
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = () => { load(); loadChains(); };

    // ===== 续磨链卡片操作 =====
    const chainForm = document.querySelector('#chainForm');
    const chainsEl = document.querySelector('#chains');
    let chains = [];
    async function loadChains() { chains = await api('/api/chains'); renderChains(); }
    function renderChains() {
      chainsEl.innerHTML = chains.length ? chains.map(chainCardHtml).join('') : '<div class="meta">暂无续磨记录，先在左侧登记一段。</div>';
      document.querySelectorAll('[data-correct]').forEach(btn => btn.onclick = () => correctChainSegment(btn.dataset.correct));
    }
    function chainCardHtml(chain) {
      const segs = chain.segments.map((s, i) => '<div class="seg"><span>段'+(i+1)+' · '+s.minutes+'分钟 · 残墨'+s.residualInk+'克 · '+s.grinder+'</span><span class="pill">'+s.status+'</span><button class="secondary" data-correct="'+s.id+'">改正</button></div>').join('');
      const off = chain.disabled.map(s => '<div class="seg off"><span>'+s.minutes+'分钟 · 残墨'+s.residualInk+'克 · '+s.grinder+'</span><span class="pill">已停用</span></div>').join('');
      const warn = chain.warn ? '<div class="warn">建议换砚：'+chain.reasons.join('；')+'</div>' : '';
      return '<article class="card"><h3>'+chain.inkstone+'</h3><div class="meta">累计研墨'+chain.totalMinutes+'分钟 · 最新残墨'+(chain.latestResidual === null ? '—' : chain.latestResidual+'克')+'</div>'+warn+segs+off+'</article>';
    }
    async function correctChainSegment(id) {
      const chain = chains.find(c => c.segments.some(s => s.id === id));
      const seg = chain && chain.segments.find(s => s.id === id);
      if (!seg) return;
      const minutes = prompt('研墨分钟', seg.minutes);
      if (minutes === null) return;
      const residualInk = prompt('残墨量（克）', seg.residualInk);
      if (residualInk === null) return;
      const grinder = prompt('研磨人', seg.grinder);
      if (grinder === null) return;
      const res = await api('/api/segments/'+id, { method:'PATCH', body: JSON.stringify({ minutes, residualInk, grinder }) });
      if (res.disabled && res.disabled.length) alert('前段已改正，后续'+res.disabled.length+'段已停用');
      if (res.warning && res.warning.warn) alert('建议换砚：'+res.warning.reasons.join('；'));
      await loadChains();
    }
    chainForm.onsubmit = async event => {
      event.preventDefault();
      const res = await api('/api/segments', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(chainForm).entries())) });
      chainForm.reset();
      if (res.warning && res.warning.warn) alert('建议换砚：'+res.warning.reasons.join('；'));
      await loadChains();
    };

    renderForms(); load(); loadChains();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建墨锭" }] };

      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const getItem = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (getItem && req.method === "GET") {
      const item = db.items.find(x => x.id === getItem[1] || x.code === getItem[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      return send(res, 200, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      Object.assign(item, await body(req));
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      const score = Number(input.score || 0);
      item.tests ||= [];
      item.tests.push({ at: new Date().toISOString(), ...input, score });
      item.status = score >= 85 ? "已试磨" : "重点观察";
      item.logs.push({ at: new Date().toISOString(), step: "试磨", note: (input.paper || "试纸") + "，评分" + score, score });
      await saveDb(db);
      return send(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/api/chains") return send(res, 200, allChains(db.segments));
    if (req.method === "GET" && url.pathname === "/api/segments") return send(res, 200, db.segments);
    if (req.method === "POST" && url.pathname === "/api/segments") {
      const input = await body(req);
      const errors = validateSegmentInput(input);
      if (errors.length) return send(res, 400, { error: errors.join("；") });
      const { created, settled } = appendSegment(db.segments, input, newSegmentId());
      await saveDb(db);
      const summary = chainSummary(db.segments, created.inkstone);
      return send(res, 201, { segment: created, settled, warning: { warn: summary.warn, reasons: summary.reasons } });
    }
    const segPatch = url.pathname.match(/^\/api\/segments\/([^/]+)$/);
    if (segPatch && req.method === "PATCH") {
      const result = correctSegment(db.segments, segPatch[1], await body(req));
      if (result.error) {
        const status = result.error === "segment_not_found" ? 404 : result.error === "segment_disabled" ? 409 : 400;
        return send(res, status, { error: result.error });
      }
      await saveDb(db);
      const summary = chainSummary(db.segments, result.updated.inkstone);
      return send(res, 200, { segment: result.updated, disabled: result.disabled, warning: { warn: summary.warn, reasons: summary.reasons } });
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("墨锭试磨室 listening on http://localhost:" + port));
