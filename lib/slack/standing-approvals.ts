import type { Sql } from "../db.ts";
import type { Migration } from "../ledger/migrations.ts";
import type { SlackApi } from "./api.ts";
import { resolveTarget } from "./reach.ts";

// Standing approvals (decision 105). A person tells Sym to stop asking before its posts in one
// channel, and names the group pings that may go with them. Code then skips the `slack_post`
// approval click for that person's posts there, in their own turns and in the runs that act for
// them. A Slack Connect channel and any ping the person did not name still ask.

export const standingApprovalsMigration: Migration = {
  version: "043_standing_approvals",
  sql: `
    -- One row per allowed ping; mention '' is the channel's posts without a ping.
    create table standing_approvals (
      granted_by text not null,
      channel_id text not null,
      mention text not null default '',
      label text not null default '',
      created_at timestamptz not null default now(),
      primary key (granted_by, channel_id, mention)
    );
  `,
};

export const OWN_TURN_ONLY =
  "Only the person themselves can change when I ask them, in their own conversation.";

// The channel a person names, when it is a channel and not a DM.
export async function channelOf(slack: SlackApi | undefined, input: string) {
  if (!slack) return undefined;
  const target = await resolveTarget(slack, input).catch(() => undefined);
  return target && !target.channel.startsWith("D") ? target.channel : undefined;
}

// A group ping: a user group ID such as S0ONCALL, or here, channel, or everyone.
export interface Ping {
  mention: string;
  label: string;
}

const TOKEN = /<!(subteam\^([A-Z0-9]+)|here|channel|everyone|group)\b(?:\|@?([^>]*))?[^>]*>/gi;
const PLAIN = /(?:^|[^\w@.])@(here|channel|everyone)\b/gi;
const WORD = /^@?(here|channel|everyone)$/i;
const GROUP_ID = /^S[A-Z0-9]{2,}$/;

function pingOf(token: string, groupId: string | undefined, label: string | undefined): Ping {
  if (groupId) return { mention: groupId, label: label?.trim() || groupId };
  const word = token.toLowerCase() === "group" ? "channel" : token.toLowerCase();
  return { mention: word, label: word };
}

// Every group ping in a message, once each.
export function pingsIn(text: string): Ping[] {
  const found = new Map<string, Ping>();
  for (const match of text.matchAll(TOKEN)) {
    const ping = pingOf(match[1] ?? "", match[2], match[3]);
    if (!found.has(ping.mention)) found.set(ping.mention, ping);
  }
  for (const match of text.matchAll(PLAIN)) {
    const ping = pingOf(match[1] ?? "", undefined, undefined);
    if (!found.has(ping.mention)) found.set(ping.mention, ping);
  }
  return [...found.values()];
}

// One ping a person names for a grant: a Slack group mention, a group ID, or here, channel, or
// everyone. A group's name alone has no ID, so it gives undefined.
export function parsePing(input: string): Ping | undefined {
  const text = input.trim();
  const [token] = pingsIn(text);
  if (token) return token;
  if (GROUP_ID.test(text)) return { mention: text, label: text };
  const word = WORD.exec(text)?.[1];
  return word ? { mention: word.toLowerCase(), label: word.toLowerCase() } : undefined;
}

export interface StandingApproval {
  channelId: string;
  pings: Ping[];
}

export async function addStandingApproval(
  sql: Sql,
  input: { grantedBy: string; channelId: string; pings: readonly Ping[] },
): Promise<void> {
  const rows = [{ mention: "", label: "" }, ...input.pings].map((ping) => ({
    granted_by: input.grantedBy,
    channel_id: input.channelId,
    mention: ping.mention,
    label: ping.label,
  }));
  await sql`
    insert into standing_approvals ${sql(rows)}
    on conflict (granted_by, channel_id, mention) do update set label = excluded.label
  `;
}

export async function listStandingApprovals(
  sql: Sql,
  grantedBy: string,
): Promise<StandingApproval[]> {
  const rows = await sql<{ channelId: string; mention: string; label: string }[]>`
    select channel_id, mention, label from standing_approvals
    where granted_by = ${grantedBy}
    order by channel_id, created_at, mention
  `;
  const byChannel = new Map<string, StandingApproval>();
  for (const row of rows) {
    const approval = byChannel.get(row.channelId) ?? { channelId: row.channelId, pings: [] };
    if (row.mention) approval.pings.push({ mention: row.mention, label: row.label });
    byChannel.set(row.channelId, approval);
  }
  return [...byChannel.values()];
}

// Removes one ping, or the whole channel when no ping is named. Returns the rows removed.
export async function removeStandingApproval(
  sql: Sql,
  input: { grantedBy: string; channelId: string; ping?: Ping | undefined },
): Promise<number> {
  const removed = input.ping
    ? await sql`
        delete from standing_approvals
        where granted_by = ${input.grantedBy} and channel_id = ${input.channelId}
          and mention = ${input.ping.mention}
      `
    : await sql`
        delete from standing_approvals
        where granted_by = ${input.grantedBy} and channel_id = ${input.channelId}
      `;
  return removed.count;
}

// True when the person's standing approval covers this post: the channel, and every ping in it.
// A broadcast form that names no readable ping is never covered.
export async function standingApprovalCovers(
  sql: Sql,
  input: { grantedBy: string; channelId: string; text: string; hasPing: boolean },
): Promise<boolean> {
  const pings = pingsIn(input.text);
  if (input.hasPing && pings.length === 0) return false;
  const rows = await sql<{ mention: string }[]>`
    select mention from standing_approvals
    where granted_by = ${input.grantedBy} and channel_id = ${input.channelId}
  `;
  const allowed = new Set(rows.map((row) => row.mention));
  return allowed.has("") && pings.every((ping) => allowed.has(ping.mention));
}

// A plain-text description that pings nobody.
export function describePings(pings: readonly Ping[]): string {
  return pings.length ? `, with pings to ${pings.map((ping) => ping.label).join(", ")}` : "";
}
