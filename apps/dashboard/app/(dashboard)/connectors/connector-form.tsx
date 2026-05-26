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

const labelCls = 'block text-ink-secondary text-xs font-medium mb-1';

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
            className="input font-sans"
            placeholder="My Connector"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="connector-slug">
            Slug
            <span className="ml-1 text-ink-muted font-normal">(kebab-case)</span>
          </label>
          <input
            id="connector-slug"
            name="slug"
            type="text"
            required
            pattern="[a-z0-9][a-z0-9\-]*"
            className="input font-mono"
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
          className="input font-mono"
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
          className="input input-select"
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
            className="input font-mono"
            placeholder={initial.hasExistingToken ? '••••••••' : 'Paste token…'}
            // Write-only: never pre-fill with the stored value.
          />
          {initial.hasExistingToken && (
            <p className="mt-1 text-ink-muted text-xs font-mono">
              Token set — leave blank to keep the current value.
            </p>
          )}
        </div>
      )}

      {authMode === 'oauth' && (
        <div className="card px-4 py-3">
          <p className="text-ink-secondary text-xs">
            Each user connects their own account — connect flow coming soon.
          </p>
        </div>
      )}

      {/* Transport is always 'http' in v1 — stdio needs the sandbox runner (deferred). */}
      <input type="hidden" name="transport" value="http" />

      {error && <p className="text-danger text-xs font-mono">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="btn-primary">
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" disabled={busy} className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className={enabled ? 'badge badge-success' : 'badge'}>
      {enabled ? 'enabled' : 'disabled'}
    </span>
  );
}

function AuthModeBadge({ mode }: { mode: ConnectorAuthMode }) {
  const labels: Record<ConnectorAuthMode, string> = {
    none: 'open',
    static: 'static',
    oauth: 'oauth',
  };
  return <span className="badge">{labels[mode]}</span>;
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
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-ink-primary text-sm font-medium truncate">{connector.name}</span>
          <span className="font-mono text-ink-muted text-[10px]">{connector.slug}</span>
          <AuthModeBadge mode={connector.authMode} />
          <EnabledBadge enabled={connector.enabled} />
        </div>
        <span className="text-ink-tertiary text-[10px] font-mono truncate block mt-0.5">
          {connector.url ?? '—'}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          disabled={busy}
          className="btn-ghost text-[11px] py-1 px-2"
          onClick={handleToggle}
          title={connector.enabled ? 'Disable' : 'Enable'}
        >
          {connector.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          disabled={busy}
          className="btn-ghost text-[11px] py-1 px-2"
          onClick={onEdit}
          title="Edit"
        >
          <Pencil className="w-3 h-3" />
          Edit
        </button>
        <button
          type="button"
          disabled={busy}
          className="btn-ghost text-[11px] py-1 px-2 text-danger border-danger/30 hover:border-danger/50"
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
    <div className="mx-auto max-w-3xl p-6 space-y-5 animate-fade-in">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-ink-primary font-medium text-sm">Connectors</h1>
          <p className="text-ink-secondary text-xs mt-0.5">
            Remote MCP servers extend Sym with external tools. The agent reads these on every turn.
          </p>
        </div>
        {!showAdd && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setShowAdd(true);
              setEditingId(null);
              setFormError(null);
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        )}
      </div>

      {flashError && (
        <div className="rounded border border-danger/20 bg-danger/10 px-4 py-2">
          <p className="text-danger text-xs font-mono">{flashError}</p>
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <section className="card p-5 space-y-4">
          <p className="section-heading">New connector</p>
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
          <div className="flex flex-col items-center justify-center py-14 gap-2 text-center">
            <p className="text-ink-secondary text-xs">No connectors configured yet.</p>
            <p className="text-ink-muted text-[10px] font-mono">
              Add a remote MCP server above to extend Sym&apos;s toolset.
            </p>
          </div>
        ) : (
          connectors.map((connector) =>
            editingId === connector.id && editingConnector ? (
              <div key={connector.id} className="px-4 py-4 border-b border-border last:border-0">
                <p className="section-heading mb-3">Edit &ldquo;{editingConnector.name}&rdquo;</p>
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

      <p className="text-ink-muted text-[10px] font-mono">
        Only HTTP transport is supported in v1. stdio servers (local command execution) require the
        sandbox runner and will be enabled in a future release.
      </p>
    </div>
  );
}
