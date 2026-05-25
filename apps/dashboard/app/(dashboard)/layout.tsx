import { redirect } from 'next/navigation';

import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { getWorkspace } from '@/lib/admin-check';
import { dashboardGate } from '@/lib/auth';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

/**
 * Dashboard layout — server-side auth gate, fail CLOSED.
 *
 * dashboardGate covers all three modes (password / clerk / open): 'sign-in'
 * when unauthenticated, 'request-access' for a signed-in Clerk non-admin, 'ok'
 * otherwise (incl. open dev mode where nothing is configured).
 */
export default async function DashboardLayout({ children }: DashboardLayoutProps) {
  const gate = await dashboardGate();
  if (gate === 'sign-in') {
    redirect('/sign-in');
  }
  if (gate === 'request-access') {
    redirect('/request-access');
  }

  // Re-entry guard: until setup is complete (installed + provider configured),
  // force the first-run wizard. Gated on DATABASE_URL so build/dev without a DB
  // still renders. /setup lives outside this group, so there's no redirect loop.
  if (process.env.DATABASE_URL) {
    const { getSetupStatus } = await import('@/lib/setup');
    const status = await getSetupStatus();
    if (!status.complete) {
      redirect('/setup');
    }
  }

  const workspace = await getWorkspace();

  return (
    <div className="flex h-screen bg-surface-2 overflow-hidden">
      <Sidebar workspaceName={workspace?.name ?? null} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Topbar pageTitle={workspace?.name ? `${workspace.name} · Sym` : 'Sym'} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
