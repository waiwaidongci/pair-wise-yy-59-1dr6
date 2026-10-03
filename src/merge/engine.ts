import type {
  Classification,
  Conflict,
  ConflictDecision,
  DisclosureRecord,
  EngineCtx,
  HistoryEvent,
  ImportBatch,
  ImportItem,
  MergeState,
  Redaction,
  RegionSignature,
  RegionSnap,
  RegionSource,
  ReleaseBlocker,
  Review,
  ReviewBasis,
  WriteItem
} from './types';

// ---------- 指纹与版本 ----------

const REGION_FIELDS: (keyof RegionSignature)[] = ['page', 'x', 'y', 'width', 'height', 'reason', 'privilege', 'status'];

export function regionSignature(r: RegionSignature): string {
  return REGION_FIELDS.map((key) => {
    const value = r[key];
    return typeof value === 'number' ? Math.round(value * 10000) / 10000 : value;
  }).join('|');
}

/** 文档全部区域内容的聚合指纹：中心区域集合是否变化，用它判断 */
export function regionSeqSignature(redactions: Redaction[]): string {
  return redactions
    .map((r) => `${r.id}@${r.version}:${regionSignature(r)}`)
    .sort()
    .join(';;');
}

export function currentBasis(doc: DisclosureRecord): ReviewBasis {
  return { docVersion: doc.docVersion, regionSeq: doc.regionSeq, classification: doc.classification };
}

export function basisMatches(basis: ReviewBasis | undefined, doc: DisclosureRecord): boolean {
  if (!basis) return false;
  return basis.docVersion === doc.docVersion
    && basis.regionSeq === doc.regionSeq
    && basis.classification === doc.classification;
}

function snapshotRegions(redactions: Redaction[], source: RegionSource): RegionSnap[] {
  return redactions.map((r) => ({ id: r.id, signature: regionSignature(r), version: r.version, source }));
}

function appendHistory(doc: DisclosureRecord, event: Omit<HistoryEvent, 'at' | 'operator'> & { at?: string; operator?: string }, ctx: EngineCtx, operator: string): void {
  doc.history.push({ at: ctx.now(), operator, ...event });
}

// ---------- 中心侧修改：推进版本并失效关联的未完成复核 ----------

/**
 * 中心区域或密级发生变化：
 * 1) 推进 docVersion / classVersion / regionSeq；
 * 2) 关联的未完成复核一律失效（invalid），并按新内容重算一条 pending；
 * 3) 已签过的复核保留当时依据，只标记依据过期，不覆盖结论。
 */
export function applyCenterChange(
  state: MergeState,
  docId: string,
  change:
    | { kind: 'classification'; classification: Classification; operator: string }
    | { kind: 'region'; region: Redaction; operator: string; mode: 'add' | 'edit' },
  ctx: EngineCtx
): MergeState {
  const next = cloneState(state);
  const doc = mustFindDoc(next, docId);
  const operator = change.operator;
  const beforeSeq = regionSeqSignature(doc.redactions);

  if (change.kind === 'classification') {
    if (doc.classification === change.classification) return state;
    doc.classification = change.classification;
    doc.classVersion += 1;
    doc.docVersion += 1;
    appendHistory(doc, {
      kind: 'class-center',
      message: `中心将密级调整为「${change.classification}」，密级版本 v${doc.classVersion}`,
    }, ctx, operator);
  } else {
    const existing = doc.redactions.find((r) => r.id === change.region.id);
    if (existing) {
      Object.assign(existing, change.region, { version: existing.version + 1, changedBy: operator, source: 'center' as RegionSource });
      appendHistory(doc, {
        kind: 'region-edit-center',
        message: `中心修改区域 ${existing.id}（${existing.reason}），区域版本 v${existing.version}`,
        regionSnapshots: snapshotRegions([existing], 'center'),
      }, ctx, operator);
    } else {
      const region: Redaction = { ...change.region, version: 1, changedBy: operator, source: 'center' };
      doc.redactions.push(region);
      appendHistory(doc, {
        kind: 'region-add-center',
        message: `中心新增区域 ${region.id}（${region.reason}）`,
        regionSnapshots: snapshotRegions([region], 'center'),
      }, ctx, operator);
    }
  }

  if (regionSeqSignature(doc.redactions) !== beforeSeq || change.kind === 'classification') {
    doc.regionSeq += 1;
    doc.docVersion += change.kind === 'classification' ? 0 : 1;
  }
  doc.updatedAt = ctx.now();

  invalidateOpenReviews(doc, change.kind === 'classification' ? '中心密级发生变化' : '中心区域内容发生变化', ctx, operator);
  return next;
}

