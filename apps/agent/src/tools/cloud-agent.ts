/**
 * Built-in tool: dispatch_cloud_agent.
 *
 * Launches a Cursor cloud agent on an allowlisted repo and tracks the run in
 * the control-tier store; the boot-time reconciler posts the PR back into the
 * thread when it finishes. Marked `destructiveHint: true` so it routes through
 * the existing confirmation gate — the owner previews the repo + task before
 * the run fires (the task text is model-generated and may follow content read
 * during the turn). Registered only when the feature is configured.
 */

import { randomUUID } from 'node:crypto';

import { cloudDispatchInputSchema, resolveRepo } from '@sym/cursor-runtime';

import { argError, errMsg, execError } from './_helpers.js';

import type { SlackClient } from '@sym/adapter-slack';
import type {
  JsonSchema,
  SlackChannelId,
  SlackThreadTs,
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from '@sym/contracts';
import type { CloudRunStore, CursorCloudClient, RepoAllowlist } from '@sym/cursor-runtime';

export const DISPATCH_CLOUD_AGENT_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'dispatch_cloud_agent',
  description: [
    'Dispatch an autonomous Cursor cloud agent to do a coding task on a repository, then open a pull request. Use for real code work the owner asks for — investigate a bug, fix a failing test, implement a small change — on one of the allowlisted repos.',
    '',
    'The agent runs in an isolated cloud VM (not here); it clones the repo, works, and opens a PR for review. You will NOT get the result inline — Sym posts the PR link into this thread when the run finishes (minutes to hours later). Tell the owner you have started it.',
    '',
    'Only allowlisted repos can be targeted. The owner is asked to approve the repo + task before dispatch.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'The target repository — an allowlisted repo name or its exact GitHub URL.',
      },
      task: {
        type: 'string',
        description: 'A clear, self-contained description of the coding task for the cloud agent.',
      },
      branch: {
        type: 'string',
        description: 'Optional starting branch/ref to work from (defaults to the repo default).',
      },
    },
    required: ['repo', 'task'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: false,
  destructiveHint: true,
};

/** Dependencies for the dispatch handler — supplied per turn by the registry. */
export interface CloudAgentToolDeps {
  client: CursorCloudClient;
  store: CloudRunStore;
  allowlist: RepoAllowlist;
  slackClient: SlackClient;
  channel: SlackChannelId;
  threadTs: SlackThreadTs;
}

export async function handleDispatchCloudAgent(
  call: ToolCall,
  deps: CloudAgentToolDeps,
): Promise<ToolResult> {
  const args = call.arguments;
  const branch = args['branch'];
  const parsed = cloudDispatchInputSchema.safeParse({
    repoQuery: args['repo'],
    task: args['task'],
    ...(typeof branch === 'string' ? { startingRef: branch } : {}),
  });
  if (!parsed.success) {
    return argError(
      call,
      `Invalid dispatch arguments: ${parsed.error.issues[0]?.message ?? 'bad input'}`,
    );
  }

  const repo = resolveRepo(parsed.data.repoQuery, deps.allowlist);
  if (repo === null) {
    return argError(
      call,
      `Repo "${parsed.data.repoQuery}" is not in the cloud-agent allowlist. Allowed: ${deps.allowlist.map((r) => r.name).join(', ') || '(none configured)'}.`,
    );
  }

  // Write the intent row BEFORE dispatch so a crash in the dispatch window
  // leaves a recoverable row rather than an untracked live run.
  const dispatchId = randomUUID();
  deps.store.insertIntent({ dispatchId, channel: deps.channel, threadTs: deps.threadTs });

  let result;
  try {
    result = await deps.client.dispatch({
      repoUrl: repo.url,
      task: parsed.data.task,
      ...(parsed.data.startingRef !== undefined ? { startingRef: parsed.data.startingRef } : {}),
    });
  } catch (err) {
    deps.store.markStatus(dispatchId, 'error', { statusText: 'dispatch failed' });
    return execError(call, `Cloud dispatch failed: ${errMsg(err)}`);
  }

  deps.store.patchDispatched(dispatchId, { runId: result.runId, agentId: result.agentId });

  try {
    await deps.slackClient.chatPostMessage({
      channel: deps.channel,
      thread_ts: deps.threadTs,
      text: `🚀 Started a cloud agent on *${repo.name}* — I'll post the PR here when it's ready.`,
    });
  } catch {
    // Non-fatal: the run is tracked; the reconciler still delivers the result.
  }

  return {
    callId: call.id,
    ok: true,
    content: `Dispatched a cloud agent on ${repo.name}. It runs in the background and I'll post the PR in this thread when it finishes — no need to wait.`,
  };
}
