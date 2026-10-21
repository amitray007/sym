# 044. The brain has a persona, and Sym's own messages are short, structured, and neutral

Status: accepted. Decision 062 drops the fixed shape: the persona sets the voice, the brain and
the `writer` subagent pick the shape, and the template result is the fallback.
Date: 2026-10-20

## Context

Live Slack replies were walls of text with no voice. A job result repeated its facts in several
places, listed the same concern twice, and ended with a raw worker thread ID. Then the brain
posted a second paragraph that summarized the same result.

The owner wants short, clear answers that are always structured, in a casual voice, with an
optional persona that may lightly tease the owner.

## Decision

Two kinds of message get two rules.

1. **The brain gets a persona.** `SYM_PERSONA` is `plain`, `casual` (default), or `spicy`. Each is
   a short, model-neutral Markdown file in `agent/personas/`. A dynamic instruction
   (`agent/instructions/persona.ts`) adds the text at session start and skips worker callers. An
   unknown value warns and uses `casual`. A pack may set `persona: <file>.md` (same path rules as
   `instructions`); it wins over the environment. The pack persona is read at start from
   `SYM_PACK_DIR`, so the overlay does not copy it.
2. **Shared Voice rules** in `agent/instructions.md` apply in every persona: the answer first in
   one line, then structure (numbered steps, bullets, `☐`/`✅` checklists), about 6 lines at most,
   bold on the key word only, never repeat a Sym post, and never change a fact, number, job ref,
   link, or warning.
3. **`spicy` has hard limits in its file.** It teases only the person talking to Sym. It never
   jokes about failures, incidents, data loss, security, health, or anything personal. It never
   jokes in briefs, approvals, permission DMs, sign-in, or errors. It makes at most one joke per
   message and drops jokes when the person seems stressed or the thread is about a problem.
4. **Sym's code-built messages stay neutral** and never get a persona. They become scannable:
   - The result starts with a status emoji (✅ done and matches, ⚠️ done with concerns, ❌ failed)
     and a title line. The tl;dr is the first sentence of the summary, capped near 160 characters,
     or the whole summary when it is short.
   - The model verdict merges into the concerns header: `⚠️ check before merge (75% sure)`. A
     clean verdict is one line.
   - Concerns are a numbered list. Sym drops near duplicates: it normalizes case, punctuation,
     and stop words, and treats high word overlap as the same line (`lib/jobs/similar.ts`). An open
     question that a concern already covers is dropped. Open questions are a `☐` checklist.
   - The footer holds the PR link, the first clause of the tests line, and the file count. The raw
     worker thread line leaves a normal result. A result with no summary and a failure keep it,
     because it is the only pointer.
   - The brief, status answers, quiet notice, and permission DM get the same style where it was a
     cheap change. The card blocks are unchanged.

## The duplicate re-summary

The `worker_job` task result returned the worker's `summary` and `lastMessage` with a note: "Sym
already posted this... Call no_reply unless the person asked for more." The brain received the full
text again, and the escape clause let it decide the person wanted more. The instruction also keyed
on a result that "says Sym already posted it", which no field said.

The result now holds only `job`, `status`, `threadId`, `posted: true`, and a short note to call
`no_reply` and write nothing. The summary stays in the ledger and in the posted result. The
instruction says: after a `worker_job` result with `posted: true`, call `no_reply` and write nothing.
The fixture brain does the same, and a test pins it.

## Consequences

The brain cannot restate a result it never receives, but a model can still ignore the rule. Voice
evals in `evals/voice/` pin it with a real model: the silence after a posted result, the short
structured shape, no long lines, and two persona floors (`pnpm eval:plain`, `pnpm eval:spicy`).
They use deterministic checks only. They cannot judge tone or prove that a joke is absent. The
owner runs them (decision 039).

Rule-check concern text and the model verifier's concerns keep their wording. Only the layout
changed. A persona file that a pack supplies can undo the casual tone but not the shared Voice
rules, which live in the core instructions. Built-in persona files are read from `agent/personas/`
under the working directory, which the image ships; a missing file warns and adds no persona.
