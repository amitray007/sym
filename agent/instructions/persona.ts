import { defineDynamic, defineInstructions } from "eve/instructions";
import { isWorkerCaller } from "../../lib/callers.ts";
import { personaInstructions } from "../../lib/persona.ts";
import { pack } from "../../lib/runtime.ts";

// The brain's voice (decision 044): the pack's persona file, else the built-in persona named by
// SYM_PERSONA (default casual). Worker threads get none. A failed read adds nothing, and the
// shared Voice rules in instructions.md still apply.
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      if (isWorkerCaller(ctx.session.auth.current)) return null;
      try {
        const content = personaInstructions({ env: process.env.SYM_PERSONA, pack: pack() });
        return content ? defineInstructions({ content }) : null;
      } catch (error) {
        console.warn("persona: could not load the persona", error);
        return null;
      }
    },
  },
});
