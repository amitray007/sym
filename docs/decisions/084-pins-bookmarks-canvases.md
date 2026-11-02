# 084. Pins, bookmarks, and channel canvases on request

Status: accepted
Date: 2026-11-03

## Context

Decision 081 planned tools to pin messages, add channel bookmarks, and write canvases. Each one
needs a new Slack scope, and a canvas holds text that people edit together.

## Decision

1. `slack_pin` pins or unpins a linked message (`pins.add`, `pins.remove`).
2. `slack_bookmark` adds an https link bookmark to a channel (`bookmarks.add`). It never removes
   one; removal needs `bookmarks:read` to find the bookmark.
3. `slack_canvas` writes Markdown to a channel's canvas. When the channel has no canvas, it
   creates one (`conversations.canvases.create`). Otherwise it adds to the end of the canvas
   (`canvases.edit` with `insert_at_end`). It never replaces or deletes canvas content.
4. All three follow the decision 081 checks. Bookmarks and canvases carry words into a channel,
   so they follow the decision 082 approval rules, and a canvas write counts toward the hourly
   post cap. None of them work in a DM.
5. The manifest adds `pins:write`, `bookmarks:write`, and `canvases:write`. The owner reinstalls
   the app to grant them.

## Consequences

- Until the reinstall, these tools get Slack's `missing_scope` and say Slack refused.
- Some Slack plans do not allow channel canvases. The tool says so.
- A pin needs no approval: the message is already in that channel.