/**
 * 未完成复核失效并按新内容重算；已签复核冻结依据。
 * exclude 中的 pending 复核是调用方已按新内容建好的重算后继，不再重复失效。
 * 返回新建的 pending 复核（用于写账）。
 */
function invalidateOpenReviews(doc: DisclosureRecord, reason: string, ctx: EngineCtx, operator: string, exclude: Set<string> = new Set()): Review[] {
  const recomputed: Review[] = [];
  doc.reviews = doc.reviews.flatMap((review) => {
    if (review.status === 'signed') {
      // 已签过的保留当时依据：结论不动，只标注依据相对当前已过期
      review.basisStale = !basisMatches(review.basis, doc);
      return [review];
    }
    if (review.status === 'invalid') return [review];
    if (exclude.has(review.id)) return [review];

    review.status = 'invalid';
    review.invalidReason = reason;
    const successor: Review = {
      id: `RV-${ctx.nextId('n')}`,
      docId: doc.id,
      check: review.check,
      status: 'pending',
      operator: '待重算',
      note: `依据新版本重算（接替 ${review.id}）`,
      createdAt: ctx.now(),
    };
    review.supersededBy = successor.id;
    recomputed.push(successor);

    appendHistory(doc, {
      kind: 'review-invalidated',
      message: `未完成复核 ${review.id}（${review.check}）因${reason}失效`,
    }, ctx, operator);
    appendHistory(doc, {
      kind: 'review-recompute',
      message: `按新内容生成重算复核 ${successor.id}（${review.check}），等待重新结论`,
      basis: currentBasis(doc),
    }, ctx, operator);
    return [review, successor];
  });
  return recomputed;
}

// ---------- 导入批：幂等受理 + 三方合并 ----------

export type ImportOutcome = {
  state: MergeState;
  writes: WriteItem[];
  conflicts: Conflict[];
  reused: boolean;
};

/**
 * 受理外聘复核员的导入批。
 * - 同批复传（batchId 已受理过）：沿用第一次结果，不重复写入；
 * - 每一项写入都进账本，失败可只从失败项重试；
 * - 中心变化按版本比对，双改区域开冲突，保留双方和来源。
 */
export function ingestBatch(prev: MergeState, batch: ImportBatch, ctx: EngineCtx, failInject?: Set<string>): ImportOutcome {
  // 同批复传沿用第一次结果
  const prior = prev.batches.find((b) => b.batchId === batch.batchId);
  if (prior) {
    return { state: prev, writes: [], conflicts: [], reused: true };
  }

  let state = cloneState(prev);
  const writes: WriteItem[] = [];
  const conflicts: Conflict[] = [];

  for (const item of batch.items) {
    const result = mergeItem(state, item, batch, ctx, failInject);
    state = result.state;
    writes.push(...result.writes);
    conflicts.push(...result.conflicts);
  }

  const failed = writes.filter((w) => w.status === 'failed').length;
  state.batches.push({
    batchId: batch.batchId,
    operator: batch.operator,
    importedAt: ctx.now(),
    result: 'accepted',
    firstReceivedAt: ctx.now(),
    itemCount: batch.items.length,
    conflictCount: conflicts.length,
  });
  state.writes.push(...writes);
  state.conflicts.push(...conflicts);

  if (failed > 0) {
    // 部分写入失败：批仍登记受理时间点，但发布门禁会拦住失败项所在文档
  }
  return { state, writes, conflicts, reused: false };
}

type MergeItemResult = { state: MergeState; writes: WriteItem[]; conflicts: Conflict[] };

