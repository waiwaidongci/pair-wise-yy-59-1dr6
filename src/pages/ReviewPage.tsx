import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, Check, ChevronLeft, ChevronRight, ClipboardCheck, Copy, FileCheck2, Highlighter } from 'lucide-react';
import { Badge, Button, Dialog, X as XIcon } from '../components/ui';
import { PdfPage } from '../components/PdfPage';
import { SourceBadge, VersionLine, classTone, sourceMeta } from '../components/shared';
import { useMergeStore } from '../store';
import type { Classification } from '../merge/types';

export function ReviewPage() {
  const { documentId } = useParams({ from: '/review/$documentId' });
  const navigate = useNavigate();
  const documents = useMergeStore((s) => s.documents);
  const activePage = useMergeStore((s) => s.activePage);
  const redactionMode = useMergeStore((s) => s.redactionMode);
  const activeRedactionId = useMergeStore((s) => s.activeRedactionId);
  const setPage = useMergeStore((s) => s.setPage);
  const toggleRedactionMode = useMergeStore((s) => s.toggleRedactionMode);
  const addRedaction = useMergeStore((s) => s.addRedaction);
  const confirmRedaction = useMergeStore((s) => s.confirmRedaction);
  const selectRedaction = useMergeStore((s) => s.selectRedaction);
  const updateClassification = useMergeStore((s) => s.updateClassification);
  const doc = documents.find((item) => item.id === documentId) ?? documents[0];
  const pageRegions = doc.redactions.filter((item) => item.page === activePage);
  const active = doc.redactions.find((item) => item.id === activeRedactionId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState('商业秘密');
  const [privilege, setPrivilege] = useState('合同保密');
  const pendingCount = doc.reviews.filter((r) => r.status === 'pending').length;

  return (
    <div className="page review-page">
      <header className="review-header">
        <div className="review-title">
          <Button variant="ghost" onClick={() => navigate({ to: '/' })}><ArrowLeft size={16} /></Button>
          <div><small>{doc.id} / 去密审阅</small><h1>{doc.title}</h1></div>
          <Badge tone={classTone(doc.classification)}>{doc.classification} v{doc.classVersion}</Badge>
          <VersionLine doc={doc} />
        </div>
        <div className="review-actions">
          <Button variant="outline" onClick={toggleRedactionMode} className={redactionMode ? 'active-button' : ''}><Highlighter size={16} /> {redactionMode ? '取消绘制' : '绘制去密区'}</Button>
          <Button variant="outline" onClick={() => setDialogOpen(true)}><FileCheck2 size={16} /> 发布前校验</Button>
          <Link to="/quality"><Button><ClipboardCheck size={16} /> 去复核结论</Button></Link>
        </div>
      </header>
      <div className="review-layout">
        <aside className="page-thumbs">
          <div className="side-label">页级预览 <span>{doc.pages} 页</span></div>
          {Array.from({ length: doc.pages }, (_, i) => i + 1).map((page) => (
            <button key={page} className={activePage === page ? 'active' : ''} onClick={() => setPage(page)}>
              <div className="mini-page"><span>{page}</span><i style={{ width: `${45 + page * 9}%` }} /><i style={{ width: `${70 - page * 5}%` }} /><i style={{ width: `${55 + page * 4}%` }} /></div>
              <small>第 {page} 页</small>
            </button>
          ))}
        </aside>
        <section className="viewer-column">
          <div className="viewer-toolbar">
            <div><button onClick={() => setPage(Math.max(1, activePage - 1))} disabled={activePage === 1}><ChevronLeft size={16} /></button><strong>{activePage} / {doc.pages}</strong><button onClick={() => setPage(Math.min(doc.pages, activePage + 1))} disabled={activePage === doc.pages}><ChevronRight size={16} /></button></div>
            <span>原页 · 掩码叠加 · 区域带版本与来源</span>
          </div>
          <div className="pdf-stage">
            <PdfPage
              pageNumber={activePage}
              onDraw={redactionMode ? (region) => addRedaction({ ...region, page: activePage, reason, privilege }) : undefined}
            />
            {pageRegions.map((region) => (
              <button
                key={region.id}
                className={`redaction-region ${region.status} region-${region.source} ${activeRedactionId === region.id ? 'selected' : ''}`}
                style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
                onClick={() => selectRedaction(region.id)}
                title={`${region.reason} / ${region.privilege} / v${region.version} / ${sourceMeta[region.source].label}`}
              />
            ))}
          </div>
        </section>
        <aside className="inspector">
          <div className="side-label">区域属性 <span>版本化</span></div>
          {active ? (
            <>
              <div className="inspector-title"><strong>{active.reason}</strong>
                <span className="inspector-badges">
                  <Badge tone={active.status === 'confirmed' ? 'green' : 'amber'}>{active.status === 'confirmed' ? '已确认' : '草稿'}</Badge>
                  <SourceBadge source={active.source} />
                </span>
              </div>
              <label>保密级别（中心修改会推进密级版本并失效未完成复核）
                <select value={doc.classification} onChange={(event) => updateClassification(event.target.value as Classification)}>
                  <option>内部</option><option>机密</option><option>严格机密</option>
                </select>
              </label>
              <label>去密原因<input value={active.reason} readOnly /></label>
              <label>特权标签<input value={active.privilege} readOnly /></label>
              <label>最近改动者<input value={active.changedBy} readOnly /></label>
              <div className="coordinate-grid"><div><span>区域版本</span><b>v{active.version}</b></div><div><span>所属页</span><b>第 {active.page} 页</b></div><div><span>宽</span><b>{Math.round(active.width * 100)}%</b></div><div><span>高</span><b>{Math.round(active.height * 100)}%</b></div></div>
              <Button onClick={() => confirmRedaction(active.id)} disabled={active.status === 'confirmed'}><Check size={15} /> 确认此区域（记一次中心版本）</Button>
              <Button variant="outline" disabled><Copy size={15} /> 批量复制到同类页</Button>
            </>
          ) : <p className="muted">在文档页面上选择一个去密区域查看版本与来源；外聘并入的区域有独立标记。</p>}
          <div className="rule-note"><AlertTriangle size={16} /><span>区域或密级一旦在中心变化，关联的未完成复核先失效并按新内容重算；已签结论保留当时依据。</span></div>
        </aside>
      </div>
      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>发布前校验</Dialog.Title>
            <Dialog.Description>系统将核对原始页与发布页的一致性，并检查版本与合并状态。</Dialog.Description>
            <div className="dialog-checks">
              <p><Check /> {doc.redactions.length} 个去密区域已定位（区域 seq{doc.regionSeq}）</p>
              <p><Check /> 文档版本 v{doc.docVersion} · 密级 v{doc.classVersion}</p>
              <p className={doc.redactions.some((item) => item.status === 'draft') ? 'failed' : ''}><AlertTriangle /> {doc.redactions.some((item) => item.status === 'draft') ? '仍有未确认区域' : '所有区域已确认'}</p>
              <p className={pendingCount > 0 ? 'failed' : ''}><AlertTriangle /> {pendingCount} 条复核待签 / 待重算</p>
            </div>
            <Dialog.Close asChild><Button>返回检查 <XIcon size={15} /></Button></Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
