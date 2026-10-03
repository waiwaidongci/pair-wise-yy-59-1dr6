import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, ClipboardCheck, FileText, GitMerge, History, RefreshCw, UploadCloud, Wifi, WifiOff } from 'lucide-react';
import { Badge, Button, Card, Tabs } from '../components/ui';
import { VersionLine, classTone } from '../components/shared';
import { useMergeStore } from '../store';

const bundleQuery = async () => ({
  queue: [
    { id: 'Q-31', name: '第三批补充材料', count: 128, owner: '林清', progress: 68, due: '今日 16:00' },
    { id: 'Q-32', name: '证人材料图像件', count: 47, owner: '周叙', progress: 34, due: '明日 11:00' },
    { id: 'Q-33', name: '专家报告附件', count: 19, owner: '顾言', progress: 91, due: '09-30 18:00' }
  ]
});

export function DocumentsPage() {
  const documents = useMergeStore((s) => s.documents);
  const conflicts = useMergeStore((s) => s.conflicts);
  const writes = useMergeStore((s) => s.writes);
  const batches = useMergeStore((s) => s.batches);
  const simulateCenterDrift = useMergeStore((s) => s.simulateCenterDrift);
  const ingestDemoBatch = useMergeStore((s) => s.ingestDemoBatch);
  const resetDemo = useMergeStore((s) => s.resetDemo);
  const { data } = useQuery({ queryKey: ['document-queues'], queryFn: bundleQuery });
  const [filter, setFilter] = useState('全部');
  const visible = filter === '全部' ? documents : documents.filter((doc) => doc.status === filter);
  const regionTotal = documents.reduce((n, d) => n + d.redactions.length, 0);
  const openConflicts = conflicts.filter((c) => c.status === 'open').length;
  const failed = writes.filter((w) => w.status === 'failed').length;
  const imported = batches.length > 0;

  return (
    <div className="page">
      <header className="page-heading">
        <div><small>DISCLOSURE CONTROL / DOCUMENT SET</small><h1>披露文档集</h1><p>文档、去密区域、复核结论全部带版本；外聘断网清单回中心按版本合并、可恢复。</p></div>
        <div className="heading-actions">
          <Button variant="outline" onClick={resetDemo}><RefreshCw size={15} /> 重置演示</Button>
          <Button onClick={ingestDemoBatch}><UploadCloud size={16} /> {imported ? '同批复传（沿用首次结果）' : '受理外聘导入批'}</Button>
        </div>
      </header>

      <Card className="merge-drill-card">
        <div className="drill-icon"><WifiOff size={18} /></div>
        <div className="drill-body">
          <strong>断网外聘复核合并演练</strong>
          <p>外聘复核员沈确在离线基线上改了区域与密级、签了复核号 REV-EXT-7031/7032。按顺序操作可看到：中心变化导致未完成复核失效重算、同区域双改冲突保留双方、密级双改冲突、一个写入失败项从失败重试恢复。</p>
        </div>
        <div className="drill-actions">
          <Button variant="outline" onClick={simulateCenterDrift}><GitMerge size={15} /> 1. 模拟中心离线期变化</Button>
          <Button variant="outline" onClick={ingestDemoBatch}><Wifi size={15} /> 2. 受理导入批</Button>
          <Link to="/merge"><Button>3. 去裁决 / 重试 <ChevronRight size={15} /></Button></Link>
        </div>
      </Card>

      <section className="summary-strip">
        <div><span>文档（均含版本）</span><strong>{documents.length}</strong><small>文档 v / 密级 v / 区域 seq</small></div>
        <div><span>去密区域</span><strong>{regionTotal}</strong><small>中心 / 外聘来源可辨</small></div>
        <div><span>待裁决冲突</span><strong className={openConflicts ? 'warning-text' : ''}>{openConflicts}</strong><small>逐项裁决后才能发布</small></div>
        <div><span>失败写入</span><strong className={failed ? 'warning-text' : ''}>{failed}</strong><small>从失败项重试恢复</small></div>
      </section>
      <div className="two-column">
        <Card className="document-table-card">
          <div className="card-heading">
            <div><Tabs.Root value={filter} onValueChange={setFilter}><Tabs.List className="segmented">
              {['全部', '去密中', '待质检', '可发布'].map((item) => <Tabs.Trigger key={item} value={item}>{item}</Tabs.Trigger>)}
            </Tabs.List></Tabs.Root></div>
            <span>{visible.length} 份文档</span>
          </div>
          <div className="document-table versioned-table">
            {visible.map((doc) => {
              const docConflicts = conflicts.filter((c) => c.docId === doc.id && c.status === 'open').length;
              const docFailed = writes.filter((w) => w.docId === doc.id && w.status === 'failed').length;
              const pendingReviews = doc.reviews.filter((r) => r.status === 'pending').length;
              return (
                <div className="document-row versioned-row" key={doc.id}>
                  <div className="file-icon"><FileText size={19} /></div>
                  <div className="doc-main">
                    <strong>{doc.title}</strong>
                    <span>{doc.id} · {doc.bundle} · {doc.size}</span>
                    <VersionLine doc={doc} />
                  </div>
                  <div className="doc-field"><span>密级</span><Badge tone={classTone(doc.classification)}>{doc.classification}</Badge><small>v{doc.classVersion}</small></div>
                  <div className="doc-field"><span>负责人员</span><strong>{doc.owner}</strong></div>
                  <div className="doc-field">
                    <span>合并状态</span>
                    {docConflicts > 0 && <Badge tone="red">{docConflicts} 冲突</Badge>}
                    {docFailed > 0 && <Badge tone="amber">{docFailed} 失败</Badge>}
                    {pendingReviews > 0 && <Badge tone="amber">{pendingReviews} 待签</Badge>}
                    {docConflicts === 0 && docFailed === 0 && pendingReviews === 0 && <Badge tone="green">一致</Badge>}
                  </div>
                  <div className="doc-field"><span>状态</span><Badge tone={doc.status === '可发布' ? 'green' : doc.status === '待质检' ? 'amber' : 'blue'}>{doc.status}</Badge></div>
                  <div className="doc-actions">
                    <Link to="/review/$documentId" params={{ documentId: doc.id }}><Button variant="outline">审阅</Button></Link>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
        <aside className="side-stack">
          <Card className="queue-card">
            <div className="card-title"><ClipboardCheck size={17} /><strong>去密任务队列</strong></div>
            {(data?.queue ?? []).map((item) => (
              <div className="queue-item" key={item.id}>
                <div><strong>{item.name}</strong><span>{item.count} 份 · {item.owner}</span></div>
                <div className="progress"><i style={{ width: `${item.progress}%` }} /></div>
                <small>{item.progress}% · 截止 {item.due}</small>
              </div>
            ))}
          </Card>
          <Card className="audit-card">
            <div className="card-title"><History size={17} /><strong>版本轨迹（最近）</strong></div>
            {documents.flatMap((d) => d.history.slice(-2).map((h) => ({ d, h }))).slice(-6).reverse().map(({ d, h }, i) => (
              <p key={i}><b>{h.at}</b> {d.id} · {h.message}</p>
            ))}
          </Card>
        </aside>
      </div>
    </div>
  );
}