function mergeItem(prev: MergeState, item: ImportItem, batch: ImportBatch, ctx: EngineCtx, failInject?: Set<string>): MergeItemResult {
  const state = cloneState(prev);
  const doc = state.documents.find((d) => d.id === item.docId);
  const writes: WriteItem[] = [];
  const conflicts: Conflict[] = [];

  const recordWrite = (kind: WriteItem['kind'], refId: string | undefined, summary: string, apply: () => void): void => {
    const id = `W-${ctx.nextId('w')}`;
    const shouldFail = failInject?.has(`${item.docId}:${kind}:${refId ?? ''}`) ?? false;
    if (shouldFail) {
      writes.push({ id, batchId: batch.batchId, docId: item.docId, kind, refId, summary, status: 'failed', attempts: 1, lastError: '中心写入暂存失败（模拟存储不可用）', at: ctx.now() });
      return; // 该项不落地，等待从失败项重试
    }
    apply();
    writes.push({ id, batchId: batch.batchId, docId: item.docId, kind, refId, summary, status: 'succeeded', attempts: 1, at: ctx.now() });
  };

  if (!doc) {
    // 中心已不存在的文档：单项失败，可重试（人工处理后）
    writes.push({
      id: `W-${ctx.nextId('w')}`, batchId: batch.batchId, docId: item.docId, kind: 'import-region',
      summary: `导入 ${item.docId}：中心未找到该文档`, status: 'failed', attempts: 1, lastError: '中心文档不存在', at: ctx.now(),
    });
    return { state, writes, conflicts };
  }

  const beforeSeq = regionSeqSignature(doc.redactions);
  let appliedChange = false;
  // 已在导入阶段直接生成的"按新内容重算"后继，不参与末尾的统一失效扫描，避免多绕一环
  const recomputedById = new Set<string>();

  // ---- 密级：以版本号做三方裁决 ----
  if (item.classification !== doc.classification) {
    // 三方：外聘基线密级（baseClassification/baseClassVersion）对比当前中心值与外聘值
    const baseClass = item.baseClassification ?? doc.classification;
    const baseClassVersion = item.baseClassVersion ?? item.classVersion;
    const centerMoved = doc.classification !== baseClass || doc.classVersion > baseClassVersion;
    const remoteMoved = item.classification !== baseClass;
    if (centerMoved && remoteMoved) {
      // 两边都改过密级 → 冲突，保留双方，逐项裁决
      const conflict: Conflict = {
        id: `CF-${ctx.nextId('c')}`,
        docId: doc.id,
        kind: 'classification',
        status: 'open',
        center: {
          label: doc.classification, classification: doc.classification, classVersion: doc.classVersion,
          operator: doc.owner, at: doc.updatedAt,
        },
        remote: {
          label: item.classification, classification: item.classification, classVersion: item.classVersion,
          operator: batch.operator, at: batch.exportedAt,
        },
      };
      conflicts.push(conflict);
      appendHistory(doc, {
        kind: 'conflict-open',
        message: `密级两边都改过：基线「${baseClass}」→ 中心「${doc.classification}」v${doc.classVersion} / 外聘「${item.classification}」，待裁决`,
        conflictId: conflict.id,
      }, ctx, batch.operator);
      recordWrite('import-class', conflict.id, `密级冲突待裁决（中心 ${doc.classification} / 外聘 ${item.classification}）`, () => {});
    } else if (centerMoved) {
      // 只有中心动过：保留中心，外聘值不盖回
      appendHistory(doc, {
        kind: 'class-center',
        message: `密级仅中心变化（中心「${doc.classification}」），外聘旧值「${item.classification}」不盖回`,
      }, ctx, batch.operator);
    } else {
      recordWrite('import-class', undefined, `采用外聘密级「${item.classification}」`, () => {
        doc.classification = item.classification;
        doc.classVersion = Math.max(doc.classVersion, item.classVersion);
        appliedChange = true;
        appendHistory(doc, {
          kind: 'class-remote',
          message: `合并导入批 ${batch.batchId}（外聘 ${batch.operator}）密级「${item.classification}」；批带文档 v${item.docVersion} / 区域 seq${item.regionVersion}`,
        }, ctx, batch.operator);
      });
    }
  }

  // ---- 区域：逐区域三方合并（离线基线 = baseVersion + 指纹） ----
  for (const incoming of item.redactions) {
    const incomingSig = regionSignature(incoming);

    // 新绘制区域（外聘侧 id 可能已给，也可能没有）
    if (!incoming.id || !doc.redactions.some((r) => r.id === incoming.id)) {
      const id = incoming.id ?? `R-${ctx.nextId('r')}`;
      recordWrite('import-region', id, `并入外聘新增区域（${incoming.reason}，第 ${incoming.page} 页）`, () => {
        const region: Redaction = {
          ...incoming,
          id,
          version: 1,
          changedBy: batch.operator,
          source: 'remote',
        };
        doc.redactions.push(region);
        appliedChange = true;
        appendHistory(doc, {
          kind: 'region-add-remote',
          message: `外聘 ${batch.operator} 离线新增区域 ${id}（${region.reason}）`,
          regionSnapshots: snapshotRegions([region], 'remote'),
        }, ctx, batch.operator);
      });
      continue;
    }

    const centerRegion = doc.redactions.find((r) => r.id === incoming.id)!;
    const centerSig = regionSignature(centerRegion);
    if (centerSig === incomingSig) continue; // 内容一致，无变化

    // 外聘基线版本：baseVersion 为 0/缺省时，若中心版本 > 基线版本说明中心也动过
    const baseVersion = incoming.baseVersion ?? 1;
    const centerChanged = centerRegion.version > baseVersion;

    if (centerChanged) {
      // 同一区域两边都改过 → 保留双方和来源，开逐项冲突
      const remoteView: Redaction = {
        ...incoming,
        id: centerRegion.id,
        version: baseVersion + 1,
        changedBy: batch.operator,
        source: 'remote',
      };
      const conflict: Conflict = {
        id: `CF-${ctx.nextId('c')}`,
        docId: doc.id,
        kind: 'region-both-edited',
        regionId: centerRegion.id,
        status: 'open',
        center: {
          label: `${centerRegion.reason} · v${centerRegion.version}`,
          signature: centerSig,
          region: { ...centerRegion },
          operator: centerRegion.changedBy,
          at: doc.updatedAt,
        },
        remote: {
          label: `${remoteView.reason} · 外聘版`,
          signature: incomingSig,
          region: remoteView,
          operator: batch.operator,
          at: batch.exportedAt,
        },
      };
      conflicts.push(conflict);
      appendHistory(doc, {
        kind: 'conflict-open',
        message: `区域 ${centerRegion.id} 两边都改过：中心 v${centerRegion.version}（${centerRegion.reason}）/ 外聘版（${remoteView.reason}），双方内容已保留待裁决`,
        conflictId: conflict.id,
        regionSnapshots: [
          ...snapshotRegions([centerRegion], 'center'),
          ...snapshotRegions([remoteView], 'remote'),
        ],
      }, ctx, batch.operator);
      recordWrite('conflict-adjudication', conflict.id, `区域 ${centerRegion.id} 双改，待逐项裁决`, () => {});
    } else {
      // 只有外聘侧改过：快进采用，不盖中心（中心没动）
      recordWrite('import-region', centerRegion.id, `快进采用外聘区域 ${centerRegion.id}（${incoming.reason}）`, () => {
        const prevVersion = centerRegion.version;
        Object.assign(centerRegion, incoming, {
          version: Math.max(prevVersion, baseVersion) + 1,
          changedBy: batch.operator,
          source: 'remote' as RegionSource,
        });
        appendHistory(doc, {
          kind: 'region-edit-remote',
          message: `区域 ${centerRegion.id} 快进外聘修改，版本 v${prevVersion} → v${centerRegion.version}`,
          regionSnapshots: snapshotRegions([centerRegion], 'remote'),
        }, ctx, batch.operator);
        appliedChange = true;
      });
    }
  }

  if (regionSeqSignature(doc.redactions) !== beforeSeq) {
    doc.regionSeq += 1;
    doc.docVersion = Math.max(doc.docVersion, item.docVersion) + 1;
  } else {
    doc.docVersion = Math.max(doc.docVersion, item.docVersion);
  }
  doc.updatedAt = ctx.now();

  // ---- 复核结论：复核号幂等；中心内容已变则未完成复核失效重算，已签保留依据 ----
  for (const imported of item.reviews) {
    recordWrite('import-review', imported.reviewNo, `并入复核 ${imported.reviewNo}（${imported.check}）`, () => {
      const duplicate = doc.reviews.find((r) => r.reviewNo === imported.reviewNo);
      if (duplicate) {
        // 同批复传 / 同复核号：沿用第一次结果，不再落一条
        appendHistory(doc, {
          kind: 'review-imported',
          message: `复核号 ${imported.reviewNo} 已存在，沿用首次结果`,
        }, ctx, batch.operator);
        return;
      }
      const basisFresh = basisMatches(imported.basis, doc);
      let review: Review;
      if (imported.status === 'signed' && !basisFresh) {
        // 外聘离线期间中心已变：其签核保留当时依据可查，但不作为当前有效结论；
        // 未完成角度按新内容重算一条 pending。
        review = {
          id: `RV-${ctx.nextId('rv')}`,
          docId: doc.id,
          check: imported.check,
          status: 'signed',
          operator: imported.operator,
          reviewNo: imported.reviewNo,
          batchId: batch.batchId,
          basis: imported.basis,
          conclusion: imported.conclusion,
          basisStale: true,
          note: `外聘签核时依据（文档 v${imported.basis.docVersion} / 区域 seq${imported.basis.regionSeq}）已过期，结论按当时依据保留`,
          createdAt: ctx.now(),
          signedAt: imported.signedAt ?? batch.exportedAt,
        };
        const successor: Review = {
          id: `RV-${ctx.nextId('rv')}`,
          docId: doc.id,
          check: imported.check,
          status: 'pending',
          operator: '待重算',
          note: `中心内容已变，按新内容重算外聘复核 ${imported.reviewNo}`,
          createdAt: ctx.now(),
        };
        review.supersededBy = successor.id;
        recomputedById.add(successor.id);
        doc.reviews.push(review, successor);
      } else {
        review = {
          id: `RV-${ctx.nextId('rv')}`,
          docId: doc.id,
          check: imported.check,
          status: imported.status,
          operator: imported.operator,
          reviewNo: imported.reviewNo,
          batchId: batch.batchId,
          basis: imported.status === 'signed' ? imported.basis : undefined,
          conclusion: imported.conclusion,
          note: imported.note,
          createdAt: ctx.now(),
          signedAt: imported.status === 'signed' ? (imported.signedAt ?? batch.exportedAt) : undefined,
        };
        doc.reviews.push(review);
      }
      appendHistory(doc, {
        kind: 'review-imported',
        message: `导入复核 ${imported.reviewNo}（${imported.check} / ${review.status === 'signed' ? (review.basisStale ? '已签·依据过期保留' : '已签') : '未完成'}）`,
        basis: review.basis,
      }, ctx, batch.operator);
    });
  }

  // 区域 / 密级成功落地的变化会让中心原有的未完成复核失效并重算；
  // 已在上面按新内容生成后继的导入复核（exclude）不再重复失效
  if (appliedChange) {
    invalidateOpenReviews(doc, '导入批合并后内容发生变化', ctx, batch.operator, recomputedById);
  }

  return { state, writes, conflicts };
}

