import { defineDynamic, defineInstructions } from "eve/instructions";
import { isWorkerCaller } from "../../lib/callers.ts";
import { personaInstructions } from "../../lib/persona.ts";
import { storedPersonaOrNone } from "../../lib/persona-setting.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// The brain's voice (decisions 044, 046): the pack's persona file, else the owner's Slack
// setting, else the persona named by SYM_PERSONA (default casual). Worker threads get none. A
// failed setting read falls back to the environment with one warning. A failed file read adds
// nothing, and the shared Voice rules in instructions.md still apply.
// Eve evaluates this before every model call, so the memo keeps one read per session.
export default defineDynamic(async (ctx) => {
  if (isWorkerCaller(ctx.session.auth.current)) return null;
  try {
    const content = await ctx.memo(ctx.session.id, async () =>
      personaInstructions({
        stored: await storedPersonaOrNone(ledger),
        env: process.env.SYM_PERSONA,
        pack: pack(),
      }),
    );
    return content ? defineInstructions({ content }) : null;
  } catch (error) {
    console.warn("persona: could not load the persona", error);
    return null;
  }
});
