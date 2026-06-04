# Z16 — System-level Cross-Cutting Concerns

**Auditor:** corrective pass (2026-06-02). Closes CRITIQUE.md gaps M2, M3, M4, M5.
**Files reviewed:** `apps/agent/src/handle-turn.ts`, `apps/agent/src/pi/loop.ts`,
`apps/agent/src/tui/ui/theme.ts`, `apps/agent/src/tui/ui/components.tsx`,
`apps/agent/src/tui/index.tsx`, `apps/agent/src/tui/app.tsx`,
`apps/agent/src/tui/screens/Dashboard.tsx`, `apps/agent/src/tui/screens/SecretsManager.tsx`,
`apps/agent/src/cli/index.ts`, `apps/agent/package.json`, `package.json`,
`.github/workflows/ci.yml`, plus grep-wide passes across `apps/agent/src/` and
`packages/` for logging and console calls.

---

## Area 1 — Logging / Observability

### Ground-truth counts (confirmed by grep, 2026-06-02 HEAD)

| Level           | Count outside `cli/` | Count inside `cli/`            |
| --------------- | -------------------- | ------------------------------ |
| `console.warn`  | ~100                 | 0                              |
| `console.info`  | ~22                  | 0                              |
| `console.error` | ~10                  | 1 (`stderr` for removed verbs) |
| `console.log`   | **0**                | ~25 (legitimate CLI output)    |

The two `console.log` calls the CRITIQUE flagged (`workspace-context.ts:100`,
`mcp/store.ts:105`) are **not executable log statements**: the first is a code
comment (`// console.log…`) and the second is a string literal inside a help-text
array. There are zero executable `console.log` calls in the server/agent path. The
MEMORY rule is currently upheld. The risk is regression — future contributors
writing `console.log` for quick debug won't notice the rule unless CI enforces it.

Despite clean `console.log` hygiene, the logging posture has real structural gaps:

### Findings

| ID     | Severity | Category      | Short description                                                                                      | Evidence                                          | Effort  |
| ------ | -------- | ------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------- |
| Z16-01 | low      | logging       | No CI grep-gate preventing `console.log` in server path                                                | `ci.yml` — no such step                           | trivial |
| Z16-02 | medium   | observability | No per-turn correlation id; ~123 ad hoc `console.*` calls carry no shared context                      | All `console.*` in `apps/agent/src/` (excl. cli/) | small   |
| Z16-03 | low      | logging       | No log-level convention documented or enforced; `warn`/`info`/`error` usage is idiomatic but unwritten | All server-path log calls                         | trivial |

---

### Z16-01 — No CI gate forbidding `console.log` outside `cli/` (LOW)

**Evidence:** `.github/workflows/ci.yml` runs typecheck, lint, test, and build.
No step checks for `console.log` in the server path. ESLint does not forbid it
(no `no-console` rule in the eslint config). The project's MEMORY rule ("server
logs never `console.log`; the CLI tests spy on `console.log` and `JSON.parse` it,
so any server `console.log` races into `--json` output — flaky CI, bit twice")
describes a failure mode already observed in production twice. The protection is
currently tribal knowledge, not a machine check.

**Recommendation:** Add a CI step (30-second grep) that fails if any `.ts` or
`.tsx` file outside `apps/agent/src/cli/` contains a non-comment, non-string
`console.log` call:

```yaml
- name: No console.log outside cli/
  run: |
    hits=$(grep -rn 'console\.log' apps/agent/src packages \
      --include='*.ts' --include='*.tsx' \
      | grep -v 'src/cli/' \
      | grep -v '//.*console\.log' \
      | grep -v "console\.log'" \
      | grep -v '".*console\.log') || true
    if [ -n "$hits" ]; then echo "$hits"; exit 1; fi
```

This is a one-time 5-minute addition; it guards the regression indefinitely.

**Effort:** trivial. **Blast radius:** isolated (CI config only).

---

### Z16-02 — No per-turn correlation id in log output (MEDIUM)