// ---------- 失败项重试 ----------

/** 只重试指定（或全部）失败写项；已成功项不重复执行，保证从失败项恢复 */
export function retryFailedWrites(prev: MergeState, batch: ImportBatch, writeIds: string[] | 'all', ctx: EngineCtx, failInject?: Set<string>): MergeState {
  const targets = prev.writes.filter((w) => w.status === 'failed' && (writeIds === 'all' || writeIds.includes(w.id)));
  if (targets.length === 0) return prev;

  // 重新跑整批合并，但用"账本记忆"跳过此前已成功的写入，仅落地失败项
  const succeededMemory = new Set(
    prev.writes.filter((w) => w.status === 'succeeded').map((w) => `${w.docId}:${w.kind}:${w.refId ?? ''}`)
  );
  // 去掉该批的失败账本与受理记录后重放，已成功项通过注入失败集合的反面来跳过——
  // 这里采用更直接的方式：以当前状态重放，所有成功过的项视为空操作。
  const replayed = replayBatchSkipping(prev, batch, succeededMemory, targets, ctx, failInject);
  return replayed;
}

function replayBatchSkipping(
  prev: MergeState,
  batch: ImportBatch,
  skip: Set<string>,
  retryTargets: WriteItem[],
  ctx: EngineCtx,
  failInject?: Set<string>
): MergeState {
  // 移除本批"被选中重试"的失败账本行；未选中的失败行原样保留
  const retryIds = new Set(retryTargets.map((w) => w.id));
  let state: MergeState = {
    ...cloneState(prev),
    writes: prev.writes.filter((w) => !(w.batchId === batch.batchId && w.status === 'failed' && retryIds.has(w.id))),
  };

  // 未选中重试的失败项继续视作"不可执行"：重放时把它们排除在落地集合之外
  const stillBlocked = new Set(
    prev.writes
      .filter((w) => w.batchId === batch.batchId && w.status === 'failed' && !retryIds.has(w.id))
      .map((w) => `${w.docId}:${w.kind}:${w.refId ?? ''}`)
  );

  for (const item of batch.items) {
    const result = mergeItemWithSkip(state, item, batch, ctx, skip, stillBlocked, failInject);
    state = result.state;
    state.writes.push(...result.writes);
  }
  return state;
}

