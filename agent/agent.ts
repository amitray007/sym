import { defineAgent, defineDynamic } from "eve";
import { overSessionBudget } from "../lib/brain/budget.ts";
import { fixtureBrain } from "../lib/brain/fixture.ts";
import { stepModel } from "../lib/brain/model.ts";

// The brain's model comes from SYM_MODEL and SYM_MODEL_PROVIDER through lib/brain/model.ts
// (decisions 018, 080), shared with the subagents. Workers run their own models on the worker host.

export default defineAgent({
  // Workers do repository work, so Sym needs no shell or file tools (docs/eve.md).
  defaultTools: false,
  // Root copies would inherit worker_job and Slack write tools.
  tool: false,
  // The brain plans and summarizes; workers spend the real compute. A session that passes this
  // model cost pauses and asks a person to continue or stop (docs/eve.md, spend limits).
  // The window restarts when the person approves Continue. A direct provider reports no cost, so
  // its tokens are priced at reference rates (lib/brain/budget.ts, decision 080).
  limits: { sessionUsage: ({ window }) => overSessionBudget(window) },
  // Resolved per step because the fixture and direct providers are live model objects, which
  // only step selections may return. The model ID stays the same each step, so the prompt cache
  // stays valid.
  model: defineDynamic(() => stepModel(fixtureBrain, "medium")),
});
