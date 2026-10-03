import type { DisclosureRecord, MergeState } from './types';
import { migrateLegacyDocument } from './engine';

// 演示用时钟/序号，保证单机能复现完整流程
let seqCounter = 100;
export const demoCtx = {
  now: () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  },
  nextId: (prefix: string) => `${prefix.toUpperCase()}-${seqCounter++}`,
};

// 一份"旧草稿"：没有任何版本号，迁移时应补成首版且区域/记录保留可查
const legacyDoc = {
  id: 'DOC-00418',
  title: '设备采购补充协议（第三版）',
  bundle: '北岭项目 · 第一批披露',
  pages: 3,
  classification: '严格机密' as const,
  owner: '林清',
  updatedAt: '09:48',
  status: '去密中' as const,
  issue: '合同主体与商业条款',
  size: '8.4 MB',
  redactions: [
    { id: 'R-01', page: 1, x: 0.12, y: 0.16, width: 0.30, height: 0.04, reason: '商业秘密', privilege: '合同保密', status: 'confirmed' as const },
    { id: 'R-02', page: 1, x: 0.50, y: 0.43, width: 0.34, height: 0.06, reason: '个人手机号', privilege: '个人信息', status: 'draft' as const },
    { id: 'R-03', page: 2, x: 0.11, y: 0.25, width: 0.68, height: 0.05, reason: '第三方报价', privilege: '商业敏感', status: 'confirmed' as const }
  ]
};

function doc00427(): DisclosureRecord {
  return migrateLegacyDocument({
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
    classVersion: 2,
    docVersion: 3,
    regionSeq: 2,
    redactions: [
      { id: 'R-04', page: 1, x: 0.08, y: 0.69, width: 0.74, height: 0.05, reason: '内部调查意见', privilege: '工作成果', status: 'confirmed', version: 2, changedBy: '周叙', source: 'center' }
    ],
    reviews: [
      {
        id: 'RV-SIGNED-1',
        docId: 'DOC-00427',
        check: '页序与页码连续性',
        status: 'signed',
        operator: '顾言',
        basis: { docVersion: 2, regionSeq: 2, classification: '机密' },
        conclusion: '页序连续，无拆页漏页',
        createdAt: '09:20',
        signedAt: '09:31'
      }
    ],
    history: [
      { at: '09:12', operator: '周叙', kind: 'region-confirm', message: '区域 R-04 确认（内部调查意见）' },
      { at: '09:31', operator: '顾言', kind: 'review-sign', message: '复核「页序与页码连续性」签核（依据文档 v2 / 区域 seq2 / 机密）' }
    ]
  }, demoCtx);
}

function doc00435(): DisclosureRecord {
  return migrateLegacyDocument({
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
    classVersion: 1,
    docVersion: 2,
    regionSeq: 1,
    redactions: [
      { id: 'R-05', page: 2, x: 0.44, y: 0.56, width: 0.26, height: 0.04, reason: '人员姓名', privilege: '个人信息', status: 'confirmed', version: 1, changedBy: '顾言', source: 'center' }
    ],
    reviews: [],
    history: [{ at: '08:56', operator: '顾言', kind: 'seed', message: '文档进入发布批次（v2）' }]
  }, demoCtx);
}

export function buildInitialState(): MergeState {
  const migrated = migrateLegacyDocument(legacyDoc, demoCtx);
  migrated.history.unshift({ at: '09:48', operator: '林清', kind: 'seed', message: '本机草稿建立（无版本号）' });
  return {
    documents: [migrated, doc00427(), doc00435()],
    conflicts: [],
    batches: [],
    writes: [],
    releases: []
  };
}
