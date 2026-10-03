/**
 * 合并引擎：版本快照、复核失效与重算、两边冲突保留与裁决、写入队列断点续传、旧草稿版本补录。
 * 纯函数模块，不依赖 zustand；store 负责调用并落库。
 */
import type { DisclosureRecord, Redaction, ReviewRecord, ImportBatch, ImportItem, ConflictItem, Source } from './store';

export const IDEMPOTENCY_PREFIX = 'yy59-merge';
export const OPERATOR_CENTER = '林清';

export function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function idempotencyKey(batchNo: string, reviewNo: string): string {
  return `${IDEMPOTENCY_PREFIX}:${batchNo}:${reviewNo}`;
}

/** 取文档各区域当前版本号。 */
export function regionVersionMap(doc: DisclosureRecord): Record<string, number> {
  const map: Record<string, number> = {};
  doc.redactions.forEach((r) => { map[r.id] = r.regionVersion; });
  return map;
}

/** 生成复核依据快照：文档版本、各区域版本、密级与区域内容。 */
export function makeBasis(doc: DisclosureRecord): ReviewRecord['basis'] {
  return {
    docVersion: doc.docVersion,
    regionVersions: regionVersionMap(doc),
    classification: doc.classification,
    regionCount: doc.redactions.length,
    regionSnapshot: doc.redactions.map((r) => ({ ...r }))
  };
}

/**
 * 中心内容变更后：未签署（未完成）复核标记失效；已签署复核不动，保留当时依据。
 */
export function invalidateUnsignedReviews(
  reviews: ReviewRecord[],
  docId: string,
  stamp: string
): ReviewRecord[] {
  return reviews.map((r) => {
    if (r.docId !== docId) return r;
    if (r.status === '已签结') return r;
    if (r.status === '已失效') return r;
    return { ...r, status: '已失效' as const, invalidatedAt: stamp };
  });
}

/** 按当前（新）内容重算一条复核：生成新的有效复核，原复核保留失效记录并互相关联。 */
export function recalculateReview(
  reviews: ReviewRecord[],
  reviewId: string,
  docs: DisclosureRecord[],
  stamp: string
): ReviewRecord[] {
  const target = reviews.find((r) => r.id === reviewId);
  if (!target) return reviews;
  const doc = docs.find((d) => d.id === target.docId);
  if (!doc) return reviews;
  const newReview: ReviewRecord = {
    ...target,
    id: `RW-${target.docId}-${Date.now()}`,
    reviewNo: `${target.reviewNo}·重算`,
    status: '有效',
    signedAt: null,
    conclusion: null,
    basis: makeBasis(doc),
    recalculatedFrom: target.id,
    recalculatedTo: undefined,
    invalidatedAt: undefined,
    createdAt: stamp
  };
  return [
    ...reviews.map((r) => (r.id === reviewId ? { ...r, recalculatedTo: newReview.id } : r)),
    newReview
  ];
}

/** 失效未完成复核，并立即按新内容重算；已签结复核保留当时依据。 */
export function invalidateAndRecalculate(
  reviews: ReviewRecord[],
  docId: string,
  docs: DisclosureRecord[],
  stamp: string
): ReviewRecord[] {
  let next = invalidateUnsignedReviews(reviews, docId, stamp);
  const newlyInvalidated = next.filter(
    (r) => r.docId === docId && r.status === '已失效' && r.invalidatedAt === stamp && !r.recalculatedTo
  );
  for (const r of newlyInvalidated) {
    next = recalculateReview(next, r.id, docs, stamp);
  }
  return next;
}

function maxRegionVersion(doc: DisclosureRecord): number {
  return doc.redactions.reduce((max, r) => Math.max(max, r.regionVersion), 0);
}

