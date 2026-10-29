import { defineDynamic, defineInstructions } from "eve/instructions";
import { isWorkerCaller } from "../../lib/callers.ts";
import { capabilityInstructions } from "../../lib/capabilities.ts";

// The features this deployment has on (decision 068). Pure: it reads the environment only.
export default defineDynamic((ctx) => {
  if (isWorkerCaller(ctx.session.auth.current)) return null;
  return defineInstructions({ content: capabilityInstructions() });
});
