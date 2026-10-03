// 端到端校验：旧草稿迁移 → 中心变化失效重算 → 外聘导入 → 双改冲突 → 失败重试 → 复核号幂等 → 裁决门禁 → 发布
import { buildInitialState, demoCtx } from '../src/merge/seed';
import {
  applyCenterChange,
  createReleaseBatch,
  evaluateRelease,
  ingestBatch,
  resolveConflict,
  retryFailedWrites,
  signReview
} from '../src/merge/engine';
import { offlineBatch } from '../src/merge/demoBatches';
import type { MergeState } from '../src/merge/types';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 确定性时钟/序号
let n = 0;
const ctx = { now: () => `T+${(++n).toString().padStart(2, '0')}`, nextId: (p: string) => `${p}-${n}` };

console.log('1) 旧草稿迁移：无版本号补首版，原区域保留可查');
let state: MergeState = buildInitialState();
let d418 = state.documents.find((d) => d.id === 'DOC-00418')!;
check('DOC-00418 文档补为首版 v1', d418.docVersion === 1 && d418.classVersion === 1 && d418.regionSeq === 1);
check('3 个原有区域全部保留且版本为 1', d418.redactions.length === 3 && d418.redactions.every((r) => r.version === 1));
check('迁移事件写入历史', d418.history.some((h) => h.kind === 'legacy-bootstrap'));

console.log('2) 中心在外聘离线期间改 R-02 区域：未完成复核先失效重算');
// 先给 418 加一条未完成复核
state = {
  ...state,
  documents: state.documents.map((d) => d.id === 'DOC-00418' ? {
    ...d,
    reviews: [...d.reviews, { id: 'RV-OPEN-1', docId: d.id, check: '图像边界残片' as const, status: 'pending' as const, operator: '林清', createdAt: 'T0' }]
  } : d)
};
const r02before = state.documents.find((d) => d.id === 'DOC-00418')!.redactions.find((r) => r.id === 'R-02')!;
state = applyCenterChange(state, 'DOC-00418', { kind: 'region', region: { ...r02before, reason: '个人手机号（中心扩框）', width: 0.4 }, operator: '林清', mode: 'edit' }, ctx);
d418 = state.documents.find((d) => d.id === 'DOC-00418')!;
const invalidated = d418.reviews.find((r) => r.id === 'RV-OPEN-1')!;
const successor = d418.reviews.find((r) => r.id === invalidated.supersededBy)!;
check('原未完成复核变为 invalid', invalidated.status === 'invalid');
check('生成 pending 重算后继', successor && successor.status === 'pending');
check('R-02 中心版本升到 v2', d418.redactions.find((r) => r.id === 'R-02')!.version === 2);
check('区域 seq 与文档版本推进', d418.regionSeq === 2 && d418.docVersion === 2);

console.log('3) 中心改 DOC-00427 密级：已签复核保留当时依据，只标过期');
state = applyCenterChange(state, 'DOC-00427', { kind: 'classification', classification: '严格机密', operator: '林清' }, ctx);
let d427 = state.documents.find((d) => d.id === 'DOC-00427')!;
const signedOld = d427.reviews.find((r) => r.id === 'RV-SIGNED-1')!;
check('已签复核仍为 signed，结论保留', signedOld.status === 'signed' && signedOld.conclusion === '页序连续，无拆页漏页');
check('已签复核依据冻结且标记过期', signedOld.basis?.classification === '机密' && signedOld.basisStale === true);
check('密级版本推进到 v3', d427.classVersion === 3 && d427.classification === '严格机密');

console.log('4) 受理外聘导入批：双改冲突保留双方、写入失败入账');
const failInject = new Set(['DOC-00418:import-region:R-10']);
const batch = { ...offlineBatch(), importedAt: 'T-IMPORT' };
const outcome = ingestBatch(state, batch, ctx, failInject);
state = outcome.state;
d418 = state.documents.find((d) => d.id === 'DOC-00418')!;
d427 = state.documents.find((d) => d.id === 'DOC-00427')!;
check('产生 2 项冲突（R-02 双改 + 密级双改）', state.conflicts.filter((c) => c.status === 'open').length === 2,
  `实际 ${state.conflicts.filter((c) => c.status === 'open').length}`);
const regionConflict = state.conflicts.find((c) => c.regionId === 'R-02')!;
check('区域冲突保留中心版与外聘版双方内容', regionConflict.center.region?.reason.includes('中心扩框') && regionConflict.remote.region?.reason.includes('外聘缩框'));
check('中心原区域没有被外聘版盖回', d418.redactions.find((r) => r.id === 'R-02')!.reason.includes('中心扩框'));
const classConflict = state.conflicts.find((c) => c.kind === 'classification')!;
check('密级冲突保留中心严格机密 / 外聘内部', classConflict.center.classification === '严格机密' && classConflict.remote.classification === '内部');
check('R-10 首次写入失败入账', state.writes.some((w) => w.refId === 'R-10' && w.status === 'failed'));
check('R-10 失败所以区域尚未并入', !d418.redactions.some((r) => r.id === 'R-10'));
check('外聘新增复核 REV-EXT-7031 已并入', d418.reviews.some((r) => r.reviewNo === 'REV-EXT-7031'));
check('外聘 427 签核依据（机密）已过期但保留', d427.reviews.some((r) => r.reviewNo === 'REV-EXT-7032' && r.status === 'signed' && r.basisStale));
check('外聘过期签核直接派生按新内容的重算 pending（不重复失效）', d427.reviews.some((r) => r.note?.includes('按新内容重算') && r.status === 'pending'));

