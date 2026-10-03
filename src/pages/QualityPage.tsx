import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Check, Eye, FileCheck2, History, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card } from '../components/ui';
import { PdfPage } from '../components/PdfPage';
import { ReviewStatusBadge, VersionLine, classTone } from '../components/shared';
import { useMergeStore } from '../store';
import type { Review } from '../merge/types';

function ReviewChain({ docId, review }: { docId: string; review: Review }) {
  const documents = useMergeStore((s) => s.documents);
  const signReviewById = useMergeStore((s) => s.signReviewById);
  const doc = documents.find((d) => d.id === docId)!;
  const successor = review.supersededBy ? doc.reviews.find((r) => r.id === review.supersededBy) : undefined;
  const [conclusion, setConclusion] = useState('按新版本复核通过');

  return (
    <div className={`review-chain-item ${review.status}`}>
      <div className="review-chain-head">
        <strong>{review.check}</strong>
        <ReviewStatusBadge review={review} />
      </div>
      <div className="review-chain-meta">
        <span>{review.id}{review.reviewNo ? ` · 复核号 ${review.reviewNo}` : ''}</span>
        <span>{review.operator}</span>
        {review.signedAt && <span>签于 {review.signedAt}</span>}
      </div>
      {review.basis && (
        <div className="review-basis">
          签核依据冻结：<b>文档 v{review.basis.docVersion}</b> · <b>区域 seq{review.basis.regionSeq}</b> · <b>{review.basis.classification}</b>
          {review.basisStale && <em>（相对当前已过期，结论仍按当时依据保留）</em>}
        </div>
      )}
      {review.conclusion && <p className="review-conclusion">结论：{review.conclusion}</p>}
      {review.status === 'invalid' && <p className="review-invalid-reason">失效原因：{review.invalidReason} · 已生成重算项 {review.supersededBy}</p>}
      {review.status === 'pending' && (
        <div className="review-sign">
          <input value={conclusion} onChange={(e) => setConclusion(e.target.value)} placeholder="填写复核结论" />
          <Button onClick={() => signReviewById(review.id, conclusion)}><Check size={14} /> 签核（冻结当前版本依据）</Button>
        </div>
      )}
      {successor && (
        <div className="review-successor">
          <span>↓ 后继重算</span>
          <ReviewChain docId={docId} review={successor} />
        </div>
      )}
    </div>
  );
}

export function QualityPage() {
  const documents = useMergeStore((s) => s.documents);
  const conflicts = useMergeStore((s) => s.conflicts);
  const writes = useMergeStore((s) => s.writes);
  const [selectedId, setSelectedId] = useState(documents[1]?.id ?? documents[0].id);
  const doc = documents.find((d) => d.id === selectedId) ?? documents[0];
  const docConflicts = conflicts.filter((c) => c.docId === doc.id);
  const openConflicts = docConflicts.filter((c) => c.status === 'open').length;
  const failed = writes.filter((w) => w.docId === doc.id && w.status === 'failed').length;
  const pending = doc.reviews.filter((r) => r.status === 'pending').length;
  const signed = doc.reviews.filter((r) => r.status === 'signed').length;
  const invalid = doc.reviews.filter((r) => r.status === 'invalid').length;
  // 展示链头：未被其它记录指向的复核
  const supersededIds = new Set(doc.reviews.map((r) => r.supersededBy).filter(Boolean));
  const chainHeads = doc.reviews.filter((r) => !supersededIds.has(r.id));

  return (
    <div className="page">
      <header className="page-heading">
        <div><small>QUALITY ASSURANCE / VERSIONED REVIEW</small><h1>复核结论与失效重算链</h1><p>中心内容变化后未完成复核失效并按新内容重算；已签结论冻结当时依据，事后可查但不被盖回。</p></div>
        <Link to="/batches"><Button><FileCheck2 size={16} /> 去发布批次</Button></Link>
      </header>

      <div className="quality-doc-tabs">
        {documents.map((d) => {
          const dPending = d.reviews.filter((r) => r.status === 'pending').length;
          return (
            <button key={d.id} className={d.id === doc.id ? 'active' : ''} onClick={() => setSelectedId(d.id)}>
              <strong>{d.id}</strong>
              <span>{d.title}</span>
              {dPending > 0 && <i className="tab-dot">{dPending}</i>}
            </button>
          );
        })}
      </div>

      <div className="comparison-banner">
        <div><Eye size={17} /><strong>{doc.title}</strong><VersionLine doc={doc} /></div>
        <div className="banner-badges">
          <Badge tone={classTone(doc.classification)}>{doc.classification}</Badge>
          {openConflicts > 0 ? <Badge tone="red">{openConflicts} 冲突未裁</Badge> : <Badge tone="green">冲突已清</Badge>}
          {pending > 0 ? <Badge tone="amber">{pending} 待签 / 重算中</Badge> : <Badge tone="green">复核链全部签核</Badge>}
        </div>
      </div>

      <div className="compare-grid">
        <Card className="compare-panel"><div className="compare-head"><span>原始页</span><Badge tone="neutral">源文件</Badge></div><div className="compare-page"><PdfPage pageNumber={1} /></div></Card>
        <Card className="compare-panel"><div className="compare-head"><span>发布页</span><Badge tone="green">已遮蔽</Badge></div><div className="compare-page redacted-preview"><PdfPage pageNumber={1} redacted /><div className="demo-mask mask-one" /><div className="demo-mask mask-two" /></div></Card>
      </div>

      <div className="quality-bottom quality-bottom-v2">
        <Card className="review-chain-card">
          <div className="card-title"><History size={17} /><strong>复核记录链（失效 / 重算 / 签核全程保留）</strong><span>{signed} 已签 · {invalid} 失效留痕 · {pending} 待签</span></div>
          {chainHeads.length === 0 && <p className="muted">该文档尚无复核记录。外聘导入批合并后这里会出现带复核号的签核或重算链。</p>}
          {chainHeads.map((review) => <ReviewChain key={review.id} docId={doc.id} review={review} />)}
        </Card>

        <Card className="decision-card">
          <div className="card-title"><ShieldCheck size={17} /><strong>发布门禁预检</strong></div>
          <GateRow ok={openConflicts === 0} label={openConflicts === 0 ? '冲突已逐项裁决' : `${openConflicts} 项冲突未裁决，不能发布`} />
          <GateRow ok={failed === 0} label={failed === 0 ? '中心写入全部成功' : `${failed} 个失败写入，须从失败项重试`} />
          <GateRow ok={pending === 0} label={pending === 0 ? '未完成复核均已签核' : `${pending} 条复核待签 / 待重算签核`} />
          <GateRow ok={!doc.redactions.some((r) => r.status === 'draft')} label={doc.redactions.some((r) => r.status === 'draft') ? '仍有草稿区域' : '区域均已确认'} />
          <div className="decision-hint">
            <AlertTriangle size={15} />
            <span>已签但依据过期的复核不阻塞发布：它保留的是当时依据下的结论；内容已变的部分由重算后继项把关。</span>
          </div>
          {(openConflicts > 0 || failed > 0) && <Link to="/merge"><Button variant="outline">去合并台处理</Button></Link>}
        </Card>
      </div>
    </div>
  );
}

function GateRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`gate-row ${ok ? 'ok' : 'block'}`}>
      <span>{ok ? <Check size={14} /> : <AlertTriangle size={14} />}</span>
      <strong>{label}</strong>
    </div>
  );
}
