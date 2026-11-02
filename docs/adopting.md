# Adopting Sym

Sym's repository stays generic. An adopter keeps everything specific to their team in a **pack**:
a private folder or repository that Sym loads at build time and at session start (decision 010).

## What goes where

| In the Sym repository | In your pack |
|---|---|
| Job ledger, watch loop, reconcile, outbox | Your Slack user IDs, channels, and allow-list |
| Worker adapters | Worker endpoints and which projects each worker may use |
| Display rule and its defaults | Quiet hours, time zone, per-class display preferences |
| Skill loading and the shared safety rules | Your playbooks: on-call check, release steps, incident triage |
| Schedule engine | Your schedules |
| Eval harness and generic evals | Evals for your playbooks |

Anything that names a company, team, customer, private repository, or internal system belongs in
the pack.

## Pack layout

```
my-pack/
  sym.config.yaml     owner, allow-list, channels, time zone, quiet hours, workers, projects
  instructions/       extra instruction files (tone, house rules)
  personas/           optional persona file for the brain's voice
  playbooks/          legacy Eve skills, one Markdown file each
  skills/             on-demand procedures, one Markdown file each
  schedules.yaml      schedules to seed at start (optional)
  evals/              eval cases for your playbooks
```

Example `sym.config.yaml`:

```yaml
owner:
  slackUserId: U0123456789
allowList: [U0123456789]
timeZone: Europe/Berlin
quietHours: { from: "22:00", to: "09:00" }
channels:
  default: C0123456789
  digest: C0123456789
workers:
  - name: laptop
    kind: t3
    mcpUrl: https://laptop.example.ts.net/mcp
    models:                        # optional; replaces the built-in model list
      - id: claudeAgent/claude-sonnet-5-5
        use: Routine changes, small fixes, docs
        effort: medium             # optional
        default: true              # optional; the first entry is the default when none is marked
      - id: claudeAgent/claude-opus-5-5
        use: Hard bugs, migrations, security
        effort: high
projects:
  - name: sync-service
    worker: laptop
    workerProject: sync-service    # the worker's project ID or title; defaults to name
    allowedPaths: ["src/**", "test/**"]
    defaultBaseBranch: main
    prPolicy: draft                # none (default) or draft
    productionData: read-only
    model: claudeAgent/claude-opus-5-5   # optional; always this model for this project
instructions: [instructions/tone.md]
persona: personas/house.md        # optional; wins over SYM_PERSONA
playbooks: [playbooks/release-steps.md]  # existing packs keep working
skills: [skills/investigate.md]
identities:                       # optional; who a GitHub or Linear user is in Slack
  - slackUserId: U0123456789
    github: octo-dev               # a GitHub login
    linear: sam@example.com        # a Linear user's email or ID
```

Rules (decision 026):

- Unknown fields fail, and so does any field named like a secret (token, key, password, secret,
  credential). `mcpUrl` carries no credentials.
- `prPolicy` is `none` or `draft`. `productionData` is `read-only`. A pack narrows Sym's rules and
  never widens them.
- `models` is the list the brain picks from for that worker (decision 041). Each `id` is
  `<provider>/<model>`, with the T3 provider instance ID as the provider. Duplicate IDs fail, and
  so do two `default: true` entries. A worker with no `models` uses the built-in list in
  `lib/workers/models.ts`. A project `model` must be on its worker's list (or the built-in list)
  and wins over the brief. `SYM_WORKER_MODEL` still sets the default entry.
- `projects` is the allow-list of projects Sym may work on (decision 042). A brief for any other
  project is refused in code, and the brain sees only these names. An empty list allows nothing.
  Without a pack, `SYM_PROJECTS` plays this role.
- The owner is always allowed; `allowList` adds people.
- `identities` maps GitHub logins and Linear users to Slack people (decision 091). A mention of
  the GitHub App or a delegation in Linear counts as a request only from a mapped person who is
  also allowed. Without a pack, `SYM_GITHUB_USERS` and `SYM_LINEAR_USERS` play this role.
