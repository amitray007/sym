# 097. The brain knows the deployment's settings

Status: accepted
Date: 2026-11-12

## Context

Decision 068 told the brain which opt-in features are on. It did not tell the brain who may use
Sym, who the owner is, where the digest goes, which model it runs on, or which triggers and
connections are set up. Asked "who can use you?", the brain guessed. A brain that guesses about
its own setup gives wrong answers to the people who rely on it.

## Decision

1. A dynamic instruction, `agent/instructions/settings.ts`, adds "How Sym is set up here". It
   lists the configuration source (a pack or the environment), the owner, the allow-list,
   stranger replies, the thread name, the GitHub and Linear identity mappings, feedback buttons,
   the result writer, the digest channel and time, the pack's time zone, quiet hours, and default
   channel, the brain model and route, reasoning, the prompt-cache lifetime, the researcher
   budget, the transcription model, the sandbox's memory and image, the trigger run cap, the
   trigger gate, webhooks, the GitHub and Linear apps, the GitHub repository list, the callback
   and public addresses, and the API and MCP tokens.
2. Each line calls the helper the code itself reads, so the note matches the behavior. The
   allow-list and identity lists come from shared helpers in `lib/slack/guard.ts` and
   `lib/identities.ts`.
3. The note names settings and Slack user IDs, never a secret's value. A token or key shows
   only as set or not set. The brain looks names up with `slack_user` and tags a person only when
   asked. The allow-list shows at most 50 people, then a count.
4. The note goes to every Slack session. Strangers never reach the brain, so only allowed people
   see it. Worker threads get none. Projects, worker models, the worker label, and the persona
   keep their own instructions.

## Consequences

- People can ask Sym about its own setup and get the configured answer.
- A new setting adds a line here, next to its helper, or the brain will not know it.
