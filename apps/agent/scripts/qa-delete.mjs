// QA harness — drive Sym's REAL `delete_message` tool against live Slack.
//
// Exercises the full builtin-dispatcher → slack-client → Slack `chat.delete`
// path over the real wire, using the same compiled modules the agent runs. It
// posts a throwaway message AS SYM (bot token), deletes it through the
// `delete_message` tool, then re-reads the channel to confirm it's gone. This
// is the on-demand "does deletion actually work end-to-end?" check — not a
// mocked unit test.
//
// Safe by construction: it only ever deletes the throwaway message it just
// posted (Sym's own message), and Slack's bot-token chat.delete cannot touch
// anyone else's messages anyway.
//
// Usage (reads SLACK_BOT_TOKEN / SLACK_BOT_USER_ID from the repo-root .env):
//   SYM_QA_CHANNEL=C0123 pnpm --filter @sym/agent qa:delete
//
// SYM_QA_CHANNEL must be a channel (or DM) Sym is a member of. The bot posts
// "🧪 Sym delete_message QA …" there for a fraction of a second, then removes it.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';

import { WebApiSlackClient } from '../dist/slack-client.js';
import { createBuiltinDispatcher } from '../dist/builtin-tools.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
loadDotenv({ path: resolve(repoRoot, '.env'), override: true });

const botToken = process.env.SLACK_BOT_TOKEN;
const botUserId = process.env.SLACK_BOT_USER_ID ?? 'U0';
const channel = process.env.SYM_QA_CHANNEL;

if (botToken === undefined || botToken.trim() === '') {
  console.error('[qa] SLACK_BOT_TOKEN missing — set it in .env');
  process.exit(1);
}
if (channel === undefined || channel.trim() === '') {
  console.error('[qa] set SYM_QA_CHANNEL to a channel/DM id Sym is in, e.g. SYM_QA_CHANNEL=C0123');
  process.exit(1);
}

const slack = new WebApiSlackClient(botToken);
const dispatcher = createBuiltinDispatcher({ slackClient: slack, botUserId });

// 1. Post a throwaway message AS SYM.
const marker = `🧪 Sym delete_message QA — safe to ignore (auto-deleting)`;
console.log(`[qa] posting throwaway message to ${channel}…`);
const posted = await slack.chatPostMessage({ channel, text: marker });
console.log(`[qa] posted ts=${posted.ts}`);

// 2. Delete it through the REAL delete_message tool (dispatcher → chat.delete).
console.log('[qa] dispatching delete_message…');
const result = await dispatcher.dispatch(
  {
    id: 'qa_del_1',
    name: 'delete_message',
    arguments: { channel_id: channel, message_ts: posted.ts },
  },
  {
    workspaceId: 'qa',
    conversationId: 'qa',
    channelId: channel,
    requester: botUserId,
    turnId: 'qa',
  },
);

if (!result.ok) {
  console.error(`[qa] FAIL: delete_message returned an error: ${result.error?.message}`);
  process.exit(2);
}
console.log(`[qa] tool ok: ${result.content}`);

// 3. Verify it's actually gone from the channel.
const { messages } = await slack.conversationsHistory({ channel, limit: 20 });
const stillThere = messages.some((m) => m.ts === posted.ts);
if (stillThere) {
  console.error(`[qa] FAIL: message ${posted.ts} is still present in ${channel} after delete`);
  process.exit(3);
}

console.log(`[qa] PASS — message ${posted.ts} deleted and absent from channel history ✅`);