**Evidence:** `handle-turn.ts` and `pi/loop.ts` together emit ~60 `console.warn`
calls. Each carries a human prefix (`[agent]`, `[pi]`, `[mcp]`, `[render]`) but
no turn id. When two concurrent turns fire (slash command + DM), their interleaved
`[agent] appendStream failed` / `[agent] history fetch failed` lines are
indistinguishable in the log stream. The `Turn` type already carries `turn.id`
(`handle-turn.ts:948–950`: `console.warn('[agent] turn ${turn.id} has no
channelId')` uses it in one place, but the pattern is not applied consistently).

**Recommendation:** Thread `turn.id` (a short UUID already generated per-turn) as
a prefix on every log call inside `handleTurn`, `streamReply`, `runTurnLoop`,
and `runLoopPi`. A small helper `logCtx(turnId: string)` returning `{warn, info,
error}` functions that prepend `[turn:<id>]` makes this a low-churn change and
preserves the existing non-structural format (no structured logger needed).
Structured logging (pino/winston) would be a larger investment; the immediate
value is the correlation id, which can be backfilled later.

The full argument for a structured logger (JSON lines, log-level filtering, sink
routing) exists but is a separate investment decision. The in-scope recommendation
here is: add the correlation id, document the `warn`/`info`/`error` convention
(already idiomatic — just write it down), and defer structured logging.

**Effort:** small. **Blast radius:** package (`apps/agent/src/` logging calls).

---

### Z16-03 — Log-level convention is unwritten (LOW)

**Evidence:** The three log levels are used idiomatically (`error` = fatal/data
loss, `warn` = degraded but continuing, `info` = structural events at boot/reload)
but this convention is not documented anywhere in the codebase (not in
`CONTRIBUTING.md`, not in code comments). A new contributor writing a warning will
guess correctly most of the time, but won't know the difference between `warn` and
`error` at the boundary of "recoverable" vs "system broken."

**Recommendation:** Add a single paragraph to `ARCHITECTURE.md` (the C22 target
doc) codifying: `error` = unrecoverable / action required; `warn` = degraded but
the turn continues; `info` = structural state change (boot, reload, warm). No code
change required.

**Effort:** trivial. **Blast radius:** isolated (docs).

---

## Area 2 — Performance as a System Property

### Hot-path anatomy

A Sym turn follows this sequence (inferred from `handle-turn.ts:948–1057` and
`pi/loop.ts:387–734`):

1. **Event ingress + dedup** — Hono route → signature verify → dedup LRU →
   `handleTurn` called off the hot path (async, 200 ACK returned immediately
   to Slack). No latency contribution here from the user's perspective; Slack
   requires the 200 within 3 s but the turn runs independently.
2. **History + context load** — `Promise.all([loadTurnHistory, loadViewedChannelContext])`
   → up to two Slack API calls (`conversations.replies` or `.history`). These are
   the first user-visible latency contributors. Un-threaded turns fetch
   `HISTORY_LIMIT = 20` recent messages; threaded turns fetch the full thread
   (unbounded).
3. **Mention rewrite** — `nameResolver.rewriteMentions` on the user's message and
   each history message (one cache-miss Slack API call per unknown id). Concurrent
   via `Promise.all` over history; the turn message is sequential.
4. **Tool registry build** — `initMcpPool` (await on first turn only; subsequent
   turns are cheap), `ToolRegistry` instantiation, `partitionDescriptors`. Cheap
   after warm.
5. **Pi loop** — `agent.prompt(userText)` → one or more LLM calls + tool
   dispatches. This is the dominant latency component. There is no timeout or
   max-round guard in `runLoopPi`; theoretically the loop runs until the model stops
   calling tools. In practice Fireworks latency per call is 1–4 s; a 3-tool turn
   could easily take 8–15 s total.
6. **Cleanup LLM call** — `cleanupReply` fires an additional LLM call whenever any
   tool ran or a plan was set (`handle-turn.ts:364–366`). This adds 1–3 s to every
   non-trivial turn.
