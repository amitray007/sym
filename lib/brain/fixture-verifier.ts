import type { LanguageModel } from "ai";
import { type MockModelRequest, type MockModelResponse, mockModel } from "eve/evals";
import { ruleConcernsIn, type VerifierOutput } from "../jobs/verify.ts";

// A scripted `verifier` subagent for local end-to-end runs (SYM_MODEL=fixture), next to the
// scripted brain in fixture.ts. It calls no model provider. It is a test fixture, not a product
// behavior.
//
// Script: the verdict is pass when the rule checks found nothing, and concerns otherwise. The
// concerns repeat the rule-check concerns, so the result message shows each one once.
export function fixtureVerifier(): LanguageModel {
  return mockModel({ modelId: "sym-fixture-verifier", provider: "sym", respond: verifyAsFixture });
}

// Eve asks for structured output through its reply tool (`eve__reply`).
const REPLY_TOOL = "eve__reply";

export function verifyAsFixture(request: MockModelRequest): MockModelResponse | string {
  const verdict = fixtureVerdict(request.lastUserMessage ?? "");
  if (request.tools.some((tool) => tool.name === REPLY_TOOL)) {
    return { toolCalls: [{ name: REPLY_TOOL, input: verdict }] };
  }
  return JSON.stringify(verdict);
}

export function fixtureVerdict(message: string): VerifierOutput {
  const concerns = ruleConcernsIn(message);
  return concerns.length === 0
    ? { verdict: "pass", concerns: [], confidence: 0.9 }
    : { verdict: "concerns", concerns, confidence: 0.6 };
}
