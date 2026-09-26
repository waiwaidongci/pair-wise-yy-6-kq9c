// 续磨链规则自测：node test/chains.test.js
import {
  appendSegment, settleChain, reviseSegment, resumeSegment,
  listChainsView, chainSummary, ChainRuleError, MAX_TOTAL_MINUTES
} from "../lib/chains.js";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.error("  ✗", name, extra || ""); }
}
function expectThrow(name, code, fn) {
  try { fn(); fail++; console.error("  ✗", name, "(未抛错)"); }
  catch (e) {
    if (e instanceof ChainRuleError && e.code === code) { pass++; console.log("  ✓", name); }
    else { fail++; console.error("  ✗", name, "(code=" + (e.code || e.message) + ", 期望 " + code + ")"); }
  }
}
const db = { items: [], grindChains: [] };

// 1. 第一段开新链
const r1 = appendSegment(db, { stone: "青石砚", minutes: 20, leftover: 8, grinder: "阿松" });
check("首段开新链且状态为 active", r1.segment.status === "active" && db.grindChains.length === 1);
check("首段记录砚台/分钟/残墨/研磨人",
  r1.segment.stone === "青石砚" && r1.segment.minutes === 20 && r1.segment.leftover === 8 && r1.segment.grinder === "阿松");
check("首段累计 20 分钟无换砚提示", r1.summary.totalMinutes === 20 && r1.summary.warnings.length === 0);

// 2. 同砚再续：接在未结算前段后面，前段变 chained
const r2 = appendSegment(db, { stone: "青石砚", minutes: 25, leftover: 5, grinder: "阿竹" });
check("新段接在前一段后面(prevId/nextId)", r2.segment.prevId === r1.segment.id && r1.segment.nextId === r2.segment.id);
check("前段转为 chained，新段 active", r1.segment.status === "chained" && r2.segment.status === "active");
check("两条段在同一条链上", r1.chain === r2.chain && db.grindChains.length === 1);
check("累计 45 分钟提示换砚", r2.summary.totalMinutes === 45 && r2.summary.warnings.some(w => w.includes("换砚") && w.includes("45")));

// 3. 同砚不能同时挂两段（新段已接上；再查挂砚段只有一条）
const tails = db.grindChains[0].segments.filter(s => s.status === "active");
check("同砚同时只有一段 active", tails.length === 1 && tails[0].id === r2.segment.id);

// 4. 残墨少于 2 克提示换砚
const r3 = appendSegment(db, { stone: "青石砚", minutes: 1, leftover: 1.5, grinder: "阿梅" });
check("残墨 1.5 克提示换砚", r3.summary.warnings.some(w => w.includes("残墨") && w.includes("换砚")));
check("累计仍为有效段之和(46)", r3.summary.totalMinutes === 46);

// 5. 另一砚台自动开新链，互不干扰
const b1 = appendSegment(db, { stone: "端砚", minutes: 10, leftover: 12, grinder: "阿松" });
check("别的砚台开第二条链", db.grindChains.length === 2 && b1.segment.prevId === null);
check("两条链累计互不影响", chainSummary(b1.chain).totalMinutes === 10);

// 6. 改正前段：后面的段先停用
const rev = reviseSegment(db, r1.segment.id, { minutes: 30 });
check("前段改正被保存", r1.segment.minutes === 30 && r1.segment.revisions.length === 1);
check("后面的段全部停用", rev.halted.length === 2 && r2.segment.status === "halted" && r3.segment.status === "halted");
check("被改正段保持 chained 状态", r1.segment.status === "chained");

// 7. 有停用段时同砚不能再续磨
expectThrow("挂着停用段时拒绝续磨", "tail_halted", () =>
  appendSegment(db, { stone: "青石砚", minutes: 5, leftover: 3, grinder: "阿松" }));

// 8. 停用段未恢复前不能结算
expectThrow("停用尾段不能直接结算", "not_tail", () =>
  settleChain(db, r3.segment.id, "回锭封存"));

// 9. 逐段启用：必须按顺序
expectThrow("前一段还停用时不能跳段启用", "prev_halted", () => resumeSegment(db, r3.segment.id));
const rs2 = resumeSegment(db, r2.segment.id);
check("启用紧邻的停用段(成为挂砚末段)", r2.segment.status === "active");
// 再改正一次前段，r2 重新停用，然后逐段恢复 r2、r3
reviseSegment(db, r1.segment.id, { minutes: 28 });
check("再次改正，后续再次停用", r2.segment.status === "halted" && r3.segment.status === "halted");
resumeSegment(db, r2.segment.id);
check("r2 先恢复为挂砚段", r2.segment.status === "active");
const rs3 = resumeSegment(db, r3.segment.id);
check("再恢复尾段后，r2 退回 chained、r3 为 active", r2.segment.status === "chained" && r3.segment.status === "active");
check("恢复后累计重算(28+25+1=54)", rs3.summary.totalMinutes === 54);