function mergeItemWithSkip(
  prev: MergeState,
  item: ImportItem,
  batch: ImportBatch,
  ctx: EngineCtx,
  skip: Set<string>,
  blocked: Set<string>,
  failInject?: Set<string>
): MergeItemResult {
  const state = cloneState(prev);
  const doc = state.documents.find((d) => d.id === item.docId);
  const writes: WriteItem[] = [];
  const conflicts: Conflict[] = [];
  if (!doc) return { state, writes, conflicts };

  const guarded = (key: string, kind: WriteItem['kind'], refId: string | undefined, summary: string, apply: () => void) => {
    const ledgerKey = `${item.docId}:${kind}:${refId ?? ''}`;
    if (skip.has(ledgerKey)) return; // 已成功过，不重复
    if (blocked.has(ledgerKey)) return; // 未被选中重试的失败项，保持失败
    const shouldFail = failInject?.has(ledgerKey) ?? false;
    const id = `W-${ctx.nextId('w')}`;
    if (shouldFail) {
      writes.push({ id, batchId: batch.batchId, docId: item.docId, kind, refId, summary, status: 'failed', attempts: 1, lastError: '中心写入暂存失败（模拟存储不可用）', at: ctx.now() });
      return;
    }
    apply();
    writes.push({ id, batchId: batch.batchId, docId: item.docId, kind, refId, summary, status: 'succeeded', attempts: 1, at: ctx.now() });
  };

  const beforeSeq = regionSeqSignature(doc.redactions);
  let appliedChange = false;

  if (item.classification !== doc.classification) {
    const baseClass = item.baseClassification ?? doc.classification;
    const baseClassVersion = item.baseClassVersion ?? item.classVersion;
    const centerMoved = doc.classification !== baseClass || doc.classVersion > baseClassVersion;
    const remoteMoved = item.classification !== baseClass;
    if (centerMoved && remoteMoved) {
      const existing = state.conflicts.find((c) => c.docId === doc.id && c.kind === 'classification' && c.status === 'open');
      if (!existing) {
        guarded(`${item.docId}-class`, 'import-class', undefined, `密级冲突待裁决（中心 ${doc.classification} / 外聘 ${item.classification}）`, () => {});
      }
    } else if (!centerMoved) {
      guarded(`${item.docId}-class`, 'import-class', undefined, `采用外聘密级「${item.classification}」（失败项重试补写）`, () => {
        doc.classification = item.classification;
        appliedChange = true;
        appendHistory(doc, {
          kind: 'class-remote',
          message: `失败项重试补写：采用导入批 ${batch.batchId} 密级「${item.classification}」`,
        }, ctx, batch.operator);
      });
    }
  }

  for (const incoming of item.redactions) {
    const id = incoming.id ?? `R-${ctx.nextId('r')}`;
    if (!incoming.id || !doc.redactions.some((r) => r.id === incoming.id)) {
      guarded(id, 'import-region', id, `并入外聘新增区域（${incoming.reason}，第 ${incoming.page} 页）（失败项重试补写）`, () => {
        const region: Redaction = { ...incoming, id, version: 1, changedBy: batch.operator, source: 'remote' };
        doc.redactions.push(region);
        appliedChange = true;
        appendHistory(doc, {
          kind: 'region-add-remote',
          message: `失败项重试补写：外聘 ${batch.operator} 新增区域 ${id}（${region.reason}）`,
          regionSnapshots: snapshotRegions([region], 'remote'),
        }, ctx, batch.operator);
      });
      continue;
    }
    const centerRegion = doc.redactions.find((r) => r.id === incoming.id)!;
    const baseVersion = incoming.baseVersion ?? 1;
    if (regionSignature(centerRegion) === regionSignature(incoming)) continue;
    if (centerRegion.version > baseVersion) {
      const existing = state.conflicts.find((c) => c.regionId === centerRegion.id && c.status === 'open');
      if (!existing) {
        guarded(centerRegion.id, 'conflict-adjudication', centerRegion.id, `区域 ${centerRegion.id} 双改，待逐项裁决`, () => {});
      }
    } else {
      guarded(centerRegion.id, 'import-region', centerRegion.id, `快进采用外聘区域 ${centerRegion.id}（失败项重试补写）`, () => {
        const prevVersion = centerRegion.version;
        Object.assign(centerRegion, incoming, { version: prevVersion + 1, changedBy: batch.operator, source: 'remote' as RegionSource });
        appliedChange = true;
        appendHistory(doc, {
          kind: 'region-edit-remote',
          message: `失败项重试补写：区域 ${centerRegion.id} 快进外聘修改 v${prevVersion} → v${centerRegion.version}`,
          regionSnapshots: snapshotRegions([centerRegion], 'remote'),
        }, ctx, batch.operator);
      });
    }
  }

  if (regionSeqSignature(doc.redactions) !== beforeSeq) {
    doc.regionSeq += 1;
    doc.docVersion = Math.max(doc.docVersion, item.docVersion) + 1;
  }
  if (appliedChange) {
    doc.updatedAt = ctx.now();
    invalidateOpenReviews(doc, '失败项重试补写后内容发生变化', ctx, batch.operator);
  }

  for (const imported of item.reviews) {
    guarded(imported.reviewNo, 'import-review', imported.reviewNo, `并入复核 ${imported.reviewNo}（${imported.check}）`, () => {
      if (doc.reviews.some((r) => r.reviewNo === imported.reviewNo)) return;
      doc.reviews.push({
        id: `RV-${ctx.nextId('rv')}`,
        docId: doc.id,
        check: imported.check,
        status: imported.status,
        operator: imported.operator,
        reviewNo: imported.reviewNo,
        batchId: batch.batchId,
        basis: imported.status === 'signed' ? imported.basis : undefined,
        conclusion: imported.conclusion,
        createdAt: ctx.now(),
        signedAt: imported.status === 'signed' ? (imported.signedAt ?? batch.exportedAt) : undefined,
      });
    });
  }

  return { state, writes, conflicts };
}

