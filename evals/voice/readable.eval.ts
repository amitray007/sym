import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { readabilityProblems } from "../../lib/voice/readable.ts";
import { writeToolStubs } from "../stubs.ts";

// A dense metrics dump is the case where replies turn into walls of text (decision 103). The
// reply is checked before the rewrite pass, so this grades the brain itself.
const DUMP = `checkout-api alert again. here's what I pulled, what's going on?
- instances: 10/10 (maxScale 10), at max for 8h
- last hour: 199k 4xx, 48k 2xx, all sampled 4xx are 429 on POST /webhooks/orders
- 4xx per day: 29k (nov 18), 262k (nov 22), 581k (last 24h)
- 2xx p95: 400ms -> 1.3s today; 692 requests over 5s in 30 min
- queue: 9 messages, oldest 77s
- cpu p99 44%, memory 60%, database cpu 50%, concurrency 4 per instance
- last deploy: nov 19 08:14, image only`;

export default defineEval({
  description: "A dense metrics dump gets an answer readable at a glance.",
  tags: ["voice"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(DUMP);
    t.succeeded();
    t.notCalledTool("worker_job");
    const reply = String(turn.reply ?? "").trim();
    t.check(
      reply,
      satisfies(
        (value) => readabilityProblems(String(value)).length === 0,
        "no long lines, number-dense lines, or long prose",
      ),
    );
    t.check(reply, includes(/429|cap|max/i));
    const judgments = t.judge({
      state: { message: DUMP, reply },
      questions: {
        glance: {
          type: "boolean",
          instructions:
            "Could a busy on-call engineer get the main point of the reply in five seconds? " +
            "The answer comes first, each line holds one idea, and supporting numbers that do " +
            "not change the decision are left out.",
        },
        complete: {
          type: "boolean",
          instructions: "Does the reply still say whether data is at risk and what to do next?",
        },
      },
    });
    judgments.glance.label("readable at a glance").gate(0.7);
    judgments.complete.label("keeps the risk and next step").gate(0.7);
  },
});
