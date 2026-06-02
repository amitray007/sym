# Sym documentation

Organized by [Diátaxis](https://diataxis.fr/) — four kinds of docs, each with a
distinct job, so you can find what you need by the question you're asking.

## Tutorials — _learning by doing_

- **[Quick start](../README.md#quick-start)** — install, configure, and run Sym
  locally (and via Docker), end to end.

## How-to guides — _task-oriented_

- **[MCP connector setup](./mcp-setup.md)** — wire in an MCP connector (stdio,
  http, OAuth, ambient CLI), inject credentials, and reconcile the live pool.
- **[examples/](../examples/)** — copy-pasteable connector `config.json` to start from.

## Reference — _information-oriented_

- **[Environment variables](./reference/env-vars.md)** — every config variable,
  its default, and what it does.
- **[Dependency graph](./reference/dependency-graph.mmd)** — the committed
  package/module DAG (also `dependency-graph.json`).

## Explanation — _understanding-oriented_

- **[ARCHITECTURE.md](../ARCHITECTURE.md)** — the two-tier design, the invariants
  (I-1…I-7), and a turn's lifecycle.
- **[FUTURE.md](./FUTURE.md)** — parked ideas and the rationale for keeping the
  local-state control tier.

---

For contributors: `docs/refactor/` holds the OSS-readiness audit and the
dependency-ordered chunk backlog that drove this restructure.