7. **Streaming delivery** — `chatAppendStream` calls batched by `FLUSH_CHARS = 60`;
   stream close at turn end. Latency here is network-bound to Slack.

### Findings

| ID     | Severity | Category    | Short description                                                                                                                  | Evidence                                                                                                                                 | Effort       |
| ------ | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Z16-04 | medium   | performance | No per-turn latency budget or timeout guard on the Pi loop; runaway tool loops have no ceiling                                     | `pi/loop.ts:613–697` (Agent.prompt, no maxRounds)                                                                                        | small        |
| Z16-05 | medium   | performance | Thread context fed to the model is unbounded for threaded turns; a 500-message thread sends the full payload to the LLM            | `handle-turn.ts:104` (HISTORY_LIMIT only applies to un-threaded turns), `handle-turn.ts:522–527` (`conversations.replies` with no limit) | small        |
| Z16-06 | low      | performance | Cleanup LLM call (`cleanupReply`) adds 1–3 s to every tool-using turn even on buffer-mode delivery where the body is already clean | `handle-turn.ts:364–366`, `handle-turn.ts:797–798`                                                                                       | medium       |
| Z16-07 | low      | performance | Per-turn micro-findings (Z03-10, Z07-10, Z08-08, Z06-14, Z05-15) lack a systemic frame; no per-turn token/cost envelope exists     | See referenced findings                                                                                                                  | small (docs) |

---

### Z16-04 — No timeout/max-rounds guard on the Pi loop (MEDIUM)

**Evidence:** `pi/loop.ts:613–697` constructs an `Agent` and calls `agent.prompt(userText)`
with no `maxRounds`, `timeout`, or `AbortSignal` deadline. The `signal` path
(`loop.ts:687–692`) wires an external `AbortSignal` to `agent.abort()` — the
infrastructure exists — but `runLoopPi` itself never sets a deadline. A model that
keeps calling tools (or Fireworks that starts returning errors) will loop
indefinitely, holding the turn open and consuming credits without bound.
`handleTurn` calls `runTurnLoop` with no timeout either.

**Recommendation:** Add a per-turn deadline: pass a `AbortSignal.timeout(TURN_TIMEOUT_MS)`
(60 000 ms is a reasonable ceiling for a Slack interaction) into `runLoopPi` as
the external `signal`. Separately, consider a `maxRounds` knob on the Pi `Agent`
if the SDK exposes one. The abort path already surfaces a graceful error reply
(`loop.ts:706–712`). Document the ceiling in ARCHITECTURE.md.

**Effort:** small. **Blast radius:** package (`pi/loop.ts`, `handle-turn.ts`).

---

### Z16-05 — Threaded turn context is unbounded (MEDIUM)

**Evidence:** `handle-turn.ts:522–527`:

```ts
({ messages } = await deps.slackClient.conversationsReplies({
  channel,
  ts: turn.threadTs,
}));
```

`HISTORY_LIMIT = 20` (line 104) applies only to the un-threaded path
(`conversations.history`, line 529–530). The threaded path has no `limit`
parameter, which means a 200-reply thread sends all 200 messages to
`threadToHistory` and then to the model. At ~500 tokens/message, a 200-message
thread approaches the model's context window and incurs a proportionally large
cost on every subsequent turn.

**Recommendation:** Add a `limit` (e.g. 80 messages, configurable via
`SYM_THREAD_HISTORY_LIMIT`) to the `conversationsReplies` call. The
`adapter-slack` `SlackClient` interface already accepts `limit` on
`conversationsHistory`; confirm it does on `conversationsReplies` and add the
parameter. Document the default in ARCHITECTURE.md as part of the per-turn cost
envelope.

**Effort:** small. **Blast radius:** package (`handle-turn.ts`, `adapter-slack`
interface, and tests).

---

### Z16-06 — Cleanup LLM call fires even in buffer mode where the body is already unseen (LOW)