// ---------- 冲突逐项裁决 ----------

/**
 * 逐项裁决冲突。裁决后才能进入发布批次：
 * - adopt-center：保留中心版（外聘版仍留在冲突记录与历史里可查）；
 * - adopt-remote：以外聘版覆盖为新中心版本，来源记 adopted-remote；
 * - keep-both：中心区域保留，外聘内容复制为一个新区域（remoteTwinId），双方同页共存。
 */
export function resolveConflict(prev: MergeState, conflictId: string, decision: ConflictDecision, operator: string, ctx: EngineCtx): MergeState {
  const state = cloneState(prev);
  const conflict = state.conflicts.find((c) => c.id === conflictId);
  if (!conflict || conflict.status === 'resolved') return prev;
  const doc = mustFindDoc(state, conflict.docId);

  if (conflict.kind === 'classification') {
    if (decision === 'adopt-remote' && conflict.remote.classification) {
      doc.classification = conflict.remote.classification;
      doc.classVersion += 1;
      doc.docVersion += 1;
    }
    // adopt-center / keep-both 对密级都维持中心值（keep-both 对密级等同中心，另在历史中记录双值）
  } else if (conflict.regionId && conflict.remote.region) {
    const centerRegion = doc.redactions.find((r) => r.id === conflict.regionId);
    if (!centerRegion) return prev;
    if (decision === 'adopt-remote') {
      const incoming = conflict.remote.region;
      Object.assign(centerRegion, {
        page: incoming.page, x: incoming.x, y: incoming.y, width: incoming.width, height: incoming.height,
        reason: incoming.reason, privilege: incoming.privilege, status: incoming.status,
        version: centerRegion.version + 1,
        changedBy: operator,
        source: 'adopted-remote' as RegionSource,
      });
      doc.regionSeq += 1;
      doc.docVersion += 1;
    } else if (decision === 'keep-both') {
      const incoming = conflict.remote.region;
      const twinId = `R-${ctx.nextId('r')}`;
      doc.redactions.push({
        id: twinId,
        page: incoming.page, x: incoming.x, y: incoming.y, width: incoming.width, height: incoming.height,
        reason: incoming.reason, privilege: incoming.privilege, status: incoming.status,
        version: 1,
        changedBy: conflict.remote.operator,
        source: 'remote',
      });
      centerRegion.source = 'kept-both';
      conflict.remoteTwinId = twinId;
      doc.regionSeq += 1;
      doc.docVersion += 1;
    } else {
      centerRegion.source = 'adopted-center';
    }
  }

  conflict.status = 'resolved';
  conflict.decision = decision;
  conflict.decidedBy = operator;
  conflict.decidedAt = ctx.now();

  appendHistory(doc, {
    kind: 'conflict-resolve',
    message:
      conflict.kind === 'classification'
        ? `密级冲突裁决：${decision === 'adopt-remote' ? '采用外聘「' + doc.classification + '」' : '保留中心「' + doc.classification + '」'}`
        : `区域 ${conflict.regionId} 裁决：${decision === 'adopt-center' ? '采用中心版' : decision === 'adopt-remote' ? '采用外聘版' : `双方保留（外聘副本 ${conflict.remoteTwinId ?? ''}）`}`,
    conflictId: conflict.id,
  }, ctx, operator);

  // 裁决推进了内容：未完成复核失效重算
  invalidateOpenReviews(doc, '冲突裁决后内容定稿', ctx, operator);
  doc.updatedAt = ctx.now();
  return state;
}

