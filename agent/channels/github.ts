import type { RouteHandlerArgs } from "eve/channels";
import { type GitHubChannelState, githubChannel } from "eve/channels/github";
import { fireGitHubEvent, onGitHubComment } from "../../lib/integrations/github.ts";
import { ledgerDeps } from "../../lib/runtime.ts";
import { githubConfigured } from "../../lib/triggers/sources.ts";

// GitHub App webhooks at /eve/v1/github (decision 091). Eve verifies the signature with
// GITHUB_WEBHOOK_SECRET and calls these hooks. Each hook returns null, so no session runs on
// GitHub: events fire `github` triggers, whose runs post in Slack, and a mention of the app by a
// mapped, allowed person moves to that person's Slack DM. Route paths compile at build time, so
// the route always exists; without the GitHub App variables it answers 404 and does nothing.

const warn = (what: string) => (error: unknown) => {
  console.warn(`Sym could not handle a GitHub ${what}.`, (error as Error)?.name ?? "Error");
};

const channel = githubChannel({
  progress: { reactions: false },
  async onComment(ctx, comment) {
    await onGitHubComment(ledgerDeps(), ctx, comment).catch(warn("comment"));
    return null;
  },
  async onIssue(ctx, issue) {
    await fireGitHubEvent(ledgerDeps(), ctx, "issues", {
      action: issue.action,
      item: issue.raw,
    }).catch(warn("issue event"));
    return null;
  },
  async onPullRequest(ctx, pullRequest) {
    await fireGitHubEvent(ledgerDeps(), ctx, "pull_request", {
      action: pullRequest.action,
      item: pullRequest.raw,
    }).catch(warn("pull request event"));
    return null;
  },
  async onCheckSuite(ctx, suite) {
    await fireGitHubEvent(ledgerDeps(), ctx, "check_suite", {
      action: suite.action,
      item: suite.raw,
      number: suite.pullRequests[0] ?? null,
    }).catch(warn("check suite event"));
    return null;
  },
});

const notFound = () => new Response("not found", { status: 404 });

const github: typeof channel = {
  ...channel,
  routes: channel.routes.map((route) =>
    route.transport === "websocket"
      ? route
      : {
          ...route,
          handler: (request: Request, args: RouteHandlerArgs<GitHubChannelState>) =>
            githubConfigured() ? route.handler(request, args) : Promise.resolve(notFound()),
        },
  ),
};

export default github;
