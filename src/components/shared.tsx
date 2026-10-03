import { GitMerge, X } from 'lucide-react';
import { Badge } from './ui';
import { useMergeStore } from '../store';
import type { Classification, RegionSource, Review } from '../merge/types';

export function VersionLine({ doc }: { doc: { docVersion: number; classVersion: number; regionSeq: number } }) {
  return (
    <span className="version-line">
      <b>文档 v{doc.docVersion}</b>
      <b>密级 v{doc.classVersion}</b>
      <b>区域 seq{doc.regionSeq}</b>
    </span>
  );
}

export const sourceMeta: Record<RegionSource, { label: string; tone: 'neutral' | 'blue' | 'green' | 'amber' }> = {
  center: { label: '中心', tone: 'blue' },
  remote: { label: '外聘', tone: 'amber' },
  'adopted-remote': { label: '裁决采外聘', tone: 'green' },
  'adopted-center': { label: '裁决采中心', tone: 'green' },
  'kept-both': { label: '双方保留', tone: 'green' }
};

export function SourceBadge({ source }: { source: RegionSource }) {
  const meta = sourceMeta[source];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function classTone(c: Classification): 'red' | 'amber' | 'neutral' {
  return c === '严格机密' ? 'red' : c === '机密' ? 'amber' : 'neutral';
}

export function ReviewStatusBadge({ review }: { review: Review }) {
  if (review.status === 'signed') return review.basisStale
    ? <Badge tone="amber">已签 · 依据过期保留</Badge>
    : <Badge tone="green">已签核</Badge>;
  if (review.status === 'invalid') return <Badge tone="red">已失效 · 已重算</Badge>;
  return <Badge tone="amber">待重算 / 待签</Badge>;
}

export function NoticeBar() {
  const lastNotice = useMergeStore((s) => s.lastNotice);
  const clearNotice = useMergeStore((s) => s.clearNotice);
  if (!lastNotice) return null;
  return (
    <div className="notice-bar">
      <GitMerge size={15} />
      <span>{lastNotice}</span>
      <button onClick={clearNotice} aria-label="关闭提示"><X size={14} /></button>
    </div>
  );
}
