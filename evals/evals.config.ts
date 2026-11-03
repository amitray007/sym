import { defineEvalConfig } from "eve/evals";
import { prepareEvalDatabase } from "./database.ts";

// These evals check the brain's routing with a real model, so `pnpm eval` spends model tokens
// (decision 039). Routing assertions are deterministic. The tone cases also use Eve's default
// judge model through the same gateway (decision 093). A real-model run needs a gateway
// credential with access to SYM_MODEL and the judge. CI does not run it. Setup
// moves the run to its own database before the agent server starts (decision 064).
export default defineEvalConfig({
  async setup() {
    await prepareEvalDatabase();
  },
  timeoutMs: 180_000,
  maxConcurrency: 2,
});
