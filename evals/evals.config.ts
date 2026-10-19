import { defineEvalConfig } from "eve/evals";

// These evals check the brain's routing with a real model, so `pnpm eval` spends model tokens
// (decision 039). Every assertion is deterministic, so no judge model runs and the config sets
// none. A real-model run needs SYM_MODEL and AI_GATEWAY_API_KEY. CI does not run it.
export default defineEvalConfig({
  timeoutMs: 180_000,
  maxConcurrency: 2,
});
