import { defineDynamic, defineInstructions } from "eve/instructions";
import { isWorkerCaller } from "../../lib/callers.ts";
import { personaInstructions } from "../../lib/persona.ts";
import { storedPersonaOrNone } from "../../lib/persona-setting.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// The brain's voice (decisions 044, 046): the pack's persona file, else the owner's Slack
// setting, else the persona named by SYM_PERSONA (default casual). Worker threads get none. A
// failed setting read falls back to the environment with one warning. A failed file read adds
// nothing, and the shared Voice rules in instructions.md still apply.
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      if (isWorkerCaller(ctx.session.auth.current)) return null;
      try {
        const stored = await storedPersonaOrNone(ledger);
        const content = personaInstructions({
          stored,
          env: process.env.SYM_PERSONA,
          pack: pack(),
        });
        return content ? defineInstructions({ content }) : null;
      } catch (error) {
        console.warn("persona: could not load the persona", error);
        return null;
      }
    },
  },
});
