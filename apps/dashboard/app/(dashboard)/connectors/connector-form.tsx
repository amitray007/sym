'use client';

import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { createConnector, deleteConnector, setConnectorEnabled, updateConnector } from './actions';

export interface ConnectorRow {
  id: string;
  name: string;
  slug: string;
  url: string | null;
  authMode: 'none' | 'static' | 'oauth';
  enabled: boolean;
}

interface ConnectorFormProps {
  connectors: ConnectorRow[];
}

const inputCls =
  'w-full bg-surface-3 border border-border rounded-md px-3 py-2 text-ink-primary text-sm ' +
  'placeholder:text-ink-muted focus:outline-none focus:border-accent-400 font-mono';
const selectCls =
  'w-full bg-surface-3 border border-border rounded-md px-3 py-2 text-ink-primary text-sm ' +
  'focus:outline-none focus:border-accent-400';
const labelCls = 'block text-ink-secondary text-xs font-medium mb-1';
const btnPrimaryCls =
  'inline-flex items-center gap-2 rounded-md bg-accent-500 px-4 py-2 text-sm font-medium ' +
  'text-white hover:bg-accent-400 disabled:opacity-50 transition-colors';
const btnGhostCls =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ' +
  'text-ink-secondary border border-border hover:bg-surface-4 disabled:opacity-50 transition-colors';
const btnDangerCls =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ' +
  'text-danger border border-border hover:bg-surface-4 disabled:opacity-50 transition-colors';

/** Auto-generate a slug from a display name. */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

type ConnectorAuthMode = 'none' | 'static' | 'oauth';

interface ConnectorFormFields {
  name: string;
  slug: string;
  url: string;
  authMode: ConnectorAuthMode;
  /** Whether this is an edit of an existing static connector (affects token hint). */
  hasExistingToken: boolean;
}

