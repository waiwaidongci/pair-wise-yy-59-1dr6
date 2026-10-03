import { useState } from 'react';
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter
} from '@tanstack/react-router';
import { GitMerge, Highlighter, Layers3, Menu, ScanSearch, ShieldCheck, Stamp, Tags } from 'lucide-react';
import { Badge } from './components/ui';
import { NoticeBar } from './components/shared';
import { useMergeStore } from './store';
import { DocumentsPage } from './pages/DocumentsPage';
import { ReviewPage } from './pages/ReviewPage';
import { MergePage } from './pages/MergePage';
import { QualityPage } from './pages/QualityPage';
import { BatchesPage } from './pages/BatchesPage';

function AppShell() {
  const [mobileNav, setMobileNav] = useState(false);
  const openConflicts = useMergeStore((s) => s.conflicts.filter((c) => c.status === 'open').length);
  const failedWrites = useMergeStore((s) => s.writes.filter((w) => w.status === 'failed').length);
  const links = [
    { to: '/', label: '文档集', icon: Layers3, alert: 0 },
    { to: '/review/$documentId', label: '去密审阅', icon: Highlighter, alert: 0, params: { documentId: 'DOC-00418' } },
    { to: '/merge', label: '合并与冲突', icon: GitMerge, alert: openConflicts + failedWrites },
    { to: '/quality', label: '复核结论', icon: ScanSearch, alert: 0 },
    { to: '/batches', label: '发布批次', icon: Tags, alert: 0 }
  ];
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-symbol"><Stamp size={18} /></div>
          <div><strong>披露质控台</strong><span>North Ridge / Litigation Support</span></div>
        </div>
        <div className="top-actions">
          {failedWrites > 0 && <Badge tone="red">{failedWrites} 写入失败待重试</Badge>}
          {openConflicts > 0 && <Badge tone="amber">{openConflicts} 项冲突待裁决</Badge>}
          <Badge tone="green"><ShieldCheck size={12} /> 版本化合并已开启</Badge>
          <div className="operator"><span>质控员</span><strong>林清 · 审核组</strong></div>
        </div>
        <button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="菜单"><Menu /></button>
      </header>
      <div className="shell-body">
        <aside className={mobileNav ? 'sidebar open' : 'sidebar'}>
          <div className="workspace-title">
            <span>当前工作区</span>
            <strong>北岭项目 · 诉讼披露</strong>
          </div>
          <nav>
            {links.map(({ to, label, icon: Icon, alert, params }) => (
              <Link
                key={to}
                to={to as '/'}
                params={params as never}
                activeProps={{ className: 'active' }}
                onClick={() => setMobileNav(false)}
              >
                <Icon size={17} /> <span>{label}</span>
                {alert ? <i className="nav-alert">{alert}</i> : null}
              </Link>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div><ShieldCheck size={16} /><span>版本轨迹全程留痕</span></div>
            <small>本机草稿带版本号，可恢复合并</small>
          </div>
        </aside>
        <main className="main-content">
          <NoticeBar />
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({ component: AppShell });
const documentsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: DocumentsPage });
const reviewRoute = createRoute({ getParentRoute: () => rootRoute, path: '/review/$documentId', component: ReviewPage });
const mergeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/merge', component: MergePage });
const qualityRoute = createRoute({ getParentRoute: () => rootRoute, path: '/quality', component: QualityPage });
const batchesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches', component: BatchesPage });
const routeTree = rootRoute.addChildren([documentsRoute, reviewRoute, mergeRoute, qualityRoute, batchesRoute]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

export default function App() {
  return <RouterProvider router={router} />;
}
