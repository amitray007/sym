import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Harness,
  messageText,
  newConversation,
  OWNER,
  startHarness,
  until,
} from "./harness.ts";

// The prompt cache on the direct Anthropic route (decision 094). A fake Anthropic Messages API
// records each request and reports cache reads, so the run shows the 1-hour cache marker on the
// wire and the cache log line Sym writes for each model run.

const requests: Array<Record<string, unknown>> = [];
let anthropic: Server;
let h: Harness;

function sse(events: Array<Record<string, unknown>>) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function reply(model: string) {
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 9_000,
          cache_creation_input_tokens: 900,
          output_tokens: 1,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Cached hello from the fake model." },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ]);
}

beforeAll(async () => {
  anthropic = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(reply(String(parsed.model)));
    });
  });
  await new Promise<void>((resolve) => anthropic.listen(0, "127.0.0.1", resolve));
  const { port } = anthropic.address() as AddressInfo;
  h = await startHarness({
    database: "sym_e2e_prompt_cache",
    env: {
      SYM_MODEL_PROVIDER: "anthropic",
      SYM_MODEL: "claude-sonnet-5-5",
      SYM_PROMPT_CACHE_TTL: "1h",
      ANTHROPIC_API_KEY: "fake-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/v1`,
    },
  });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
  await new Promise((resolve) => anthropic?.close(resolve));
});

describe("prompt cache", () => {
  it("asks Anthropic for a 1-hour cache and logs the cache usage", async () => {
    const c = newConversation(h);
    await c.mention("<@UBOT> hello", OWNER);
    await until(() => c.botMessages().find((m) => messageText(m).includes("Cached hello")), {
      label: "the fake model's reply",
    });

    const ttls = JSON.stringify(requests).match(/"ttl":"[^"]+"/g) ?? [];
    expect(ttls.length).toBeGreaterThan(0);
    expect(new Set(ttls)).toEqual(new Set(['"ttl":"1h"']));

    const log = await until(() => /model cache usage \{[^}]*\}/.exec(h.logs())?.[0], {
      label: "the cache usage log entry",
    });
    expect(log).toMatch(/cacheReadTokens: 9000\b/);
    expect(log).toMatch(/cacheWriteTokens: 900\b/);
    expect(log).toMatch(/cacheHitRate: 0\.9\b/);
  });
});
