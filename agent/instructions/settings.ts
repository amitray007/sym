import { defineDynamic, defineInstructions } from "eve/instructions";
import { isWorkerCaller } from "../../lib/callers.ts";
import { pack } from "../../lib/runtime.ts";
import { settingsInstructions } from "../../lib/settings.ts";

// The deployment's settings: people, reports, models, triggers, connections (decision 097).
// Pure: it reads the pack and the environment only.
export default defineDynamic((ctx) => {
  if (isWorkerCaller(ctx.session.auth.current)) return null;
  try {
    return defineInstructions({ content: settingsInstructions(pack()) });
  } catch (error) {
    console.warn("settings: could not build the settings note", error);
    return null;
  }
});
