/**
 * Line-buffered narration filter — strips agent self-talk from the streamed
 * reply BEFORE it reaches Slack.
 *
 * **Why this exists.** The system prompt asks the model not to narrate plan
 * mechanics ("marking p1 complete", "now searching the channel", "calling
 * search_messages"). Prompts get us partway; the model still leaks
 * occasionally — especially smaller open-weights checkpoints under load. The
 * live task card already shows the owner exactly what's happening, so the
 * narration is pure noise in the reply text.
 *
 * **Defensive belt to the prompt's suspenders.** This filter is a
 * conservative regex layer: false drops (eating real reply text) are MUCH
 * worse than false keeps (leaving one stray "now searching"). Patterns are
 * tight — anchored to line starts, gated on plan-id shapes (`p1`/`p2`), or
 * gated on bare tool names that essentially never appear in normal English.
 *
 * **Streaming reality.** Pi delivers deltas mid-word: a single sentence
 * can arrive as `'Mark'`, `'ing p1'`, `' as complete.\n'`. We CANNOT
 * classify on each delta — we'd miss the pattern that only emerges across
 * the boundary. So we accumulate into a line buffer and only classify on
 * a "segment boundary": newline OR sentence terminator (`. `, `! `, `? `).
 *
 * **End-of-stream tail.** A real reply often ends without a trailing
 * newline (Slack mrkdwn doesn't require one). `flush()` emits whatever is
 * left in the buffer unchanged at end-of-stream — a narration line ending
 * without newline could slip through, but the inverse mistake (eating the
 * owner's actual answer) is unacceptable. Acceptable trade.
 *
 * **State.** Stateless across turns. Construct one per `streamReply`.
 */

/**
 * Patterns that mark a complete segment (line or sentence) as agent
 * narration. Conservative — each pattern is gated on something that's
 * implausible in a real Slack reply (plan-id token, bare status word, bare
 * tool name, verb at line start with a Slack-mechanics object).
 *
 * Anything not matching ANY of these passes through unchanged.
 */
const NARRATION_PATTERNS: readonly RegExp[] = [
  // "Update p1", "Now p2", "Next p3", "Marking p1", "Mark p1" — plan-row narration.
  // Plan ids (`p1`, `p2`, ...) almost never appear at sentence start in normal English.
  /^(?:update|now|next|marking|mark)\s+p\d+\b/i,

  // Bare status words at line start, followed by punctuation/word that makes
  // it a status announcement ("in_progress", "complete.", "blocked —"). Plain
  // English uses "complete" too ("I've got a complete picture") — so we
  // require the status word to be near the start of a SHORT segment, not
  // mid-paragraph. The line filter handles this naturally: a 4-word segment
  // starting with "Complete." is almost certainly status narration.
  /^(?:in[_ ]progress|complete|blocked)\b[.!\s—-]/i,

  // "p1 done", "p2: complete", "p3 in_progress" — plan-id forward narration.
  /^p\d+\b\s*[:.\-—]?\s*(?:done|complete|in[_ ]progress|blocked|started|finished)/i,

  // Tool-name mentions. These tool names essentially NEVER appear in normal
  // English — `search_messages`, `read_channel`, etc. are snake_case
  // identifiers. Any segment that names one is narration.
  /\b(?:search_messages|read_channel|read_thread|set_plan|update_task|read_user_profile|fetch_url|list_channels|post_as_owner|react_as_owner|set_status|add_reminder|get_current_time)\b/,

  // "Searching Slack", "Reading the thread", "Calling messages" — bare
  // gerund + Slack-mechanics object at line start. Gated to line-start so
  // sentences like "I'm reading the thread now" mid-paragraph don't trip
  // (those rarely appear; if they do, the cost is one extra line drop).
  /^(?:searching|reading|calling|fetching|looking up|checking)\s+(?:slack|the\s+(?:channel|thread|messages?|workspace)|messages|channels?|the\s+web)\b/i,

  // "Now fetch profile.", "Now search again.", "Now read channel C0123." —
  // model talking to itself with an imperative verb after "Now". Gated to
  // a tight verb list so "Now I have the answer" stays through. Observed
  // 2026-05-29 dogfood: "Now fetch profile.Amit's recent remarks…"
  /^now\s+(?:fetch|search|read|check|call|run|use|look\s+up|update|mark|move\s+on)\b/i,

  // "Search again broader", "Search wider", "Search broader" — meta-narration
  // about the model's own retrieval strategy. Gated to "search" as the
  // line-start verb; the adverbs are the smoking gun.
  /^search\s+(?:again|broader|wider|harder|deeper|more)\b/i,

  // "Need to include those.", "Need to fetch the profile.", "Need to widen
  // the search." — self-instruction. Real owner-facing prose almost never
  // starts a sentence with bare "Need to" (it's "I need to" or "We need to").
  /^need\s+to\s+\w+/i,

  // "Let me check the docs", "Let me search again" — model planning aloud.
  // Common in agent traces, rare in actual sharp-colleague replies. Gated
  // to a tight verb list so "Let me know if…" stays through.
  /^let\s+me\s+(?:check|search|see|look|find|try|read|fetch|pull|run)\b/i,
];

