import { defineDynamic, defineInstructions } from "eve/instructions";
import { isWorkerCaller } from "../../lib/callers.ts";
import { projectInstructions } from "../../lib/projects/allowed.ts";
import { allowedFromEnv } from "../../lib/runtime.ts";

// The projects Sym may touch (decision 042). Pure: it reads the pack and the environment only.
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      if (isWorkerCaller(ctx.session.auth.current)) return null;
      try {
        return defineInstructions({ content: projectInstructions(allowedFromEnv()) });
      } catch (error) {
        console.warn("projects: could not build the project list", error);
        return null;
      }
    },
  },
});
