import { defineTool } from "eve/tools";
import { webFetch } from "eve/tools/web_fetch";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";

export default defineTool({
  ...webFetch,
  execute(input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) {
      return {
        content: NOT_FOR_WORKERS,
        contentType: "text/plain",
        truncated: false,
        url: input.url,
      };
    }
    return webFetch.execute(input, ctx);
  },
});