- Instruction, playbook, and skill files are listed by path and stay inside the pack folder,
  including their resolved symlink targets. Skill names must be valid Eve names and cannot use
  the reserved `eve` namespace. Names must be unique, ignoring case, across `playbooks` and
  `skills`. Each skill file is limited to 64 KiB of UTF-8 text. Empty bodies,
  malformed YAML frontmatter, and invalid description or metadata types fail before the overlay
  writes files (decision 087). Legacy playbooks may begin with a Markdown horizontal rule or
  empty frontmatter; the overlay keeps their first-line description fallback.
- `persona` is one Markdown file inside the pack folder, with the same rules as `instructions`
  (decision 044). It replaces the built-in persona that `SYM_PERSONA` would pick. Sym reads it at
  start from `SYM_PACK_DIR`, so it needs no overlay. It sets the brain's tone only. The shared
  Voice rules in `agent/instructions.md` still apply, and Sym's code-built messages ignore it.

## Seeding schedules

`schedules.yaml` is a list. Unknown fields fail, like `sym.config.yaml`.

```yaml
- key: weekday-check          # stable ID: lowercase words joined by hyphens
  title: Weekday check
  cron: "0 9 * * 1-5"         # five fields, in UTC
  channel: C0123456789        # optional; default is channels.default
  instruction: >-             # what each run does, in plain words
    Look for failing checks on example-app and report each one.
  builder: ask                # optional; ask (default) or auto
```

The deployer wrote each entry, so a seeded row is active at once and Sym sends no notice. The
`instruction` is the same text a person gives Sym in chat. With `builder: auto`, a run may start
Builder work without a Start click; with `ask`, it shows Start / Not now. If the cron, title,
channel, instruction, or builder mode changes in the file, Sym updates the row. A row someone
paused stays paused. A key that leaves the file is deleted, and a deleted key that returns is
active again. An entry with the old `brief` field fails the pack check (decisions 055 and 085).

## How Sym loads a pack

- **Build time:** `node scripts/pack-overlay.ts <pack-dir> <app-dir>` validates the pack, then
  copies each instruction file to `agent/instructions/<name>.md` and each playbook or skill to
  `agent/skills/<name>.md` before `eve build`, so Eve compiles them like built-in files.
  Instructions are added after `agent/instructions.md`, in alphabetical order; the overlay never
  overwrites an instruction file. A playbook with the same name as a built-in skill replaces it.
  A skill without `description` frontmatter gets one from its first line, but write your own
  so the model can route on intent. File names use ASCII letters, digits, `_`, and `-`.
  In Docker, pass the pack as a build context: `docker build --build-context pack=./my-pack -t sym .`.
  Without it, the image builds with no pack. Mount the pack at `SYM_PACK_DIR` at runtime too,
  because the runtime reads `sym.config.yaml` from there.
- **Start:** Sym reads `sym.config.yaml` from `SYM_PACK_DIR`, validates it, and refuses to start
  on an error that names the file and the field. It reads the optional `schedules.yaml` the same
  way. The first dispatcher tick then seeds its rows (see "Seeding schedules").
- **Session start:** `defineDynamic`, memoized once per session, adds approved learning-layer-2 rows from Postgres on top.

Milestone 1 checked this split: Eve 0.81.0 compiles pack instructions and playbooks from the
overlay, in `eve build` and in `docker build`.

## Loading skills

A repo procedure lives at `agent/skills/<name>.md`. A pack procedure is listed under `skills`
or the legacy `playbooks` field. Both use Eve's skill catalog: the brain sees the description and
calls `eve__skill({ name })` to load the full text only when it needs that procedure. Prefer a
description that says when to use it. Flat Markdown text works without a sandbox. Supporting
files, references, and scripts are not available until a sandbox layer is added.

Skills add instructions, not tools or permission. They cannot bypass Builder consent, the Projects
list, or production read-only rules. Worker MCP callers cannot load or read them. Approved learned
playbooks still load from Layer 2 rows under their existing approval rules; they do not become
skills (decisions 033, 058, and 087).

## Secrets

Secrets never go in the pack or in this repository. Put the Slack bot token, the Slack signing
secret, the model API key, the database URL, and worker tokens in the deployment's environment.
See [self-hosting.md](self-hosting.md).
