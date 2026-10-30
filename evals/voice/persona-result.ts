import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import type { PersonaName } from "../../lib/persona.ts";
import { afterFinishedJob, isQuickReply } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

// These are tone floors, not a judgment of how likable a voice is. The owner reviews the
// captured replies for that. No judge model runs. Casual runs in the default suite; plain and
// spicy use their existing process-wide persona scripts.
export function personaResultEval(persona: PersonaName) {
  return defineEval({
    description: `${persona}: a colleague's short PR recap preserves the concern, tests, and link.`,
    tags: persona === "casual" ? ["voice", "persona-casual"] : ["persona", `persona-${persona}`],
    async test(t) {
      const session = await t.session({ stubs: [...writeToolStubs] });
      const turn = await session.send(
        afterFinishedJob(
          "Remind me where we landed on this, including the concern. Keep it short.",
        ),
      );
      t.succeeded();
      t.notCalledTool("worker_job");
      t.notCalledTool("job_followup");
      t.notCalledTool("no_reply");
      t.check(turn.reply, satisfies(isQuickReply, "a short conversation, without report sections"));
      t.check(turn.reply, includes("https://example.com/example-app/pull/42"));
      t.check(turn.reply, includes(/pass/i));
      t.check(turn.reply, includes(/6|six/i));
      t.check(
        turn.reply,
        satisfies(
          (value) =>
            !/\b(bestie|chief|skill issue|idiot|obviously|genius|legendary)\b/i.test(String(value)),
          "no forced familiarity, hostility, or flattery",
        ),
      );
      if (persona === "plain") {
        t.check(
          turn.reply,
          satisfies((value) => !/\p{Extended_Pictographic}/u.test(String(value)), "no emoji"),
        );
      } else {
        t.check(
          turn.reply,
          satisfies(
            (value) =>
              !/\b(request acknowledged|task completed successfully|please be advised)\b/i.test(
                String(value),
              ),
            "avoid a formal system voice",
          ),
        );
      }
    },
  });
}
