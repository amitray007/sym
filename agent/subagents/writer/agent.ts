import { defineAgent, defineDynamic } from "eve";
import { fixtureWriter } from "../../../lib/brain/fixture-writer.ts";

// The `writer` subagent (decision 062). Only worker_job calls it, through ctx.agent with an
// output schema, so the brain does not see it as a tool. It writes a finished job's result in
// the persona's voice. It uses the same model selection as the brain (agent/agent.ts): SYM_MODEL,
// a gateway model ID, or `fixture` for the scripted writer in local end-to-end runs.
const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

export default defineAgent({
  description: "Write a finished worker job's result message in Sym's voice. Called by worker_job.",
  tool: false,
  // It only writes. It changes nothing, so it gets no tools.
  defaultTools: false,
  model: defineDynamic({
    events: {
      "step.started": () => {
        const model = process.env.SYM_MODEL?.trim() || DEFAULT_MODEL;
        if (model === "fixture") {
          return { model: fixtureWriter(), modelContextWindowTokens: 1_000_000 };
        }
        return { model, reasoning: "low" as const };
      },
    },
  }),
});
