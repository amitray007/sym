import { callSlackApi } from "eve/channels/slack";
import { type SlackApi, SlackApiError } from "./api.ts";

// The real SlackApi, built on Eve's callSlackApi (docs/slack.md). It reads SLACK_BOT_TOKEN and an
// optional SLACK_API_BASE_URL, so tests and the local e2e can point Slack at a fake server.
// Unset SLACK_API_BASE_URL keeps Slack's own host. It never logs the token or a request body.
export function slackApiFromEnv(env: NodeJS.ProcessEnv = process.env): SlackApi {
  return {
    async call(method, body) {
      const botToken = env.SLACK_BOT_TOKEN;
      if (!botToken) throw new Error("SLACK_BOT_TOKEN is not set");
      const response = await callSlackApi({
        ...(env.SLACK_API_BASE_URL ? { api: { apiBaseUrl: env.SLACK_API_BASE_URL } } : {}),
        botToken,
        operation: method,
        body,
      });
      if (!response.ok) {
        throw new SlackApiError(
          method,
          typeof response.error === "string" ? response.error : "unknown_error",
        );
      }
      return response as Record<string, unknown>;
    },
  };
}