// ---------- 复核签核：冻结当时依据 ----------

export function signReview(prev: MergeState, reviewId: string, operator: string, conclusion: string, ctx: EngineCtx): MergeState {
  const state = cloneState(prev);
  for (const doc of state.documents) {
    const review = doc.reviews.find((r) => r.id === reviewId);
    if (!review) continue;
    if (review.status !== 'pending') return prev;
    review.status = 'signed';
    review.operator = operator;
    review.conclusion = conclusion;
    review.signedAt = ctx.now();
    review.basis = currentBasis(doc);
    review.basisStale = false;
    appendHistory(doc, {
      kind: 'review-sign',
      message: `复核 ${review.check} 签核：${conclusion}（依据文档 v${review.basis.docVersion} / 区域 seq${review.basis.regionSeq} / ${review.basis.classification}）`,
      basis: review.basis,
    }, ctx, operator);
    return state;
  }
  return prev;
}

// ---------- 发布门禁与发布批次 ----------

/** 逐项裁决后才能进入发布批次：未决冲突 / 失败写入 / 未完成复核都会阻塞 */
export function evaluateRelease(state: MergeState, docIds: string[]): { ok: boolean; blockers: ReleaseBlocker[] } {
  const blockers: ReleaseBlocker[] = [];
  for (const docId of docIds) {
    const reasons: string[] = [];
    const doc = state.documents.find((d) => d.id === docId);
    if (!doc) {
      reasons.push('文档不存在');
    } else {
      const openConflicts = state.conflicts.filter((c) => c.docId === docId && c.status === 'open');
      if (openConflicts.length > 0) reasons.push(`${openConflicts.length} 项冲突未裁决（须逐项裁决）`);
      const failedWrites = state.writes.filter((w) => w.docId === docId && w.status === 'failed');
      if (failedWrites.length > 0) reasons.push(`${failedWrites.length} 个写入失败项未重试成功`);
      // 失效记录保留为审计轨迹；只要每个检查项沿后继链走到了已签核，就不再阻塞
      const pending = doc.reviews.filter((r) => r.status === 'pending');
      if (pending.length > 0) reasons.push(`${pending.length} 条未完成复核（含失效后重算项），须重新签核`);
      const drafts = doc.redactions.filter((r) => r.status === 'draft');
      if (drafts.length > 0) reasons.push(`${drafts.length} 个去密区域仍是草稿`);
    }
    if (reasons.length > 0) blockers.push({ docId, reasons });
  }
  return { ok: blockers.length === 0, blockers };
}

