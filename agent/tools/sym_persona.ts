import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import { PERSONAS } from "../../lib/persona.ts";
import { changePersona } from "../../lib/persona-setting.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// Lets the owner switch the brain's voice in plain words (decision 046). The tool checks the
// caller itself, because code decides, not the model. The change applies from the next session,
// so the current reply keeps the old voice.
export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "Change the brain's persona when the owner asks for a different voice, such as 'be spicy' " +
    "or 'tone it down'. Only the owner can do this. The change applies from the next " +
    "conversation, so tell the owner that.",
  inputSchema: z.object({
    persona: z
      .enum(PERSONAS)
      .describe("plain is neutral, casual is the default, spicy is playful."),
  }),
  label: { start: ({ persona }) => `Set persona ${persona}` },
  async execute(input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    return changePersona({
      sql: ledger(),
      pack: pack(),
      userId: slackUserOfPrincipal(ctx.session.auth.current?.principalId),
      name: input.persona,
    });
  },
});
