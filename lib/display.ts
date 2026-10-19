// The display rule (docs/display.md): every Slack post goes through chooseDisplay.

/** 0 silent, 1 text, 2 text and buttons, 3 live card, 4 summary and file. */
export type DisplayLevel = 0 | 1 | 2 | 3 | 4;

export type Surface = "dm" | "channel" | "shared-channel" | "schedule";

export interface DisplayInput {
  /** Job class, for example "code-change" or "on-call-check". */
  kind: string;
  /** A person must approve, answer, or unblock. */
  needsAction: boolean;
  /** Something changed since the last post. */
  isNew: boolean;
  /** The job failed. Failures post even in quiet mode. */
  failed?: boolean;
  /** Expected duration of the work. */
  estMinutes: number;
  /** Steps worth following. */
  steps: number;
  /** Answer length in lines. */
  lines: number;
  /** Rows in the largest table of the answer. */
  tableRows?: number;
  surface: Surface;
  /** In a shared channel: the job was requested in this channel. */
  askedHere?: boolean;
  /** The requester's words, passed by the model. */
  hint?: "text" | "card";
  /** Learned preferences for this job class. */
  prefs?: { textOnly?: boolean };
  /** Quiet mode or quiet hours. */
  quiet: boolean;
}

export interface DisplayChoice {
  level: DisplayLevel;
  /** Where the post goes. */
  target: "thread" | "dm";
  reason: string;
}

const CARD_MIN_MINUTES = 2;
const CARD_MIN_STEPS = 3;
const DOCUMENT_MIN_LINES = 40;
const DOCUMENT_MIN_TABLE_ROWS = 10;

export function chooseDisplay(input: DisplayInput): DisplayChoice {
  const target = input.surface === "shared-channel" && !input.askedHere ? "dm" : "thread";

  // Step 1: a needed action always posts, quiet or not.
  if (input.needsAction) return { level: 2, target, reason: "needs action" };

  // Step 2: nothing new means silence. The digest carries it.
  if (!input.isNew) return { level: 0, target, reason: "nothing new" };

  // Quiet mode: only actions and failures post.
  if (input.quiet && !input.failed) return { level: 0, target, reason: "quiet: digest" };

  // Step 3: long work with steps worth following gets a live card.
  const long = input.estMinutes > CARD_MIN_MINUTES && input.steps >= CARD_MIN_STEPS;
  if (input.hint === "card") return { level: 3, target, reason: "requester asked for progress" };
  if (long && input.hint !== "text" && !input.prefs?.textOnly) {
    return { level: 3, target, reason: "long job with steps" };
  }

  // Step 4: long answers become a summary and a file.
  const longAnswer =
    input.lines > DOCUMENT_MIN_LINES || (input.tableRows ?? 0) > DOCUMENT_MIN_TABLE_ROWS;
  if (longAnswer) return { level: 4, target, reason: "long answer" };

  const why = long
    ? input.hint === "text"
      ? "requester asked for text"
      : "learned: text only"
    : "short";
  return { level: 1, target, reason: why };
}
