import http from "node:http";
import { loadDb, saveDb } from "./lib/store.js";
import {
  appendSegment,
  settleChain,
  reviseSegment,
  resumeSegment,
  listChainsView,
  ChainRuleError
} from "./lib/chains.js";

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
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tests || []).length;
  return { ...item, logCount };
}
function ruleStatus(code) {
  if (code === "segment_not_found") return 404;
  if (code === "invalid_input") return 400;
  return 409;
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
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.halted { background:#8a6d3b; } button:disabled { opacity:.5; cursor:not-allowed; }
    .tabs { display:flex; gap:8px; margin-bottom:16px; } .tabs button { background:#dfe5da; color:var(--ink); } .tabs button.on { background:var(--accent); color:#fff; }
    .view { display:grid; grid-template-columns:380px 1fr; gap:22px; } .view.hidden { display:none; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.active { background:#e7efe1; border-color:#b8cda9; } .pill.chained { background:#ecefea; } .pill.settled { background:#e3e6df; } .pill.halted { background:#f3e7d6; border-color:#d8bd93; color:#8a6d3b; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .banner { border:1px solid var(--warn); color:var(--warn); background:#f8ece8; border-radius:8px; padding:10px 14px; margin-bottom:14px; display:none; } .banner.show { display:block; }
    .chain-segments { border-top:1px solid var(--line); padding-top:8px; display:grid; gap:8px; }
    .seg { border-left:3px solid var(--line); padding:4px 0 4px 10px; display:grid; gap:2px; } .seg.active { border-left-color:var(--accent); } .seg.halted { border-left-color:#8a6d3b; opacity:.75; } .seg.settled { border-left-color:#9aa196; }
    .seg-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; } .seg-actions button { padding:5px 9px; font-size:12px; }
    .hint { font-size:12px; color:var(--muted); margin-top:6px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} .view{grid-template-columns:1fr;} main{padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>墨锭试磨室</h1><div class="meta">墨锭建档、试磨记录，以及同砚续磨链</div></div><button id="reload">刷新</button></header>
  <main>
    <div class="tabs">
      <button id="tabOld" class="on">旧试磨记录</button>
      <button id="tabChains">续磨链</button>
    </div>

    <section id="viewOld" class="view">
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存墨锭</button></form>
      <section>
        <div class="stats" id="stats"></div>
        <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
        <div class="panel"><h2>选择墨锭后录入试磨记录，系统会保留多次试磨结果并更新评分状态。</h2><div class="grid" id="cards"></div></div>
      </section>
    </section>

    <section id="viewChains" class="view hidden">
      <form id="grindForm">
        <h2>续磨一段</h2>
        <label>砚台</label><input name="stone" id="stoneInput" list="stoneList" required placeholder="如：青石三方砚">
        <datalist id="stoneList"></datalist>
        <label>研墨分钟</label><input name="minutes" type="number" min="0" step="0.1" required>
        <label>残墨量（克）</label><input name="leftover" type="number" min="0" step="0.01" required>
        <label>研磨人</label><input name="grinder" required>
        <div class="hint">同砚若有未结算的段，新段自动接在其后；新砚台则开一条新链。同砚同一时间只挂一段。</div>
        <div style="margin-top:12px"><button>提交续磨</button></div>
      </form>
      <section>
        <div id="chainBanner" class="banner"></div>
        <div class="panel"><h2>续磨链：累计研墨超过 40 分钟或残墨少于 2 克时请换砚；改正前段后，后续段会先停用。</h2><div class="grid" id="chainCards"></div></div>
      </section>
    </section>
  </main>
  <script>
    const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
    const stages = ["待试磨","已试磨","重点观察"];
    const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];
    const segStatus = { active: "挂砚中", chained: "已续接", settled: "已结算", halted: "已停用" };
    const createForm = document.querySelector('#createForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const chainCards = document.querySelector('#chainCards');
    const chainBanner = document.querySelector('#chainBanner');
    const grindForm = document.querySelector('#grindForm');
    let items = [];
    let chains = [];

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '请求失败');
      return data;
    }
    function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function fmtTime(at) { return at ? new Date(at).toLocaleString('zh-CN', { hour12:false }) : ''; }
    function showBanner(lines, isError) {
      if (!lines || !lines.length) { chainBanner.classList.remove('show'); chainBanner.textContent = ''; return; }
      chainBanner.classList.toggle('show', true);
      chainBanner.innerHTML = lines.map(l => '<div>' + (isError ? '✗ ' : '⚠ ') + esc(l) + '</div>').join('');
    }

    // ---------- 旧试磨视图 ----------
    document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
    // 旧的“创建试磨记录”表单挂在墨锭卡片上，保持原有录入方式不变。
    function renderOld() {
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+encodeURIComponent(sel.dataset.status), { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await loadOld(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+encodeURIComponent(id)+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await loadOld(); } });
      document.querySelectorAll('[data-test]').forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.test;
        const paper = prompt('试磨纸张'); if (paper === null) return;
        const water = prompt('加水量') || '';
        const score = Number(prompt('评分', '80') || 0);
        await api('/api/items/'+encodeURIComponent(id)+'/action', { method:'POST', body: JSON.stringify({ paper, water, score }) });
        await loadOld();
      });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+esc(item[key])+'</div>').join('');
      const tests = (item.tests || []).slice(-3).map(t => '<div>试磨：'+esc(t.paper || '')+'，评分'+esc(t.score ?? '')+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      return '<article class="card"><h3>'+esc(item.code || item.id)+'</h3><span class="pill">'+esc(item.status)+'</span>'+main
        + '<label>状态</label><select data-status="'+esc(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'
        + '<div><button class="secondary" data-test="'+esc(item.id || item.code)+'">创建试磨记录</button> <button class="secondary" data-note="'+esc(item.id || item.code)+'">追加备注</button></div>'
        + '<div class="logs meta">'+(tests || logs || '暂无记录')+'</div></article>';
    }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await loadOld(); };
    document.querySelector('#statusFilter').onchange = renderOld; document.querySelector('#search').oninput = renderOld;

    // ---------- 续磨链视图 ----------
    function renderChains() {
      const stones = [...new Set(chains.map(c => c.stone))];
      document.querySelector('#stoneList').innerHTML = stones.map(s => '<option value="'+esc(s)+'">').join('');
      if (!chains.length) { chainCards.innerHTML = '<div class="meta">还没有续磨链，先在左侧续磨一段。</div>'; return; }
      chainCards.innerHTML = chains.map(chainCardHtml).join('');
      chainCards.querySelectorAll('[data-settle]').forEach(btn => btn.onclick = () => settle(btn.dataset.settle));
      chainCards.querySelectorAll('[data-resume]').forEach(btn => btn.onclick = () => resume(btn.dataset.resume));
      chainCards.querySelectorAll('[data-revise]').forEach(btn => btn.onclick = () => revise(btn.dataset.revise));
    }
    function chainCardHtml(chain) {
      const head = '<h3>'+esc(chain.stone)+'</h3>'
        + '<span class="pill '+(chain.settled ? 'settled' : 'active')+'">'+(chain.settled ? '已结算' : '挂砚中')+'</span>'
        + '<div class="meta">链号 '+esc(chain.id)+' · 共 '+chain.segments.length+' 段 · 累计 '+chain.totalMinutes+' 分钟'+(chain.haltedCount ? ' · <span class="warn">'+chain.haltedCount+' 段停用</span>' : '')+'</div>'
        + (chain.settledAt ? '<div class="meta">结算于 '+fmtTime(chain.settledAt)+'</div>' : '')
        + (chain.warnings.length ? '<div class="warn">'+chain.warnings.map(w => '⚠ '+esc(w)).join('<br>')+'</div>' : '');
      const segs = '<div class="chain-segments">' + chain.segments.map(s => segHtml(chain, s)).join('') + '</div>';
      return '<article class="card">'+head+segs+'</article>';
    }
    function segHtml(chain, s) {
      const actions = [];
      if (s.status === 'active' && !chain.settled) actions.push('<button data-settle="'+esc(s.id)+'">结算末段</button>');
      if (!chain.settled && s.status !== 'settled') actions.push('<button class="secondary" data-revise="'+esc(s.id)+'">改正数据</button>');
      if (s.status === 'halted') actions.push('<button class="halted" data-resume="'+esc(s.id)+'">启用此段</button>');
      return '<div class="seg '+s.status+'">'
        + '<div><span class="pill '+s.status+'">'+segStatus[s.status]+'</span> <b>'+esc(s.grinder)+'</b></div>'
        + '<div class="meta">研墨 '+esc(s.minutes)+' 分钟 · 残墨 '+esc(s.leftover)+' 克 · '+fmtTime(s.createdAt)+'</div>'
        + (s.inkDestination ? '<div class="meta">余墨去向：'+esc(s.inkDestination)+'</div>' : '')
        + (s.revisions && s.revisions.length ? '<div class="meta warn">已改正 '+s.revisions.length+' 次</div>' : '')
        + (actions.length ? '<div class="seg-actions">'+actions.join('')+'</div>' : '')
        + '</div>';
    }
    grindForm.onsubmit = async event => {
      event.preventDefault();
      try {
        const result = await api('/api/chains/segments', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(grindForm).entries())) });
        grindForm.reset();
        showBanner(result.summary.warnings, false);
        await loadChains();
      } catch (e) { showBanner([e.message], true); }
    };
    async function settle(id) {
      const destination = prompt('余墨去向（如：回锭封存 / 当日用完 / 入小盏留存）');
      if (destination === null) return;
      try { await api('/api/chains/segments/'+encodeURIComponent(id)+'/settle', { method:'POST', body: JSON.stringify({ destination }) }); await loadChains(); }
      catch (e) { showBanner([e.message], true); }
    }
    async function resume(id) {
      try { await api('/api/chains/segments/'+encodeURIComponent(id)+'/resume', { method:'POST' }); await loadChains(); }
      catch (e) { showBanner([e.message], true); }
    }
    function revise(id) {
      const s = chains.flatMap(c => c.segments).find(x => x.id === id);
      const stone = prompt('砚台', s.stone); if (stone === null) return;
      const minutes = prompt('研墨分钟', s.minutes); if (minutes === null) return;
      const leftover = prompt('残墨量（克）', s.leftover); if (leftover === null) return;
      const grinder = prompt('研磨人', s.grinder); if (grinder === null) return;
      api('/api/chains/segments/'+encodeURIComponent(id), { method:'PATCH', body: JSON.stringify({ stone, minutes, leftover, grinder }) })
        .then(() => loadChains()).catch(e => showBanner([e.message], true));
    }

    // ---------- 装载与分页 ----------
    async function loadOld() { items = await api('/api/items'); renderOld(); }
    async function loadChains() { chains = await api('/api/chains'); renderChains(); }
    document.querySelector('#tabOld').onclick = () => switchTab('old');
    document.querySelector('#tabChains').onclick = () => switchTab('chains');
    let currentTab = 'old';
    function switchTab(tab) {
      currentTab = tab;
      document.querySelector('#tabOld').classList.toggle('on', tab === 'old');
      document.querySelector('#tabChains').classList.toggle('on', tab === 'chains');
      document.querySelector('#viewOld').classList.toggle('hidden', tab !== 'old');
      document.querySelector('#viewChains').classList.toggle('hidden', tab !== 'chains');
      if (tab === 'chains') loadChains();
    }
    document.querySelector('#reload').onclick = () => currentTab === 'chains' ? loadChains() : loadOld();
    loadOld();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    // 旧试磨：建档、改状态、备注、试磨录入，全部维持原行为。
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建墨锭" }] };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
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
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));

    // 续磨链：路由只做参数收发，判定全部交给 lib/chains.js。
    if (req.method === "GET" && url.pathname === "/api/chains") {
      return send(res, 200, listChainsView(db));
    }
    if (req.method === "POST" && url.pathname === "/api/chains/segments") {
      const result = appendSegment(db, await body(req));
      await saveDb(db);
      return send(res, 201, { ...listChainsView(db).find(c => c.id === result.chain.id), newSegmentId: result.segment.id, summary: result.summary });
    }
    const settle = url.pathname.match(/^\/api\/chains\/segments\/([^/]+)\/settle$/);
    if (settle && req.method === "POST") {
      const result = settleChain(db, settle[1], (await body(req)).destination);
      await saveDb(db);
      return send(res, 200, listChainsView(db).find(c => c.id === result.chain.id));
    }
    const resume = url.pathname.match(/^\/api\/chains\/segments\/([^/]+)\/resume$/);
    if (resume && req.method === "POST") {
      const result = resumeSegment(db, resume[1]);
      await saveDb(db);
      return send(res, 200, listChainsView(db).find(c => c.id === result.chain.id));
    }
    const segPatch = url.pathname.match(/^\/api\/chains\/segments\/([^/]+)$/);
    if (segPatch && req.method === "PATCH") {
      const result = reviseSegment(db, segPatch[1], await body(req));
      await saveDb(db);
      return send(res, 200, { ...listChainsView(db).find(c => c.id === result.chain.id), halted: result.halted });
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof ChainRuleError) return send(res, ruleStatus(error.code), { error: error.code, message: error.message });
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("墨锭试磨室 listening on http://localhost:" + port));
