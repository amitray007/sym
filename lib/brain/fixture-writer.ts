import type { LanguageModel } from "ai";
import { type MockModelRequest, type MockModelResponse, mockModel } from "eve/evals";
import type { WriterOutput } from "../jobs/writer.ts";

// A scripted `writer` subagent for local end-to-end runs (SYM_MODEL=fixture), next to the
// scripted verifier. It calls no model provider. It is a test fixture, not a product behavior.
//
// Script: "Written: <ref> - <summary>", read from the message's job and worker result.
export function fixtureWriter(): LanguageModel {
  return mockModel({ modelId: "sym-fixture-writer", provider: "sym", respond: writeAsFixture });
}

// Eve asks for structured output through its reply tool (`eve__reply`).
const REPLY_TOOL = "eve__reply";

export function writeAsFixture(request: MockModelRequest): MockModelResponse | string {
  const output = fixtureText(request.lastUserMessage ?? "");
  if (request.tools.some((tool) => tool.name === REPLY_TOOL)) {
    return { toolCalls: [{ name: REPLY_TOOL, input: output }] };
  }
  return JSON.stringify(output);
}

export function fixtureText(message: string): WriterOutput {
  const ref = /"ref": "(J-\d+)"/.exec(message)?.[1] ?? "the job";
  const summary = /"summary": "((?:[^"\\]|\\.)*)"/.exec(message)?.[1] ?? "done";
  return { text: `Written: ${ref} - ${summary}` };
}
