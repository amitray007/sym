import { defineDynamic, defineInstructions } from "eve/instructions";
import { isWorkerCaller } from "../../lib/callers.ts";
import { sessionInstructions } from "../../lib/learning/format.ts";
import { approvedForSession } from "../../lib/learning/rows.ts";
import { ledger } from "../../lib/runtime.ts";

// Layer 2 (docs/learning.md): approved playbooks and rules load once per session, through a
// session-keyed memo. The resolver is a pure read, because Eve may re-run it during recovery. A
// failed read adds nothing.
export default defineDynamic(async (ctx) => {
  if (isWorkerCaller(ctx.session.auth.current)) return null;
  try {
    const content = await ctx.memo(ctx.session.id, async () =>
      sessionInstructions(await approvedForSession(ledger())),
    );
    return content ? defineInstructions({ content }) : null;
  } catch (error) {
    console.warn("playbooks: could not load approved rows", error);
    return null;
  }
});
