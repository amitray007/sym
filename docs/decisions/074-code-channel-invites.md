# 074. Invite people into a code channel on request

Status: accepted
Date: 2026-10-30

A person can ask Sym to bring a mentioned teammate into a job's code channel. With
`SYM_CODE_CHANNELS` on, `code_channel_invite` takes an optional job handle and 1 to 10 Slack user
IDs or @-mentions. Without a handle, it finds the job of the current code channel or origin
thread. Workers never get the tool. Sym never invites someone on its own. A name without an
@-mention needs clarification.

Code checks the requester's pack or environment allow-list, the job's open state, and the
channel's archive state. For a private code channel, each invitee must already belong to the
origin channel. Sym reads all pages of `conversations.members` and refuses outsiders with
"not in the original channel". Missing origin or unreadable membership cannot grant access.
The existing private-channel creation handling stays in force.

Sym calls `conversations.invite` once per person. It reports invited, already there, or Slack's
refusal code for each person, using @-mentions and the work's title. A failed invite does not
block the others. Slack failures log only the error code. No ledger write is needed.

The manifest adds `channels:write.invites` and `groups:write.invites`. The owner must reinstall
the Slack app to grant these scopes. Slack documents these narrow scopes for
[conversations.invite](https://docs.slack.dev/reference/methods/conversations.invite/) and cursor
pagination for [conversations.members](https://docs.slack.dev/reference/methods/conversations.members/).
The invite method does not explicitly promise support for code channels; local tests use fakes,
and a live check remains with the owner. The owner runs the invite routing eval with
`SYM_CODE_CHANNELS=on`; model evals are not part of the local checks.
