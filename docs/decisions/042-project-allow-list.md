# 042. Sym touches only the projects on its allow-list

Status: accepted
Date: 2026-10-20

## Context

An owner can have many T3 Code projects and want Sym to work on a few. Sym's T3 token can read
every project, thread, and file on the worker. The brain must never see, name, list, guess, or
discuss a project outside the few. Only Sym's own code can enforce that.

## Decision

Sym keeps a project allow-list, and it fails closed:

- With a pack, the allowed projects are the pack's `projects` (decisions 026 and 030).
- Without a pack, `SYM_PROJECTS` lists them: comma-separated T3 project titles or IDs. An entry
  matches by exact ID or case-insensitive exact title.
- With neither, nothing is allowed. No job starts, and the brain is told no projects are
  configured.

`lib/projects/allowed.ts` holds the list and the checks. It is pure, so a workflow body can reach
it. Code enforces the list at each point before a worker runs:

1. `t3_job` checks the brief's project first. A refused brief records no job and posts no brief.
2. `planLaunch` checks again, so a stored brief or a schedule for a removed project fails closed.
3. `schedule_create` refuses a brief for a project off the list. The schedule dispatcher skips a
   schedule whose project left the list and records the run as failed. `t3_job` would refuse it too.
4. `worker_projects` is a read-only tool. It asks the worker for its projects and returns only the
   allowed ones, with the T3 title and whether the worker has each. It never returns or counts
   other projects. When the worker is unreachable, it still returns the allowed names with state
   `unknown`.

A refusal reads `"X" is not one of Sym's projects. Sym works on: a, b.` The words are the same
whether X exists on the worker or not, so a refusal never confirms that another project exists.

A dynamic instruction gives the brain the allowed names. `agent/instructions.md` tells it to work
only on those projects, never to name, list, guess, or discuss any other project, and to use
`worker_projects` to resolve a name.

The decision also fixes two small logging gaps. The Slack allow-list now logs one `console.warn`
line with the Slack user ID when it drops a request (no text). A failed ephemeral reply logs
Slack's error code, never the message. The worker sign-in tool now tells the brain when the DM
could not be sent yet, so it does not say "check your DM".

## Consequences

Sym's T3 token still reads every project. The guard is Sym's code, not T3 permissions. A bug in
that code, or a new tool that calls the worker, could leak a project. Every new path from T3 to
the brain must filter through the list. Existing jobs for a project that left the list stay in the
ledger and in `jobs_status`, because they are Sym's own jobs.

A separate T3 instance for Sym (`T3CODE_HOME` or `--base-dir`) or OS-level isolation is the
stronger option, because the token then cannot reach the other projects at all. It is not built.
Moving to a pack or changing `SYM_PROJECTS` takes effect at the next process start.