export function createReleaseBatch(prev: MergeState, name: string, docIds: string[], operator: string, ctx: EngineCtx): MergeState | { error: string } {
  const gate = evaluateRelease(prev, docIds);
  if (!gate.ok) {
    return { error: gate.blockers.map((b) => `${b.docId}：${b.reasons.join('；')}`).join(' || ') };
  }
  const state = cloneState(prev);
  state.releases.push({
    id: `REL-${ctx.nextId('rel')}`,
    name,
    docIds,
    frozen: docIds.map((docId) => {
      const doc = state.documents.find((d) => d.id === docId)!;
      return { docId, docVersion: doc.docVersion, regionSeq: doc.regionSeq, classVersion: doc.classVersion };
    }),
    operator,
    createdAt: ctx.now(),
  });
  for (const doc of state.documents) {
    if (docIds.includes(doc.id)) doc.status = '可发布';
  }
  return state;
}

// ---------- 旧草稿迁移：无版本号补成首版，历史记录继续可查 ----------

type LegacyRedaction = Omit<Redaction, 'version' | 'changedBy' | 'source'> & { version?: number; changedBy?: string; source?: RegionSource };
export type LegacyDocument = Omit<DisclosureRecord, 'classVersion' | 'docVersion' | 'regionSeq' | 'reviews' | 'history' | 'redactions'> & {
  classVersion?: number;
  docVersion?: number;
  regionSeq?: number;
  redactions: LegacyRedaction[];
  reviews?: Review[];
  history?: HistoryEvent[];
};

/** 旧草稿没有版本号时补成首版；原区域和复核记录原样保留、继续可查 */
export function migrateLegacyDocument(legacy: LegacyDocument, ctx: EngineCtx): DisclosureRecord {
  const redactions: Redaction[] = legacy.redactions.map((r) => ({
    ...r,
    version: r.version ?? 1,
    changedBy: r.changedBy ?? legacy.owner,
    source: r.source ?? 'center',
  }));
  const history = legacy.history ?? [];
  const migrated: DisclosureRecord = {
    ...legacy,
    classification: legacy.classification,
    classVersion: legacy.classVersion ?? 1,
    docVersion: legacy.docVersion ?? 1,
    regionSeq: legacy.regionSeq ?? 1,
    redactions,
    reviews: legacy.reviews ?? [],
    history,
  };
  const hadVersions = legacy.redactions.every((r) => typeof r.version === 'number')
    && typeof legacy.docVersion === 'number';
  if (!hadVersions) {
    migrated.history.push({
      at: ctx.now(),
      operator: legacy.owner,
      kind: 'legacy-bootstrap',
      message: `旧草稿迁移：文档补为首版（文档 v1 / 密级 v1 / 区域 seq1），${redactions.length} 个原有区域与 ${migrated.reviews.length} 条复核记录保留可查`,
      regionSnapshots: snapshotRegions(redactions, 'center'),
    });
  }
  return migrated;
}

// ---------- 工具 ----------

export function mustFindDoc(state: MergeState, docId: string): DisclosureRecord {
  const doc = state.documents.find((d) => d.id === docId);
  if (!doc) throw new Error(`文档不存在：${docId}`);
  return doc;
}

export function cloneState(state: MergeState): MergeState {
  return structuredClone(state);
}

export function openConflictsOf(state: MergeState, docId?: string): Conflict[] {
  return state.conflicts.filter((c) => c.status === 'open' && (docId ? c.docId === docId : true));
}
