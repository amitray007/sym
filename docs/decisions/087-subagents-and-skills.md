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
   Independent task calls can run in parallel, within Eve's session task limit. Do not add the
   sandbox-backed `workflow({ maxSubagents })` tool. Disable the root `agent` copy with
   `tool: false`: a copy would inherit `worker_job`, Slack writes, and connections.
3. The researcher's `jobs_status` reads saved ledger facts only. The root tool may refresh a
   worker, change job state, and deliver posts, so it is not a read-only research tool. Slack reads
   use the immediate parent's session and turn for destination privacy checks and the read marker
   that requires approval for later writes. The child cannot choose its destination in an input.
4. Add optional manifest `skills: [skills/<name>.md]` beside legacy `playbooks`. Both lists use
   the pack's path and real-path containment checks and become flat files in `agent/skills/`
   through the overlay. Reject invalid or reserved names, duplicate names across the lists,
   malformed frontmatter, invalid description or metadata types, and empty bodies before writing.
   Missing descriptions use the existing first-line fallback. A pack skill may replace a built-in
   skill of the same name. Repo skills need only an `agent/skills/<name>.md` file.
5. Eve advertises skill descriptions and supplies `eve__skill` when skills exist, even with
   default tools disabled. Loading returns static instructions and adds no tools, authority, or
   consent. Keep skill publication off on the worker MCP channel (`skills: false`, `agent: false`);
   it publishes neither the research workflow nor catalog tools. Ship no new built-in procedure:
   no current instruction block needs moving. Tests supply generic skills. Supporting files and
   scripts need a sandbox, which this layer does not add. Approved Layer 2 rows and their approval
   rules stay unchanged (decisions 033 and 058).
6. Keep the root's $2 `sessionUsage` check. Eve applies it to a child with no separate limit.
   Child tokens and reported costs also count in the parent's usage when the research task ends.
   Direct-provider tokens use Sym's reference-rate estimate, as for the root. Each limit is checked
   before the next model call, after completed usage arrives; concurrent children can pass the
   combined budget before the parent checks it. This is a pause threshold, not a hard spend cap.

## Consequences

Research uses the brain's configured model and spend policy, with less working text in the main
conversation. The researcher cannot post its answer or acquire a connection through a skill.
Pack skill changes still need a rebuild. Repo and pack skill text is trusted deployment content,
while research sources remain untrusted data. Fixture tests prove child dispatch, ledger reads,
skill loading, and worker refusals without paid models or live Slack. They do not prove a model
will choose research or a skill well; that remains a real-model evaluation for the owner.