console.log('5) 发布门禁被未决冲突 / 失败写入 / 待签复核拦下');
let gate = evaluateRelease(state, ['DOC-00418', 'DOC-00427']);
check('门禁不通过', gate.ok === false);
check('两份文档都有阻塞原因', gate.blockers.length === 2);
const publishAttempt = createReleaseBatch(state, '测试批次', ['DOC-00418', 'DOC-00427'], ctx) as { error?: string };
check('强行发布会返回错误', typeof publishAttempt.error === 'string');

console.log('6) 从失败项重试：已成功项不重复，R-10 补写成功');
const writesBefore = state.writes.length;
state = retryFailedWrites(state, batch, 'all', ctx);
d418 = state.documents.find((d) => d.id === 'DOC-00418')!;
check('R-10 重试后并入', d418.redactions.some((r) => r.id === 'R-10' && r.source === 'remote'));
check('账本中 R-10 变为成功', state.writes.some((w) => w.refId === 'R-10' && w.status === 'succeeded'));
check('没有遗留失败项', state.writes.every((w) => w.status === 'succeeded'));
check('其它成功项没有重复入账（同批成功行数不翻倍）', state.writes.filter((w) => w.batchId === batch.batchId && w.status === 'succeeded').length <= writesBefore + 1);

console.log('7) 同批复传沿用第一次结果（幂等）');
const beforeRetransmit = { conflicts: state.conflicts.length, writes: state.writes.length, regions: d418.redactions.length };
const retransmit = ingestBatch(state, { ...batch, importedAt: 'T-RETRY2' }, ctx);
check('复传不产生任何新写入/冲突', retransmit.reused && retransmit.writes.length === 0 && retransmit.conflicts.length === 0);
check('状态没有被二次盖写', retransmit.state.conflicts.length === beforeRetransmit.conflicts && retransmit.state.writes.length === beforeRetransmit.writes);

console.log('8) 逐项裁决冲突：双方保留 + 采用中心');
state = resolveConflict(state, regionConflict.id, 'keep-both', '林清', ctx);
d418 = state.documents.find((d) => d.id === 'DOC-00418')!;
check('keep-both 后外聘内容复制为新区域共存', d418.redactions.some((r) => r.reason.includes('外聘缩框')) && d418.redactions.some((r) => r.reason.includes('中心扩框')));
state = resolveConflict(state, classConflict.id, 'adopt-center', '林清', ctx);
d427 = state.documents.find((d) => d.id === 'DOC-00427')!;
check('密级裁决采中心，维持严格机密', d427.classification === '严格机密');
check('冲突全部 resolved', state.conflicts.every((c) => c.status === 'resolved'));

console.log('9) 重算后继逐项签核后才能发布');
const pendings = state.documents.flatMap((d) => d.reviews.filter((r) => r.status === 'pending').map((r) => ({ d, r })));
check('仍有 pending 复核阻塞发布', pendings.length >= 1, `pending=${pendings.length}`);
for (const { d, r } of pendings) {
  state = signReview(state, r.id, '林清', `重算签核：${r.check} 通过`, ctx);
  void d;
}
// R-02 中心扩框时仍是 draft，需要确认；确认是一次中心修改，但此时没有 pending 复核，不会再派生
const draftsLeft = state.documents.flatMap((d) => d.redactions.filter((x) => x.status === 'draft').map((x) => ({ d, x })));
for (const { d, x } of draftsLeft) {
  state = applyCenterChange(state, d.id, { kind: 'region', region: { ...x, status: 'confirmed' as const }, operator: '林清', mode: 'edit' }, ctx);
}
// 确认后引擎若又失效重算了后继项，补签到无 pending 为止
let guard = 0;
while (state.documents.some((d) => d.reviews.some((r) => r.status === 'pending')) && guard < 10) {
  const nextPending = state.documents.flatMap((d) => d.reviews.filter((r) => r.status === 'pending'))[0];
  state = signReview(state, nextPending.id, '林清', `重算签核：${nextPending.check} 通过`, ctx);
  guard += 1;
}
gate = evaluateRelease(state, ['DOC-00418', 'DOC-00427']);
check('所有 pending 清零', state.documents.every((d) => d.reviews.every((r) => r.status !== 'pending')));
check('门禁通过', gate.ok, gate.blockers.map((b) => `${b.docId}: ${b.reasons.join(';')}`).join(' | '));

console.log('10) 生成发布批次：冻结版本号');
const result = createReleaseBatch(state, '第三批披露 · 合并后发布', ['DOC-00418', 'DOC-00427'], '林清', ctx);
check('发布成功', !('error' in result));
if (!('error' in result)) {
  state = result;
  const rel = state.releases[state.releases.length - 1];
  check('批次冻结了各文档版本', rel.frozen.length === 2 && rel.frozen.every((f) => f.docVersion > 0 && f.regionSeq > 0 && f.classVersion > 0));
  check('文档状态变为可发布', state.documents.filter((d) => ['DOC-00418', 'DOC-00427'].includes(d.id)).every((d) => d.status === '可发布'));
}

console.log('11) 历史全程可查');
for (const id of ['DOC-00418', 'DOC-00427']) {
  const doc = state.documents.find((d) => d.id === id)!;
  const kinds = doc.history.map((h) => h.kind);
  check(`${id} 含冲突开启/裁决/重算/签核轨迹`, kinds.includes('conflict-open') && kinds.includes('conflict-resolve') && kinds.includes('review-recompute'));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
