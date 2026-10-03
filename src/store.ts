import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  applyAdjudication,
  backfill,
  idempotencyKey,
  invalidateAndRecalculate,
  nowStamp,
  OPERATOR_CENTER,
  recalculateReview,
  runWritePass
} from './merge';

export type Source = '中心' | '外聘回传';
export type ReviewStatus = '有效' | '已失效' | '已签结';
export type WriteStatus = '待写入' | '已写入' | '写入失败' | '待裁决';
export type BatchStatus = '待写入' | '写入中' | '部分失败' | '待裁决' | '已完成';
export type AdjudicationChoice = '采用中心' | '采用外聘';

export type Redaction = {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  reason: string;
  privilege: string;
  status: 'draft' | 'confirmed';
  // 版本与来源
  regionVersion: number;
  regionUpdatedBy: string;
  regionUpdatedAt: string;
  source: Source;
  conflict?: boolean;
};

export type DisclosureRecord = {
  id: string;
  title: string;
  bundle: string;
  pages: number;
  classification: '内部' | '机密' | '严格机密';
  owner: string;
  updatedAt: string;
  status: '去密中' | '待质检' | '可发布';
  issue: string;
  size: string;
  redactions: Redaction[];
  docVersion: number;
  docUpdatedBy: string;
  docUpdatedAt: string;
};

export type ReviewRecord = {
  id: string;
  reviewNo: string;
  docId: string;
  batchNo: string | null;
  operator: string;
  createdAt: string;
  signedAt: string | null;
  conclusion: '通过' | '退回补件' | null;
  status: ReviewStatus;
  basis: {
    docVersion: number;
    regionVersions: Record<string, number>;
    classification: string;
    regionCount: number;
    regionSnapshot: Redaction[];
  };
  invalidatedAt?: string;
  recalculatedFrom?: string;
  recalculatedTo?: string;
  legacy?: boolean;
};

export type ImportItem = {
  id: string;
  docId: string;
  regionId: string | null;
  changeType: '区域' | '密级' | '复核结论';
  offlineChanged: boolean;
  payload: Record<string, unknown>;
  baseDocVersion: number;
  baseRegionVersion: number;
  writeStatus: WriteStatus;
  failReason?: string;
};

export type ImportBatch = {
  batchNo: string;
  reviewNo: string;
  operator: string;
  source: Source;
  importedAt: string;
  docVersion: number;
  regionVersion: number;
  items: ImportItem[];
  batchStatus: BatchStatus;
};

export type ConflictParty = {
  version: number;
  updatedBy: string;
  updatedAt: string;
  source: Source;
  data: Record<string, unknown>;
};

export type ConflictItem = {
  id: string;
  docId: string;
  regionId: string | null;
  kind: '区域' | '密级';
  batchNo: string;
  center: ConflictParty;
  offline: ConflictParty;
  status: '待裁决' | AdjudicationChoice;
  adjudicatedBy?: string;
  adjudicatedAt?: string;
};

const rawDocuments: DisclosureRecord[] = [
  {
    id: 'DOC-00418',
    title: '设备采购补充协议（第三版）',
    bundle: '北岭项目 · 第一批披露',
    pages: 3,
    classification: '严格机密',
    owner: '林清',
    updatedAt: '09:48',
    status: '去密中',
    issue: '合同主体与商业条款',
    size: '8.4 MB',
    docVersion: 1,
    docUpdatedBy: '林清',
    docUpdatedAt: '09:48',
    redactions: [
      { id: 'R-01', page: 1, x: 0.12, y: 0.16, width: 0.30, height: 0.04, reason: '商业秘密', privilege: '合同保密', status: 'confirmed', regionVersion: 1, regionUpdatedBy: '林清', regionUpdatedAt: '09:48', source: '中心' },
      { id: 'R-02', page: 1, x: 0.50, y: 0.43, width: 0.34, height: 0.06, reason: '个人手机号', privilege: '个人信息', status: 'draft', regionVersion: 1, regionUpdatedBy: '林清', regionUpdatedAt: '09:48', source: '中心' },
      { id: 'R-03', page: 2, x: 0.11, y: 0.25, width: 0.68, height: 0.05, reason: '第三方报价', privilege: '商业敏感', status: 'confirmed', regionVersion: 1, regionUpdatedBy: '林清', regionUpdatedAt: '09:48', source: '中心' }
    ]
  },
  {
    id: 'DOC-00427',
    title: '现场会议纪要 2026-08-19',
    bundle: '北岭项目 · 第一批披露',
    pages: 3,
    classification: '机密',
    owner: '周叙',
    updatedAt: '09:31',
    status: '待质检',
    issue: '事故预防与整改安排',
    size: '3.1 MB',
    docVersion: 1,
    docUpdatedBy: '周叙',
    docUpdatedAt: '09:31',
    redactions: [
      { id: 'R-04', page: 1, x: 0.08, y: 0.69, width: 0.74, height: 0.05, reason: '内部调查意见', privilege: '工作成果', status: 'confirmed', regionVersion: 1, regionUpdatedBy: '周叙', regionUpdatedAt: '09:31', source: '中心' }
    ]
  },
  {
    id: 'DOC-00435',
    title: '设备运行数据摘录',
    bundle: '北岭项目 · 第二批披露',
    pages: 3,
    classification: '内部',
    owner: '顾言',
    updatedAt: '08:56',
    status: '可发布',
    issue: '运行记录',
    size: '12.7 MB',
    docVersion: 1,
    docUpdatedBy: '顾言',
    docUpdatedAt: '08:56',
    redactions: [
      { id: 'R-05', page: 2, x: 0.44, y: 0.56, width: 0.26, height: 0.04, reason: '人员姓名', privilege: '个人信息', status: 'confirmed', regionVersion: 1, regionUpdatedBy: '顾言', regionUpdatedAt: '08:56', source: '中心' }
    ]
  }
];