/** 构造区域冲突项：中心版本与外聘版本各自完整保留，来源可查。 */
function buildRegionConflict(
  doc: DisclosureRecord,
  region: Redaction,
  item: ImportItem,
  batch: ImportBatch,
  stamp: string
): ConflictItem {
  const payload = item.payload as Partial<Redaction>;
  const offlineData: Record<string, unknown> = {
    ...region,
    ...payload,
    id: region.id,
    source: '外聘回传',
    regionVersion: item.baseRegionVersion + 1,
    regionUpdatedBy: batch.operator,
    regionUpdatedAt: stamp
  };
  return {
    id: `CF-${region.id}-${batch.batchNo}`,
    docId: doc.id,
    regionId: region.id,
    kind: '区域',
    batchNo: batch.batchNo,
    center: {
      version: region.regionVersion,
      updatedBy: region.regionUpdatedBy,
      updatedAt: region.regionUpdatedAt,
      source: region.source,
      data: { ...region }
    },
    offline: {
      version: item.baseRegionVersion + 1,
      updatedBy: batch.operator,
      updatedAt: stamp,
      source: '外聘回传',
      data: offlineData
    },
    status: '待裁决'
  };
}

/** 构造密级冲突项（文档级）。 */
function buildClassificationConflict(
  doc: DisclosureRecord,
  item: ImportItem,
  batch: ImportBatch,
  stamp: string
): ConflictItem {
  const offlineClassification = (item.payload.classification as DisclosureRecord['classification']) ?? doc.classification;
  return {
    id: `CF-${doc.id}-CLS-${batch.batchNo}`,
    docId: doc.id,
    regionId: null,
    kind: '密级',
    batchNo: batch.batchNo,
    center: {
      version: doc.docVersion,
      updatedBy: doc.docUpdatedBy,
      updatedAt: doc.docUpdatedAt,
      source: '中心',
      data: { classification: doc.classification }
    },
    offline: {
      version: item.baseDocVersion + 1,
      updatedBy: batch.operator,
      updatedAt: stamp,
      source: '外聘回传',
      data: { classification: offlineClassification }
    },
    status: '待裁决'
  };
}

/** 确定性的模拟写入失败：同一待写项在失败开关打开时稳定失败，便于演示断点续传。 */
function failHash(id: string): boolean {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 4 === 0;
}

export type WriteResult = {
  docs: DisclosureRecord[];
  reviews: ReviewRecord[];
  conflicts: ConflictItem[];
  items: ImportItem[];
  batchStatus: ImportBatch['batchStatus'];
  notice: string;
};

/**
 * 写入趟次：按导入项顺序写入，已写入项跳过（断点续传）。
 * - 中心未改动、仅外聘改动 → 快速转发并升版本；
 * - 中心与外聘改了同一区域/密级 → 保留双方与来源，标记待裁决；
 * - 写入失败 → 从失败项重试，已写入项不重复。
 */