**Evidence:** `handle-turn.ts:797–798` (`cleanBody` in buffer mode) and
`handle-turn.ts:844–858` (CASE 3 live-with-stream) both call `cleanupReply`. In
buffer mode the body was never streamed to the user — it was held entirely in
memory. The narration the cleanup targets never appeared on screen. The LLM call
is still made, adding 1–3 s and ~$0.001 per turn. `needsLlmCleanup` (line 364)
gates on "any tool ran", which is exactly the condition that triggers buffer mode.

**Recommendation:** In buffer mode, `cleanupReply` is redundant if the model
produced a clean direct answer (no narration was shown). Consider skipping cleanup
in buffer mode when the draft doesn't contain known narration markers
(`…searching`, `…reading`, `let me`, `I'll`). This is a heuristic; the safer path
is to accept the cost and skip cleanup only on very short replies (under 100 chars)
where narration is unlikely. Either way, document this as a known cost contribution
in the per-turn budget.

**Effort:** medium. **Blast radius:** package (`handle-turn.ts`, tests).

---

### Z16-07 — Scattered micro-findings need a systemic latency/cost frame (LOW)

**Evidence:** Five existing performance findings are unconnected:

- Z03-10: fat Docker image (deploy-time, not turn-time)
- Z07-10: `resolveCliCapabilities()` + `resolveAllowlist()` called twice per turn
- Z08-08: config file read up to 3× per `resolveCliCapabilities` call
- Z06-14: `fieldsFor(d)` called twice per search match
- Z05-15: `Agent` re-instantiated in `cleanupReply` on each call

Collectively, Z07-10 + Z08-08 add synchronous file I/O on every turn. Z05-15 adds
an `Agent` object allocation on every cleanup call. None of these is individually
critical, but they add up to a pattern: there is no per-turn cost envelope.

**Recommendation:** Add a "Per-turn latency and cost budget" section to
ARCHITECTURE.md (slot into C22). Define three tiers:

- **Simple reply (no tools):** target < 3 s wall time, < 1000 prompt tokens.
- **Single-tool turn:** target < 8 s, < 3000 prompt tokens.
- **Multi-tool turn with cleanup:** target < 15 s, < 6000 prompt tokens.

Reference the above micro-findings as addressable within these budgets. Add the
Fireworks cost per 1 k tokens so per-turn cost can be estimated from usage data
in the receipt footer (already tracked via `reply.receipt.usage`).

**Effort:** small (documentation + one calculation). **Blast radius:** isolated
(docs).

---

## Area 3 — Third-Party License / Supply Chain

### License compatibility check (confirmed 2026-06-02 against installed packages)

All runtime dependencies use permissive licenses:

| Package                         | Version | License | Note                                                  |
| ------------------------------- | ------- | ------- | ----------------------------------------------------- |
| `@modelcontextprotocol/sdk`     | 1.29.0  | MIT     |                                                       |
| `hono`                          | 4.12.22 | MIT     |                                                       |
| `ink`                           | 5.2.1   | MIT     |                                                       |
| `ink-text-input`                | 6.0.0   | MIT     |                                                       |
| `react`                         | 18.3.1  | MIT     |                                                       |
| `yaml`                          | 2.9.0   | ISC     | ISC is permissive; equivalent to MIT for our purposes |
| `@earendil-works/pi-agent-core` | 0.75.5  | MIT     |                                                       |
| `@earendil-works/pi-ai`         | 0.75.5  | MIT     |                                                       |
| `@hono/node-server`             | 1.13.7  | MIT     |                                                       |

No GPL, LGPL, AGPL, or EUPL packages are present in the runtime closure. The
project's own `LICENSE` is MIT (copyright "Sym authors", which is acceptable for
a personal project). **No NOTICE/attribution file is legally required** under MIT
or ISC.

