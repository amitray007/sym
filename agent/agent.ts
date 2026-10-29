import { defineAgent, defineDynamic } from "eve";
import { fixtureBrain } from "../lib/brain/fixture.ts";
import { stepModel } from "../lib/brain/model.ts";

// The brain's model comes from SYM_MODEL through lib/brain/model.ts (decision 018), shared with
// the subagents. Workers run their own models on the worker host.

export default defineAgent({
  // Workers do repository work, so Sym needs no shell or file tools (docs/eve.md).
  defaultTools: false,
  // The brain plans and summarizes; workers spend the real compute. A session that passes this
  // model cost pauses and asks a person to continue or stop (docs/eve.md, spend limits).
  // The window restarts when the person approves Continue.
  limits: { sessionUsage: ({ window }) => (window.costUsd ?? 0) >= 2 },
  // Resolved per step because the fixture is a live model object, which only step selections
  // may return. A gateway ID stays the same each step, so the prompt cache stays valid.
  model: defineDynamic(() => stepModel(fixtureBrain, "medium")),
});
