import { digestEnabled } from "./digest/post.ts";
import { prFollowEnabled } from "./jobs/pr-wakes.ts";
import { verifierEnabled } from "./jobs/verify.ts";
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
    verifierEnabled(env)
      ? "- A model check (the verifier) reviews each finished code job against its brief."
      : "- Finished code jobs get rule checks only; the model check (the verifier) is off.",
    prFollowEnabled(env)
      ? "- Sym follows a job's pull request and reports CI and review changes."
      : "- Sym does not follow pull requests after a job ends.",
    digestEnabled(env) ? "- Sym posts a daily digest." : "- The daily digest is off.",
  ];
  return [
    "# What Sym can do here",
    "",
    "These are this deployment's settings. Do not offer or deny anything that contradicts them.",
    "",
    ...lines,
  ].join("\n");
}