export function runWritePass(input: {
  docs: DisclosureRecord[];
  reviews: ReviewRecord[];
  conflicts: ConflictItem[];
  batch: ImportBatch;
  simulateFailures: boolean;
  stamp: string;
}): WriteResult {
  let docs = input.docs.map((d) => ({
    ...d,
    redactions: d.redactions.map((r) => ({ ...r }))
  }));
  let reviews = input.reviews.map((r) => ({
    ...r,
    basis: {
      ...r.basis,
      regionVersions: { ...r.basis.regionVersions },
      regionSnapshot: r.basis.regionSnapshot.map((s) => ({ ...s }))
    }
  }));
  let conflicts = input.conflicts.map((c) => ({
    ...c,
    center: { ...c.center, data: { ...c.center.data } },
    offline: { ...c.offline, data: { ...c.offline.data } }
  }));
  const items = input.batch.items.map((i) => ({ ...i, payload: { ...i.payload } }));
  let notice = '';

  for (const item of items) {
    if (item.writeStatus === '已写入') continue;
    if (item.writeStatus === '待裁决') continue;
    const doc = docs.find((d) => d.id === item.docId);
    if (!doc) {
      item.writeStatus = '写入失败';
      item.failReason = '中心文档不存在';
      continue;
    }

    if (item.changeType === '区域') {
      const region = doc.redactions.find((r) => r.id === item.regionId);
      if (!region) {
        // 外聘离线新增的区域
        if (!item.offlineChanged) {
          item.writeStatus = '已写入';
          continue;
        }
        if (input.simulateFailures && failHash(item.id)) {
          item.writeStatus = '写入失败';
          item.failReason = '模拟中心写入超时（可从失败项重试）';
          continue;
        }
        const payload = item.payload as Partial<Redaction>;
        const newRegion: Redaction = {
          id: item.regionId ?? `R-NEW-${Date.now()}`,
          page: payload.page ?? 1,
          x: payload.x ?? 0.1,
          y: payload.y ?? 0.1,
          width: payload.width ?? 0.2,
          height: payload.height ?? 0.04,
          reason: payload.reason ?? '外聘新增遮蔽',
          privilege: payload.privilege ?? '个人信息',
          status: payload.status ?? 'confirmed',
          regionVersion: maxRegionVersion(doc) + 1,
          regionUpdatedBy: input.batch.operator,
          regionUpdatedAt: input.stamp,
          source: '外聘回传'
        };
        doc.redactions.push(newRegion);
        doc.docVersion += 1;
        doc.docUpdatedBy = input.batch.operator;
        doc.docUpdatedAt = input.stamp;
        reviews = invalidateAndRecalculate(reviews, doc.id, docs, input.stamp);
        item.writeStatus = '已写入';
        continue;
      }

      if (region.regionVersion > item.baseRegionVersion && item.offlineChanged) {
        // 同一区域两边都改过：保留双方版本与来源，逐项裁决
        conflicts.push(buildRegionConflict(doc, region, item, input.batch, input.stamp));
        region.conflict = true;
        item.writeStatus = '待裁决';
        notice = '同一区域两边都有修改，已保留双方版本与来源，请逐项裁决后再进入发布批次';
        continue;
      }

      if (item.offlineChanged) {
        if (input.simulateFailures && failHash(item.id)) {
          item.writeStatus = '写入失败';
          item.failReason = '模拟中心写入超时（可从失败项重试）';
          continue;
        }
        Object.assign(region, item.payload, {
          regionVersion: item.baseRegionVersion + 1,
          regionUpdatedBy: input.batch.operator,
          regionUpdatedAt: input.stamp,
          source: '外聘回传' as Source
        });
        doc.docVersion += 1;
        doc.docUpdatedBy = input.batch.operator;
        doc.docUpdatedAt = input.stamp;
        reviews = invalidateAndRecalculate(reviews, doc.id, docs, input.stamp);
        item.writeStatus = '已写入';
      } else {
        item.writeStatus = '已写入';
      }
      continue;
    }

    if (item.changeType === '密级') {
      if (input.simulateFailures && failHash(item.id)) {
        item.writeStatus = '写入失败';
        item.failReason = '模拟中心写入超时（可从失败项重试）';
        continue;
      }
      if (doc.docVersion > item.baseDocVersion) {
        conflicts.push(buildClassificationConflict(doc, item, input.batch, input.stamp));
        item.writeStatus = '待裁决';
        notice = '密级两边都有修改，已保留双方版本与来源，请逐项裁决';
        continue;
      }
      doc.classification = (item.payload.classification as DisclosureRecord['classification']) ?? doc.classification;
      doc.docVersion += 1;
      doc.docUpdatedBy = input.batch.operator;
      doc.docUpdatedAt = input.stamp;
      reviews = invalidateAndRecalculate(reviews, doc.id, docs, input.stamp);
      item.writeStatus = '已写入';
      continue;
    }

    if (item.changeType === '复核结论') {
      if (input.simulateFailures && failHash(item.id)) {
        item.writeStatus = '写入失败';
        item.failReason = '模拟中心写入超时（可从失败项重试）';
        continue;
      }
      const reviewNo = (item.payload.reviewNo as string) ?? input.batch.reviewNo;
      if (reviews.some((r) => r.reviewNo === reviewNo)) {
        item.writeStatus = '已写入'; // 同批复传沿用第一次结果
        continue;
      }
      const newReview: ReviewRecord = {
        id: `RW-${doc.id}-${reviewNo}`,
        reviewNo,
        docId: doc.id,
        batchNo: input.batch.batchNo,
        operator: input.batch.operator,
        createdAt: input.stamp,
        signedAt: input.stamp,
        conclusion: (item.payload.conclusion as ReviewRecord['conclusion']) ?? '通过',
        status: '已签结',
        basis: {
          docVersion: item.baseDocVersion,
          regionVersions: regionVersionMap(doc),
          classification: (item.payload.classification as string) ?? doc.classification,
          regionCount: doc.redactions.length,
          regionSnapshot: doc.redactions.map((r) => ({ ...r }))
        }
      };
      reviews.push(newReview);
      item.writeStatus = '已写入';
    }
  }

  const batchStatus: ImportBatch['batchStatus'] = items.some((i) => i.writeStatus === '待裁决')
    ? '待裁决'
    : items.some((i) => i.writeStatus === '写入失败')
      ? '部分失败'
      : '已完成';

  return { docs, reviews, conflicts, items, batchStatus, notice };
}

