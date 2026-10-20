# 052. The App Home tab is a read-only dashboard

Status: accepted
Date: 2026-10-20

## Context

"What is Sym doing?" had two answers: `/sym status` and asking in a thread. Both are pull and
text-only. The Home tab is a page that never notifies, so it fits a status view. docs/slack.md
had it as "Team phase".

## Decision

1. **Hook.** Eve routes `app_home_opened` to `onEvent` as a raw Events API event (it is not a
   message, so it falls through the message hooks). `agent/channels/slack.ts` handles it in one
   branch: for `tab: "home"` it calls `publishLiveHome` (`lib/home/live.ts`). The `messages` tab
   does nothing.
2. **Who sees what** (`homeRole`, `lib/home/home.ts`).
   - Not on the allow-list: one line, "Sym isn't set up for you." No ledger read.
   - Allowed: header, running and waiting jobs, finished jobs, schedules, and the project names.
   - Owner: the allowed view plus MCP connections (status, sign-in state, default mode) and
     settings (persona and its source, quiet mode). "Owner" means the configured owner only
     (`ownerUserId`). With no owner configured nobody gets the owner sections, unlike approvals
     where an unset owner lets the allow-list decide. Read access should not open by default.
3. **Content.** `lib/home/view.ts` builds the Block Kit view from plain data, so it is a pure
   function. Limits: 10 active jobs, 5 finished jobs (plus done and failed counts for the last 24
   hours), 10 schedules, 20 project names, "+N more" after each cut. Sections are cut to 3000
   characters and the view to 100 blocks. Job and schedule titles are escaped and clipped.
   Waiting jobs sort first. Each job links to its Slack thread with
   `https://slack.com/app_redirect?channel=...&message_ts=...`, which needs no `chat.getPermalink`
   call.
4. **Projects.** The view shows the allow-list names from `allowedProjects` (decision 042). The
   code never reads another project, and the worker check does not list projects.
5. **Worker state.** The header shows the worker label (decision 043), reachable and signed in,
   and the sign-in expiry. The sign-in row is a ledger read. Reachability is one `projects` call
   with a 3 second timeout. Any error or timeout shows "status unknown". No sign-in shows "not
   signed in". The publish never waits longer than the timeout.
6. **Refresh.** The view publishes on `app_home_opened`, so opening the tab refreshes it. It has
   no Refresh button: Eve 0.81.0 drops Home-view clicks (see Consequences). Sym does not
   re-publish after job
   state changes: the cost (a publish per viewer per change, with a 30 s per-user limit to track)
   is not worth it while opening the tab is free.
7. **The one display exception.** `views.publish` is not a message post. It makes no
   notification, and nothing in the outbox or `chooseDisplay` applies to it. This is the one Slack
   write that skips both. It still goes through the `SlackApi` seam (`lib/slack/api.ts`), and a
   failure logs only Slack's error code.
8. **Manifest.** `home_tab_enabled: true` and the `app_home_opened` bot event. The owner must
   reinstall the app after this change, because Slack applies a manifest change to events only
   after a reinstall.

## Consequences

- Unverified against real Slack: the live `views.publish` call and the rendering. Tests use the
  fake Slack server.
- Eve 0.81.0 does not deliver block actions that come from a Home view to `onInteraction`: its
  parser drops a `block_actions` payload without a channel and a message
  (`parseBlockActionsPayload` in `interactions.js`). So the view has no buttons until Eve
  supports them. The tab refreshes each time it opens.
- `Finished` counts the last 24 hours, the window `/sym status` uses, not the calendar day.
- Each open of the tab reads the ledger and calls the worker once. A burst of opens costs a burst
  of reads.
