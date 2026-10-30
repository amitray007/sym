import { createHmac } from "node:crypto";

// Builds signed Slack requests for Eve's Slack route, shaped like Slack sends them. The
// signature is v0 HMAC-SHA256 over `v0:{timestamp}:{rawBody}`.

export function signSlackRequest(
  body: string,
  signingSecret: string,
  timestamp: number | string = Math.floor(Date.now() / 1000),
): { "x-slack-signature": string; "x-slack-request-timestamp": string } {
  const ts = String(timestamp);
  const digest = createHmac("sha256", signingSecret).update(`v0:${ts}:${body}`).digest("hex");
  return { "x-slack-signature": `v0=${digest}`, "x-slack-request-timestamp": ts };
}

export interface SlackRequestParts {
  body: string;
  headers: Record<string, string>;
}

function jsonRequest(
  payload: unknown,
  signingSecret: string,
  timestamp?: number,
): SlackRequestParts {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      "content-type": "application/json",
      ...signSlackRequest(body, signingSecret, timestamp),
    },
  };
}

interface EventContext {
  signingSecret: string;
  teamId?: string;
  appId?: string;
  botUserId?: string;
  eventId?: string;
  timestamp?: number;
}

export function codeChannelActionRequest(
  input: EventContext & { channel: string; user: string; key: string },
): SlackRequestParts {
  return jsonRequest(
    envelope(input, {
      type: "code_channel_action",
      channel: input.channel,
      user: input.user,
      key: input.key,
    }),
    input.signingSecret,
    input.timestamp,
  );
}

function envelope(ctx: EventContext, event: Record<string, unknown>) {
  const now = ctx.timestamp ?? Math.floor(Date.now() / 1000);
  return {
    token: "unused",
    team_id: ctx.teamId ?? "T0FAKE",
    api_app_id: ctx.appId ?? "A0FAKE",
    type: "event_callback",
    event_id: ctx.eventId ?? `Ev${now}${Math.floor(Math.random() * 1e6)}`,
    event_time: now,
    authorizations: [
      { team_id: ctx.teamId ?? "T0FAKE", user_id: ctx.botUserId ?? "UBOT", is_bot: true },
    ],
    event,
  };
}

// An `app_mention` event_callback. `threadTs` makes it a reply inside a thread.
export function appMentionRequest(
  input: EventContext & {
    channel: string;
    user: string;
    text: string;
    ts: string;
    threadTs?: string;
  },
): SlackRequestParts {
  const event: Record<string, unknown> = {
    type: "app_mention",
    user: input.user,
    text: input.text,
    ts: input.ts,
    channel: input.channel,
    event_ts: input.ts,
  };
  if (input.threadTs) event.thread_ts = input.threadTs;
  return jsonRequest(envelope(input, event), input.signingSecret, input.timestamp);
}

// A plain message event in a public channel, as Slack sends one for a reply in a thread.
export function channelMessageRequest(
  input: EventContext & {
    channel: string;
    user: string;
    text: string;
    ts: string;
    threadTs?: string;
  },
): SlackRequestParts {
  const event: Record<string, unknown> = {
    type: "message",
    channel_type: "channel",
    user: input.user,
    text: input.text,
    ts: input.ts,
    channel: input.channel,
    event_ts: input.ts,
  };
  if (input.threadTs) event.thread_ts = input.threadTs;
  return jsonRequest(envelope(input, event), input.signingSecret, input.timestamp);
}

// A direct message event (`message` in an `im` channel).
export function directMessageRequest(
  input: EventContext & {
    channel: string;
    user: string;
    text: string;
    ts: string;
    threadTs?: string;
  },
): SlackRequestParts {
  const event: Record<string, unknown> = {
    type: "message",
    channel_type: "im",
    user: input.user,
    text: input.text,
    ts: input.ts,
    channel: input.channel,
    event_ts: input.ts,
  };
  if (input.threadTs) event.thread_ts = input.threadTs;
  return jsonRequest(envelope(input, event), input.signingSecret, input.timestamp);
}

