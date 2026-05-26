'use client';

import { ArrowRight, CheckCircle2, Circle, KeyRound, Slack } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { saveProviderConfig } from './actions';

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
  ownerSlackUserId: string | null;
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
        {done ? <CheckCircle2 className="w-4 h-4" /> : <Circle className="w-4 h-4" />}
      </span>
      <span className="text-ink-tertiary">{icon}</span>
      <div>
        <h3 className="text-ink-primary text-sm font-medium">{title}</h3>
        <p className="text-ink-tertiary text-xs mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
}

const labelCls = 'block text-ink-secondary text-xs font-medium mb-1';

export function SetupWizard({
  status,
  workspaceName,
  ownerSlackUserId,
  agentInstallUrl,
  provider,
}: Props) {
  const [providerDone, setProviderDone] = useState(status.hasProvider);
  const [providerMsg, setProviderMsg] = useState<string | null>(null);
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

  const complete = status.hasInstall && providerDone;

  return (
    <div className="mx-auto max-w-2xl p-6 space-y-5 animate-fade-in">
      {/* Page header */}
      <div>
        <h1 className="text-ink-primary font-medium text-sm">Set up Sym</h1>
        <p className="text-ink-secondary text-xs mt-0.5">
          {workspaceName ? `Configuring ${workspaceName}.` : 'Connect Sym to your Slack workspace.'}
        </p>
      </div>

      {/* Step 1 — Install */}
      <section className="card p-5 space-y-4">
        <StepHeader
          done={status.hasInstall}
          icon={<Slack className="w-3.5 h-3.5" />}
          title="1 · Install to Slack"
          subtitle="Authorize Sym's bot in your workspace (OAuth — nothing is baked in)."
        />
        {status.hasInstall ? (
          <p className="text-success text-xs font-mono">Installed</p>
        ) : agentInstallUrl ? (
          <a className="btn-primary" href={`${agentInstallUrl}/slack/install`}>
            <Slack className="w-3.5 h-3.5" /> Install to Slack
          </a>
        ) : (
          <p className="text-warning text-xs font-mono">
            Set <code>AGENT_URL</code> (and the Slack app credentials on the agent) to enable
            install.
          </p>
        )}
      </section>

      {/* Step 2 — Provider */}
      <section className="card p-5 space-y-4">
        <StepHeader
          done={providerDone}
          icon={<KeyRound className="w-3.5 h-3.5" />}
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
              className="input font-mono"
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
              className="input font-mono"
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
                className="input font-mono"
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
                className="input font-mono"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={busy} className="btn-primary">
              Save provider
            </button>
            {providerMsg && (
              <span
                className={`text-xs font-mono ${providerDone ? 'text-success' : 'text-danger'}`}
              >
                {providerMsg}
              </span>
            )}
          </div>
        </form>
      </section>

      {/* Done */}
      <section className="card p-5">
        <StepHeader
          done={complete}
          icon={<CheckCircle2 className="w-3.5 h-3.5" />}
          title="3 · Done"
          subtitle={complete ? 'Sym is ready.' : 'Finish the steps above to activate Sym.'}
        />
        {complete && (
          <div className="mt-4 space-y-3">
            <p className="text-ink-tertiary text-xs font-mono">
              owner: <span className="text-ink-secondary">{ownerSlackUserId ?? 'unknown'}</span> —
              Sym takes requests only from this Slack user.
            </p>
            <Link href="/activity" className="btn-primary">
              Go to dashboard <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
