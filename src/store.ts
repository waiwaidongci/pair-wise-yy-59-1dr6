import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  applyCenterChange,
  createReleaseBatch,
  ingestBatch,
  migrateLegacyDocument,
  resolveConflict,
  retryFailedWrites,
  signReview
} from './merge/engine';
import { buildInitialState, demoCtx } from './merge/seed';
import { offlineBatch } from './merge/demoBatches';
import type {
  Classification,
  ConflictDecision,
  DisclosureRecord,
  ImportBatch,
  MergeState,
  Redaction
} from './merge/types';

const CENTER_OPERATOR = '林清（中心质控）';

/** 演示：让外聘新增区域 R-10 的首次中心写入失败，合并后可从失败项重试 */
const FAIL_FIRST_IMPORT = new Set(['DOC-00418:import-region:R-10']);

type MergeStore = MergeState & {
  activeDocumentId: string;
  activePage: number;
  activeRedactionId: string | null;
  redactionMode: boolean;
  lastNotice: string | null;
  selectDocument: (id: string) => void;
  setPage: (page: number) => void;
  toggleRedactionMode: () => void;
  selectRedaction: (id: string | null) => void;
  addRedaction: (redaction: Omit<Redaction, 'id' | 'status' | 'version' | 'changedBy' | 'source'>) => void;
  confirmRedaction: (id: string) => void;
  updateClassification: (classification: Classification) => void;
  /** 演示场景：中心在外聘离线期间先改动，制造"同一区域两边都改过" */
  simulateCenterDrift: () => void;
  ingestDemoBatch: () => void;
  retryWrites: (writeIds: string[] | 'all') => void;
  adjudicate: (conflictId: string, decision: ConflictDecision) => void;
  signReviewById: (reviewId: string, conclusion: string) => void;
  publish: (name: string, docIds: string[]) => string | null;
  resetDemo: () => void;
  clearNotice: () => void;
};

function activeDoc(state: MergeStore): DisclosureRecord {
  return state.documents.find((d) => d.id === state.activeDocumentId) ?? state.documents[0];
}

let localRegionCounter = 100;