/**
 * Classify a complete segment as narration (drop) or content (keep).
 * Whitespace-only segments are kept (preserve paragraph breaks).
 */
function isNarration(segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return false;
  for (const re of NARRATION_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

/**
 * Find the index AFTER the first segment boundary in `s`, or -1 if none.
 *
 * Boundaries (in order of preference):
 *  - `\n` — strongest signal
 *  - `. ` / `! ` / `? ` — sentence end followed by whitespace
 *  - `.X` / `!X` / `?X` where X is a capital letter — sentence end with NO
 *    space (some checkpoints emit glued sentences: `"broader.We have..."`).
 *    Without this lookahead the entire stretch arrives as one segment and
 *    slips past narration classification at flush time.
 *
 * We treat the boundary as INCLUSIVE — the returned index is the cut point
 * so the segment we extract includes the terminator (matters for preserving
 * the newline / space in kept content).
 */
function findSegmentEnd(s: string): number {
  // Newline first — strongest signal.
  const nl = s.indexOf('\n');
  // Sentence-end: `.`, `!`, `?` followed by whitespace OR a capital letter
  // (sentence boundary even without a space). The lookahead is intentionally
  // strict on the capital-letter case so `e.g.` / `i.e.` / abbreviations
  // mid-segment don't trip false splits.
  const sentenceRe = /[.!?](?=\s|[A-Z])/;
  const m = sentenceRe.exec(s);
  // `m.index` points at the punctuation. The cut point depends on what
  // followed:
  //  - whitespace → include the whitespace in this segment so it isn't lost
  //  - capital letter → do NOT include it; that letter belongs to the next
  //    sentence (otherwise "broader.We" emits "e have…" — the W gets eaten)
  let sentEnd = -1;
  if (m !== null) {
    const punctIdx = m.index;
    const next = s.charAt(punctIdx + 1);
    sentEnd = /\s/.test(next) ? punctIdx + 2 : punctIdx + 1;
  }

  if (nl === -1 && sentEnd === -1) return -1;
  if (nl === -1) return sentEnd;
  if (sentEnd === -1) return nl + 1;
  // Take the earlier boundary. Newline cut is always nl+1 (include the \n).
  const nlCut = nl + 1;
  return nlCut <= sentEnd ? nlCut : sentEnd;
}

/**
 * Line-buffered narration filter. Construct one per stream. Feed each model
 * delta to `push`; the returned string is the FILTERED text (possibly empty)
 * to send onward. At end-of-stream call `flush` and emit its return value
 * unchanged.
 */
export class NarrationFilter {
  private buf = '';

  /**
   * Accept a model delta. Returns the filtered text to emit downstream
   * (already-classified segments concatenated). The trailing partial segment
   * stays in the internal buffer for the next call.
   */
  push(delta: string): string {
    if (delta.length === 0) return '';
    this.buf += delta;
    let out = '';
    // Greedy: extract every complete segment we can find this call. Each
    // extraction either gets appended to `out` (keep) or dropped silently.
    for (;;) {
      const end = findSegmentEnd(this.buf);
      if (end === -1) break;
      const segment = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      if (!isNarration(segment)) {
        out += segment;
      }
    }
    return out;
  }

  /**
   * End-of-stream — return whatever is still buffered, UNCHANGED. A real
   * reply often ends without a newline; we'd rather emit a stray narration
   * tail than eat the owner's answer. Idempotent.
   */
  flush(): string {
    const out = this.buf;
    this.buf = '';
    return out;
  }
}
