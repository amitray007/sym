import { defineDynamic, defineInstructions } from "eve/instructions";
import { isWorkerCaller } from "../../lib/callers.ts";
import { workerLabelInstructions } from "../../lib/worker-label.ts";

// The name people see for the worker (decision 043). It comes from SYM_WORKER_LABEL.
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      if (isWorkerCaller(ctx.session.auth.current)) return null;
      return defineInstructions({ content: workerLabelInstructions() });
    },
  },
});
