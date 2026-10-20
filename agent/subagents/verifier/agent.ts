import { defineAgent, defineDynamic } from "eve";
import { fixtureVerifier } from "../../../lib/brain/fixture-verifier.ts";

// The `verifier` subagent (docs/architecture.md, flow 4, decision 032). Only worker_job calls it,
// through ctx.agent with an output schema, so the brain does not see it as a tool.
// It uses the same model selection as the brain (agent/agent.ts): SYM_MODEL, a gateway model ID,
// or `fixture` for the scripted verifier in local end-to-end runs.
const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

export default defineAgent({
  description:
    "Compare a finished worker result with its brief and report pass or concerns. Called by worker_job.",
  tool: false,
  // It reads and judges. It changes nothing, so it gets no tools.
  defaultTools: false,
  model: defineDynamic({
    events: {
      "step.started": () => {
        const model = process.env.SYM_MODEL?.trim() || DEFAULT_MODEL;
        if (model === "fixture") {
          return { model: fixtureVerifier(), modelContextWindowTokens: 1_000_000 };
        }
        return { model, reasoning: "medium" as const };
      },
    },
  }),
});
