# 062. Results read in the persona's voice, with no template

Status: accepted
Date: 2026-10-21

## Context

Sym's code built every result from one template (decisions 044 and 047): a headline, a tl;dr cut
near 160 characters, the concerns, an "open questions" checklist, and a footer. The voice was
always neutral, whatever the persona. The brain's shared Voice rules also fixed a shape: the
answer in one line, then a list, about 6 lines. The owner wants the persona to set the voice and
the model to choose the shape. Workers also filled `open_questions` with notes, because the brief
showed only the empty field.

The template had reasons that still hold. A result written by the brain was lost when its
session died, and the brain repeated the worker's summary (decision 044). The result block is
data that Sym's checks read: the PR, the tests, and the changed files.

## Decision

1. A `writer` subagent writes the result of a finished code job. `worker_job` holds the job in
   `checking` (like the verifier), runs the verifier when it is on, then the writer. The writer
   gets the persona, the approved playbooks and rules (what the owner taught Sym), the job facts,
   the concerns from both checks, and the worker's result and report as untrusted data. Its
   instructions set no template. It has no tools and replies through an output schema
   (`{ text }`, at most 6,000 characters).
2. Sym's code still posts the result through the outbox. The post is the writer's text in a
   `markdown` block, then the verifier line, the check concerns as a numbered list, the open
   questions as a `☐` checklist, a `context` footer (status emoji, `J-n`, duration, tests, file
   count), and Open PR, Looks good, Fix, and Close. The verifier line, the concerns, and the open
   questions stay code-owned, so a worker report cannot talk the writer out of a warning or a
   decision. Slack mention tokens such as `<!channel>` and `<@U123>` in the written text lose
   their brackets, so copied report text pings no one.
3. The template is the fallback: when the writer's input cannot be read, the writer fails, times
   out (120 s, `SYM_WRITER_TIMEOUT_SECONDS`, cut so the verifier and the writer together stay a
   minute under the 10-minute watch lease), or returns no text; when reconcile finishes the job; for a Fix
   follow-up, which reconcile drives; for a scheduled check; for failures and cancellations; and
   with `SYM_RESULT_WRITER=off`. The switch is on by default, unlike the paid calls of decision
   054, because the owner asked for this to be how Sym speaks.
4. The brain's shared Voice rules keep only what is not style: facts, refs, links, and warnings
   stay exact, and the brain never repeats a Sym post. The persona files drop their structure
   lines. The voice evals that asserted a shape are removed.
5. The worker writes its report in any form. The brief says the JSON block is data for Sym's
   code, and that `open_questions` holds only decisions a person must make.

## Consequences

- Each finished code job in a live session costs one more model call.
- Results read differently from job to job and follow the persona. The facts that matter for a
  scan, the concerns and the footer, sit in the same place each time.
- Feedback still teaches through approved rows: a learned rule about results reaches the writer.
- A Fix follow-up's result uses the template until reconcile can run the writer.
