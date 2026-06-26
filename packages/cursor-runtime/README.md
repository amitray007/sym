# @sym/cursor-runtime

Cursor cloud-agent runtime for Sym — dispatch an autonomous [Cursor cloud
agent](https://cursor.com/docs/cloud-agent) onto a repo, track the run, and
surface the resulting PR. This is Sym's second execution tier: the
conversational Pi loop dispatches a coding task here, and a background poller
delivers the PR back to Slack when the cloud agent finishes.

Depends only on `@cursor/sdk` and `zod`. Imports nothing from `apps/*` (enforced
by the dependency DAG).

## Components

- **`CursorCloudClient`** — a thin, typed wrapper over `@cursor/sdk` cloud mode.
  `dispatch()` launches a cloud agent (`autoCreatePR`, no auto-merge);
  `getRun()` polls and normalizes a run. All SDK calls sit behind an injectable
  `CursorSdkPort` (tests never load the SDK). Errors surface as
  `CursorClientError` with a `code` + `retryable` flag, and the API key is
  scrubbed from the message, stack, and cause chain.
- **`CloudRunStore`** — unencrypted control-tier SQLite (`node:sqlite`) tracking
  runs through `dispatching → running → terminal → delivered`. Stores routing
  data only (channel, thread, run ids, status) — never conversation content.
  An intent row is written **before** dispatch so a crash can't orphan a run,
  and `deliveredAt` guards the Slack post so a failed delivery retries.
- **`CloudRunReconciler`** — a non-reentrant interval poller. Drives each run to
  terminal and delivers exactly once: it handles the PR-not-yet-ready wait, a
  max-run deadline, fatal-vs-retryable poll errors, and stuck intent rows, and
  resumes in-flight runs on restart. Timers and the clock are injected.
- **`resolveRepo`** — resolves a repo reference against the allowlist
  (case-insensitive name or exact URL); the boundary on which repos may be
  touched.

## Usage

```ts
import {
  CursorCloudClient,
  CloudRunStore,
  CloudRunReconciler,
  resolveRepo,
} from '@sym/cursor-runtime';

const client = new CursorCloudClient({
  apiKey: process.env.CURSOR_API_KEY!,
  model: 'composer-2.5',
});
const store = new CloudRunStore({ dbPath: '.sym/cloud.db' });

// Dispatch (after resolving + allowlisting the repo, writing an intent row):
const { agentId, runId } = await client.dispatch({ repoUrl, task });
store.patchDispatched(dispatchId, { runId, agentId });

// Track + deliver:
const reconciler = new CloudRunReconciler({
  client,
  store,
  onTransition: (run) => postToSlack(run), // markDelivered runs only if this resolves
});
reconciler.start();
```

In Sym this is wired by `apps/agent`: the `dispatch_cloud_agent` tool (gated
behind owner confirmation) drives the client + store, and the reconciler posts
the PR into the originating thread.

## Invariants

- **Single deployable.** The reconciler assumes one process over the run store
  (Sym is one deployable). Running ≥2 pollers over a shared store would
  double-deliver — add a claim/lease column first.
- **Control-tier, not message state.** The store survives restarts because run
  tracking must; it holds no message content, so Sym's stateless conversational
  tier (I-1) is preserved.

## Out of scope (v1)

Webhook delivery (polling only), run cancellation / max-age leakage policy,
custom Cursor environments, and arbitrary (non-allowlisted) repos.
