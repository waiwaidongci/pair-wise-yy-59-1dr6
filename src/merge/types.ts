// 可恢复合并流程的核心领域模型：
// 文档 / 去密区域 / 复核结论全部带版本号，所有变化写入 append-only 历史，
// 导入批（ImportBatch）做三方合并，双改项以冲突形式保留双方来源，逐项裁决后才能发布。

export type Classification = '内部' | '机密' | '严格机密';

export const REVIEW_CHECKS = [
  '全文禁词与姓名复核',
  '页序与页码连续性',
  '图像边界残片',
  '文档元数据清理'
] as const;

export type CheckLabel = (typeof REVIEW_CHECKS)[number];

export type RegionStatus = 'draft' | 'confirmed';

export type RegionSource = 'center' | 'remote' | 'adopted-remote' | 'adopted-center' | 'kept-both';

export type Redaction = {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  reason: string;
  privilege: string;
  status: RegionStatus;
  /** 区域版本（seq），每次该区域被修改都 +1；旧草稿迁移时补为 1 */
  version: number;
  /** 最近一次改动来源：本机 / 外聘复核员 / 裁决采用 */
  changedBy: string;
  source: RegionSource;
};

/** 复核依据：冻结签核当时的版本快照，事后中心再变也不覆盖它 */
export type ReviewBasis = {
  docVersion: number;
  regionSeq: number;
  classification: Classification;
};

export type ReviewStatus = 'pending' | 'signed' | 'invalid';

/** 同一条复核线索在版本演进中形成的链表；未完成的旧一环 invalid，新一环 pending 重算 */
export type Review = {
  id: string;
  docId: string;
  check: CheckLabel;
  status: ReviewStatus;
  operator: string;
  /** 外聘复核号：同批复传按此幂等，沿用第一次结果 */
  reviewNo?: string;
  batchId?: string;
  basis?: ReviewBasis;
  conclusion?: string;
  /** 签核时依据相对当前内容是否已经过期（内容已变，但当时依据保留可查） */
  basisStale?: boolean;
  note?: string;
  invalidReason?: string;
  supersededBy?: string;
  createdAt: string;
  signedAt?: string;
};

export type DocStatus = '去密中' | '待质检' | '可发布';

export type DisclosureRecord = {
  id: string;
  title: string;
  bundle: string;
  pages: number;
  classification: Classification;
  /** 文档密级版本：中心修改或导入改密级时 +1 */
  classVersion: number;
  /** 文档内容版本：任一区域增删改 / 密级变化都会推进 */
  docVersion: number;
  owner: string;
  updatedAt: string;
  status: DocStatus;
  issue: string;
  size: string;
  redactions: Redaction[];
  /** 全部区域版本聚合号：区域集合任一次变化都 +1，用于复核依据 */
  regionSeq: number;
  /** 已签过的复核记录即使依据过期也保留，继续可查 */
  reviews: Review[];
  /** append-only 的版本轨迹（文档 / 区域 / 密级 / 复核 / 裁决） */
  history: HistoryEvent[];
};

export type HistoryEvent = {
  at: string;
  operator: string;
  batchId?: string;
  kind:
    | 'seed'
    | 'legacy-bootstrap'
    | 'import'
    | 'class-center'
    | 'class-remote'
    | 'region-add-center'
    | 'region-add-remote'
    | 'region-edit-center'
    | 'region-edit-remote'
    | 'region-confirm'
    | 'review-sign'
    | 'review-invalidated'
    | 'review-recompute'
    | 'review-imported'
    | 'conflict-open'
    | 'conflict-resolve';
  message: string;
  /** 与事件同时冻结的区域 / 密级快照，供合并时找回"离线基线"与事后回查 */
  regionSnapshots?: RegionSnap[];
  basis?: ReviewBasis;
  conflictId?: string;
};

export type RegionSnap = {
  id: string;
  signature: string;
  version: number;
  source: RegionSource;
};

