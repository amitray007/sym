'use client';

import { useState } from 'react';

import { saveProvider } from './actions';

import type { ActionResult } from './actions';

const DEFAULT_MODEL = 'accounts/fireworks/models/llama-v3p3-70b-instruct';

export interface ProviderFormProps {
  modelChat: string | null;
  baseUrl: string | null;
  enabled: boolean;
  hasKey: boolean;
  updatedAt: Date | null;
}

const labelCls = 'block text-ink-secondary text-xs font-medium mb-1';

export function ProviderForm({
  modelChat,
  baseUrl,
  enabled,
  hasKey,
  updatedAt,
}: ProviderFormProps) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const res = await saveProvider(new FormData(e.currentTarget));
    setBusy(false);
    setResult(res);
  }

  return (
    <div className="mx-auto max-w-2xl p-6 space-y-5 animate-fade-in">
      {/* Page header */}
      <div>
        <h1 className="text-ink-primary font-medium text-sm">AI Provider</h1>
        <p className="text-ink-secondary text-xs mt-0.5">
          Fireworks API key and model selection. Credentials are encrypted at rest.
        </p>
      </div>

      <section className="card p-5 space-y-4">
        <p className="section-heading">Fireworks configuration</p>
        <form onSubmit={onSubmit} className="space-y-4">
          {/* API key */}
          <div>
            <label className={labelCls} htmlFor="apiKey">
              API key
              {hasKey && (
                <span className="ml-1 text-ink-muted font-normal">
                  — leave blank to keep current
                </span>
              )}
            </label>
            <input
              id="apiKey"
              name="apiKey"
              type="password"
              autoComplete="new-password"
              required={!hasKey}
              className="input font-mono"
              placeholder={hasKey ? '•••••••• — leave blank to keep current' : 'fw-…'}
            />
            {hasKey && (
              <p className="mt-1 text-ink-muted text-[10px] font-mono">
                Key is set — paste a new value to rotate, or leave blank to keep the stored key.
              </p>
            )}
          </div>

          {/* Chat model */}
          <div>
            <label className={labelCls} htmlFor="modelChat">
              Chat model
            </label>
            <input
              id="modelChat"
              name="modelChat"
              type="text"
              required
              className="input font-mono"
              defaultValue={modelChat ?? DEFAULT_MODEL}
              placeholder={DEFAULT_MODEL}
            />
            <p className="mt-1 text-ink-muted text-[10px] font-mono">
              Used for chat, tone-rewrite, and summarization (three columns, one model in v1).
            </p>
          </div>

          {/* Base URL */}
          <div>
            <label className={labelCls} htmlFor="baseUrl">
              Base URL
              <span className="ml-1 text-ink-muted font-normal">
                (optional — override endpoint)
              </span>
            </label>
            <input
              id="baseUrl"
              name="baseUrl"
              type="url"
              className="input font-mono"
              defaultValue={baseUrl ?? ''}
              placeholder="https://api.fireworks.ai/inference/v1"
            />
          </div>

          {/* Enabled */}
          <div className="flex items-center gap-2.5">
            <input
              id="enabled"
              name="enabled"
              type="checkbox"
              defaultChecked={enabled}
              className="w-3.5 h-3.5 accent-accent cursor-pointer"
            />
            <label htmlFor="enabled" className="text-ink-secondary text-xs cursor-pointer">
              Enabled
              <span className="ml-1 text-ink-muted font-normal">
                (uncheck to disable this provider without deleting config)
              </span>
            </label>
          </div>

          {/* Submit row */}
          <div className="flex items-center gap-3 pt-1">
            <button type="submit" disabled={busy} className="btn-primary">
              {busy ? 'Saving…' : 'Save provider'}
            </button>
            {result && (
              <span className={`text-xs font-mono ${result.ok ? 'text-success' : 'text-danger'}`}>
                {result.ok ? 'Saved.' : (result.error ?? 'Failed to save.')}
              </span>
            )}
          </div>
        </form>
      </section>

      {updatedAt && (
        <p className="text-ink-muted text-[10px] font-mono">
          Last saved:{' '}
          {updatedAt.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}{' '}
          {updatedAt.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}
        </p>
      )}
    </div>
  );
}
