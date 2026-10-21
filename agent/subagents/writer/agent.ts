import { defineAgent, defineDynamic } from "eve";
import { fixtureWriter } from "../../../lib/brain/fixture-writer.ts";
import { stepModel } from "../../../lib/brain/model.ts";

// The `writer` subagent (decision 062). Only worker_job calls it, through ctx.agent with an
// output schema, so the brain does not see it as a tool. It writes a finished job's result in
// the persona's voice. It uses the same model selection as the brain (agent/agent.ts): SYM_MODEL,
// a gateway model ID, or `fixture` for the scripted writer in local end-to-end runs.

export default defineAgent({
  description: "Write a finished worker job's result message in Sym's voice. Called by worker_job.",
  tool: false,
  // It only writes. It changes nothing, so it gets no tools.
  defaultTools: false,
  model: defineDynamic({
    events: {
      "step.started": () => stepModel(fixtureWriter, "low"),
    },
  }),
});