function ConnectorFormFields({
  initial,
  onSave,
  onCancel,
  busy,
  error,
}: {
  initial: ConnectorFormFields;
  onSave: (data: FormData) => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [url, setUrl] = useState(initial.url);
  const [authMode, setAuthMode] = useState<ConnectorAuthMode>(initial.authMode);
  const [slugEdited, setSlugEdited] = useState(initial.slug !== '');

  function handleNameChange(v: string) {
    setName(v);
    if (!slugEdited) setSlug(toSlug(v));
  }

  function handleSlugChange(v: string) {
    setSlug(v);
    setSlugEdited(true);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    onSave(fd);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls} htmlFor="connector-name">
            Name
          </label>
          <input
            id="connector-name"
            name="name"
            type="text"
            required
            className={inputCls}
            placeholder="My Connector"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="connector-slug">
            Slug
            <span className="ml-1 text-ink-muted font-normal">(unique, kebab-case)</span>
          </label>
          <input
            id="connector-slug"
            name="slug"
            type="text"
            required
            pattern="[a-z0-9][a-z0-9\-]*"
            className={inputCls}
            placeholder="my-connector"
            value={slug}
            onChange={(e) => handleSlugChange(e.target.value)}
          />
        </div>
      </div>

      <div>
        <label className={labelCls} htmlFor="connector-url">
          URL
          <span className="ml-1 text-ink-muted font-normal">(https)</span>
        </label>
        <input
          id="connector-url"
          name="url"
          type="url"
          required
          className={inputCls}
          placeholder="https://mcp.example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      <div>
        <label className={labelCls} htmlFor="connector-auth-mode">
          Auth mode
        </label>
        <select
          id="connector-auth-mode"
          name="authMode"
          className={selectCls}
          value={authMode}
          onChange={(e) => setAuthMode(e.target.value as ConnectorAuthMode)}
        >
          <option value="none">None (open)</option>
          <option value="static">Static token (workspace-shared)</option>
          <option value="oauth">OAuth (per-user)</option>
        </select>
      </div>

      {authMode === 'static' && (
        <div>
          <label className={labelCls} htmlFor="connector-token">
            Token
            {initial.hasExistingToken && (
              <span className="ml-1 text-ink-muted font-normal">
                — leave blank to keep existing
              </span>
            )}
          </label>
          <input
            id="connector-token"
            name="token"
            type="password"
            autoComplete="new-password"
            className={inputCls}
            placeholder={initial.hasExistingToken ? '••••••••' : 'Paste token…'}
            // Write-only: never pre-fill with the stored value.
          />
          {initial.hasExistingToken && (
            <p className="mt-1 text-ink-muted text-xs">
              Token set — leave blank to keep the current value.
            </p>
          )}
        </div>
      )}

      {authMode === 'oauth' && (
        <div className="rounded-md border border-border bg-surface-3 px-4 py-3">
          <p className="text-ink-secondary text-xs">
            Each user connects their own account — connect flow coming soon.
          </p>
        </div>
      )}

      {/* Transport is always 'http' in v1 — stdio needs the sandbox runner (deferred). */}
      <input type="hidden" name="transport" value="http" />

      {error && <p className="text-danger text-xs">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className={btnPrimaryCls}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" disabled={busy} className={btnGhostCls} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={
        `inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ` +
        (enabled
          ? 'bg-success/10 text-success border-success/20'
          : 'bg-surface-4 text-ink-tertiary border-border')
      }
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

function AuthModeBadge({ mode }: { mode: ConnectorAuthMode }) {
  const labels: Record<ConnectorAuthMode, string> = {
    none: 'Open',
    static: 'Static token',
    oauth: 'OAuth',
  };
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-surface-4 text-ink-tertiary border-border">
      {labels[mode]}
    </span>
  );
}

function ConnectorRow({
  connector,
  onEdit,
  onDeleted,
  onToggled,
}: {
  connector: ConnectorRow;
  onEdit: () => void;
  onDeleted: (err: string | null) => void;
  onToggled: (err: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleToggle() {
    setBusy(true);
    const res = await setConnectorEnabled(connector.id, !connector.enabled);
    setBusy(false);
    onToggled(res.ok ? null : (res.error ?? 'Failed.'));
  }

  async function handleDelete() {
    if (!confirm(`Delete "${connector.name}"? This cannot be undone.`)) return;
    setBusy(true);
    const res = await deleteConnector(connector.id);
    setBusy(false);
    onDeleted(res.ok ? null : (res.error ?? 'Failed.'));
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-ink-primary text-sm font-medium truncate">{connector.name}</span>
          <span className="text-ink-muted text-xs font-mono shrink-0">{connector.slug}</span>
          <AuthModeBadge mode={connector.authMode} />
        </div>
        <span className="text-ink-tertiary text-xs font-mono truncate block mt-0.5">
          {connector.url ?? '—'}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <EnabledBadge enabled={connector.enabled} />
        <button
          type="button"
          disabled={busy}
          className={btnGhostCls}
          onClick={handleToggle}
          title={connector.enabled ? 'Disable' : 'Enable'}
        >
          {connector.enabled ? 'Disable' : 'Enable'}
        </button>
        <button type="button" disabled={busy} className={btnGhostCls} onClick={onEdit} title="Edit">
          <Pencil className="w-3 h-3" />
          Edit
        </button>
        <button
          type="button"
          disabled={busy}
          className={btnDangerCls}
          onClick={handleDelete}
          title="Delete"
        >
          <Trash2 className="w-3 h-3" />
          Delete
        </button>
      </div>
    </div>
  );
}

export function ConnectorForm({ connectors }: ConnectorFormProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [flashError, setFlashError] = useState<string | null>(null);

  async function handleCreate(fd: FormData) {
    setBusy(true);
    setFormError(null);
    const res = await createConnector(fd);
    setBusy(false);
    if (res.ok) {
      setShowAdd(false);
    } else {
      setFormError(res.error ?? 'Failed to create connector.');
    }
  }

  async function handleUpdate(id: string, fd: FormData) {
    setBusy(true);
    setFormError(null);
    const res = await updateConnector(id, fd);
    setBusy(false);
    if (res.ok) {
      setEditingId(null);
    } else {
      setFormError(res.error ?? 'Failed to update connector.');
    }
  }

  function handleFlash(err: string | null) {
    setFlashError(err);
    if (err) {
      setTimeout(() => setFlashError(null), 4000);
    }
  }

  const editingConnector =
    editingId !== null ? connectors.find((c) => c.id === editingId) : undefined;

  return (
    <div className="mx-auto max-w-3xl p-8 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-ink-primary text-xl font-semibold">Connectors</h1>
          <p className="text-ink-tertiary text-sm mt-1">
            Remote MCP servers extend Sym with external tools. The agent reads these on every turn.
          </p>
        </div>
        {!showAdd && (
          <button
            type="button"
            className={btnPrimaryCls}
            onClick={() => {
              setShowAdd(true);
              setEditingId(null);
              setFormError(null);
            }}
          >
            <Plus className="w-4 h-4" />
            Add connector
          </button>
        )}
      </div>

      {flashError && (
        <div className="rounded-md border border-danger/20 bg-danger/10 px-4 py-2">
          <p className="text-danger text-xs">{flashError}</p>
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <section className="card p-5 space-y-4">
          <h2 className="text-ink-primary text-sm font-semibold">New connector</h2>
          <ConnectorFormFields
            initial={{ name: '', slug: '', url: '', authMode: 'none', hasExistingToken: false }}
            onSave={handleCreate}
            onCancel={() => {
              setShowAdd(false);
              setFormError(null);
            }}
            busy={busy}
            error={formError}
          />
        </section>
      )}

      {/* Connector list */}
      <section className="card overflow-hidden">
        {connectors.length === 0 && !showAdd ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <p className="text-ink-secondary text-sm">No connectors configured yet.</p>
            <p className="text-ink-muted text-xs">
              Add a remote MCP server above to extend Sym&apos;s toolset.
            </p>
          </div>
        ) : (
          connectors.map((connector) =>
            editingId === connector.id && editingConnector ? (
              <div key={connector.id} className="px-4 py-4 border-b border-border last:border-0">
                <h2 className="text-ink-primary text-sm font-semibold mb-3">
                  Edit &ldquo;{editingConnector.name}&rdquo;
                </h2>
                <ConnectorFormFields
                  initial={{
                    name: editingConnector.name,
                    slug: editingConnector.slug,
                    url: editingConnector.url ?? '',
                    authMode: editingConnector.authMode,
                    hasExistingToken: editingConnector.authMode === 'static',
                  }}
                  onSave={(fd) => handleUpdate(connector.id, fd)}
                  onCancel={() => {
                    setEditingId(null);
                    setFormError(null);
                  }}
                  busy={busy}
                  error={formError}
                />
              </div>
            ) : (
              <ConnectorRow
                key={connector.id}
                connector={connector}
                onEdit={() => {
                  setEditingId(connector.id);
                  setShowAdd(false);
                  setFormError(null);
                }}
                onDeleted={handleFlash}
                onToggled={handleFlash}
              />
            ),
          )
        )}
      </section>

      <p className="text-ink-muted text-xs">
        Only HTTP transport is supported in v1. stdio servers (local command execution) require the
        sandbox runner and will be enabled in a future release.
      </p>
    </div>
  );
}
