# 089. A sandbox for the brain

Status: accepted
Date: 2026-11-03

## Context

Sym had `defaultTools: false` and no sandbox (decisions 013, 019). The brain could not add up a
column in a CSV someone shared, run a small script, or open a file people posted in Slack. Eve
stages Slack attachments into the session sandbox, but the deploy image built with
`--skip-sandbox-prewarm`, so production had no sandbox to stage into: every shared file reached
the brain as a note with its name.

Eve's built-in Docker provider prepares a template image during `eve build`. A Dockerfile
`RUN eve build` step has no Docker daemon, so that build would record nothing to start from. Eve's
provider also sets no memory, CPU, or process limits.

## Decision

1. The brain gets a sandbox when `SYM_SANDBOX=on` (default off). One sandbox per Eve session, so
   one per Slack thread. `agent/sandbox.ts` defines it; `lib/sandbox/` holds the code.
2. Production (`eve build`, `eve start`) uses Sym's own Docker provider, `sym-docker`
   (`lib/sandbox/docker.ts`), built on Eve's documented `defineSandboxProvider`. It builds no
   template, so the image build needs no Docker daemon: `prepare` only records where the agent's
   skill and workspace files are. Each session container starts from the base image, which the
   first session pulls, and `docker cp` copies those files in. It talks to Docker through the
   `docker` CLI, which the runtime image now holds, and honors `DOCKER_HOST`.
3. `eve dev`, `eve eval`, and `pnpm test:e2e` use Eve's just-bash provider: a JavaScript shell and
   virtual filesystem, with no Docker. The choice reads `EVE_DEV` and `EVE_EVALUATION`, which
   Eve sets itself, so a build and the server it produces agree. just-bash has no process or
   network isolation, so production never uses it. `just-bash` is a dev dependency.
4. The image is Eve's sandbox image (`ghcr.io/vercel/eve`, Ubuntu with Node.js 24, Python 3, git,
   ripgrep, jq, curl), pinned to the tag Eve 0.88 uses. `SYM_SANDBOX_IMAGE` replaces it. The
   image must give its default user bash and a writable `/workspace`.
5. Each container runs with 1 GB of memory and no extra swap, 1 CPU, 256 processes, `--init`,
   every Linux capability dropped, and `no-new-privileges`, so `sudo` in the image does nothing.
   It stops after 30 minutes with no sandbox call and keeps its files; the next call starts it
   again. A background command still running then stops, so 30 minutes past the last call is the
   time limit. A single `bash` call waits 30 seconds and then keeps running in the background, as
   Eve's tool does. Session end removes the container.
6. Network: none by default (`--network none`). A command cannot send a shared file anywhere,
   reach the Docker host's private network or tailnet, or read a cloud metadata endpoint, and it
   cannot install packages. `SYM_SANDBOX_NETWORK=on` gives the container Docker's default bridge,
   with full egress. Eve's web tools (decision 086) run in the app runtime and need no sandbox
   network.
7. The tools are Eve's `bash`, `read_file`, `write_file`, `glob`, and `grep`, each in its own slot
   under `agent/tools/` with `defaultTools: false` kept. `lib/sandbox/tools.ts` puts Sym's checks
   in front: a worker caller is refused (Eve's MCP channel publishes every plain tool); with the
   sandbox off the tool says so without opening one; input that carries the value of one of
   Sym's secret variables (names with TOKEN, SECRET, PASSWORD, API_KEY, AUTHKEY, CREDENTIAL, or
   DATABASE_URL) is refused; and a sandbox that cannot open becomes a short "not available"
   error. Each refusal is a tool error, so the brain reads it and the turn continues. There is no
   per-command approval: the sandbox holds no secrets and no credentials.
8. Secrets stay out. A container's environment is exactly `AI_AGENT=eve`, always passed as
   `NAME=value`. The docker CLI runs with `PATH`, `HOME`, `TMPDIR`, `XDG_RUNTIME_DIR`, and
   `DOCKER_*` only. The sandbox has no repository credentials and no git push credentials.
9. The repository rule holds. The brain may use the sandbox to compute, analyze files people
   share in Slack, run small scripts, and prepare text or data. Code changes and repository
   checkouts go to Builder (decision 063). It must not clone a repository to change it. The
   capability note (decision 068) and the `bash` description say so, and production and
   customer data stay read-only.
10. Slack files: Eve stages each attachment under `/workspace/.eve/attachments/` and labels it
    with that path, so `read_file` and `bash` open it. With the sandbox off, or when it cannot
    open, Eve gives the brain a note with the file's name instead and the turn goes on. The
    local e2e points Eve's file downloads at the fake Slack host (`fileBaseUrl`), and a scenario
    opens a shared CSV with `read_file`. The voice-notes layer (decision 092) transcribes audio
    before the turn and keeps Eve from staging audio, so a voice note reaches the brain as text
    and never as a sandbox file; this decision does not change that.
11. The verifier and writer subagents have no tools, so they share the parent's sandbox
    (`defineParentSandbox`) and need no template of their own.
12. Deploy: the Dockerfile build stage runs the full `pnpm build`, which records the sandbox
    artifact, and the runtime stage copies the docker CLI from `docker:29.4.0-cli`.
    `compose.yaml` carries the socket mount and `group_add` commented out. CI keeps
    `pnpm build:compile` (decision 013).

## Consequences

- This changes decisions 013 and 019 in part: deploy images now run the full `eve build`. It does
  not need Docker or pull Eve's image at build time.
- Mounting `/var/run/docker.sock` gives the Sym process control of the host's Docker daemon,
  which is root on that host. The brain never reaches the socket: its commands run inside a
  container that has none, and Sym runs only the fixed docker commands in `lib/sandbox/docker.ts`.
  But a bug in Sym or a compromised dependency would reach it. `DOCKER_HOST` pointing at a
  separate Docker host keeps that off the Sym host.
- The first sandbox call on a host pulls about 550 MB. Pre-pull the image to avoid the wait.
- Stopped containers keep their files until their session ends. Long-lived Slack sessions can
  leave them on the host; `docker container prune --filter label=sym.sandbox` removes them.
- Disk use per container is not capped: Docker can cap it only on some storage drivers.
- The secret check matches exact values of Sym's secret variables. It stops an accidental paste;
  it does not stop a value the brain was never given, and Sym gives the brain none.
- With the sandbox on, files people share in a thread live in that thread's container until the
  session ends.
- Changing `SANDBOX_LIMITS` or the image takes effect for new containers. Upgrading Eve may change
  its image tag; keep `DEFAULT_SANDBOX_IMAGE` in step.
