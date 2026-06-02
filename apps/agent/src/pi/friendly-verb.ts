/**
 * Tool name → friendly present-progressive status verb, for Slack's setStatus
 * shimmer and the task card. Where a tool's arguments carry meaning (the command
 * for `run_cli`, the query for a search, the URL host) we surface them so the
 * owner sees what's really happening, not just the bare tool name.
 */

import { parseMcpName } from './meta-tools.js';

/**
 * Map a tool name → a friendly present-progressive verb phrase for Slack's
 * setStatus shimmer. Unmapped tools fall back to `using {toolName}`.
 */
const TOOL_VERBS: Record<string, string> = {
  read_thread: 'reading the thread',
  read_channel: 'reading the channel',
  get_current_time: 'checking the time',
  read_user_profile: 'looking up the user',
  fetch_url: 'reading the page',
  list_channels: 'listing channels',
  post_as_owner: 'sending a message as you',
  react_as_owner: 'reacting as you',
  set_status: 'updating your status',
  add_reminder: 'setting a reminder',
  delete_message: 'deleting its message',
  // find_tools / call_tool are specialized from args in friendlyVerb (below).
  // NOTE: no entry for set_plan / present_* — they're in SILENT_TOOLS, so a
  // verb here would be dead (their start never reaches the shimmer/card).
};

/** "sentry__search_issues" → "sentry: search issues" for readable status. */
function humanizeMcpName(name: string): string {
  const { connector, local } = parseMcpName(name);
  if (connector === local) return name.replace(/_/g, ' ');
  return `${connector}: ${local.replace(/_/g, ' ')}`;
}

/** Clip a value for a task-row title — short, single-line, scannable. */
function clip(s: string, max = 56): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A trimmed, non-empty string argument, or undefined. */
function strArg(args: unknown, key: string): string | undefined {
  const v = (args as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * A SPECIFIC, present-progressive status verb for a tool call. Where a tool's
 * arguments carry meaning, we surface them — the actual command (`run_cli`), the
 * search query, the connector tool, the URL host — so the owner sees what's
 * really happening ("Running gcloud projects list") instead of the bare tool
 * name ("Using run_cli"). Generic tools fall back to TOOL_VERBS; anything
 * unmapped reads as "using <tool name>". Exported for tests.
 */
export function friendlyVerb(toolName: string, args?: unknown): string {
  switch (toolName) {
    case 'run_cli': {
      const argv = (args as { argv?: unknown } | undefined)?.argv;
      if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string')) {
        return `running ${clip((argv as string[]).join(' '))}`;
      }
      return 'running a command';
    }
    case 'call_tool': {
      const name = (args as { name?: unknown } | undefined)?.name;
      return typeof name === 'string' && name.length > 0
        ? `running ${humanizeMcpName(name)}`
        : 'running a connector tool';
    }
    case 'find_tools': {
      const q = strArg(args, 'query');
      return q !== undefined ? `finding tools for “${clip(q, 40)}”` : 'finding the right tool';
    }
    case 'web_search': {
      const q = strArg(args, 'query');
      return q !== undefined ? `searching the web for “${clip(q, 40)}”` : 'searching the web';
    }
    case 'search_messages': {
      const q = strArg(args, 'query');
      return q !== undefined ? `searching Slack for “${clip(q, 40)}”` : 'searching Slack';
    }
    case 'fetch_url': {
      const url = strArg(args, 'url');
      if (url !== undefined) {
        try {
          return `reading ${new URL(url).hostname}`;
        } catch {
          return `reading ${clip(url, 40)}`;
        }
      }
      return 'reading the page';
    }
    default:
      return TOOL_VERBS[toolName] ?? `using ${toolName.replace(/_/g, ' ')}`;
  }
}
