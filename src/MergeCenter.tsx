import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  CloudOff,
  CloudUpload,
  GitMerge,
  History,
  RefreshCw,
  RotateCcw,
  Scale,
  ShieldCheck,
  X,
  XCircle
} from 'lucide-react';
import { Badge, Button, Card } from './components/ui';
import { useDisclosureStore, type AdjudicationChoice, type ConflictItem, type ImportBatch, type ReviewRecord } from './store';

function statusTone(status: string): 'green' | 'amber' | 'red' | 'blue' | 'neutral' {
  if (status === '已完成' || status === '已写入' || status === '已签结' || status === '有效') return 'green';
  if (status === '部分失败' || status === '写入失败' || status === '待裁决') return 'red';
  if (status === '已失效' || status === '待写入') return 'amber';
  return 'neutral';
}

function BatchCard({ batch }: { batch: ImportBatch }) {
  const store = useDisclosureStore();
  const failed = batch.items.filter((i) => i.writeStatus === '写入失败').length;
  const pending = batch.items.filter((i) => i.writeStatus === '待裁决').length;
  const written = batch.items.filter((i) => i.writeStatus === '已写入').length;
  return (
    <Card className="batch-merge-card">
      <div className="batch-merge-head">
        <div className="batch-merge-title">
          <GitMerge size={16} />
          <strong>{batch.batchNo}</strong>
          <Badge tone={batch.source === '外聘回传' ? 'blue' : 'neutral'}>{batch.source}</Badge>
          <Badge tone={statusTone(batch.batchStatus)}>{batch.batchStatus}</Badge>
        </div>
        <span className="batch-merge-meta">复核号 {batch.reviewNo} · {batch.operator} · {batch.importedAt}</span>
      </div>
      <div className="batch-merge-versions">
        <span>文档版本 <b>v{batch.docVersion}</b></span>
        <span>区域版本 <b>v{batch.regionVersion}</b></span>
        <span>写入进度 <b>{written}/{batch.items.length}</b></span>
        {failed > 0 && <span className="failed-text">失败 {failed} 项</span>}
        {pending > 0 && <span className="pending-text">待裁决 {pending} 项</span>}
      </div>
      <div className="batch-items">
        {batch.items.map((item) => (
          <div className={`batch-item ${item.writeStatus === '写入失败' ? 'failed' : item.writeStatus === '待裁决' ? 'pending' : ''}`} key={item.id}>
            <span className="batch-item-type">{item.changeType}</span>
            <span className="batch-item-target">{item.docId}{item.regionId ? ` · ${item.regionId}` : ''}</span>
            <Badge tone={statusTone(item.writeStatus)}>{item.writeStatus}</Badge>
            {item.failReason && <small className="batch-item-fail"><XCircle size={11} /> {item.failReason}</small>}
          </div>
        ))}
      </div>
      <div className="batch-merge-actions">
        {batch.batchStatus === '部分失败' && (
          <Button variant="outline" onClick={() => store.retryBatch(batch.batchNo)}><RotateCcw size={14} /> 从失败项重试（已写入 {written} 项跳过）</Button>
        )}
        <Button variant="ghost" onClick={() => store.reimportBatch(batch.batchNo)}><RefreshCw size={14} /> 同批复传</Button>
      </div>
    </Card>
  );
}

function ConflictCard({ conflict }: { conflict: ConflictItem }) {
  const store = useDisclosureStore();
  const [expanded, setExpanded] = useState(false);
  const decided = conflict.status !== '待裁决';
  const renderParty = (label: string, tone: 'center' | 'offline', party: ConflictItem['center']) => (
    <div className={`conflict-party ${tone}`}>
      <div className="conflict-party-head">
        <Badge tone={tone === 'center' ? 'neutral' : 'blue'}>{label}</Badge>
        <span>v{party.version} · {party.source}</span>
      </div>
      <strong>{party.updatedBy}</strong>
      <small>{party.updatedAt}</small>
      <pre className="conflict-party-data">{JSON.stringify(party.data, null, 2)}</pre>
    </div>
  );
  return (
    <Card className={`conflict-card ${decided ? 'decided' : ''}`}>
      <div className="conflict-head">
        <Scale size={16} />
        <strong>{conflict.docId}{conflict.regionId ? ` · ${conflict.regionId}` : ''}</strong>
        <Badge tone="red">{conflict.kind}冲突</Badge>
        <Badge tone={statusTone(conflict.status)}>{conflict.status}</Badge>
        {decided && <span className="conflict-decided-by">{conflict.adjudicatedBy} · {conflict.adjudicatedAt}</span>}
      </div>
      <div className="conflict-parties">
        {renderParty('中心版本', 'center', conflict.center)}
        {renderParty('外聘回传版本', 'offline', conflict.offline)}
      </div>
      {!decided ? (
        <div className="conflict-actions">
          <Button variant="outline" onClick={() => store.adjudicateConflict(conflict.id, '采用中心' as AdjudicationChoice)}><Check size={14} /> 采用中心版本</Button>
          <Button onClick={() => store.adjudicateConflict(conflict.id, '采用外聘' as AdjudicationChoice)}><CloudUpload size={14} /> 采用外聘版本</Button>
          <span className="conflict-note">逐项裁决后才能进入发布批次；双方版本与来源均保留可查。</span>
        </div>
      ) : (
        <div className="conflict-actions">
          <span className="conflict-note"><CheckCircle2 size={13} /> 已裁决：{conflict.status}，双方记录保留在案。</span>
        </div>
      )}
      <button className="conflict-expand" onClick={() => setExpanded(!expanded)}>
        <ChevronDown size={13} /> {expanded ? '收起' : '查看'}来源与依据
      </button>
      {expanded && (
        <div className="conflict-sources">
          <p><ShieldCheck size={13} /> 中心来源：{conflict.center.updatedBy} 于 {conflict.center.updatedAt} 修改，版本 v{conflict.center.version}。</p>
          <p><CloudOff size={13} /> 外聘来源：{conflict.offline.updatedBy} 于断网期间修改，回传批次 {conflict.batchNo}，版本 v{conflict.offline.version}。</p>
        </div>
      )}
    </Card>
  );
}

