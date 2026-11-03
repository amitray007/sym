import { anthropic } from "@ai-sdk/anthropic";
import { defineEvalConfig } from "eve/evals";
import { prepareEvalDatabase } from "./database.ts";

// These evals check the brain's routing with a real model, so `pnpm eval` spends model tokens
// (decision 039). Routing assertions are deterministic. The tone cases also use a judge model
// (decision 093). By default it is Eve's gateway judge. With SYM_MODEL_PROVIDER=anthropic it
// uses ANTHROPIC_API_KEY, so a run needs no gateway; SYM_EVAL_JUDGE_MODEL names the model. CI
// does not run evals. Setup moves the run to its own database before the agent server starts
// (decision 064).
function judgeConfig(env = process.env) {
  if (env.SYM_MODEL_PROVIDER?.trim().toLowerCase() !== "anthropic") return {};
  const model = env.SYM_EVAL_JUDGE_MODEL?.trim() || "claude-sonnet-5-5";
  return { judge: { model: anthropic.decisionModel(model) } };
}

export default defineEvalConfig({
  ...judgeConfig(),
  async setup() {
    await prepareEvalDatabase();
  },
  timeoutMs: 180_000,
  maxConcurrency: 2,
});
