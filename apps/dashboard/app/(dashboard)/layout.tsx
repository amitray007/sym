import { redirect } from 'next/navigation';

import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { isAdmin, getWorkspace } from '@/lib/admin-check';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

/**
 * Dashboard layout — server-side admin gate.
 *
 * When Clerk keys are absent (build/test time without live credentials),
 * we skip the auth check and render the shell so `next build` stays green.
 * In production DATABASE_URL + Clerk keys are always injected.
 */
export default async function DashboardLayout({ children }: DashboardLayoutProps) {
  const hasClerkKey = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  if (hasClerkKey) {
    // Dynamic import so the module only loads when keys are present
    const { auth } = await import('@clerk/nextjs/server');
    const { userId } = await auth();

    if (!userId) {
      redirect('/sign-in');
    }

    // Fail CLOSED: a signed-in non-admin (or an unverifiable check when the DB
    // is unreachable) never sees the dashboard. Build/dev without Clerk keys is
    // already handled by the `hasClerkKey` guard above.
    const adminOk = await isAdmin(userId);

    if (!adminOk) {
      redirect('/request-access');
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