const initial = backfill(rawDocuments, []);

type State = {
  documents: DisclosureRecord[];
  activeDocumentId: string;
  activePage: number;
  activeRedactionId: string | null;
  redactionMode: boolean;
  reviewChecks: Record<string, boolean>;
  metadataCleaned: boolean;
  // 合并与版本
  reviews: ReviewRecord[];
  importBatches: ImportBatch[];
  conflicts: ConflictItem[];
  mergeNotice: string | null;
  simulateFailures: boolean;
  selectDocument: (id: string) => void;
  setPage: (page: number) => void;
  toggleRedactionMode: () => void;
  addRedaction: (redaction: Omit<Redaction, 'id' | 'status' | 'regionVersion' | 'regionUpdatedBy' | 'regionUpdatedAt' | 'source'>) => void;
  confirmRedaction: (id: string) => void;
  selectRedaction: (id: string) => void;
  updateClassification: (classification: DisclosureRecord['classification']) => void;
  toggleReviewCheck: (id: string) => void;
  toggleMetadata: () => void;
  markReady: () => void;
  setSimulateFailures: (value: boolean) => void;
  simulateCenterChange: () => void;
  simulateOfflineImport: () => void;
  reimportBatch: (batchNo: string) => void;
  retryBatch: (batchNo: string) => void;
  adjudicateConflict: (conflictId: string, choice: AdjudicationChoice) => void;
  recalculateReview: (reviewId: string) => void;
  clearMergeNotice: () => void;
};

