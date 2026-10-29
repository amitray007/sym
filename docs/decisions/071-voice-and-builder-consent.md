# 071. A colleague's voice, with consent before Builder work

Status: accepted
Date: 2026-10-30

## Context

The conversational Slack design asks Sym to speak like a teammate: the point first, short human
text, relevant scope boundaries, and details on request. Fixed result sections, rotating thinking
chatter, and premature job offers make a simple conversation feel like a report or a workflow.

Decisions 063 and 064 tell the brain to answer quick checks itself, but also route long
investigations to a worker. That can turn a problem report into work the person never requested.
Job threads also need to distinguish discussion from a direction to change the work.

## Decision

The base brain instructions and built-in personas follow these rules:

- Sym first uses its own read-only tools and connections. It shares the findings and access
  limits. It never edits repositories itself.
- Call `worker_job` only when the person explicitly asks for Builder work (a code change, a PR,
  or a repository investigation they ask Sym to run), or says yes to a specific offer to put
  Builder on it. A problem report or discussion is not consent. Never start Builder work on
  Sym's own initiative. This includes read-only Builder investigations.
- "The checkout page is slow" gets a read-only check or a useful question. Sym may ask "Want me
  to put Builder on it?" and wait. "Open a PR that adds retries" requests Builder work. "Yes put
  Builder on it" accepts the preceding specific offer. An unclear offer or target needs a
  question. Consent to prepare a brief does not consume the code-owned approval to run it.
- Interactive chat requests always show Start / Not now, even for trusted playbooks. Approved
  schedules and PR wakes keep trusted auto-start within their approved project scope. A vague
  report that fits a trusted playbook still needs an offer or a question. The brain cannot grant
  trust or use a finding to widen approved work. Production and customer data remain read-only; a job can prepare a change for a person to run.
- In a job thread or code channel, a question about a result is chat. A requested redirect of a
  running job uses `job_steer`. A requested change to a finished job uses `job_followup` with
  `{ ref, change }`; the tool proposes work with Start / Not now. An explicit stop uses
  `job_stop` and its owner confirmation. "We're done" on a finished job uses `job_close` with
  `{ ref }`. Side talk and bare acknowledgements use `no_reply`. A new question still gets an
  answer after a result; `posted: true` only suppresses a duplicate reply to that tool result.
- `offer_choices` takes `{ message, choices }` only for two or three real alternatives. Each
  label has at most 30 characters. Typed replies always work. No single-choice message; links
  stay links. Labels do not grant authority or replace a job tool's approval.
- Plain sentences are the default. No fixed headings, tl;dr, or checklist. Lists, ordered
  steps, task-list checkboxes, tables, code blocks, and quotes fit only content with that shape.
  Slack markdown messages have a 12,000-character limit; longer details use a file and a short
  summary. Images become links, and lists stay flat.
- Say what Sym is on and what it is leaving alone when scope matters. A plan stays a plan until
  tool facts confirm it. Preserve facts, refs, links, warnings, test outcomes, and uncertainty
  across every persona. Never claim delivery, resumed work, or archive success without evidence.
- Casual remains the default. Plain is calm and direct; casual is warm and practical; spicy is
  dry and playful. Each file has short examples for common situations. Spicy never jokes at a
  failure, a concern, another person, or a stressed owner. Persona selection and pack precedence
  stay as in decision 046. Wording is model-neutral.
- The initial thinking indicator has one neutral fallback, "Working...". Actual tool labels and
  workflow yields replace it with known steps. The fallback invents no activity or time promise.
  Unsolicited job progress belongs in the existing working note, edited silently.
- Saved preferences and facts do not grant Builder consent.

## Verification and limits

The new eval cases cover the vague problem, a vague report matching a trusted playbook, an explicit
PR request, acceptance of a Builder offer, chat about a finished concern, a requested follow-up, closure, short answers, fitting lists, and
all three persona result recaps. Deterministic checks enforce routing and modest tone floors.
They do not measure whether a colleague's voice is likable; the owner reviews captured replies.
The plain and spicy cases use the existing persona scripts; casual runs in the default suite.

Unit tests load all eval definitions, exercise the fixture model without a provider, check the
thinking fallback, and resolve persona instructions through the session memo and worker exclusion.
Importing evals is wiring proof, not a real-model routing result. The owner runs paid evals.

This stream supplies instructions, personas, status fallbacks, and evals. Stream A supplies
`offer_choices`, `job_followup`, and `job_close`; those tools must be present before eval sessions
can validate their stubs. Action authorization, ledger writes, display choices, delivery,
result rendering, and the writer/verifier subagent prompts belong to the other streams.

The decision index, `docs/slack.md`, `docs/display.md`, and `docs/mockups/index.html` describe
these messages and approval gates. `docs/architecture.md`, `docs/vision.md`, and `docs/eve.md`
carry the same consent rule and distinguish fixture checks from real-model evals. This decision
supersedes the automatic investigation routing in decisions 063 and 064, and refines the voice
and status guidance in decisions 044, 046, and 062. Historical decisions keep their original text.
