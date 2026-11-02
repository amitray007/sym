# 087. Read-only research and on-demand skills belong to the brain

Status: accepted
Date: 2026-11-03

## Context

The brain can read public web pages and search (decision 086), but a multi-source investigation
can fill its conversation with working notes. Eve 0.88 supports declared subagents with their own
tools and skills loaded on demand. The existing verifier and writer have no tools and are called
only from `worker_job` (decisions 032 and 062). Pack playbooks already become Eve skills through
the build overlay (decision 035).

## Decision

1. Add a declared `researcher` with `defaultTools: false`. Its exact authored tool set is
   `web_fetch`, `web_search`, `slack_read`, and `jobs_status`. It has no connections, skills,
   nested agents, write tools, or Builder access. Search keeps decision 086's model-route limits.
   The child has its own context and returns concise findings, source links, conflicts, and
   limits. The brain answers a few-call question directly and uses research for several sources.
   Code changes, repository checkouts, and running code or tests still go to Builder with consent
   (decisions 063 and 071).
2. Expose research through an authored `research` task which refuses `isWorkerCaller` before
   opening the child. Eve 0.88 rejects a same-named tool and child during artifact validation,
   so the public tool and declared child have different names. The declaration uses `tool: false`
   so only the guarded wrapper exposes it.
   The brain must run at most three research calls at once. This is an instruction limit,
   not a hard concurrency cap: Eve permits 32 working tasks, and a process-local step counter
   cannot enforce one safely across replay, restarts, or multiple processes. Do not add the
   sandbox-backed `workflow({ maxSubagents })` tool. Disable the root `agent` copy with
   `tool: false`: a copy would inherit `worker_job`, Slack writes, and connections.
3. The researcher's `jobs_status` reads saved ledger facts only. The root tool may refresh a
   worker, change job state, and deliver posts, so it is not a read-only research tool. Slack reads
   use the immediate parent's session and turn for destination privacy checks and the read marker
   that requires approval for later writes. The child cannot choose its destination in an input.
   Every successful research task also marks its parent turn as read in a step, even when it
   read only web sources, so later posts and DMs need the requester's approval (decision 082).
   The returned answer is labeled as untrusted source data, never instructions or consent.
   Steps and approval policies are bundled separately, so the existing bounded turn-marker set
   lives in a shared process registry. The marker has the same process lifetime as Slack reads.
4. Add optional manifest `skills: [skills/<name>.md]` beside legacy `playbooks`. Both lists use
   the pack's path and real-path containment checks and become flat files in `agent/skills/`
   through the overlay. Each file is capped at 64 KiB of UTF-8 text. Reject invalid or reserved
   names, case-insensitive duplicate names across the lists, malformed frontmatter, invalid
   description or metadata types, and empty bodies before writing.
   Legacy playbooks may start with a Markdown horizontal rule or empty frontmatter; these
   retain the first-line description fallback. Explicit skills require valid frontmatter when
   they start with a delimiter. Missing descriptions use the existing first-line fallback.
   A pack skill may replace a built-in skill of the same name. Repo skills need only an
   `agent/skills/<name>.md` file.
5. Eve advertises skill descriptions and supplies `eve__skill` when skills exist, even with
   default tools disabled. Loading returns static instructions and adds no tools, authority, or
   consent. Keep skill publication off on the worker MCP channel (`skills: false`, `agent: false`);
   it publishes neither the research workflow nor catalog tools. Ship no new built-in procedure:
   no current instruction block needs moving. Tests supply generic skills. Supporting files and
   scripts need a sandbox, which this layer does not add. Approved Layer 2 rows and their approval
   rules stay unchanged (decisions 033 and 058).
6. Keep the root's $2 `sessionUsage` window and give each researcher its own $0.50 window.
   `SYM_RESEARCH_BUDGET_USD` overrides the child threshold with a positive finite USD amount;
   unset or invalid values use $0.50. Child tokens and reported costs roll into the parent only
   when the research task ends. The windows are independent, not one shared token budget.
   Direct-provider tokens use Sym's reference-rate estimate in both checks. Eve checks limits
   before the next model call, after completed usage arrives. A call may cross its threshold,
   and parallel children may spend more than the parent's remaining allowance before it checks.
   These are pause thresholds, not hard spend caps.

## Consequences

Research uses the brain's configured model and spend policy, with less working text in the main
conversation. The researcher cannot post its answer or acquire a connection through a skill.
Pack skill changes still need a rebuild. Repo and pack skill text is trusted deployment content,
while research sources remain untrusted data. Fixture tests prove child dispatch, ledger reads,
skill loading, and worker refusals without paid models or live Slack. They do not prove a model
will choose research or a skill well; that remains a real-model evaluation for the owner.
