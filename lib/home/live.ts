import { currentWorker, ledger, pack, withJobDeps } from "../runtime.ts";
import { type SlackApi, SlackApiError } from "../slack/api.ts";
import { type HomeDeps, publishHome } from "./home.ts";

// The Home tab with Sym's real dependencies, for the Slack channel (decision 052).

/** The raw Web API handle Eve gives a webhook handler, as a SlackApi that throws on `ok: false`. */
export function slackApiOfContext(slack: {
  request(
    operation: string,
    body: Record<string, unknown>,
  ): Promise<{ ok?: boolean; error?: string }>;
}): SlackApi {
  return {
    async call(method, body) {
      const response = await slack.request(method, body);
      if (response.ok === false) throw new SlackApiError(method, response.error ?? "unknown_error");
      return response as Record<string, unknown>;
    },
  };
}

function liveDeps(): HomeDeps {
  return {
    sql: ledger(),
    pack: pack(),
    env: process.env,
    async worker() {
      const worker = await currentWorker();
      return worker ? { expiresAt: worker.expiresAt } : undefined;
    },
    async ping() {
      await withJobDeps((deps) => deps.worker.projects());
    },
  };
}

/** Publishes the Home tab for one Slack user. Never throws. */
export function publishLiveHome(
  slack: Parameters<typeof slackApiOfContext>[0],
  userId: string,
): Promise<boolean> {
  return publishHome(slackApiOfContext(slack), liveDeps(), userId);
}