/** 区域内容指纹：坐标、原因、特权标签、状态任一不同即视为内容变化 */
export type RegionSignature = Pick<Redaction, 'page' | 'x' | 'y' | 'width' | 'height' | 'reason' | 'privilege' | 'status'>;

export type ConflictStatus = 'open' | 'resolved';
export type ConflictKind = 'region-both-edited' | 'classification';
export type ConflictDecision = 'adopt-center' | 'adopt-remote' | 'keep-both';

export type Conflict = {
  id: string;
  docId: string;
  kind: ConflictKind;
  regionId?: string;
  status: ConflictStatus;
  /** 中心侧内容与来源 */
  center: {
    label: string;
    signature?: string;
    region?: Redaction;
    classification?: Classification;
    classVersion?: number;
    operator: string;
    at: string;
  };
  /** 外聘复核员侧内容与来源 */
  remote: {
    label: string;
    signature?: string;
    region?: Redaction;
    classification?: Classification;
    classVersion?: number;
    operator: string;
    at: string;
  };
  decision?: ConflictDecision;
  decidedBy?: string;
  decidedAt?: string;
  /** keep-both 裁决后，远端副本占用的新区域 id */
  remoteTwinId?: string;
};

export type ImportedRegion = RegionSignature & {
  /** 外聘复核员离线时所基于的区域版本；新绘制区域为 0 */
  baseVersion?: number;
  id?: string;
};

export type ImportedReview = {
  check: CheckLabel;
  status: Extract<ReviewStatus, 'pending' | 'signed'>;
  operator: string;
  reviewNo: string;
  basis: ReviewBasis;
  conclusion?: string;
  note?: string;
  signedAt?: string;
};

export type ImportItem = {
  docId: string;
  docVersion: number;
  /** 整批区域版本号，随批携带 */
  regionVersion: number;
  classification: Classification;
  classVersion: number;
  /** 外聘导出时中心的密级版本与密级值（离线基线），用于三方判断中心是否也改过 */
  baseClassVersion?: number;
  baseClassification?: Classification;
  redactions: ImportedRegion[];
  reviews: ImportedReview[];
};

/** 外聘复核员回中心合并的导入批：带文档版本、区域版本、操作者和复核号 */
export type ImportBatch = {
  batchId: string;
  operator: string;
  exportedAt: string;
  importedAt: string;
  items: ImportItem[];
};

export type WriteKind =
  | 'import-region'
  | 'import-class'
  | 'import-review'
  | 'review-invalidate'
  | 'conflict-adjudication';

export type WriteStatus = 'pending' | 'succeeded' | 'failed';

/** 中心写入账单项；失败后只重试失败项 */
export type WriteItem = {
  id: string;
  batchId: string;
  docId: string;
  kind: WriteKind;
  refId?: string;
  summary: string;
  status: WriteStatus;
  attempts: number;
  lastError?: string;
  at: string;
};

export type ReleaseBatch = {
  id: string;
  name: string;
  docIds: string[];
  frozen: {
    docId: string;
    docVersion: number;
    regionSeq: number;
    classVersion: number;
  }[];
  operator: string;
  createdAt: string;
};

export type MergeState = {
  documents: DisclosureRecord[];
  conflicts: Conflict[];
  /** 已受理的导入批（含同批复传沿用第一次结果的判定记录） */
  batches: BatchRecord[];
  writes: WriteItem[];
  releases: ReleaseBatch[];
};

export type BatchRecord = {
  batchId: string;
  operator: string;
  importedAt: string;
  /** 首次受理 / 复传幂等沿用 */
  result: 'accepted' | 'retransmitted-reused';
  firstReceivedAt: string;
  reusedFromBatchId?: string;
  itemCount: number;
  conflictCount: number;
};

export type EngineCtx = {
  now: () => string;
  nextId: (prefix: string) => string;
};

/** 发布门禁逐项阻塞原因 */
export type ReleaseBlocker = {
  docId: string;
  reasons: string[];
};