The Fireworks API and Slack Events API are consumed as remote HTTP services; their
terms of service govern usage, not their SDK licenses (neither publishes a
first-party Node SDK in the monorepo — Fireworks is reached via pi-ai's
OpenAI-compatible surface, Slack via the adapter's own `fetch`-based client).

### Findings

| ID     | Severity | Category     | Short description                                                                                                                                             | Evidence                               | Effort  |
| ------ | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------- |
| Z16-08 | low      | supply-chain | `dependabot.yml` does not exist; npm ecosystem has no automated vulnerability/update scanning                                                                 | `.github/` has only `workflows/ci.yml` | trivial |
| Z16-09 | low      | supply-chain | No SBOM generated or committed; relevant if the project is ever published as OSS                                                                              | No `sbom.json`/CycloneDX in repo       | trivial |
| Z16-10 | low      | docs         | License is "MIT" but no NOTICE needed; a brief `THIRD-PARTY-LICENSES.md` would satisfy the "disclose license text" clause for bundled/redistributed scenarios | No `THIRD-PARTY-LICENSES.md`           | trivial |

---

### Z16-08 — No `dependabot.yml` for the npm ecosystem (LOW)

**Evidence:** `.github/` contains only `workflows/ci.yml`. There is no
`dependabot.yml`. C21 was noted in the existing backlog as adding dependabot for
GitHub Actions only. The npm dependency tree (ink, hono, MCP SDK, pi-ai) is not
scanned for vulnerability advisories. The CI pipeline does not run `pnpm audit`.

**Recommendation:** Add `.github/dependabot.yml` with two entries: one for
`npm` (all pnpm workspaces) and one for `github-actions`. Weekly cadence is
sufficient for this project. Optionally add `pnpm audit --audit-level=high` as a
CI step; this is a 30-second job and catches critical CVEs immediately on lock
changes.

**Effort:** trivial. **Blast radius:** isolated (CI config).

---

### Z16-09 — No SBOM (LOW)

**Evidence:** No `sbom.json`, `bom.xml`, or CycloneDX artifact is generated. For a
private personal tool this is fine. If the project is ever published to npm or
used as a base image by others, an SBOM is part of OSS supply-chain best practice
(SLSA Level 2+).

**Recommendation:** Defer until OSS launch (slot under C21). At that point, add a
`pnpm sbom` or `cyclonedx-npm` step to CI and commit the artifact. No action
needed now.

**Effort:** trivial when deferred. **Blast radius:** isolated.

---

### Z16-10 — No `THIRD-PARTY-LICENSES.md` (LOW)

**Evidence:** The project bundles its dependencies into a Docker image (and will
eventually into a `dist/` for CLI distribution). MIT/ISC licenses require
preserving the copyright notice in redistributed binaries, but they do not require
a separate attribution document. A `THIRD-PARTY-LICENSES.md` is good practice for
an OSS release and reassures downstream users without being legally mandatory here.

**Recommendation:** Generate one with `license-checker --production --csv` or
`pnpm licenses list` and commit it under C21. Two minutes of work.

**Effort:** trivial. **Blast radius:** isolated.

---

## Area 4 — TUI Accessibility

### Ink 5 + Chalk 5 capability summary (confirmed against installed packages)

- **Ink 5.2.1** uses `chalk ^5.3.0`, which ships its own vendored `supports-color`
  (found at `chalk@5.6.2/node_modules/chalk/source/vendor/supports-color/index.js`).
  Chalk 5's vendored `supports-color` **does not honor the `NO_COLOR` env var**
  (grep confirms no `NO_COLOR` in that file; `NO_COLOR` support was added in
  `supports-color@9`). `FORCE_COLOR` and `--no-color` CLI flags are honored.
- **Ink 5 detects CI via `is-in-ci`** and adjusts its rendering (`ink.js:111,149,
166,190`): in CI it avoids raw mode, uses static rendering, and does not attach
  to stdin. This is automatic.
- **Ink reads `stdin.isTTY`** (`ink/build/components/App.js:return this.props.stdin.isTTY`)
  to decide whether to enter raw mode; non-TTY environments (piped input, CI) fall
  through to safe degraded rendering automatically.
- **The CLI entry point** checks `process.stdout.isTTY` before launching the TUI
  (`cli/index.ts:620`): `sym` piped to `cat` prints help text, not a TUI. The
  explicit `sym menu` / `sym tui` subcommands bypass this guard and launch the TUI
  unconditionally — they will hang or produce garbage in a non-TTY.

### Theme review

`theme.ts` defines five named color aliases:

```ts
accent: 'cyan', ok: 'green', warn: 'yellow', bad: 'red', dim: 'gray'
```

These are Ink `<Text color="...">` string names, resolved by Chalk's ANSI palette.
The contrast ratios against a typical dark terminal background (black/near-black)
are: cyan (~4:1), green (~3:1), yellow (~8:1), red (~4:1), gray (~1.5:1). The gray
(`dim`) is used pervasively for secondary labels and is the weakest contrast, but
in a TUI context (user-selected terminal emulator) it is standard practice — `dim`
text being low-contrast is expected. The interactive selection cursor uses `cyan`
bold, which is legible. Health status glyphs use Unicode bullets (`●`, `○`, `⚠`)
which degrade gracefully to ASCII in terminals that can't render them (they display
as mojibake but the adjacent text still conveys the meaning).

