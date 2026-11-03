import { digestEnabled } from "./digest/post.ts";
import { prFollowEnabled } from "./jobs/pr-wakes.ts";
import { verifierEnabled } from "./jobs/verify.ts";
import { sandboxEnabled, sandboxNetwork } from "./sandbox/config.ts";
import { codeChannelsOn } from "./slack/code-channel.ts";

// What this deployment can do, for the brain's instructions (decision 068). Each line reads the
// same switch the code reads, so the brain never claims a feature that is off or denies one that
// is on. The lines describe behavior the person sees, not how the code does it.
export function capabilityInstructions(env: Record<string, string | undefined> = process.env) {
  const codeChannels = codeChannelsOn(env)
    ? [
        "- Code channels are on. When you call `worker_job`, Sym opens the job's own Slack code channel and posts the brief and Start there, not in the thread. Slack links the channel in the thread. Say nothing more in the thread. Direct messages and Slack Connect channels keep the brief in the thread. A code channel is the same agent as its thread; when a person asks, `main_thread_post` posts in the thread it came from.",
        "- The `code_channel` tool moves the current conversation into a new code channel. Use it only when a person explicitly asks for a code channel. Never use it on your own, not even for long or multi-step work. Coding work goes through `worker_job`, which opens its own channel. It does nothing inside a code channel.",
        "- Sym cannot create, rename, or archive any other Slack channel.",
      ]
    : [
        "- Code channels are off. Sym cannot create Slack channels. If someone asks, say the owner can turn code channels on (`SYM_CODE_CHANNELS`).",
      ];
  const lines = [
    ...codeChannels,
    "- The researcher can investigate several sources with public web tools, Slack reads, and saved job status. It cannot post or start Builder work. Skills listed in the catalog load procedures on demand with eve__skill; they add no tools or authority.",
    "- Sym can read public web pages. Web search depends on the current model route; use it only when the tool is available. If search is unavailable, read a known URL or ask for one.",
    verifierEnabled(env)
      ? "- A model check (the verifier) reviews each finished code job against its brief."
      : "- Finished code jobs get rule checks only; the model check (the verifier) is off.",
    prFollowEnabled(env)
      ? "- Sym follows a job's pull request and reports CI and review changes."
      : "- Sym does not follow pull requests after a job ends.",
    digestEnabled(env) ? "- Sym posts a daily digest." : "- The daily digest is off.",
    ...sandboxLines(env),
  ];
  return [
    "# What Sym can do here",
    "",
    "These are this deployment's settings. Do not offer or deny anything that contradicts them.",
    "",
    ...lines,
  ].join("\n");
}

// The sandbox (decision 089): what it is for, what it cannot reach, and the repository rule.
function sandboxLines(env: Record<string, string | undefined>): string[] {
  if (!sandboxEnabled(env)) {
    return [
      "- The sandbox is off. You cannot run commands or open shared files; a shared file reaches you as a note with its name. If someone asks, say the owner can turn the sandbox on (`SYM_SANDBOX`).",
    ];
  }
  return [
    "- You have a sandbox for this conversation: a private Linux workspace with `bash`, `read_file`, `write_file`, `glob`, and `grep` (the default image also has Python 3, Node.js, and jq). Use it to compute, to open and analyze files people share in Slack (they appear as attached files under .eve/attachments), to run small scripts, and to prepare text or data.",
    sandboxNetwork(env)
      ? "- Sandbox commands can reach the network. Fetch only what the request needs."
      : "- The sandbox has no network. Do not try to install packages or call outside services from it.",
    "- Sandbox files last only while the sandbox is active. After 30 minutes with no sandbox call it is removed with its files, and the next call starts an empty one; a file shared before then may be gone, so ask for it again. Space is small (a few hundred MB) and lives in memory: keep files small.",
    "- The sandbox holds no secrets and no repository credentials. Never clone a repository to change it, and never push from it: code changes and repository checkouts go to the worker as a job. Production and customer data stay read-only there too.",
    "- If a sandbox tool says the sandbox is unavailable, say so briefly and answer without it.",
  ];
}
