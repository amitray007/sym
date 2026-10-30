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
    async download(url, maxBytes) {
      const botToken = env.SLACK_BOT_TOKEN;
      if (!botToken) throw new Error("SLACK_BOT_TOKEN is not set");
      if (!isSlackFileUrl(url, env.SLACK_API_BASE_URL)) {
        throw new Error("Sym downloads files only from Slack's file host.");
      }
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${botToken}` },
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Slack file download failed: ${response.status}`);
      // Slack answers a bad token with a sign-in page, not an error status.
      if ((response.headers.get("content-type") ?? "").startsWith("text/html")) {
        throw new Error("Slack file download returned a page, not the file.");
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error("The Slack file is too large.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error("The Slack file is too large.");
      return bytes;
    },
  };
}

// Slack's own file host, or the host of SLACK_API_BASE_URL when tests point Slack at a fake.
export function isSlackFileUrl(url: string, apiBaseUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (apiBaseUrl) return parsed.origin === new URL(apiBaseUrl).origin;
  return parsed.protocol === "https:" && parsed.hostname === "files.slack.com";
}