`components.tsx` uses `dimColor` extensively for secondary text. There are no
hard-coded ANSI escape sequences; all color is via Ink props (Chalk-backed), so
the `FORCE_COLOR=0` escape hatch will strip all color.

### Findings

| ID     | Severity | Category      | Short description                                                                                                                                          | Evidence                                       | Effort  |
| ------ | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------- |
| Z16-11 | medium   | accessibility | `NO_COLOR` env var is not honored: Chalk 5's vendored `supports-color` does not check it; forcing monochrome requires `FORCE_COLOR=0` or `--no-color` flag | `chalk@5.6.2` vendored `supports-color` source | small   |
| Z16-12 | low      | dx            | `sym menu` / `sym tui` launch TUI unconditionally, ignoring `process.stdout.isTTY`; hangs in CI/piped environments                                         | `cli/index.ts:627–630`                         | trivial |
| Z16-13 | low      | accessibility | Unicode glyphs (`●`, `○`, `⚠`) in `healthGlyph` and `Dashboard.tsx:143` have no ASCII fallback; render as mojibake in dumb terminals                       | `theme.ts:14–18`, `Dashboard.tsx:143`          | trivial |

---

### Z16-11 — `NO_COLOR` is not honored (MEDIUM)

**Evidence:** The `NO_COLOR` convention (https://no-color.org) is a widely-adopted
standard: if `NO_COLOR` is set (to any value), programs should not add ANSI color
codes. Chalk 5.6.2 (the version ink 5 uses) resolves color support via a vendored
`supports-color` that checks `FORCE_COLOR` and `--no-color` flags but **not the
`NO_COLOR` env var** (confirmed: `grep -n "NO_COLOR"` in the vendored file returns
0 hits). Setting `NO_COLOR=1` in the shell has no effect on the Sym TUI. Operators
running Sym's CLI in a no-color environment (editors, accessibility tools, CI with
ANSI-hostile log processors) cannot opt out of color via the standard mechanism.

**Recommendation:** Add a startup check in `tui/index.tsx` (`launchTui`) that
translates `NO_COLOR` into `FORCE_COLOR=0` before calling `render()`:

```ts
export async function launchTui(): Promise<void> {
  if (process.env['NO_COLOR'] !== undefined) {
    process.env['FORCE_COLOR'] = '0';
  }
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
```

This is a one-line shim that bridges the standard until Chalk/ink add native
`NO_COLOR` support. Add a note in `README.md` that `NO_COLOR=1` is honored.

**Effort:** small. **Blast radius:** isolated (`tui/index.tsx`).

---

### Z16-12 — `sym menu` / `sym tui` launch TUI unconditionally (LOW)

**Evidence:** `cli/index.ts:627–630`:

