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

- **Build time:** the image build copies `instructions/` and `playbooks/` into the Eve agent
  folder before `eve build`, so Eve compiles them like built-in files. Pack files with the same
  name as a built-in file replace it.
- **Start:** Sym reads `sym.config.yaml` from `SYM_PACK_DIR`, validates it, and refuses to start
  on an error that names the file and the field. Seeding `schedules.yaml` rows comes later.
- **Session start:** `defineDynamic` adds approved learning-layer-2 rows from Postgres on top.

Milestone 1 confirms this split. Until then, treat it as the plan.

## Secrets

Secrets never go in the pack or in this repository. Put the Slack bot token, the Slack signing
secret, the model API key, the database URL, and worker tokens in the deployment's environment.
See [self-hosting.md](self-hosting.md).
