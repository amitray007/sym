'use client';

import { ArrowRight, CheckCircle2, Circle, KeyRound, Shield, Slack } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { saveAcl, saveProviderConfig } from './actions';

import type { SetupStatus } from '@/lib/setup';

const DEFAULT_MODEL = 'accounts/fireworks/models/llama-v3p3-70b-instruct';

interface ProviderPrefill {
  modelChat: string;
  modelToneRewrite: string;
  modelSummarization: string;
  baseUrl: string | null;
}

interface Props {
  status: SetupStatus;
  workspaceName: string | null;
  agentInstallUrl: string | null;
  provider: ProviderPrefill | null;
}

function StepHeader({
  done,
  icon,
  title,
  subtitle,
}: {
  done: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className={done ? 'text-success' : 'text-ink-muted'}>
        {done ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
      </span>
      <span className="text-ink-tertiary">{icon}</span>
      <div>
        <h3 className="text-ink-primary text-sm font-semibold">{title}</h3>
        <p className="text-ink-tertiary text-xs mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
}

export function SetupWizard({ status, workspaceName, agentInstallUrl, provider }: Props) {
  const [providerDone, setProviderDone] = useState(status.hasProvider);
  const [providerMsg, setProviderMsg] = useState<string | null>(null);
  const [aclDone, setAclDone] = useState(status.hasAcl);
  const [aclMsg, setAclMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onProvider(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setProviderMsg(null);
    const res = await saveProviderConfig(new FormData(e.currentTarget));
    setBusy(false);
    setProviderDone(res.ok);
    setProviderMsg(res.ok ? 'Saved.' : (res.error ?? 'Failed to save.'));
  }

  async function onAcl(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setAclMsg(null);
    const res = await saveAcl(new FormData(e.currentTarget));
    setBusy(false);
    setAclDone(res.ok);
    setAclMsg(res.ok ? 'Saved.' : (res.error ?? 'Failed to save.'));
  }

  const complete = status.hasInstall && providerDone;
  const inputCls =
    'w-full bg-surface-3 border border-border rounded-md px-3 py-2 text-ink-primary text-sm ' +
    'placeholder:text-ink-muted focus:outline-none focus:border-accent-400 font-mono';
  const labelCls = 'block text-ink-secondary text-xs font-medium mb-1';
  const btnCls =
    'inline-flex items-center gap-2 rounded-md bg-accent-500 px-4 py-2 text-sm font-medium ' +
    'text-white hover:bg-accent-400 disabled:opacity-50 transition-colors';

  return (
    <div className="mx-auto max-w-2xl p-8 space-y-6 animate-fade-in">
      <div>
        <h1 className="text-ink-primary text-xl font-semibold">Set up Sym</h1>
        <p className="text-ink-tertiary text-sm mt-1">
          {workspaceName ? `Configuring ${workspaceName}.` : 'Connect Sym to your Slack workspace.'}
        </p>
      </div>

      {/* Step 1 — Install */}
      <section className="card p-5 space-y-4">
        <StepHeader
          done={status.hasInstall}
          icon={<Slack className="w-4 h-4" />}
          title="1 · Install to Slack"
          subtitle="Authorize Sym's bot in your workspace (OAuth — nothing is baked in)."
        />
        {status.hasInstall ? (
          <p className="text-success text-sm">Installed ✓</p>
        ) : agentInstallUrl ? (
          <a className={btnCls} href={`${agentInstallUrl}/slack/install`}>
            <Slack className="w-4 h-4" /> Install to Slack
          </a>
        ) : (
          <p className="text-warning text-xs">
            Set <code>AGENT_URL</code> (and the Slack app credentials on the agent) to enable
            install.
          </p>
        )}
      </section>

      {/* Step 2 — Provider */}
      <section className="card p-5 space-y-4">
        <StepHeader
          done={providerDone}
          icon={<KeyRound className="w-4 h-4" />}
          title="2 · Provider"
          subtitle="Your Fireworks API key (encrypted at rest) and per-task models."
        />
        <form onSubmit={onProvider} className="space-y-3">
          <div>
            <label className={labelCls} htmlFor="apiKey">
              Fireworks API key
            </label>
            <input
              id="apiKey"
              name="apiKey"
              type="password"
              required
              className={inputCls}
              placeholder="fw-…"
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="modelChat">
              Chat model
            </label>
            <input
              id="modelChat"
              name="modelChat"
              defaultValue={provider?.modelChat ?? DEFAULT_MODEL}
              className={inputCls}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="modelToneRewrite">
                Tone-rewrite model
              </label>
              <input
                id="modelToneRewrite"
                name="modelToneRewrite"
                defaultValue={provider?.modelToneRewrite ?? DEFAULT_MODEL}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="modelSummarization">
                Summarization model
              </label>
              <input
                id="modelSummarization"
                name="modelSummarization"
                defaultValue={provider?.modelSummarization ?? DEFAULT_MODEL}
                className={inputCls}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={busy} className={btnCls}>
              Save provider
            </button>
            {providerMsg && (
              <span className={providerDone ? 'text-success text-xs' : 'text-danger text-xs'}>
                {providerMsg}
              </span>
            )}
          </div>
        </form>
      </section>

      {/* Step 3 — Access */}
      <section className="card p-5 space-y-4">
        <StepHeader
          done={aclDone || status.hasAcl}
          icon={<Shield className="w-4 h-4" />}
          title="3 · Access"
          subtitle="Who can talk to Sym in Slack."
        />
        <form onSubmit={onAcl} className="space-y-3">
          <div>
            <label className={labelCls} htmlFor="slackMode">
              Slack access mode
            </label>
            <select id="slackMode" name="slackMode" defaultValue="open" className={inputCls}>
              <option value="open">Open — everyone in the workspace</option>
              <option value="allowlist">Allowlist — only explicitly allowed users</option>
              <option value="workspace_minus_blocked">Everyone except blocked users</option>
            </select>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={busy} className={btnCls}>
              Save access
            </button>
            {aclMsg && (
              <span className={aclDone ? 'text-success text-xs' : 'text-danger text-xs'}>
                {aclMsg}
              </span>
            )}
          </div>
        </form>
      </section>

      {/* Done */}
      <section className="card p-5">
        <StepHeader
          done={complete}
          icon={<CheckCircle2 className="w-4 h-4" />}
          title="4 · Done"
          subtitle={complete ? 'Sym is ready.' : 'Finish the steps above to activate Sym.'}
        />
        {complete && (
          <Link href="/activity" className={`${btnCls} mt-4`}>
            Go to dashboard <ArrowRight className="w-4 h-4" />
          </Link>
        )}
      </section>
    </div>
  );
}
