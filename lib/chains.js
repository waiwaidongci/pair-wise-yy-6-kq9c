// 续磨判定层：只管续磨链的规则与状态机，不碰文件读写，也不知道页面/卡片的存在。
//
// 一条链（chain）上的每一段（segment）依次记录：
//   stone 砚台 / minutes 本段研墨分钟 / leftover 本段结束时残墨量(克) / grinder 研磨人
// 段状态：
//   active  挂在砚上、尚未结算的最新一段（同砚同时只能有一段）
//   chained 后面已续上新段，本段不再占用砚台
//   settled 已结算（余墨去向已登记）
//   halted  前段数据改正后被停用的后续段，可按序启用回来
export const MAX_TOTAL_MINUTES = 40;
export const MIN_LEFTOVER_GRAMS = 2;

export class ChainRuleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let seq = 0;
export function newSegmentId() {
  seq = (seq + 1) % 1000;
  return "GS-" + Date.now().toString(36) + "-" + String(seq).padStart(3, "0");
}
export function newChainId() {
  return "GC-" + Date.now().toString(36);
}

function findSegment(db, segmentId) {
  for (const chain of db.grindChains) {
    const segment = chain.segments.find(s => s.id === segmentId);
    if (segment) return { chain, segment };
  }
  return null;
}

// 头段 = prevId 为空的段。
function headSegment(chain) {
  return chain.segments.find(s => !s.prevId) || chain.segments[0];
}

// nextId 链在改数据时可能尚未回填，提供 prevId 兜底顺序遍历。
function orderedSegments(chain) {
  const byId = new Map(chain.segments.map(s => [s.id, s]));
  const head = headSegment(chain);
  const out = [];
  let cur = head;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = byId.get(cur.nextId) || chain.segments.find(s => s.prevId === cur.id);
  }
  return out;
}

// 同砚当前挂着的未结算段：settled 链整体跳过；halted 段也算占着（必须先处理，不能另开新链）。
// 取链上真正的末段（按 prev/next 顺序），不能拿到中间的 chained 段。
export function openTailForStone(db, stone) {
  for (const chain of db.grindChains) {
    if (chain.settled) continue;
    const open = orderedSegments(chain).filter(s => s.stone === stone && s.status !== "settled");
    if (open.length) return { chain, segment: open[open.length - 1] };
  }
  return null;
}

function toNumber(value, field, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ChainRuleError("invalid_input", label + "必须是不小于 0 的数字");
  }
  return field === "minutes" ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
}

function normalizeInput(input) {
  const stone = String(input.stone || "").trim();
  const grinder = String(input.grinder || "").trim();
  if (!stone) throw new ChainRuleError("invalid_input", "砚台不能为空");
  if (!grinder) throw new ChainRuleError("invalid_input", "研磨人不能为空");
  return {
    stone,
    minutes: toNumber(input.minutes, "minutes", "研墨分钟"),
    leftover: toNumber(input.leftover, "leftover", "残墨量"),
    grinder
  };
}

// 计算一条链上仍然有效的段的累计研墨。
// 从链头开始计数，遇到第一个 halted 段即截断：其后的段是"悬空"的，恢复前不计入，
// 残墨/换砚提示也只看截断点之前的挂砚段。
export function chainSummary(chain) {
  const active = [];
  for (const s of orderedSegments(chain)) {
    if (s.status === "halted" || s.status === "settled") break;
    active.push(s);
  }
  const totalMinutes = Math.round(active.reduce((sum, s) => sum + s.minutes, 0) * 10) / 10;
  const tail = active[active.length - 1] || null;
  const warnings = [];
  if (totalMinutes > MAX_TOTAL_MINUTES) {
    warnings.push("累计研墨" + totalMinutes + "分钟，已超过" + MAX_TOTAL_MINUTES + "分钟，请换砚");
  }
  if (tail && tail.leftover < MIN_LEFTOVER_GRAMS) {
    warnings.push("残墨仅剩" + tail.leftover + "克，少于" + MIN_LEFTOVER_GRAMS + "克，请换砚");
  }
  return { totalMinutes, tail, warnings };
}

// 续磨：新的一段接在未结算的前一段后面；同砚不能同时挂两段（halted 段挡路也不行）。
export function appendSegment(db, rawInput) {
  const input = normalizeInput(rawInput);
  const open = openTailForStone(db, input.stone);
  const now = new Date().toISOString();
  let chain;
  let prev = null;

  if (open) {
    if (open.segment.status === "halted") {
      throw new ChainRuleError("tail_halted", "前段已停用，请先改正或启用该段后再续磨");
    }
    chain = open.chain;
    prev = open.segment;
    if (prev.status !== "active") {
      throw new ChainRuleError("tail_not_active", "同砚已有一段挂在砚上，不能再开新段");
    }
  } else {
    chain = { id: newChainId(), stone: input.stone, settled: false, createdAt: now, segments: [] };
    db.grindChains.push(chain);
  }

  const segment = {
    id: newSegmentId(),
    chainId: chain.id,
    prevId: prev ? prev.id : null,
    nextId: null,
    stone: input.stone,
    minutes: input.minutes,
    leftover: input.leftover,
    grinder: input.grinder,
    status: "active",
    createdAt: now,
    revisions: []
  };
  chain.segments.push(segment);
  if (prev) {
    prev.status = "chained";
    prev.nextId = segment.id;
  }
  return { chain, segment, summary: chainSummary(chain) };
}

