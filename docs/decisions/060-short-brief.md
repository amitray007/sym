# 060. The brief post is short, with a Full brief button

Status: accepted
Date: 2026-10-21

## Context

Before each Start prompt, Sym posted the whole brief in the job thread: the goal, every
constraint, and every done-when check. The brain writes these for the worker, so they are long
and detailed. The owner reads the title and the project to decide on Start, and scrolls past the
rest. Asking the brain to write a shorter brief would not help: code builds the post, and the
worker needs the detail.

## Decision

1. The brief post shows the title, the project, the delivery (draft PR, or a commit with no
   push), the model line, and the playbook line. The delivery stays because it says what the job
   may write.
2. The post has a **Full brief** button (`sym_job_brief`). A click reads the brief from the
   ledger and sends the goal, constraints, done-when list, base branch, and delivery privately
   to the person who clicked. It answers only in the job's own channel. The button works
   before, during, and after the job. The Start prompt points to the button.
3. A trusted playbook's brief has no Start line, because no Start prompt follows (decision 059).
4. The worker still gets the whole brief. Only the Slack post changes.

## Consequences

- The thread before Start is three or four lines.
- The owner approves without the goal and constraints on screen. They are one click away, and
  the title and delivery carry the decision. A brief the owner wants to change still goes through
  Edit.
- The answer to a click is ephemeral, so it does not stay in the thread and other people do not
  see it. Like the other job button answers, it is a private reply to a click, not a post, so it
  skips the outbox and `chooseDisplay`.
