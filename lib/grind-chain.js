// 续磨判定：只根据段记录计算链接、累计和换砚提示，不碰存储。

export const SEGMENT_STATUS = { OPEN: "未结算", SETTLED: "已结算", DISABLED: "已停用" };
export const MAX_CHAIN_MINUTES = 40; // 单砚累计研墨超过四十分钟提示换砚
export const MIN_RESIDUAL_INK = 2; // 最新残墨少于两克提示换砚

// 同砚同时只允许一段未结算
export function openSegmentOf(segments, inkstone) {
  return segments.find(s => s.inkstone === inkstone && s.status === SEGMENT_STATUS.OPEN) || null;
}

// 有效链：未结算/已结算的段，从头段（prevId 为空）沿 prevId 走到链尾
export function chainOf(segments, inkstone) {
  const active = segments.filter(s => s.inkstone === inkstone && s.status !== SEGMENT_STATUS.DISABLED);
  const byPrev = new Map(active.map(s => [s.prevId ?? null, s]));
  const chain = [];
  const seen = new Set();
  let cursor = byPrev.get(null) || null;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = byPrev.get(cursor.id) || null;
  }
  return chain;
}

// 沿 prevId 找出挂在指定段后面的所有段（含已停用，避免漏停）
export function descendantsOf(segments, segmentId) {
  const result = [];
  const seen = new Set([segmentId]);
  const queue = [segmentId];
  while (queue.length) {
    const prevId = queue.shift();
    for (const s of segments) {
      if (s.prevId === prevId && !seen.has(s.id)) {
        seen.add(s.id);
        result.push(s);
        queue.push(s.id);
      }
    }
  }
  return result;
}

export function validateSegmentInput(input) {
  const errors = [];
  if (!String(input.inkstone || "").trim()) errors.push("砚台不能为空");
  if (!(Number(input.minutes) > 0)) errors.push("研墨分钟需大于0");
  if (!(Number(input.residualInk) >= 0)) errors.push("残墨量需不小于0");
  if (!String(input.grinder || "").trim()) errors.push("研磨人不能为空");
  return errors;
}

// 新段接在同砚未结算的前一段后面，前段随之结算
export function appendSegment(segments, input, id, at = new Date().toISOString()) {
  const prev = openSegmentOf(segments, String(input.inkstone || "").trim());
  const created = {
    id,
    inkstone: String(input.inkstone || "").trim(),
    minutes: Number(input.minutes),
    residualInk: Number(input.residualInk),
    grinder: String(input.grinder || "").trim(),
    prevId: prev ? prev.id : null,
    status: SEGMENT_STATUS.OPEN,
    at,
  };
  if (prev) {
    prev.status = SEGMENT_STATUS.SETTLED;
    prev.settledAt = at;
  }
  segments.push(created);
  return { created, settled: prev };
}

// 改正前段：挂在后面的段先停用，被改正的段重新成为未结算的链尾
export function correctSegment(segments, id, patch, at = new Date().toISOString()) {
  const target = segments.find(s => s.id === id);
  if (!target) return { error: "segment_not_found" };
  if (target.status === SEGMENT_STATUS.DISABLED) return { error: "segment_disabled" };
  if (patch.minutes !== undefined && !(Number(patch.minutes) > 0)) return { error: "invalid_minutes" };
  if (patch.residualInk !== undefined && !(Number(patch.residualInk) >= 0)) return { error: "invalid_residual_ink" };
  if (patch.minutes !== undefined) target.minutes = Number(patch.minutes);
  if (patch.residualInk !== undefined) target.residualInk = Number(patch.residualInk);
  if (patch.grinder !== undefined && String(patch.grinder).trim()) target.grinder = String(patch.grinder).trim();
  target.status = SEGMENT_STATUS.OPEN;
  delete target.settledAt;
  target.correctedAt = at;
  const disabled = descendantsOf(segments, id).filter(s => s.status !== SEGMENT_STATUS.DISABLED);
  for (const s of disabled) {
    s.status = SEGMENT_STATUS.DISABLED;
    s.disabledAt = at;
  }
  return { updated: target, disabled };
}

// 单砚汇总：累计研墨、最新残墨和换砚提示
export function chainSummary(segments, inkstone) {
  const chain = chainOf(segments, inkstone);
  const totalMinutes = chain.reduce((n, s) => n + (Number(s.minutes) || 0), 0);
  const tail = chain[chain.length - 1] || null;
  const latestResidual = tail ? Number(tail.residualInk) : null;
  const reasons = [];
  if (totalMinutes > MAX_CHAIN_MINUTES) reasons.push(`累计研墨${totalMinutes}分钟，超过${MAX_CHAIN_MINUTES}分钟`);
  if (latestResidual !== null && latestResidual < MIN_RESIDUAL_INK) reasons.push(`残墨${latestResidual}克，不足${MIN_RESIDUAL_INK}克`);
  return {
    inkstone,
    segments: chain,
    disabled: segments.filter(s => s.inkstone === inkstone && s.status === SEGMENT_STATUS.DISABLED),
    totalMinutes,
    latestResidual,
    openSegmentId: tail && tail.status === SEGMENT_STATUS.OPEN ? tail.id : null,
    warn: reasons.length > 0,
    reasons,
  };
}

export function allChains(segments) {
  return [...new Set(segments.map(s => s.inkstone))].map(name => chainSummary(segments, name));
}
