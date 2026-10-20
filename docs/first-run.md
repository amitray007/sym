# First live run

A checklist for the first run with a real Slack workspace and a real worker. Do the steps in
order. Each step says who does it: **owner** steps need a person; **check** steps confirm the step
worked. The local end-to-end run (`pnpm test:e2e`) covers the same flow against fakes, so a
failure here is about the real services, not Sym's logic.

## Before you start

- A Docker host for Sym and Postgres, reachable from the worker host on a private network.
- A worker host with T3 Code, signed in to its agent providers.
- A test Slack workspace where you can create apps.
- An AI Gateway key for the brain model.

## 1. The worker (owner)

1. On the worker host, serve T3 over HTTPS on the private network: enable Tailscale HTTPS in T3
   (Settings, Connections), or run `t3 serve --tailscale-serve`.
2. Note the MCP URL, such as `https://<worker>.<tailnet>.ts.net/mcp`.
3. Pick a throwaway project in T3 for the first job, or create one (an empty repository with an
   `origin` works).

## 2. Sym's routes (owner)

1. Give Sym a public HTTPS address for two paths only: `/eve/v1/slack` and
   `/.well-known/workflow/` (decision 006). With Dokploy, use its domain with a path allow-list.
   With Tailscale Funnel, put the Funnel on its own port (8443 or 10000), because a Funnel exposes
   a whole port.
2. Keep `/eve/v1/mcp` and `/eve/v1/session` on the private network.

## 3. The Slack app (owner)

1. Open `slack/manifest.yaml`, replace `https://sym.example.com` with Sym's public address, and
   create the app from it (api.slack.com/apps, Create New App, From a manifest).
2. Install it to the workspace. Copy the Bot User OAuth Token and the Signing Secret.
3. Invite Sym to the test channel. Copy your own member ID (Profile, More, Copy member ID).

## 4. Settings (owner)

Set the variables in [self-hosting.md, Credentials](self-hosting.md#credentials) in the
deployment environment, never in Git or the pack. For this run:

- `SYM_OWNER_SLACK_USER` and `SYM_SLACK_USERS`: your member ID from step 3.
- `SYM_PROJECTS`: the title of the throwaway T3 project for this run. Without a pack, Sym starts
  no job until this is set.
- `T3_MCP_URL`: the URL from step 1. The in-app sign-in replaces the token.
- `SYM_CALLBACK_URL`: Sym's tailnet address, `https://sym.<tailnet>.ts.net`.
- `SYM_SIGNIN_URL`: Sym's public HTTPS address from step 2.
- `POSTGRES_PASSWORD` and `TS_AUTHKEY`: for `compose.yaml` ([Deploy](self-hosting.md#deploy)).

## 5. Deploy (owner)

1. In Dokploy, create a Docker Compose app from the repository (compose path `./compose.yaml`),
   and add the two public paths as domains on the `tailscale` service, port 3000
   ([self-hosting.md](self-hosting.md#deploy)).
2. Deploy. The start command applies ledger migrations, then runs `eve start` and the schedules.
3. **Check:** `GET /eve/v1/health` answers ready.
4. In the Slack app, open Event Subscriptions and press Retry on the request URL. **Check:** Slack
   shows it as verified.

## 6. Sign Sym in to the worker (owner)

1. Mention Sym: "sign in to the worker". The T3 consent link arrives in your DM.
2. Open it, choose the **Auto** access level, and approve.
3. **Check:** Sym confirms the sign-in. `pnpm t3:check` on a machine with the same settings lists
   the worker's projects.

## 7. The first job (owner, then check)

1. Mention Sym in the test channel with a small job, such as "in <project>, add a HELLO.md that
   says hello, and commit it".
2. **Check** each exit criterion in [milestone-1.md](milestone-1.md):
   - Sym posts the brief, then Start, Edit, and Cancel. Start launches exactly one worker thread.
   - One job card appears and only changes by edits while the job runs.
   - The thread gets one result message at the end, with a verdict.
   - "What's the update?" in the thread answers from the job.
3. Optional: ask the worker to ask you something, and answer with the buttons; stop Sym's process
   mid-job and start it again, and the job still finishes.

## When something fails

- No reply in Slack: check the request URL in Event Subscriptions and the signing secret.
- No status line: the manifest needs `assistant:write`; reinstall the app after a scope change.
- No custom emoji in reactions: the app needs `emoji:read`. Add the scope (the manifest has it),
  reinstall the app, and update `SLACK_BOT_TOKEN` if Slack issues a new one. Standard emoji work
  without it.
- "The worker is unreachable": check the private network and `T3_MCP_URL` from inside the
  container.
- No early wake after a job: check that the worker host reaches `SYM_CALLBACK_URL`. Jobs still
  finish on the 4-minute poll.
- Record each result in [milestone-1.md](milestone-1.md), and each new decision in
  [decisions/](decisions/README.md).
