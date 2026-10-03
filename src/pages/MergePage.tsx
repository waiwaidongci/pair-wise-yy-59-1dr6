import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, GitMerge, History, RefreshCw, ShieldAlert, UploadCloud, Wifi } from 'lucide-react';
import { Badge, Button, Card } from '../components/ui';
import { SourceBadge, classTone } from '../components/shared';
import { useMergeStore } from '../store';
import { offlineBatch } from '../merge/demoBatches';
import type { Conflict, ConflictDecision } from '../merge/types';

const decisionMeta: Record<ConflictDecision, { label: string; variant: 'outline' | 'primary' }> = {
  'adopt-center': { label: '采用中心版', variant: 'outline' },
  'adopt-remote': { label: '采用外聘版', variant: 'outline' },
  'keep-both': { label: '双方保留', variant: 'primary' }
};

function ConflictCard({ conflict }: { conflict: Conflict }) {
  const documents = useMergeStore((s) => s.documents);
  const adjudicate = useMergeStore((s) => s.adjudicate);
  const doc = documents.find((d) => d.id === conflict.docId);
  const isClass = conflict.kind === 'classification';

  return (
    <Card className={`conflict-card ${conflict.status === 'resolved' ? 'resolved' : ''}`}>
      <div className="conflict-head">
        <div className="conflict-title">
          <ShieldAlert size={16} />
          <strong>{isClass ? '密级两边都改过' : `去密区域 ${conflict.regionId} 两边都改过`}</strong>
          <Badge tone="neutral">{conflict.docId}</Badge>
          {conflict.status === 'resolved'
            ? <Badge tone="green"><Check size={11} /> 已裁决 · {conflict.decision === 'adopt-center' ? '采中心' : conflict.decision === 'adopt-remote' ? '采外聘' : '双方保留'}</Badge>
            : <Badge tone="red">待逐项裁决</Badge>}
        </div>
      </div>
      <div className="conflict-sides">
        <div className="conflict-side center-side">
          <div className="side-cap"><Badge tone="blue">中心侧</Badge><span>{conflict.center.operator} · {conflict.center.at}</span></div>
          {isClass ? (
            <div className="side-value">
              <Badge tone={classTone(conflict.center.classification!)}>{conflict.center.classification}</Badge>
              <small>密级版本 v{conflict.center.classVersion}</small>
            </div>
          ) : (
            <div className="side-value">
              <strong>{conflict.center.region?.reason}</strong>
              <small>{conflict.center.region?.privilege} · 第 {conflict.center.region?.page} 页 · 区域 v{conflict.center.region?.version}</small>
              <small>框 {Math.round((conflict.center.region?.x ?? 0) * 100)}%,{Math.round((conflict.center.region?.y ?? 0) * 100)}% · {Math.round((conflict.center.region?.width ?? 0) * 100)}%×{Math.round((conflict.center.region?.height ?? 0) * 100)}%</small>
              {conflict.center.region && <SourceBadge source={conflict.center.region.source} />}
            </div>
          )}
        </div>
        <div className="conflict-vs">VS</div>
        <div className="conflict-side remote-side">
          <div className="side-cap"><Badge tone="amber">外聘侧</Badge><span>{conflict.remote.operator} · {conflict.remote.at}</span></div>
          {isClass ? (
            <div className="side-value">
              <Badge tone={classTone(conflict.remote.classification!)}>{conflict.remote.classification}</Badge>
              <small>外聘密级版本 v{conflict.remote.classVersion}</small>
            </div>
          ) : (
            <div className="side-value">
              <strong>{conflict.remote.region?.reason}</strong>
              <small>{conflict.remote.region?.privilege} · 第 {conflict.remote.region?.page} 页 · 基线 v{(conflict.remote.region?.version ?? 1) - 1} 上的修改</small>
              <small>框 {Math.round((conflict.remote.region?.x ?? 0) * 100)}%,{Math.round((conflict.remote.region?.y ?? 0) * 100)}% · {Math.round((conflict.remote.region?.width ?? 0) * 100)}%×{Math.round((conflict.remote.region?.height ?? 0) * 100)}%</small>
              {conflict.remote.region && <SourceBadge source="remote" />}
            </div>
          )}
        </div>
      </div>
      {conflict.status === 'open' ? (
        <div className="conflict-decide">
          <span className="muted">逐项裁决后才能进入发布批次；双方内容与来源都已留存在该文档版本历史中。</span>
          <div className="decide-buttons">
            {(Object.keys(decisionMeta) as ConflictDecision[]).map((decision) => (
              <Button key={decision} variant={decisionMeta[decision].variant} onClick={() => adjudicate(conflict.id, decision)}>
                {decisionMeta[decision].label}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="conflict-resolved-note">
          <Check size={14} />
          {conflict.decision === 'keep-both' && conflict.remoteTwinId ? `双方保留：外聘内容已复制为新区域 ${conflict.remoteTwinId}，与中心区域同页共存。` : '裁决定稿，未完成复核已按新内容失效重算。'}
          <span>裁决人 {conflict.decidedBy} · {conflict.decidedAt}</span>
        </div>
      )}
      {doc && <Link to="/review/$documentId" params={{ documentId: doc.id }} className="conflict-link">打开文档审阅 →</Link>}
    </Card>
  );
}

export function MergePage() {
  const conflicts = useMergeStore((s) => s.conflicts);
  const writes = useMergeStore((s) => s.writes);
  const batches = useMergeStore((s) => s.batches);
  const documents = useMergeStore((s) => s.documents);
  const ingestDemoBatch = useMergeStore((s) => s.ingestDemoBatch);
  const retryWrites = useMergeStore((s) => s.retryWrites);
  const [docFilter, setDocFilter] = useState<string>('all');

  const batch = offlineBatch();
  const openConflicts = conflicts.filter((c) => c.status === 'open');
  const resolvedConflicts = conflicts.filter((c) => c.status === 'resolved');
  const failedWrites = writes.filter((w) => w.status === 'failed');
  const succeededWrites = writes.filter((w) => w.status === 'succeeded');
  const alreadyImported = batches.some((b) => b.batchId === batch.batchId);
  const shownConflicts = docFilter === 'all' ? [...openConflicts, ...resolvedConflicts] : [...openConflicts, ...resolvedConflicts].filter((c) => c.docId === docFilter);

  return (
    <div className="page merge-page">
      <header className="page-heading">
        <div><small>RECOVERABLE MERGE / THREE-WAY</small><h1>断网清单回中心合并</h1><p>导入批带文档版本、区域版本、操作者与复核号；同批复传沿用第一次结果；中心变化先失效重算未完成复核，双改项保留双方逐项裁决。</p></div>
        <Button onClick={ingestDemoBatch}><UploadCloud size={16} /> {alreadyImported ? '同批复传（幂等沿用）' : '受理外聘导入批'}</Button>
      </header>

      <div className="merge-grid">
        <div className="merge-main">
          <Card className="import-manifest">
            <div className="card-title"><Wifi size={17} /><strong>导入批清单</strong>{alreadyImported ? <Badge tone="green">已受理</Badge> : <Badge tone="amber">待受理</Badge>}</div>
            <div className="manifest-meta">
              <div><span>批号</span><b>{batch.batchId}</b></div>
              <div><span>操作者</span><b>{batch.operator}</b></div>
              <div><span>导出时间</span><b>{batch.exportedAt}</b></div>
              <div><span>文档项</span><b>{batch.items.length} 份</b></div>
            </div>
            {batch.items.map((item) => (
              <div className="manifest-item" key={item.docId}>
                <div className="manifest-item-head">
                  <strong>{item.docId}</strong>
                  <span className="version-line"><b>文档 v{item.docVersion}</b><b>区域 seq{item.regionVersion}</b><b>密级 v{item.classVersion}</b></span>
                </div>
                <div className="manifest-tags">
                  <Badge tone={classTone(item.classification)}>密级 {item.classification}</Badge>
                  <Badge tone="amber">{item.redactions.length} 个区域变更</Badge>
                  {item.reviews.map((r) => <Badge key={r.reviewNo} tone="neutral">复核号 {r.reviewNo} · {r.status === 'signed' ? '已签' : '未完成'}</Badge>)}
                </div>
              </div>
            ))}
            <p className="muted manifest-note">再次点"同批复传"不会重复写入或盖写——按批号找到第一次受理结果直接沿用。</p>
          </Card>

          <section className="conflict-section">
            <div className="section-head">
              <h2><GitMerge size={17} /> 冲突逐项裁决 <small>{openConflicts.length} 待裁 / {resolvedConflicts.length} 已裁</small></h2>
              <select value={docFilter} onChange={(e) => setDocFilter(e.target.value)}>
                <option value="all">全部文档</option>
                {documents.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
              </select>
            </div>
            {shownConflicts.length === 0 && (
              <Card className="empty-card">
                <GitMerge size={22} />
                <p>暂无冲突。可先在文档集点"模拟中心离线期变化"，再"受理导入批"，即可复现区域双改与密级双改冲突。</p>
              </Card>
            )}
            {shownConflicts.map((conflict) => <ConflictCard key={conflict.id} conflict={conflict} />)}
          </section>

          <Card className="writes-card">
            <div className="card-title"><RefreshCw size={17} /><strong>中心写入账本（可从失败项重试）</strong>
              <span>{succeededWrites.length} 成功 · {failedWrites.length} 失败</span>
            </div>
            {failedWrites.length > 0 && (
              <div className="retry-bar">
                <Badge tone="red">{failedWrites.length} 项写入失败</Badge>
                <span className="muted">重试只执行失败项，已成功项不重复落地。</span>
                <Button onClick={() => retryWrites('all')}><RefreshCw size={14} /> 一键重试全部失败项</Button>
              </div>
            )}
            <div className="writes-list">
              {writes.slice().reverse().map((w) => (
                <div key={w.id} className={`write-row ${w.status}`}>
                  <span className="write-status">{w.status === 'succeeded' ? <Check size={13} /> : <ShieldAlert size={13} />}</span>
                  <div className="write-body">
                    <strong>{w.summary}</strong>
                    <small>{w.id} · {w.docId} · {w.batchId} · 第 {w.attempts} 次尝试{w.lastError ? ` · ${w.lastError}` : ''}</small>
                  </div>
                  {w.status === 'failed' && <Button variant="outline" onClick={() => retryWrites([w.id])}>重试此项</Button>}
                </div>
              ))}
              {writes.length === 0 && <p className="muted">还没有写入记录。受理导入批后，每个区域 / 密级 / 复核写入都会在这里入账。</p>}
            </div>
          </Card>
        </div>

        <aside className="merge-side">
          <Card className="batches-card">
            <div className="card-title"><History size={17} /><strong>受理记录</strong></div>
            {batches.length === 0 && <p className="muted">尚未受理导入批。</p>}
            {batches.map((b) => (
              <div className="batch-record" key={b.batchId + b.importedAt}>
                <div><strong>{b.batchId}</strong><span>{b.operator}</span></div>
                <div className="batch-record-tags">
                  <Badge tone={b.result === 'accepted' ? 'green' : 'amber'}>{b.result === 'accepted' ? '首次受理' : '复传 · 沿用首次结果'}</Badge>
                  <Badge tone="neutral">{b.itemCount} 项 / {b.conflictCount} 冲突</Badge>
                </div>
                <small>{b.importedAt}</small>
              </div>
            ))}
          </Card>

          <Card className="rules-card">
            <div className="card-title"><GitMerge size={17} /><strong>合并规则</strong></div>
            <ul>
              <li>导入批带 <b>文档版本 / 区域版本 / 操作者 / 复核号</b>。</li>
              <li>同批复传按批号幂等，<b>沿用第一次结果</b>。</li>
              <li>中心区域或密级变化后，关联的<b>未完成复核先失效并按新内容重算</b>。</li>
              <li><b>已签复核保留当时依据</b>，只标记依据过期，结论不被盖回。</li>
              <li>同一区域 / 密级两边都改过：<b>保留双方和来源</b>，逐项裁决。</li>
              <li>裁决完成前文档<b>不能进入发布批次</b>。</li>
              <li>写入失败后<b>只从失败项重试</b>，成功项不重复。</li>
              <li>旧草稿无版本号时<b>补成首版</b>，原区域与复核记录继续可查。</li>
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}
