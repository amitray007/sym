# 101. Triggers that fire on bot posts

Status: accepted
Date: 2026-11-24

## Context

Decision 088 made bots fire no trigger, so a run's own post can never fire a trigger and two bots
cannot loop. An allowed person set up a message trigger on an alerts channel. Every post there
came from an alert app, so the trigger never fired, and nothing told the person why.

Alert and monitoring apps are a common reason to watch a channel. Slack sends an app's post as a
`bot_message` with a `bot_id`, often with no `user` and with the alert in an attachment instead
of the text.

## Decision

1. A message or reaction trigger has an `include_bots` setting, off by default. `trigger_create`
   takes it as `includeBots`. Existing triggers keep it off.
2. A trigger with the setting on fires on a new top-level post by another app or bot, and on a
   reaction to such a post. A trigger with it off works as decision 088 says.
3. Sym's own posts never fire a trigger, with the setting on or off. Eve drops them before Sym's
   handler, and the handler drops `isMe` too. A reaction by any bot still fires nothing.
4. When a bot post has no text, the event text comes from its attachments, the same way
   `messageText` reads a forwarded message.
5. The hourly cap per trigger (`SYM_TRIGGER_RUNS_PER_HOUR`) bounds a loop with another bot.

## Consequences

- An alerts channel can drive trigger runs. The person or the brain turns the setting on when the
  watched posts come from an app.
- To change an existing trigger, delete it and create it again with the setting. There is no
  update tool.
- A busy alert channel can reach the hourly cap. The deployment raises
  `SYM_TRIGGER_RUNS_PER_HOUR` or the trigger adds keywords.
- Block Kit text that is only in `blocks` is not read into the event. The run can read the
  message with its Slack tools.
