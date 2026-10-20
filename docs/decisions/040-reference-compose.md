# 040. One compose file runs the local lab and the deployment

Status: accepted
Date: 2026-10-20

## Context

The repo-root `compose.yaml` ran only the local Postgres, and the Dockerfile builds only the app.
A deployment needs Sym, a Postgres with a persistent volume, a public route for two paths
(decision 006), and a private route to and from the worker. A second compose file for the
deployment would repeat the Postgres service and drift from it.

## Decision

`compose.yaml` holds both. `pnpm db:up` starts only its `postgres` service, with the password
`sym` on `127.0.0.1:55432`. `docker compose up` runs all three services:

- Sym, built from the Dockerfile. The file builds `DATABASE_URL` from `POSTGRES_PASSWORD`, which
  a deployment must set.
- Postgres 18 with a named volume, published on loopback only.
- A Tailscale sidecar in kernel mode with accepted DNS. Sym shares its network, so Sym reaches the
  worker's MagicDNS name. Tailscale Serve (`deploy/tailscale/serve.json`) publishes Sym on the
  tailnet for the worker and operators.

The public domain points at the sidecar's port 3000 with one entry per public path. Dokploy uses
the default compose path and passes the Environment tab through `.env`.

## Consequences

A deployment needs a Tailscale auth key and MagicDNS on the tailnet. Sym has no `ports` of its
own: the domain and Serve reach it through the sidecar. A change to the Postgres service applies
to the lab and the deployment at once.
