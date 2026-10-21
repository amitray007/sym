import { defineEvalConfig } from "eve/evals";
import { prepareEvalDatabase } from "./database.ts";

// These evals check the brain's routing with a real model, so `pnpm eval` spends model tokens
// (decision 039). Every assertion is deterministic, so no judge model runs and the config sets
// none. A real-model run needs a gateway credential and SYM_MODEL. CI does not run it. Setup
// moves the run to its own database before the agent server starts (decision 064).
export default defineEvalConfig({
  async setup() {
    await prepareEvalDatabase();
  },
  timeoutMs: 180_000,
  maxConcurrency: 2,
});