export const useMergeStore = create<MergeStore>()(
  persist(
    (set, get) => ({
      ...buildInitialState(),
      activeDocumentId: 'DOC-00418',
      activePage: 1,
      activeRedactionId: null,
      redactionMode: false,
      lastNotice: null,

      selectDocument: (id) => set({ activeDocumentId: id, activePage: 1, activeRedactionId: null, redactionMode: false }),
      setPage: (page) => set({ activePage: page }),
      toggleRedactionMode: () => set((s) => ({ redactionMode: !s.redactionMode })),
      selectRedaction: (id) => set({ activeRedactionId: id }),

      addRedaction: (redaction) => {
        const s = get();
        const docId = s.activeDocumentId;
        const region: Redaction = {
          ...redaction,
          id: `R-LOCAL-${localRegionCounter++}`,
          status: 'draft',
          version: 1,
          changedBy: CENTER_OPERATOR,
          source: 'center'
        };
        const next = applyCenterChange(s, docId, { kind: 'region', region, operator: CENTER_OPERATOR, mode: 'add' }, demoCtx);
        set({ ...next, activeRedactionId: region.id, lastNotice: `区域 ${region.id} 已作为中心修改写入，文档版本推进，关联未完成复核已失效重算。` });
      },

      confirmRedaction: (id) => {
        const s = get();
        const doc = activeDoc(s);
        const existing = doc.redactions.find((r) => r.id === id);
        if (!existing || existing.status === 'confirmed') return;
        // 确认区域也是一次中心区域修改（status 进入指纹）
        const next = applyCenterChange(s, doc.id, {
          kind: 'region',
          region: { ...existing, status: 'confirmed' },
          operator: CENTER_OPERATOR,
          mode: 'edit'
        }, demoCtx);
        set({ ...next });
      },

      updateClassification: (classification) => {
        const s = get();
        const doc = activeDoc(s);
        const next = applyCenterChange(s, doc.id, { kind: 'classification', classification, operator: CENTER_OPERATOR }, demoCtx);
        set({ ...next, lastNotice: `密级已调整为「${classification}」：密级版本推进，未完成复核失效并按新内容重算，已签复核保留当时依据。` });
      },

      simulateCenterDrift: () => {
        const s = get();
        const doc = s.documents.find((d) => d.id === 'DOC-00418');
        const r02 = doc?.redactions.find((r) => r.id === 'R-02');
        if (!doc || !r02) return;
        // 中心在外聘离线基线（v1）之上也改 R-02 → 导入时两边都改过
        let next = applyCenterChange(s, doc.id, {
          kind: 'region',
          region: { ...r02, reason: '个人手机号（中心扩框）', width: 0.40, height: 0.07 },
          operator: CENTER_OPERATOR,
          mode: 'edit'
        }, demoCtx);
        // 中心同时把 DOC-00427 密级从机密改成严格机密 → 密级双改
        const d427 = next.documents.find((d) => d.id === 'DOC-00427')!;
        next = applyCenterChange(next, d427.id, {
          kind: 'classification',
          classification: '严格机密',
          operator: CENTER_OPERATOR
        }, demoCtx);
        set({
          ...next,
          lastNotice: '已模拟中心在外聘离线期间的变化：R-02 中心改框；DOC-00427 密级改为严格机密。关联的未完成复核已失效重算。'
        });
      },

      ingestDemoBatch: () => {
        const s = get();
        const batch: ImportBatch = { ...offlineBatch(), importedAt: demoCtx.now() };
        const existing = s.batches.find((b) => b.batchId === batch.batchId);
        if (existing) {
          // 同批复传沿用第一次结果
          set({
            ...s,
            batches: s.batches.map((b) => b.batchId === batch.batchId
              ? { ...b, result: 'retransmitted-reused', reusedFromBatchId: b.batchId }
              : b),
            lastNotice: `导入批 ${batch.batchId} 为同批复传：沿用第一次合并结果，不重复写入、不重复盖写。`
          });
          return;
        }
        const outcome = ingestBatch(s, batch, demoCtx, FAIL_FIRST_IMPORT);
        set({
          ...outcome.state,
          lastNotice: outcome.writes.some((w) => w.status === 'failed')
            ? `导入批 ${batch.batchId} 已合并：${outcome.conflicts.length} 项双改冲突待裁决，1 个中心写入失败，可从失败项重试。`
            : `导入批 ${batch.batchId} 已合并，产生 ${outcome.conflicts.length} 项冲突待逐项裁决。`
        });
      },

      retryWrites: (writeIds) => {
        const s = get();
        const batch = offlineBatch();
        const before = s.writes.filter((w) => w.status === 'failed').length;
        const next = retryFailedWrites(s, batch, writeIds, demoCtx);
        const after = next.writes.filter((w) => w.status === 'failed').length;
        set({ ...next, lastNotice: `失败项重试完成：失败写入 ${before} → ${after}，已成功项未重复执行。` });
      },

      adjudicate: (conflictId, decision) => {
        const s = get();
        const next = resolveConflict(s, conflictId, decision, CENTER_OPERATOR, demoCtx);
        const label = decision === 'adopt-center' ? '采用中心版' : decision === 'adopt-remote' ? '采用外聘版' : '双方保留';
        set({ ...next, lastNotice: `冲突已逐项裁决（${label}），双方内容与来源都保留在版本历史中。` });
      },

      signReviewById: (reviewId, conclusion) => {
        const s = get();
        const next = signReview(s, reviewId, CENTER_OPERATOR, conclusion, demoCtx);
        set({ ...next, lastNotice: '复核已签核，签核时的文档/区域/密级版本依据已冻结。' });
      },

      publish: (name, docIds) => {
        const s = get();
        const result = createReleaseBatch(s, name, docIds, CENTER_OPERATOR, demoCtx);
        if ('error' in result) {
          set({ lastNotice: `发布门禁未通过：${result.error}` });
          return result.error;
        }
        set({ ...result, lastNotice: `发布批次「${name}」已生成，冻结了各文档的文档/区域/密级版本。` });
        return null;
      },

      resetDemo: () => {
        const fresh = buildInitialState();
        set({
          ...fresh,
          activeDocumentId: 'DOC-00418',
          activePage: 1,
          activeRedactionId: null,
          redactionMode: false,
          lastNotice: '演示数据已重置：DOC-00418 恢复为无版本号旧草稿，重新加载时会补成首版。'
        });
      },

      clearNotice: () => set({ lastNotice: null })
    }),
    {
      name: 'yy59-disclosure-draft',
      version: 2,
      // 旧版持久化（v1：无版本号的 documents 数组）迁移为 MergeState；
      // 缺版本号的文档/区域在 migrateLegacyDocument 中补成首版，原区域与复核记录保留。
      migrate: (persisted: unknown, version: number): MergeStore => {
        const fresh = buildInitialState();
        const base = {
          ...fresh,
          activeDocumentId: 'DOC-00418',
          activePage: 1,
          activeRedactionId: null,
          redactionMode: false,
          lastNotice: null
        } as MergeStore;
        if (!persisted || typeof persisted !== 'object') return base;
        const p = persisted as Record<string, unknown>;
        if (version < 2 && Array.isArray(p.documents)) {
          const docs = (p.documents as Record<string, unknown>[]).map((d) =>
            migrateLegacyDocument(d as never, demoCtx)
          );
          return { ...base, documents: docs };
        }
        if (Array.isArray(p.documents)) {
          return { ...base, ...(persisted as Partial<MergeStore>) } as MergeStore;
        }
        return base;
      }
    }
  )
);
