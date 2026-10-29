# 065. Connection approval, current Fix policy, and job-scoped worker callbacks

Status: accepted
Date: 2026-10-29

## Context

A connection proposal could send an existing environment token to an endpoint before approval.
Fix could resume a finished job after its project was removed. The shared worker bearer could
post questions and progress under any active job's reference.

## Decision

Connection proposals probe anonymously. An active name is refused before probing. Approval binds
the stored endpoint and credential reference; only an active connection may refresh its tool list
with that credential. Token-backed proposals show no authenticated tools until approval.

Fix applies the same current project and pack policy as launch before creating a row or sending
work. The recorded worker name, credential-free endpoint, and project ID must match. The follow-up
keeps the brief constraints and receives the current pack limits. Jobs without a recorded worker
identity must start a new job. An allowed user's typed Fix remains approval under decision 056.

Each new job gets an independent random 256-bit worker capability, stored in a private ledger
table before launch. Retries reuse it. The worker message gives the MCP endpoint and bearer; a
Fix gets a new capability for its new job. Authentication binds its job ID to the service principal.
Both progress and owner questions require that authenticated ID to match the target ledger row.
Terminal jobs cannot authenticate with their capability. The shared `SYM_MCP_TOKEN` retains the
global status-read policy of decision 027, but cannot call either mutating worker tool.

## Consequences

Migrations add nullable worker identity to jobs and a separate worker-capability table. Credentials
do not appear in job status. Capability tokens are stored in Postgres, like existing OAuth tokens,
and reach the worker's private conversation. Keep database backups and worker transcripts private.
Never copy capabilities into repository files, reports, Slack, or logs. No new deployment secret
or worker-wide MCP configuration is needed. Existing workers using only the shared bearer must
start a new Sym job to receive a scoped capability; their old jobs still finish through polling.
