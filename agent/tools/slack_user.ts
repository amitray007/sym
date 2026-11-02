import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { slackUserOfPrincipal } from "../../lib/owner.ts";
import { pack, slackFromEnv } from "../../lib/runtime.ts";
import { lookUpPerson, UNKNOWN_PERSON } from "../../lib/slack/people.ts";

// Looks up a workspace member: name, title, time zone and local time, and status (decision 083).
export default defineTool({
  description:
    "Look up a Slack person when it helps answer: their name, title, time zone and local time, " +
    "and status. Pass their @-mention or user ID. Use it for 'is it late for <@U…>?' or 'who " +
    "is <@U…>?'. Answer in a sentence; do not paste the record.",
  inputSchema: z.object({
    person: z.string().min(1).max(100).describe("A Slack @-mention or user ID, such as <@U123>."),
  }),
  label: { start: () => "Look up a person" },
  async execute({ person }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const found = await lookUpPerson(
      { slack: slackFromEnv(), pack: pack() },
      slackUserOfPrincipal(ctx.session.auth.current?.principalId),
      person,
    );
    return found ?? UNKNOWN_PERSON;
  },
});