export const useDisclosureStore = create<State>()(
  persist(
    (set) => ({
      documents: initial.documents,
      activeDocumentId: initial.documents[0].id,
      activePage: 1,
      activeRedactionId: 'R-02',
      redactionMode: false,
      reviewChecks: {
        'forbidden-terms': true,
        'page-number': true,
        'image-boundary': false,
        'metadata': false
      },
      metadataCleaned: false,
      reviews: initial.reviews,
      importBatches: [],
      conflicts: [],
      mergeNotice: null,
      simulateFailures: false,
      selectDocument: (id) => set({ activeDocumentId: id, activePage: 1, activeRedactionId: null, redactionMode: false }),
      setPage: (page) => set({ activePage: page }),
      toggleRedactionMode: () => set((state) => ({ redactionMode: !state.redactionMode })),
      addRedaction: (redaction) => set((state) => {
        const stamp = nowStamp();
        const documents = state.documents.map((doc) => doc.id === state.activeDocumentId
          ? {
              ...doc,
              docVersion: doc.docVersion + 1,
              docUpdatedBy: OPERATOR_CENTER,
              docUpdatedAt: stamp,
              redactions: [...doc.redactions, {
                ...redaction,
                id: `R-${Date.now()}`,
                status: 'draft' as const,
                regionVersion: doc.redactions.reduce((max, r) => Math.max(max, r.regionVersion), 0) + 1,
                regionUpdatedBy: OPERATOR_CENTER,
                regionUpdatedAt: stamp,
                source: '中心' as Source
              }]
            }
          : doc);
        const reviews = invalidateAndRecalculate(state.reviews, state.activeDocumentId, documents, stamp);
        return { documents, reviews };
      }),
      confirmRedaction: (id) => set((state) => {
        const stamp = nowStamp();
        const documents = state.documents.map((doc) => ({
          ...doc,
          redactions: doc.redactions.map((item) => item.id === id
            ? { ...item, status: 'confirmed' as const, regionVersion: item.regionVersion + 1, regionUpdatedBy: OPERATOR_CENTER, regionUpdatedAt: stamp }
            : item)
        }));
        const changedDoc = documents.find((doc) => doc.redactions.some((r) => r.id === id));
        const reviews = changedDoc ? invalidateAndRecalculate(state.reviews, changedDoc.id, documents, stamp) : state.reviews;
        return { documents, reviews };
      }),
      selectRedaction: (id) => set({ activeRedactionId: id }),
      updateClassification: (classification) => set((state) => {
        const stamp = nowStamp();
        const documents = state.documents.map((doc) => doc.id === state.activeDocumentId
          ? { ...doc, classification, docVersion: doc.docVersion + 1, docUpdatedBy: OPERATOR_CENTER, docUpdatedAt: stamp }
          : doc);
        const reviews = invalidateAndRecalculate(state.reviews, state.activeDocumentId, documents, stamp);
        return { documents, reviews };
      }),
      toggleReviewCheck: (id) => set((state) => ({ reviewChecks: { ...state.reviewChecks, [id]: !state.reviewChecks[id] } })),
      toggleMetadata: () => set((state) => ({ metadataCleaned: !state.metadataCleaned })),
      markReady: () => set((state) => ({
        documents: state.documents.map((doc) => doc.id === state.activeDocumentId ? { ...doc, status: '可发布' } : doc)
      })),
      setSimulateFailures: (value) => set({ simulateFailures: value }),
      simulateCenterChange: () => set((state) => {
        const stamp = nowStamp();
        const documents: DisclosureRecord[] = state.documents.map((doc): DisclosureRecord => {
          if (doc.id !== 'DOC-00418') return doc;
          const classification: DisclosureRecord['classification'] = doc.classification === '严格机密' ? '机密' : '严格机密';
          return {
            ...doc,
            classification,
            docVersion: doc.docVersion + 1,
            docUpdatedBy: OPERATOR_CENTER,
            docUpdatedAt: stamp,
            redactions: doc.redactions.map((r) => r.id === 'R-02'
              ? { ...r, x: 0.51, y: 0.44, reason: '个人手机号（中心密级复核调整）', regionVersion: r.regionVersion + 1, regionUpdatedBy: OPERATOR_CENTER, regionUpdatedAt: stamp, source: '中心' as Source }
              : r)
          };
        });
        const reviews = invalidateAndRecalculate(state.reviews, 'DOC-00418', documents, stamp);
        return { documents, reviews, mergeNotice: '中心密级/区域已变更：关联的未完成复核已失效并按新内容重算，已签复核保留当时依据。' };
      }),
      simulateOfflineImport: () => set((state) => {
        const stamp = nowStamp();
        const doc = state.documents.find((d) => d.id === 'DOC-00418');
        if (!doc) return {};
        const r03 = doc.redactions.find((r) => r.id === 'R-03');
        const batchNo = 'B-2026-0928-01';
        const reviewNo = 'FH-2026-0042';
        const key = idempotencyKey(batchNo, reviewNo);
        if (state.importBatches.some((b) => idempotencyKey(b.batchNo, b.reviewNo) === key)) {
          return { mergeNotice: '同批复传已沿用第一次结果，未重复写入。' };
        }
        const batch: ImportBatch = {
          batchNo,
          reviewNo,
          operator: '外聘复核 · 周叙',
          source: '外聘回传',
          importedAt: stamp,
          docVersion: doc.docVersion,
          regionVersion: doc.redactions.reduce((max, r) => Math.max(max, r.regionVersion), 0),
          batchStatus: '待写入',
          items: [
            { id: `${batchNo}-1`, docId: doc.id, regionId: 'R-02', changeType: '区域', offlineChanged: true, payload: { x: 0.52, y: 0.45, width: 0.34, height: 0.06, reason: '个人手机号（外聘调整遮蔽范围）' }, baseDocVersion: doc.docVersion, baseRegionVersion: 1, writeStatus: '待写入' },
            { id: `${batchNo}-2`, docId: doc.id, regionId: 'R-03', changeType: '区域', offlineChanged: true, payload: { reason: '第三方报价（外聘补充复核意见）' }, baseDocVersion: doc.docVersion, baseRegionVersion: r03?.regionVersion ?? 1, writeStatus: '待写入' },
            { id: `${batchNo}-3`, docId: doc.id, regionId: 'R-OFF-1', changeType: '区域', offlineChanged: true, payload: { page: 1, x: 0.30, y: 0.62, width: 0.25, height: 0.04, reason: '外聘新增遮蔽', privilege: '个人信息', status: 'confirmed' }, baseDocVersion: doc.docVersion, baseRegionVersion: 0, writeStatus: '待写入' },
            { id: `${batchNo}-4`, docId: doc.id, regionId: null, changeType: '复核结论', offlineChanged: false, payload: { conclusion: '通过', reviewNo }, baseDocVersion: doc.docVersion, baseRegionVersion: 0, writeStatus: '待写入' }
          ]
        };
        const result = runWritePass({ docs: state.documents, reviews: state.reviews, conflicts: state.conflicts, batch, simulateFailures: state.simulateFailures, stamp });
        return {
          documents: result.docs,
          reviews: result.reviews,
          conflicts: result.conflicts,
          importBatches: [...state.importBatches, { ...batch, items: result.items, batchStatus: result.batchStatus }],
          mergeNotice: result.notice || '外聘回传批次已导入合并。'
        };
      }),
      reimportBatch: (batchNo) => set((state) => {
        const batch = state.importBatches.find((b) => b.batchNo === batchNo);
        if (!batch) return {};
        const key = idempotencyKey(batch.batchNo, batch.reviewNo);
        return { mergeNotice: `同批复传（${key}）已沿用第一次结果，未重复写入。` };
      }),
      retryBatch: (batchNo) => set((state) => {
        const stamp = nowStamp();
        const batch = state.importBatches.find((b) => b.batchNo === batchNo);
        if (!batch) return {};
        const retryItems = batch.items.map((i) => i.writeStatus === '写入失败' ? { ...i, writeStatus: '待写入' as WriteStatus, failReason: undefined } : i);
        const result = runWritePass({ docs: state.documents, reviews: state.reviews, conflicts: state.conflicts, batch: { ...batch, items: retryItems }, simulateFailures: false, stamp });
        return {
          documents: result.docs,
          reviews: result.reviews,
          conflicts: result.conflicts,
          importBatches: state.importBatches.map((b) => b.batchNo === batchNo ? { ...b, items: result.items, batchStatus: result.batchStatus } : b),
          mergeNotice: result.notice || '已从失败项重试，已写入项跳过。'
        };
      }),
      adjudicateConflict: (conflictId, choice) => set((state) => {
        const stamp = nowStamp();
        const conflict = state.conflicts.find((c) => c.id === conflictId);
        const { docs, conflicts } = applyAdjudication(state.documents, state.conflicts, conflictId, choice, OPERATOR_CENTER, stamp);
        let reviews = state.reviews;
        if (conflict) reviews = invalidateAndRecalculate(reviews, conflict.docId, docs, stamp);
        const importBatches = state.importBatches.map((b) => {
          const items = b.items.map((i) => {
            if (i.writeStatus !== '待裁决') return i;
            if (conflict && i.docId === conflict.docId && i.regionId === conflict.regionId) {
              return { ...i, writeStatus: '已写入' as WriteStatus };
            }
            return i;
          });
          const batchConflicts = conflicts.filter((c) => c.batchNo === b.batchNo);
          const stillPending = batchConflicts.some((c) => c.status === '待裁决');
          const hasFailure = items.some((i) => i.writeStatus === '写入失败');
          const batchStatus: BatchStatus = stillPending ? '待裁决' : hasFailure ? '部分失败' : '已完成';
          return { ...b, items, batchStatus };
        });
        return { documents: docs, conflicts, reviews, importBatches, mergeNotice: `已裁决：${choice}，双方版本与来源均保留可查。` };
      }),
      recalculateReview: (reviewId) => set((state) => {
        const stamp = nowStamp();
        const reviews = recalculateReview(state.reviews, reviewId, state.documents, stamp);
        return { reviews, mergeNotice: '已按当前内容重新生成复核任务，原复核保留失效记录。' };
      }),
      clearMergeNotice: () => set({ mergeNotice: null })
    }),
    {
      name: 'yy59-disclosure-draft',
      version: 1,
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>;
        const merged = { ...current, ...p };
        const { documents, reviews } = backfill(merged.documents ?? current.documents, merged.reviews ?? []);
        return { ...merged, documents, reviews };
      }
    }
  )
);
