import { defineAgent, defineDynamic } from "eve";
import { fixtureBrain } from "../lib/brain/fixture.ts";

// The brain model goes through the Vercel AI Gateway (decision 018), so any gateway model ID
// works, for example `openai/gpt-6-luna` or `moonshotai/kimi-k3`. SYM_MODEL picks it without a
// rebuild. `SYM_MODEL=fixture` runs a scripted brain for local end-to-end runs with no provider.
// Workers run their own models on the worker host.
const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

export default defineAgent({
  // Workers do repository work, so Sym needs no shell or file tools (docs/eve.md).
  defaultTools: false,
  // Resolved per step because the fixture is a live model object, which only step selections
  // may return. A gateway ID stays the same each step, so the prompt cache stays valid.
  model: defineDynamic({
    events: {
      "step.started": () => {
        const model = process.env.SYM_MODEL?.trim() || DEFAULT_MODEL;
        // A live model has no gateway catalog entry, so the selection names its window.
        if (model === "fixture") {
          return { model: fixtureBrain(), modelContextWindowTokens: 1_000_000 };
        }
        return { model, reasoning: "medium" as const };
      },
    },
  }),
});