export type AdjudicationChoice = '采用中心' | '采用外聘';

/** 裁决冲突：按所选版本写入，双方版本与来源仍保留在冲突记录中可查。 */
export function applyAdjudication(
  docs: DisclosureRecord[],
  conflicts: ConflictItem[],
  conflictId: string,
  choice: AdjudicationChoice,
  operator: string,
  stamp: string
): { docs: DisclosureRecord[]; conflicts: ConflictItem[] } {
  const conflict = conflicts.find((c) => c.id === conflictId);
  if (!conflict) return { docs, conflicts };
  const next = docs.map((d) => ({ ...d, redactions: d.redactions.map((r) => ({ ...r })) }));
  const doc = next.find((d) => d.id === conflict.docId);
  if (doc) {
    if (conflict.kind === '区域' && conflict.regionId) {
      const region = doc.redactions.find((r) => r.id === conflict.regionId);
      if (region) {
        const chosen = (choice === '采用中心' ? conflict.center.data : conflict.offline.data) as Partial<Redaction>;
        Object.assign(region, chosen, {
          regionVersion: Math.max(conflict.center.version, conflict.offline.version),
          regionUpdatedBy: operator,
          regionUpdatedAt: stamp,
          source: (choice === '采用中心' ? conflict.center.source : conflict.offline.source) as Source,
          conflict: false
        });
      }
    } else if (conflict.kind === '密级') {
      const chosen = (choice === '采用中心' ? conflict.center.data : conflict.offline.data) as { classification?: DisclosureRecord['classification'] };
      doc.classification = chosen.classification ?? doc.classification;
      doc.docVersion = Math.max(conflict.center.version, conflict.offline.version) + 1;
      doc.docUpdatedBy = operator;
      doc.docUpdatedAt = stamp;
    }
  }
  const nextConflicts = conflicts.map((c) =>
    c.id === conflictId ? { ...c, status: choice, adjudicatedBy: operator, adjudicatedAt: stamp } : c
  );
  return { docs: next, conflicts: nextConflicts };
}

/**
 * 旧草稿补录：没有版本号的文档/区域补成首版（v1），
 * 并为没有复核记录的文档补一条历史复核（原有区域与复核记录继续可查）。
 * 幂等，可在每次载入时运行。
 */
export function backfill(
  docs: DisclosureRecord[],
  reviews: ReviewRecord[]
): { documents: DisclosureRecord[]; reviews: ReviewRecord[] } {
  const stamp = nowStamp();
  const documents = docs.map((d) => ({
    ...d,
    docVersion: d.docVersion ?? 1,
    docUpdatedBy: d.docUpdatedBy ?? d.owner,
    docUpdatedAt: d.docUpdatedAt ?? d.updatedAt,
    redactions: d.redactions.map((r) => ({
      ...r,
      regionVersion: r.regionVersion ?? 1,
      regionUpdatedBy: r.regionUpdatedBy ?? d.owner,
      regionUpdatedAt: r.regionUpdatedAt ?? d.updatedAt,
      source: r.source ?? ('中心' as Source)
    }))
  }));
  const nextReviews = reviews.map((r) => ({
    ...r,
    basis: r.basis ?? makeBasis(documents.find((d) => d.id === r.docId) ?? documents[0])
  }));
  for (const d of documents) {
    if (!nextReviews.some((r) => r.docId === d.id)) {
      nextReviews.push({
        id: `RW-${d.id}`,
        reviewNo: `FH-${d.id.replace(/^DOC-/, '')}`,
        docId: d.id,
        batchNo: null,
        operator: d.owner,
        createdAt: d.updatedAt,
        signedAt: d.status === '可发布' ? d.updatedAt : null,
        conclusion: d.status === '可发布' ? '通过' : null,
        status: d.status === '可发布' ? '已签结' : '有效',
        basis: makeBasis(d),
        legacy: true
      });
    }
  }
  return { documents, reviews: nextReviews };
}
