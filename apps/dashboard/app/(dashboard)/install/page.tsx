import { slackInstalls, workspaces } from '@sym/db';
import { and, eq } from 'drizzle-orm';
import { Plug } from 'lucide-react';
import { redirect } from 'next/navigation';

import { getWorkspace } from '@/lib/admin-check';
import { dashboardGate } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatRelativeTime } from '@/lib/utils';

export const metadata = { title: 'Install · Sym' };

export const dynamic = 'force-dynamic';

interface InstallRow {
  botUserId: string;
  appId: string;
  scopes: string[];
  installedBySlackUserId: string;
  enterpriseId: string | null;
  createdAt: Date;
}

async function getActiveInstall(workspaceId: string): Promise<InstallRow | null> {
  const handle = getDb();
  if (!handle) return null;

  try {
    const rows = await handle.db
      .select({
        botUserId: slackInstalls.botUserId,
        appId: slackInstalls.appId,
        scopes: slackInstalls.scopes,
        installedBySlackUserId: slackInstalls.installedBySlackUserId,
        enterpriseId: slackInstalls.enterpriseId,
        createdAt: slackInstalls.createdAt,
      })
      .from(slackInstalls)
      .where(and(eq(slackInstalls.workspaceId, workspaceId), eq(slackInstalls.status, 'active')))
      .limit(1);

    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function getSlackTeamId(workspaceId: string): Promise<string | null> {
  const handle = getDb();
  if (!handle) return null;
  try {
    const rows = await handle.db
      .select({ slackTeamId: workspaces.slackTeamId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return rows[0]?.slackTeamId ?? null;
  } catch {
    return null;
  }
}

const labelCls = 'text-ink-tertiary text-[10px] font-mono uppercase tracking-wider w-36 shrink-0';
const valueCls = 'text-ink-primary text-xs font-mono truncate';

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-border-subtle last:border-0">
      <span className={labelCls}>{label}</span>
      <span className={valueCls}>{children}</span>
    </div>
  );
}

export default async function InstallPage() {
  const gate = await dashboardGate();
  if (gate === 'sign-in') redirect('/sign-in');
  if (gate === 'request-access') redirect('/request-access');

  const ws = await getWorkspace();
  const install = ws ? await getActiveInstall(ws.id) : null;
  const slackTeamId = ws ? await getSlackTeamId(ws.id) : null;

  const agentUrl = process.env.AGENT_URL ?? null;

  if (install && ws) {
    return (
      <div className="mx-auto max-w-2xl p-6 space-y-5 animate-fade-in">
        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-ink-primary font-medium text-sm">Slack Install</h1>
            <p className="text-ink-secondary text-xs mt-0.5">
              Bot connection status and workspace details.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-accent shrink-0" />
            <span className="badge badge-success">Connected</span>
          </div>
        </div>

        {/* Details card */}
        <section className="card p-5">
          <p className="section-heading">Workspace</p>
          <div className="mt-2">
            <DetailRow label="Team name">{ws.name}</DetailRow>
            <DetailRow label="Team ID">{slackTeamId ?? '—'}</DetailRow>
            <DetailRow label="Owner">{ws.ownerSlackUserId ?? '—'}</DetailRow>
            <DetailRow label="Bot user">{install.botUserId}</DetailRow>
            <DetailRow label="App ID">{install.appId}</DetailRow>
            {install.enterpriseId && (
              <DetailRow label="Enterprise">{install.enterpriseId}</DetailRow>
            )}
            <DetailRow label="Installed by">{install.installedBySlackUserId}</DetailRow>
            <DetailRow label="Installed">
              {formatRelativeTime(new Date(install.createdAt))}
            </DetailRow>
          </div>
        </section>

        {/* Scopes card */}
        <section className="card p-5 space-y-3">
          <p className="section-heading">Bot scopes</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {install.scopes.map((scope) => (
              <span key={scope} className="badge font-mono">
                {scope}
              </span>
            ))}
            {install.scopes.length === 0 && (
              <span className="text-ink-muted text-xs font-mono">No scopes recorded.</span>
            )}
          </div>
        </section>

        {/* Re-authorize */}
        <div className="flex items-center gap-3">
          {agentUrl ? (
            <a href={`${agentUrl}/slack/install`} className="btn-ghost">
              <Plug className="w-3.5 h-3.5" />
              Re-authorize in Slack
            </a>
          ) : (
            <p className="text-ink-muted text-xs font-mono">
              Set <code>AGENT_URL</code> to enable re-authorization.
            </p>
          )}
        </div>
      </div>
    );
  }

  // Not installed
  return (
    <div className="mx-auto max-w-2xl p-6 space-y-5 animate-fade-in">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-ink-primary font-medium text-sm">Slack Install</h1>
          <p className="text-ink-secondary text-xs mt-0.5">
            Connect Sym to your Slack workspace via OAuth.
          </p>
        </div>
        <span className="badge">Not installed</span>
      </div>

      <section className="card p-5 flex flex-col items-center justify-center py-14 gap-4 text-center">
        <div className="w-10 h-10 rounded bg-surface-4 border border-border flex items-center justify-center">
          <Plug className="w-5 h-5 text-ink-muted" />
        </div>
        <div className="space-y-1">
          <p className="text-ink-secondary text-xs">No active Slack install found.</p>
          <p className="text-ink-muted text-[10px] font-mono">
            The OAuth flow runs in the agent and writes the install record back to the database.
          </p>
        </div>
        {agentUrl ? (
          <a href={`${agentUrl}/slack/install`} className="btn-primary">
            <Plug className="w-3.5 h-3.5" />
            Install to Slack
          </a>
        ) : (
          <p className="text-ink-muted text-xs font-mono">
            Set <code>AGENT_URL</code> (and Slack app credentials on the agent) to enable install.
          </p>
        )}
      </section>
    </div>
  );
}
