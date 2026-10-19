# Adopting Sym

Sym's repository stays generic. An adopter keeps everything specific to their team in a **pack**:
a private folder or repository that Sym loads at build time and at session start (decision 010).

## What goes where

| In the Sym repository | In your pack |
|---|---|
| Job ledger, watch loop, reconcile, outbox | Your Slack user IDs, channels, and allow-list |
| Worker adapters | Worker endpoints and which projects each worker may use |
| Display rule and its defaults | Quiet hours, time zone, per-class display preferences |
| Generic playbooks: `task-brief`, `progress`, `verify-result` | Your playbooks: on-call check, release steps, incident triage |
| Schedule engine | Your schedules |
| Eval harness and generic evals | Evals for your playbooks |

Anything that names a company, team, customer, private repository, or internal system belongs in
the pack.

## Pack layout

```
my-pack/
  sym.config.yaml     owner, allow-list, channels, time zone, quiet hours, workers, projects
  instructions/       extra instruction files (tone, house rules)
  playbooks/          Eve skills, one Markdown file each
  schedules.yaml      schedules to seed on first start
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
projects:
  - name: sync-service
    worker: laptop
    workerProject: sync-service    # the worker's project ID or title; defaults to name
    allowedPaths: ["src/**", "test/**"]
    defaultBaseBranch: main
    prPolicy: draft                # none (default) or draft
    productionData: read-only
instructions: [instructions/tone.md]
playbooks: [playbooks/release-steps.md]
```

Rules (decision 026):

- Unknown fields fail, and so does any field named like a secret (token, key, password, secret,
  credential). `mcpUrl` carries no credentials.
- `prPolicy` is `none` or `draft`. `productionData` is `read-only`. A pack narrows Sym's rules and
  never widens them.
- The owner is always allowed; `allowList` adds people.
- Instruction and playbook files are listed by path and stay inside the pack folder.

## How Sym loads a pack

- **Build time:** `node scripts/pack-overlay.ts <pack-dir> <app-dir>` validates the pack, then
  copies each instruction file to `agent/instructions/<name>.md` and each playbook to
  `agent/skills/<name>.md` before `eve build`, so Eve compiles them like built-in files.
  Instructions are added after `agent/instructions.md`, in alphabetical order; the overlay never
  overwrites an instruction file. A playbook with the same name as a built-in skill replaces it.
  A playbook without `description` frontmatter gets one from its first line, but write your own
  so the model can route on intent. File names use ASCII letters, digits, `_`, and `-`.
  In Docker, pass the pack as a build context: `docker build --build-context pack=./my-pack -t sym .`.
  Without it, the image builds with no pack. Mount the pack at `SYM_PACK_DIR` at runtime too,
  because the runtime reads `sym.config.yaml` from there.
- **Start:** Sym reads `sym.config.yaml` from `SYM_PACK_DIR`, validates it, and refuses to start
  on an error that names the file and the field. Seeding `schedules.yaml` rows comes later.
- **Session start:** `defineDynamic` adds approved learning-layer-2 rows from Postgres on top.

Milestone 1 checked this split: Eve 0.81.0 compiles pack instructions and playbooks from the
overlay, in `eve build` and in `docker build`.

## Secrets

Secrets never go in the pack or in this repository. Put the Slack bot token, the Slack signing
secret, the model API key, the database URL, and worker tokens in the deployment's environment.
See [self-hosting.md](self-hosting.md).