// A `block_actions` interactive payload. Slack sends it form-encoded as `payload=<json>`.
export function blockActionsRequest(
  input: EventContext & {
    channel: string;
    user: string;
    messageTs: string;
    threadTs?: string;
    actionId: string;
    value?: string;
    // Radio buttons and static selects send the choice as `selected_option.value`.
    selectedOptionValue?: string;
    actionType?: string;
    blockId?: string;
    triggerId?: string;
  },
): SlackRequestParts {
  const payload = {
    type: "block_actions",
    user: { id: input.user, username: input.user.toLowerCase(), team_id: input.teamId ?? "T0FAKE" },
    api_app_id: input.appId ?? "A0FAKE",
    team: { id: input.teamId ?? "T0FAKE" },
    trigger_id: input.triggerId ?? "1337.42.fake",
    channel: { id: input.channel },
    container: {
      type: "message",
      message_ts: input.messageTs,
      channel_id: input.channel,
      thread_ts: input.threadTs,
    },
    message: { type: "message", ts: input.messageTs, thread_ts: input.threadTs ?? input.messageTs },
    actions: [
      {
        type: input.actionType ?? "button",
        action_id: input.actionId,
        block_id: input.blockId ?? "actions",
        value: input.value,
        ...(input.selectedOptionValue === undefined
          ? {}
          : { selected_option: { value: input.selectedOptionValue } }),
        action_ts: String(Date.now() / 1000),
      },
    ],
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  return {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...signSlackRequest(body, input.signingSecret, input.timestamp),
    },
  };
}

// A submitted modal. Slack sends the view back with each input's value under
// `state.values[blockId][actionId]`.
export function viewSubmissionRequest(
  input: EventContext & {
    user: string;
    view: Record<string, unknown>;
    values: Record<string, Record<string, string>>;
  },
): SlackRequestParts {
  const values = Object.fromEntries(
    Object.entries(input.values).map(([blockId, actions]) => [
      blockId,
      Object.fromEntries(
        Object.entries(actions).map(([actionId, value]) => [
          actionId,
          { type: "plain_text_input", value },
        ]),
      ),
    ]),
  );
  const payload = {
    type: "view_submission",
    user: { id: input.user, username: input.user.toLowerCase(), team_id: input.teamId ?? "T0FAKE" },
    api_app_id: input.appId ?? "A0FAKE",
    team: { id: input.teamId ?? "T0FAKE" },
    trigger_id: "1337.43.fake",
    view: { ...input.view, state: { values } },
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  return {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...signSlackRequest(body, input.signingSecret, input.timestamp),
    },
  };
}

// A slash command invocation. Slack sends it form-encoded.
export function slashCommandRequest(
  input: EventContext & {
    command?: string;
    text: string;
    channel: string;
    user: string;
    triggerId?: string;
  },
): SlackRequestParts {
  const body = new URLSearchParams({
    command: input.command ?? "/sym",
    text: input.text,
    user_id: input.user,
    user_name: input.user.toLowerCase(),
    channel_id: input.channel,
    channel_name: "general",
    team_id: input.teamId ?? "T0FAKE",
    api_app_id: input.appId ?? "A0FAKE",
    trigger_id: input.triggerId ?? "1337.42.fake",
    response_url: "https://hooks.slack.test/commands/T0FAKE/1/fake",
    is_enterprise_install: "false",
  }).toString();
  return {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...signSlackRequest(body, input.signingSecret, input.timestamp),
    },
  };
}

// A `reaction_added` event_callback on a message.
export function reactionAddedRequest(
  input: EventContext & {
    channel: string;
    user: string;
    reaction: string;
    messageTs: string;
    // The author of the reacted-to message. Defaults to the bot.
    itemUser?: string;
  },
): SlackRequestParts {
  const event: Record<string, unknown> = {
    type: "reaction_added",
    user: input.user,
    reaction: input.reaction,
    item: { type: "message", channel: input.channel, ts: input.messageTs },
    item_user: input.itemUser ?? input.botUserId ?? "UBOT",
    event_ts: String(Date.now() / 1000),
  };
  return jsonRequest(envelope(input, event), input.signingSecret, input.timestamp);
}
