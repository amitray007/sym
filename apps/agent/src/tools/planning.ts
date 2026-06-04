/**
 * Built-in tools: set_plan, update_task.
 *
 * Planning tools that let the model externalize its intent before doing work,
 * so the task card reflects what the owner asked for (outcomes) rather than
 * the mechanics (tool names). Pure controller-mutations: no Slack API calls,
 * no auth, no actor routing. Neither can be destructive.
 */

import { argError } from './_helpers.js';

import type { PlanController, PlanItemStatus } from '../plan-controller.js';
import type { JsonSchema, ToolCall, ToolDescriptor, ToolResult } from '@sym/contracts';

export const SET_PLAN_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'set_plan',
  description: [
    "Externalize your plan BEFORE doing the work. Call this exactly once at the start of a turn when the owner's ask requires more than one tool call OR more than one user-visible outcome (research + summarize + reminder, compare A vs B, refactor + verify, etc.).",
    '',
    "Each item is a concrete outcome the OWNER cares about — phrased as a short imperative ('Find the latest incident', 'Summarize learnings', 'Set the reminder'). NOT tool names ('search_messages'). 2–6 items.",
    '',
    "SKIP this tool for single-action asks ('what time is it?', 'who did I DM yesterday?', 'remind me at 5pm') — just answer.",
    '',
    'Idempotent: once called, the plan is locked for this turn (subsequent calls return `already_planned`). After calling, use `update_task` to flip each item to `in_progress` when you start it and `complete` when done.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered plan items. 2–6 entries, each a concrete user-visible outcome.',
      },
    },
    required: ['items'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

export const UPDATE_TASK_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'update_task',
  description: [
    'Update a plan item created by `set_plan`. Call `in_progress` when you start working on an item; `complete` when finished; `blocked` if you need owner input and cannot proceed (supply a `note` with the reason).',
    '',
    'Returns `ok: false, reason: "no_plan"` if `set_plan` was never called, or `unknown_id` if the id does not match any item — in both cases this signals a model error; recover by skipping the update and continuing.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Plan item id, e.g. `p1`, `p2` (returned by `set_plan`).',
      },
      status: {
        type: 'string',
        enum: ['in_progress', 'complete', 'blocked'],
        description: 'New status. Use `blocked` only when owner input is required.',
      },
      note: {
        type: 'string',
        description: 'Optional short context shown under the item. Required when `status=blocked`.',
      },
    },
    required: ['id', 'status'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

export async function handleSetPlan(
  call: ToolCall,
  planController: PlanController | undefined,
): Promise<ToolResult> {
  const itemsArg = call.arguments['items'];
  if (!Array.isArray(itemsArg) || itemsArg.some((v) => typeof v !== 'string')) {
    return argError(call, 'items must be an array of strings');
  }
  if (planController === undefined) {
    // No controller wired (test path, non-streaming surface). Fail
    // cleanly so the model knows planning isn't available and just
    // proceeds without a card.
    return {
      callId: call.id,
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Planning is not available on this surface — answer the request directly.',
      },
    };
  }
  const planResult = await planController.setPlan(itemsArg as string[]);
  // Hand the model a plain JsonObject — typed `SetPlanResult` doesn't
  // satisfy ToolSuccess.content (which expects an index-signature JSON
  // shape, not a closed interface).
  const content = {
    ok: planResult.ok,
    ids: planResult.ids,
    ...(planResult.reason !== undefined ? { reason: planResult.reason } : {}),
  };
  return { callId: call.id, ok: true, content };
}

export async function handleUpdateTask(
  call: ToolCall,
  planController: PlanController | undefined,
): Promise<ToolResult> {
  const idArg = call.arguments['id'];
  const statusArg = call.arguments['status'];
  const noteArg = call.arguments['note'];
  if (typeof idArg !== 'string' || idArg.length === 0) {
    return argError(call, 'id must be a non-empty string');
  }
  if (
    typeof statusArg !== 'string' ||
    !['in_progress', 'complete', 'blocked'].includes(statusArg)
  ) {
    return argError(call, 'status must be one of: in_progress, complete, blocked');
  }
  if (noteArg !== undefined && typeof noteArg !== 'string') {
    return argError(call, 'note must be a string when present');
  }
  if (planController === undefined) {
    return {
      callId: call.id,
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Planning is not available on this surface.',
      },
    };
  }
  const updateResult = await planController.updateTask(
    idArg,
    statusArg as PlanItemStatus,
    typeof noteArg === 'string' ? noteArg : undefined,
  );
  const content = {
    ok: updateResult.ok,
    ...(updateResult.reason !== undefined ? { reason: updateResult.reason } : {}),
  };
  return { callId: call.id, ok: true, content };
}
