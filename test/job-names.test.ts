import { describe, expect, it } from "vitest";
import { jobName, sentenceTitle } from "../lib/jobs/names.ts";

describe("work names", () => {
  it("links and escapes the title, with a plain title when the thread is unknown", () => {
    expect(jobName({ title: "Billing <retry> & sync" })).toBe("Billing &lt;retry&gt; &amp; sync");
    expect(jobName({ title: "Billing | sync", slackChannel: "C1", slackThreadTs: "170.1" })).toBe(
      "<https://slack.com/app_redirect?channel=C1&message_ts=170.1|Billing / sync>",
    );
    expect(jobName({ title: "Retry", slackChannel: "C2", codeChannel: true })).toBe(
      "<https://slack.com/app_redirect?channel=C2|Retry>",
    );
  });
  it.each([
    ["Billing sync retry", "billing sync retry"],
    ["API retry", "API retry"],
    ["OAuth retry", "OAuth retry"],
    ["iOS retry", "iOS retry"],
    ["S3 retry", "S3 retry"],
  ])("uses sentence case only for a plain first word: %s", (title, expected) => {
    expect(sentenceTitle(title)).toBe(expected);
  });
});