```ts
case 'menu':
case 'tui':
  await (await import('../tui/index.js')).launchTui();
  return 0;
```

No `isTTY` guard here. The bare `sym` path (line 620) correctly checks
`process.stdout.isTTY` before launching the TUI and prints help otherwise. The
explicit `sym menu`/`sym tui` subcommands bypass the guard — invoking them in a
pipe (e.g. `sym menu | head`) will attempt to render Ink in a non-TTY context.
Ink 5 degrades gracefully in CI (via `is-in-ci`), but a non-CI piped environment
will see raw escape codes.

**Recommendation:** Mirror the `isTTY` guard:

```ts
case 'menu':
case 'tui':
  if (!process.stdout.isTTY) {
    console.log(HELP);
    return 0;
  }
  await (await import('../tui/index.js')).launchTui();
  return 0;
```

**Effort:** trivial. **Blast radius:** isolated (`cli/index.ts`).

---

### Z16-13 — Unicode health glyphs lack ASCII fallback (LOW)

**Evidence:** `theme.ts:14–18` (`healthGlyph`) and `Dashboard.tsx:143` use
Unicode `●` (U+25CF), `○` (U+25CB), `⚠` (U+26A0). In terminals where these
code points are unavailable or in monochrome text-only output (`sym status --json`
doesn't use glyphs, but the TUI itself might be copy-pasted), these render as
`?` or mojibake. The adjacent color and text label still convey status when the
glyph fails, so this is low impact — but it's easily avoided.

**Recommendation:** Check `process.env['TERM'] === 'dumb'` or piggyback on the
`NO_COLOR` check in `launchTui`: if monochrome, use `+`/`-`/`!` as ASCII
fallbacks for `●`/`○`/`⚠`. Thread the capability flag into `theme.ts`'s
`healthGlyph` function:

```ts
export function healthGlyph(d, ascii = false) {
  const g = ascii ? { ok: '+', err: '!', dim: '-' } : { ok: '●', err: '⚠', dim: '○' };
  …
}
```

This is optional polish; the TUI is primarily for interactive use where Unicode is
almost universally available today.

**Effort:** trivial. **Blast radius:** isolated (`theme.ts`, `components.tsx`).

---

## Proposed Chunks

### C-Z16-A — Logging hygiene gate + turn correlation id

**Goal:** Add a CI grep-gate forbidding `console.log` outside `cli/`; thread
`turn.id` as a prefix on every server-path log call.
**Findings:** Z16-01, Z16-02, Z16-03
**Depends on:** none (pure additive, no existing chunk dependency)

### C-Z16-B — Per-turn latency/cost documentation + unbounded context fix

**Goal:** Cap thread context size in `conversationsReplies`; add a per-turn
timeout/abort ceiling on the Pi loop; document the latency/cost budget in
ARCHITECTURE.md. Roll Z03-10, Z07-10, Z08-08, Z06-14, Z05-15 under the systemic
frame.
**Findings:** Z16-04, Z16-05, Z16-06, Z16-07
**Depends on:** C22 (ARCHITECTURE.md creation)

### C-Z16-C — Supply-chain hygiene (dependabot + SBOM stub + license list)

**Goal:** Add `dependabot.yml` for npm + Actions; generate and commit
`THIRD-PARTY-LICENSES.md`; add `pnpm audit --audit-level=high` to CI; note SBOM
as deferred to OSS launch.
**Findings:** Z16-08, Z16-09, Z16-10
**Depends on:** C21 (OSS community health chunk)

### C-Z16-D — TUI accessibility: NO_COLOR + isTTY guard + ASCII fallback

**Goal:** Honor `NO_COLOR` via `FORCE_COLOR=0` shim in `launchTui`; add `isTTY`
guard to `sym menu`/`sym tui`; optionally add ASCII fallback for Unicode health
glyphs.
**Findings:** Z16-11, Z16-12, Z16-13
**Depends on:** C03/C19 (TUI stays in scope, confirmed by owner decision)
