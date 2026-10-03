import { useState } from 'react';
import { AlertTriangle, Check, Layers3, Lock, Tags } from 'lucide-react';
import { Badge, Button, Card } from '../components/ui';
import { VersionLine } from '../components/shared';
import { evaluateRelease } from '../merge/engine';
import { useMergeStore } from '../store';

export function BatchesPage() {
  const documents = useMergeStore((s) => s.documents);
  const releases = useMergeStore((s) => s.releases);
  const conflicts = useMergeStore((s) => s.conflicts);
  const writes = useMergeStore((s) => s.writes);
  const publish = useMergeStore((s) => s.publish);
  const [selected, setSelected] = useState<string[]>(documents.map((d) => d.id));
  const [batchName, setBatchName] = useState('第三批披露 · 合并后发布');
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => setSelected((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const gate = evaluateRelease(useMergeStore.getState(), selected);

  const doPublish = () => {
    const err = publish(batchName, selected);
    setError(err);
  };

  return (
    <div className="page">
      <header className="page-heading">
        <div><small>RELEASE BATCH / GATED</small><h1>发布批次与标签</h1><p>只有冲突逐项裁决、失败写入重试成功、未完成复核全部签核后，文档才能进入发布批次；批次冻结各文档版本。</p></div>
        <Button onClick={doPublish} disabled={selected.length === 0}><Lock size={15} /> 生成发布包（通过门禁后）</Button>
      </header>

      {!gate.ok && (
        <Card className="gate-block-card">
          <div className="gate-block-head"><AlertTriangle size={16} /><strong>发布门禁未通过</strong></div>
          {gate.blockers.map((b) => {
            const doc = documents.find((d) => d.id === b.docId);
            return (
              <div className="gate-block-item" key={b.docId}>
                <Badge tone="red">{b.docId}</Badge>
                <span>{doc?.title}</span>
                <ul>{b.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              </div>
            );
          })}
        </Card>
      )}
      {gate.ok && selected.length > 0 && (
        <Card className="gate-ok-card"><Check size={16} /> <strong>门禁通过：</strong>所选 {selected.length} 份文档的冲突、写入账本与复核链均已闭环，可生成发布包。</Card>
      )}
      {error && <p className="publish-error">{error}</p>}

      <div className="batch-layout">
        <Card className="batch-list">
          <div className="card-title"><Layers3 size={17} /><strong>发布批次</strong></div>
          {releases.length === 0 && <p className="muted">尚无已生成批次。</p>}
          {releases.map((rel) => (
            <button key={rel.id} className="active">
              <span>{rel.id}</span>
              <strong>{rel.name}</strong>
              <small>{rel.docIds.length} 份 · {rel.operator} · {rel.createdAt}</small>
            </button>
          ))}
        </Card>
        <Card className="batch-content">
          <div className="card-title"><Tags size={17} /><strong>选择进入批次的文档</strong><span>{selected.length} 已选择</span></div>
          <div className="batch-table">
            {documents.map((doc) => {
              const open = conflicts.filter((c) => c.docId === doc.id && c.status === 'open').length;
              const failed = writes.filter((w) => w.docId === doc.id && w.status === 'failed').length;
              const pending = doc.reviews.filter((r) => r.status === 'pending').length;
              const blocked = open + failed + pending > 0 || doc.redactions.some((r) => r.status === 'draft');
              return (
                <label key={doc.id} className="batch-row">
                  <input type="checkbox" checked={selected.includes(doc.id)} onChange={() => toggle(doc.id)} />
                  <span className="batch-file">{blocked ? <AlertTriangle size={16} /> : <Check size={16} />}</span>
                  <div>
                    <strong>{doc.title}</strong>
                    <span>{doc.id} · {doc.issue}</span>
                    <VersionLine doc={doc} />
                  </div>
                  {blocked ? <Badge tone="red">门禁未过</Badge> : <Badge tone="green">可发布</Badge>}
                </label>
              );
            })}
          </div>
          <div className="tag-editor">
            <h3>批次说明</h3>
            <input className="batch-name-input" value={batchName} onChange={(e) => setBatchName(e.target.value)} />
            <label>导出清单说明<textarea defaultValue="按案卷编号升序导出，冻结去密区域版本、文档/密级版本、操作者、复核号与裁决记录。" /></label>
          </div>
        </Card>
        <Card className="batch-summary">
          <div className="side-label">当前批次摘要</div>
          <strong>{batchName}</strong>
          <dl>
            <div><dt>文档</dt><dd>{selected.length}</dd></div>
            <div><dt>页数</dt><dd>{selected.reduce((sum, id) => sum + (documents.find((doc) => doc.id === id)?.pages ?? 0), 0)}</dd></div>
            <div><dt>未过门禁</dt><dd className={gate.blockers.length ? 'warning-text' : ''}>{gate.blockers.length}</dd></div>
          </dl>
          {releases.length > 0 && (
            <div className="frozen-versions">
              <div className="side-label">最近批次冻结版本</div>
              {releases[releases.length - 1].frozen.map((f) => (
                <div key={f.docId} className="frozen-row">
                  <b>{f.docId}</b>
                  <span>v{f.docVersion} / seq{f.regionSeq} / 密级 v{f.classVersion}</span>
                </div>
              ))}
            </div>
          )}
          <div className="summary-note"><AlertTriangle size={15} /><span>逐项裁决完成且失败项重试成功前，生成发布包会被门禁拦下。</span></div>
        </Card>
      </div>
    </div>
  );
}