// 结算末段：登记余墨去向，整条链收束。
export function settleChain(db, segmentId, rawDestination) {
  const found = findSegment(db, segmentId);
  if (!found) throw new ChainRuleError("segment_not_found", "找不到该研墨段");
  const { chain, segment } = found;
  if (chain.settled) throw new ChainRuleError("chain_settled", "这条续磨链已经结算过了");
  const { tail } = chainSummary(chain);
  if (!tail || tail.id !== segment.id || segment.status !== "active") {
    throw new ChainRuleError("not_tail", "只能结算挂在砚上的最新一段");
  }
  const destination = String(rawDestination || "").trim();
  if (!destination) throw new ChainRuleError("invalid_input", "请填写余墨去向");
  const now = new Date().toISOString();
  segment.status = "settled";
  segment.settledAt = now;
  segment.inkDestination = destination;
  chain.settled = true;
  chain.settledAt = now;
  return { chain, segment, summary: chainSummary(chain) };
}

// 改正前段数据：可改砚台/分钟/残墨/研磨人；改动之后，后面的段先停用。
const EDITABLE_FIELDS = ["stone", "minutes", "leftover", "grinder"];
export function reviseSegment(db, segmentId, rawPatch) {
  const found = findSegment(db, segmentId);
  if (!found) throw new ChainRuleError("segment_not_found", "找不到该研墨段");
  const { chain, segment } = found;
  if (chain.settled) throw new ChainRuleError("chain_settled", "已结算的链不能再改正");
  if (segment.status === "settled") throw new ChainRuleError("segment_settled", "已结算的段不能改正");

  const patch = {};
  for (const key of EDITABLE_FIELDS) {
    if (rawPatch[key] !== undefined) patch[key] = rawPatch[key];
  }
  const candidate = {
    stone: patch.stone !== undefined ? String(patch.stone).trim() : segment.stone,
    minutes: patch.minutes !== undefined ? patch.minutes : segment.minutes,
    leftover: patch.leftover !== undefined ? patch.leftover : segment.leftover,
    grinder: patch.grinder !== undefined ? String(patch.grinder).trim() : segment.grinder
  };
  const normalized = normalizeInput(candidate);

  // 改砚台时：只允许头段换砚（一条链属于同一方砚）；且不能撞上别的砚上挂着的段。
  if (normalized.stone !== segment.stone) {
    if (segment.prevId) {
      throw new ChainRuleError("stone_change_denied", "只有链上的第一段能更换砚台，中间段请停用后另行处理");
    }
    const otherBusy = db.grindChains.some(c =>
      !c.settled && c.id !== chain.id && c.segments.some(s => s.stone === normalized.stone && s.status !== "settled"));
    if (otherBusy) {
      throw new ChainRuleError("stone_busy", normalized.stone + "上已挂着一段，不能把本链改过去");
    }
  }

  const changes = {};
  for (const key of EDITABLE_FIELDS) {
    if (normalized[key] !== segment[key]) changes[key] = { from: segment[key], to: normalized[key] };
  }
  if (Object.keys(changes).length === 0) {
    throw new ChainRuleError("no_change", "没有需要改正的内容");
  }

  Object.assign(segment, normalized);
  // 头段换砚等于整链换砚（一条链始终属于同一方砚）。
  if (normalized.stone !== chain.stone) {
    chain.stone = normalized.stone;
    for (const s of chain.segments) s.stone = normalized.stone;
  }
  segment.revisions.push({ at: new Date().toISOString(), changes });

  // 后面的未结算段一律先停用；已停用的保持停用。
  const halted = [];
  let cursor = segment.nextId;
  while (cursor) {
    const next = chain.segments.find(s => s.id === cursor);
    if (!next) break;
    if (next.status === "active" || next.status === "chained") {
      next.status = "halted";
      next.haltedAt = new Date().toISOString();
      halted.push(next.id);
    }
    cursor = next.nextId;
  }
  return { chain, segment, halted, summary: chainSummary(chain) };
}

// 启用被停用的段：只允许启用紧接在本段之后的那一段（逐段恢复）。
export function resumeSegment(db, segmentId) {
  const found = findSegment(db, segmentId);
  if (!found) throw new ChainRuleError("segment_not_found", "找不到该研墨段");
  const { chain, segment } = found;
  if (segment.status !== "halted") throw new ChainRuleError("not_halted", "该段不是停用状态");

  let predecessor = null;
  if (segment.prevId) predecessor = chain.segments.find(s => s.id === segment.prevId);
  if (predecessor && predecessor.status === "halted") {
    throw new ChainRuleError("prev_halted", "前一段还停用着，请先启用前一段");
  }

  const ordered = orderedSegments(chain);
  const idx = ordered.indexOf(segment);
  delete segment.haltedAt;
  segment.resumedAt = new Date().toISOString();
  // 启用后：后面还有非停用（即已启用）的段，本段只是中间一环；否则本段就是挂砚末段。
  const hasUnhaltedAfter = ordered.slice(idx + 1).some(s => s.status !== "halted" && s.status !== "settled");
  segment.status = hasUnhaltedAfter ? "chained" : "active";
  if (segment.status === "active" && predecessor && predecessor.status === "active") {
    predecessor.status = "chained";
  }
  return { chain, segment, summary: chainSummary(chain) };
}

// 卡片/页面用的只读视图：旧试磨（items）仍可单独查看，续磨链自成一表。
export function listChainsView(db) {
  return db.grindChains.map(chain => {
    const { totalMinutes, warnings } = chainSummary(chain);
    const haltedCount = chain.segments.filter(s => s.status === "halted").length;
    return {
      id: chain.id,
      stone: chain.stone,
      settled: chain.settled,
      settledAt: chain.settledAt || null,
      createdAt: chain.createdAt,
      totalMinutes,
      warnings,
      haltedCount,
      segments: orderedSegments(chain).map(s => ({ ...s }))
    };
  });
}
