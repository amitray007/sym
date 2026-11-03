import type { LanguageModel } from "ai";
import { mockModel } from "eve/evals";

export function fixtureResearcher(): LanguageModel {
  return mockModel({
    modelId: "sym-fixture-researcher",
    provider: "sym",
    respond(request) {
      if (request.toolResults.length === 0) {
        return { toolCalls: [{ name: "jobs_status", input: {} }] };
      }
      return "Research fixture checked the saved ledger. No live worker state was checked.";
    },
  });
}
