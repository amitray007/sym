/**
 * Built-in tool dispatcher — wiring entry point.
 *
 * This file is the stable public surface: it exports `createBuiltinDispatcher`
 * and `BuiltinToolDeps`, which are the only symbols consumed by
 * `handle-turn.ts` and the test suite. Internals live in `tools/`.
 *
 * Tool implementations are split by family under `src/tools/`:
 *   - tools/time.ts          — get_current_time
 *   - tools/slack-read.ts    — read_channel, read_thread, list_channels
 *   - tools/slack-users.ts   — read_user_profile, set_status, add_reminder
 *   - tools/slack-write.ts   — post_as_owner, react_as_owner, delete_message
 *   - tools/slack-search.ts  — search_messages
 *   - tools/web.ts           — fetch_url, web_search, run_cli
 *   - tools/planning.ts      — set_plan, update_task
 *   - tools/presentation.ts  — present_card, present_table
 *   - tools/registry.ts      — Map-based dispatch table + BuiltinToolDeps
 *   - tools/_helpers.ts      — shared primitives (argError, errMsg, …)
 */

export type { BuiltinToolDeps } from './tools/registry.js';
export { createBuiltinDispatcher } from './tools/registry.js';
