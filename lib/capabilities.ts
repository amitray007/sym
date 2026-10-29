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
        "- Code channels are on. When a person clicks Start on a worker job brief, Sym moves the job into its own Slack code channel. The brief stays in the thread, and Slack links the channel there. A worker's questions are still asked in the thread where the job started.",
        "- The `code_channel` tool moves the current conversation into a new code channel. Use it only when a person explicitly asks for a code channel. Never use it on your own, not even for long or multi-step work. Coding work goes through `worker_job`, and Start moves the job. It does nothing inside a code channel.",
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
