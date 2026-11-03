import { defineEval, type EveEvalContext, type EveEvalTurn } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import type { PersonaName } from "../../lib/persona.ts";
import { afterFinishedJob, hasNoBotPhrases } from "../conversation.ts";
import { finishedStatusStub, writeToolStubs } from "../stubs.ts";

// Tone cases for decision 093: does Sym text like a teammate or like a bot? Fixed checks catch
// the clear tells; a judge model grades what a pattern cannot. The persona is process-wide
// (decision 044), so each persona runs the same cases in its own eval script.

const EMOJI = /\p{Extended_Pictographic}/u;
// "no cap" is left out: "the wait has no cap" is plain English here.
const SLANG = /\b(?:ngl|lowkey|fr|bet|bestie|slay|it's giving|cooked|bussin)\b/i;
const HELP_OFFER = /\b(?:can i|could i|want me to|anything i can)\b/i;

const VOICES: Record<PersonaName, string> = {
  plain: "calm and direct, no slang, no emoji, no jokes",
  casual: "warm and practical, like a friendly teammate",
  spicy: "a sharp gen-z engineer: lowercase, clipped, light dry wit",
};

const text = (turn: EveEvalTurn) => String(turn.reply ?? "").trim();
const lineCount = (value: string) => value.split("\n").filter((line) => line.trim()).length;
const lacks = (pattern: RegExp, label: string) =>
  satisfies((value) => !pattern.test(String(value)), label);

async function ask(t: EveEvalContext, first: string, ...rest: string[]) {
  const session = await t.session({ stubs: [...writeToolStubs, finishedStatusStub] });
  const last = await session.send(first);
  const turns = [last];
  for (const message of rest) turns.push(await session.send(message));
  return { session, last: turns.at(-1) ?? last, turns };
}

/** Length and stock-phrase floors that every tone case shares. */
function checkShort(t: EveEvalContext, turn: EveEvalTurn, maxChars: number, maxLines: number) {
  const reply = text(turn);
  t.check(
    reply,
    satisfies(
      () => reply.length <= maxChars && lineCount(reply) <= maxLines,
      `at most ${maxLines} lines and ${maxChars} characters`,
    ),
  );
  t.check(reply, satisfies(hasNoBotPhrases, "no stock assistant phrases"));
}

/** One judge request per reply. The rubric names decision 093's tells, not taste. */
function judgeTone(t: EveEvalContext, turn: EveEvalTurn, message: string, persona: PersonaName) {
  const judgments = t.judge({
    state: { message, reply: text(turn), persona: VOICES[persona] },
    questions: {
      human: {
        type: "boolean",
        instructions:
          "Does the reply read like a real teammate texting in Slack, not a chatbot or customer " +
          "support? Chatbot tells: stock openers or closers, offers to help further, restating " +
          "the message, corporate wording, enthusiasm the moment did not earn.",
      },
      length: {
        type: "choice",
        instructions:
          "Compare the reply's length with what the message needs. A few casual words need a " +
          "few words back. A question needs its answer and nothing more.",
        criteria: {
          too_long: "Longer than needed, with padding, recap, or extra detail",
          fits: "About as long as the message needs",
          too_short: "Leaves out something the message asked for",
        },
        expected: "fits",
      },
      padding: {
        type: "boolean",
        instructions:
          "Is the reply free of preamble and postamble: no echo of the request, no announcement " +
          "of what it will do, no recap, no sign-off offering help or more detail? One short " +
          "question about an obvious next decision is fine.",
      },
      voice: {
        type: "boolean",
        instructions: "Does the reply fit the persona's voice without overdoing it?",
      },
    },
  });
  judgments.human.label("human").gate(0.7);
  judgments.length.label("length").gate();
  judgments.padding.label("no padding").gate(0.7);
  judgments.voice.label("persona voice").atLeast(0.6);
}

type Case = { name: string; run: (t: EveEvalContext, persona: PersonaName) => Promise<void> };

const CASES: Case[] = [
  {
    name: "a greeting gets a greeting",
    async run(t, persona) {
      const message = "hey, you around?";
      const { last: turn } = await ask(t, message);
      t.notCalledTool("worker_job");
      checkShort(t, turn, 160, 2);
      judgeTone(t, turn, message, persona);
    },
  },
  {
    name: "small talk gets small talk, not an offer to help",
    async run(t, persona) {
      const message = "this week has been absolutely wild";
      const { last: turn } = await ask(t, message);
      t.notCalledTool("worker_job");
      checkShort(t, turn, 200, 2);
      t.check(text(turn), lacks(HELP_OFFER, "no offer to help"));
      judgeTone(t, turn, message, persona);
    },
  },
  {
    name: "a lowercase question gets a short answer",
    async run(t, persona) {
      const message = "so did the retry thing pass or nah";
      const { last: turn } = await ask(t, afterFinishedJob(message));
      checkShort(t, turn, 300, 3);
      t.check(text(turn), includes(/pass/i));
      judgeTone(t, turn, message, persona);
    },
  },
  {
    name: "a formal question gets no slang or emoji and keeps the concern",
    async run(t, persona) {
      const message =
        "Could you tell me whether the retry change passed its tests, and whether anything is still open?";
      const { last: turn } = await ask(t, afterFinishedJob(message));
      checkShort(t, turn, 600, 6);
      t.check(text(turn), lacks(SLANG, "no slang"));
      t.check(text(turn), lacks(EMOJI, "no emoji"));
      t.check(text(turn), includes(/pass/i));
      t.check(text(turn), includes(/6|six/i));
      t.check(text(turn), includes(/cap|limit/i));
      judgeTone(t, turn, message, persona);
    },
  },
  {
    name: "a winding-down message gets a reaction or nothing",
    async run(t) {
      const { last: turn } = await ask(t, afterFinishedJob("did the tests pass?"), "cool, thanks");
      t.check(
        text(turn),
        satisfies((value) => String(value).length === 0, "no closing text"),
      );
    },
  },
  {
    name: "a short chat stays short and does not repeat itself",
    async run(t, persona) {
      const { session, turns } = await ask(
        t,
        afterFinishedJob("hey, where did this land?"),
        "why would it add 6 minutes though?",
        "ok. should we cap it?",
      );
      for (const turn of turns) checkShort(t, turn, 400, 4);
      t.judge(
        "Across the conversation, the assistant sounds like one consistent human teammate. It " +
          "never repeats a fact or offer it already gave, never stacks jokes, and no reply is much " +
          `longer than its question needs. Persona: ${VOICES[persona]}.`,
        { on: session.transcript },
      )
        // A whole-conversation grade is noisy, so it is reported, not gated. The per-reply
        // judges and fixed checks above are the gates.
        .label("conversation")
        .atLeast(0.7);
    },
  },
];

/** The tone cases under one persona. Casual runs in `pnpm eval`; plain and spicy in theirs. */
export function toneEvals(persona: PersonaName) {
  const tags = persona === "casual" ? ["voice", "tone"] : ["persona", `persona-${persona}`, "tone"];
  return CASES.map((item) =>
    defineEval({
      description: `${persona}: ${item.name}.`,
      tags,
      async test(t) {
        await item.run(t, persona);
        t.succeeded();
      },
    }),
  );
}
