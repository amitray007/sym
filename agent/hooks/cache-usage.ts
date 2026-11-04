import { defineHook } from "eve/hooks";
import { cacheUsageLine } from "../../lib/brain/cache-usage.ts";

// Logs prompt-cache reads and writes for each model run, so an operator can see the hit rate.
export default defineHook({
  events: {
    "usage.recorded"(event, ctx) {
      const line = cacheUsageLine(event.data);
      if (line) console.info("model cache usage", { sessionId: ctx.session.id, ...line });
    },
  },
});
