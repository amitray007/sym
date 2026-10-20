# 040. A reference compose file deploys Sym with Postgres and a Tailscale sidecar

Status: accepted
Date: 2026-10-20

## Context

The repo-root `compose.yaml` runs only the local Postgres, and the Dockerfile builds only the app.
A deployment needs Sym, a Postgres with a persistent volume, a public route for two paths
(decision 006), and a private route to and from the worker. Each adopter would otherwise wire
these by hand.

## Decision

`deploy/compose.yaml` runs three services. Postgres 18 keeps its data in a named volume, and the
file builds `DATABASE_URL` from `POSTGRES_PASSWORD`. A Tailscale sidecar runs in kernel mode with
accepted DNS, and Sym shares its network, so Sym reaches the worker's MagicDNS name. Tailscale
Serve publishes Sym on the tailnet for the worker and operators. The public domain points at the
sidecar's port 3000 with one entry per public path. Dokploy reads the file from its compose path
and passes the Environment tab through `.env`.

## Consequences

A deployment needs a Tailscale auth key and MagicDNS on the tailnet. Sym has no `ports` of its
own: the domain and Serve reach it through the sidecar. The root `compose.yaml` stays the local
lab.