// 10. 结算：登记余墨去向，整条链收束
const st = settleChain(db, r3.segment.id, "当日用完");
check("末段结算并记录余墨去向", r3.segment.status === "settled" && r3.segment.inkDestination === "当日用完");
check("链整体标记 settled", st.chain.settled === true && !!st.chain.settledAt);
expectThrow("已结算链不能再结算", "chain_settled", () => settleChain(db, r3.segment.id, "x"));
expectThrow("已结算链不能改正", "chain_settled", () => reviseSegment(db, r3.segment.id, { minutes: 9 }));

// 11. 结算后该砚台可以开新链
const again = appendSegment(db, { stone: "青石砚", minutes: 3, leftover: 9, grinder: "阿竹" });
check("结算后同砚可另开新链", again.chain.id !== r1.chain.id && again.segment.status === "active");
check("累计 3 分钟无换砚提示", chainSummary(again.chain).warnings.length === 0);

// 12. 边界：恰好 40 分钟不提示，超过才提示
const c40 = appendSegment(db, { stone: "陶砚", minutes: 40, leftover: 5, grinder: "阿松" });
check("恰好 40 分钟不提示换砚", c40.summary.totalMinutes === MAX_TOTAL_MINUTES && c40.summary.warnings.length === 0);
const c41 = appendSegment(db, { stone: "陶砚", minutes: 0.5, leftover: 5, grinder: "阿松" });
check("40.5 分钟提示换砚", c41.summary.totalMinutes === 40.5 && c41.summary.warnings.some(w => w.includes("超过")));
const c2g = appendSegment(db, { stone: "瓦砚", minutes: 2, leftover: 2, grinder: "阿松" });
check("残墨恰好 2 克不提示", c2g.summary.warnings.length === 0);

// 13. 输入校验
expectThrow("缺砚台拒绝", "invalid_input", () => appendSegment(db, { minutes: 1, leftover: 1, grinder: "x" }));
expectThrow("缺研磨人拒绝", "invalid_input", () => appendSegment(db, { stone: "X", minutes: 1, leftover: 1 }));
expectThrow("负数分钟拒绝", "invalid_input", () => appendSegment(db, { stone: "X", minutes: -1, leftover: 1, grinder: "x" }));
expectThrow("结算缺余墨去向拒绝", "invalid_input", () => settleChain(db, c41.segment.id, "  "));
expectThrow("无改动的改正拒绝", "no_change", () => reviseSegment(db, c40.segment.id, { minutes: 40 }));

// 14. 中间段不许换砚（chained 态也不行），头段可以且同步全链
expectThrow("中间段不能换砚", "stone_change_denied", () => reviseSegment(db, c41.segment.id, { stone: "别的砚" }));
// 端砚链头段换到一个空闲砚台
const bRev = reviseSegment(db, b1.segment.id, { stone: "歙砚" });
check("头段换砚后整链砚台同步", b1.chain.segments.every(s => s.stone === "歙砚") && b1.chain.stone === "歙砚");
// 不能换到挂着段的砚（陶砚链未结算）
expectThrow("不能换到正挂砚的砚台", "stone_busy", () => reviseSegment(db, b1.segment.id, { stone: "陶砚" }));
// 中间段改分钟/残墨/研磨人不受限（末段后面没有段，无停用）
const midRev = reviseSegment(db, c41.segment.id, { minutes: 3 });
check("中间段可改正非砚台字段", c41.segment.minutes === 3 && midRev.halted.length === 0 && c41.segment.status === "active");
void bRev;

// 15. 只读视图
const view = listChainsView(db);
check("视图包含所有链且段按顺序排列", view.length === db.grindChains.length
  && view[0].segments.map(s => s.id)[0] === r1.segment.id);
check("视图给出累计/警告/停用数", view.every(c => typeof c.totalMinutes === "number" && Array.isArray(c.warnings) && typeof c.haltedCount === "number"));

console.log("\\n结果：" + pass + " 通过，" + fail + " 失败");
process.exit(fail ? 1 : 0);