function ReviewCard({ review }: { review: ReviewRecord }) {
  const store = useDisclosureStore();
  const [showSnapshot, setShowSnapshot] = useState(false);
  const doc = store.documents.find((d) => d.id === review.docId);
  return (
    <Card className={`review-merge-card ${review.status === '已失效' ? 'invalidated' : ''}`}>
      <div className="review-merge-head">
        <strong>{review.reviewNo}</strong>
        <Badge tone={statusTone(review.status)}>{review.status}</Badge>
        {review.legacy && <Badge tone="neutral">历史补录</Badge>}
      </div>
      <div className="review-merge-meta">
        <span>{doc?.title ?? review.docId}</span>
        <span>操作者 {review.operator}</span>
        {review.batchNo && <span>来源批次 {review.batchNo}</span>}
        {review.signedAt && <span>签署于 {review.signedAt}</span>}
      </div>
      <div className="review-basis">
        <span>签署/发起依据</span>
        <b>文档 v{review.basis.docVersion}</b>
        <b>密级 {review.basis.classification}</b>
        <b>区域 {review.basis.regionCount} 个</b>
        {Object.entries(review.basis.regionVersions).slice(0, 4).map(([rid, v]) => (
          <small key={rid}>{rid} v{v}</small>
        ))}
      </div>
      {review.status === '已失效' && (
        <div className="review-invalidated">
          <AlertTriangle size={13} />
          <span>已于 {review.invalidatedAt} 因中心区域/密级变更失效</span>
          {review.recalculatedTo ? (
            <Badge tone="blue">已重算</Badge>
          ) : (
            <Button variant="outline" onClick={() => store.recalculateReview(review.id)}><RotateCcw size={13} /> 按新内容重算</Button>
          )}
        </div>
      )}
      {review.recalculatedFrom && <small className="review-link">重算来源：{review.recalculatedFrom}</small>}
      {review.recalculatedTo && <small className="review-link">已重算为：{review.recalculatedTo}</small>}
      <button className="conflict-expand" onClick={() => setShowSnapshot(!showSnapshot)}>
        <ChevronDown size={13} /> {showSnapshot ? '收起' : '查看'}依据快照
      </button>
      {showSnapshot && (
        <div className="review-snapshot">
          {review.basis.regionSnapshot.map((r) => (
            <div key={r.id} className="snapshot-row">
              <span>{r.id}</span><span>v{r.regionVersion}</span><span>{r.source}</span><span>{r.reason}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function MergeCenterPage() {
  const store = useDisclosureStore();
  const pendingConflicts = store.conflicts.filter((c) => c.status === '待裁决');
  const completedConflicts = store.conflicts.filter((c) => c.status !== '待裁决');
  return (
    <div className="page">
      <header className="page-heading">
        <div>
          <small>DISCLOSURE CONTROL / MERGE CENTER</small>
          <h1>合并回传中心</h1>
          <p>导入批带文档版本、区域版本、操作者与复核号；同批复传沿用第一次结果；冲突逐项裁决后才进入发布批次。</p>
        </div>
        <div className="merge-actions">
          <label className="fail-toggle">
            <input type="checkbox" checked={store.simulateFailures} onChange={(e) => store.setSimulateFailures(e.target.checked)} />
            <span>模拟写入失败（演示断点续传）</span>
          </label>
          <Button variant="outline" onClick={store.simulateCenterChange}><AlertTriangle size={15} /> 模拟中心密级/区域变更</Button>
          <Button onClick={store.simulateOfflineImport}><CloudUpload size={15} /> 模拟外聘断网回传</Button>
        </div>
      </header>

      {store.mergeNotice && (
        <div className="merge-notice">
          <ShieldCheck size={15} />
          <span>{store.mergeNotice}</span>
          <button onClick={store.clearMergeNotice} aria-label="关闭"><X size={14} /></button>
        </div>
      )}

      <div className="merge-grid">
        <div className="merge-col">
          <section className="merge-section">
            <div className="merge-section-title"><CloudUpload size={15} /><strong>导入批与写入队列</strong><span>{store.importBatches.length} 批</span></div>
            {store.importBatches.length === 0 && <p className="muted">暂无导入批。点击右上角「模拟外聘断网回传」生成一批带版本与复核号的回传数据。</p>}
            {store.importBatches.map((batch) => <BatchCard key={batch.batchNo} batch={batch} />)}
          </section>

          {store.conflicts.length > 0 && (
            <section className="merge-section">
              <div className="merge-section-title"><Scale size={15} /><strong>冲突裁决</strong>{pendingConflicts.length > 0 && <Badge tone="red">{pendingConflicts.length} 项待裁决</Badge>}</div>
              {pendingConflicts.map((c) => <ConflictCard key={c.id} conflict={c} />)}
              {completedConflicts.map((c) => <ConflictCard key={c.id} conflict={c} />)}
            </section>
          )}
        </div>

        <div className="merge-col">
          <section className="merge-section">
            <div className="merge-section-title"><History size={15} /><strong>复核记录与依据</strong><span>{store.reviews.length} 条</span></div>
            {store.reviews.map((review) => <ReviewCard key={review.id} review={review} />)}
          </section>
        </div>
      </div>
    </div>
  );
}
