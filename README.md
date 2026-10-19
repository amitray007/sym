# Sym

Sym is a self-hosted Slack agent that hands real work to coding agents and reports back only what
matters.

You ask in Slack. Sym writes a brief, gets your approval, and starts a job on a worker: a Claude
Code or Codex thread on your own machine, run through [T3 Code](https://github.com/pingdotgg/t3code).
Sym tracks the job, answers status questions, relays the worker's questions as buttons, checks the
result, and posts the outcome. A scheduled check that finds nothing posts nothing.

> Status: design, before the first spike. There is no runnable code yet. The documents in
> [`docs/`](docs/README.md) are the source of truth.

## How it works

```
 Slack ──HTTPS──▶ Sym (Eve app, Node 24)  ──MCP / OAuth──▶  Worker (T3 Code on your machine)
                   │  channels: Slack, MCP                    Claude Code / Codex threads
                   │  tools: jobs, schedules, memory          in your repositories
                   ▼
                 Postgres: jobs ledger, schedules, outbox, feedback, memory
```

- **Brain:** [Eve](https://eve.dev), Vercel's agent framework, self-hosted. It talks in Slack,
  keeps durable job workflows, and asks for approvals.
- **Hands:** a worker adapter. The first adapter drives T3 Code through its remote MCP endpoint
  over a private network. The heavy work runs on the worker, on your own agent subscriptions.
- **Truth:** a Postgres job ledger. A job survives a lost Slack session, a restart, and an upgrade.
- **Display rule:** code, not model taste, decides whether a message is silent, plain text, text
  with buttons, a live job card, or a summary with a file. Edits notify nobody; new messages
  notify. Progress goes into card edits.
- **Learning:** memory facts take effect at once. New playbooks and rules wait for a one-click
  approval. Code changes arrive as draft pull requests that a person merges.

## What Sym is not

- A hosted service. You run it on your own server.
- A coding agent. It plans, delegates, watches, and checks. Workers write the code.
- Tied to one company. Your playbooks, schedules, and repository rules live in your own private
  pack (see [docs/adopting.md](docs/adopting.md)).

## Documentation

Start with [docs/README.md](docs/README.md). The [mockups](docs/mockups/index.html) show every
Slack surface and flow as a single HTML page.

## License

[MIT](LICENSE)
