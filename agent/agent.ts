import { defineAgent, defineDynamic } from "eve";

// The brain model goes through the Vercel AI Gateway (decision 018), so any gateway model ID
// works, for example `openai/gpt-6-luna` or `moonshotai/kimi-k3`. SYM_MODEL picks it at session
// start without a rebuild. Workers run their own models on the worker host.
const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

export default defineAgent({
  // Workers do repository work, so Sym needs no shell or file tools (docs/eve.md).
  defaultTools: false,
  // Chosen once per session: a model switch mid-session loses the prompt cache.
  model: defineDynamic({
    events: {
      "session.started": () => ({
        model: process.env.SYM_MODEL?.trim() || DEFAULT_MODEL,
        reasoning: "medium" as const,
      }),
    },
  }),
});
