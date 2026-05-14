# 06 — Tone & formality

## The problem

At work, *how you say it* is part of *what you said*. A correct
answer phrased like a text from a friend lands as low-quality when
your audience is execs or customers. A correct answer phrased like a
legal memo lands as cold when your audience is your team.

Pookie has three personalities at the workspace level (cute / balanced
/ professional). That's not enough for a real workspace. The
formality of #execs and #eng-banter and a customer DM in the same
workspace are wildly different, and the *same workspace member* (you)
adapts seamlessly. Sym should too.

## The mental model

The tone layer is a small, fast post-processor on top of the agent's
output. It does *not* change the substance — facts, citations,
actions, conclusions. It changes register: word choice, formality,
length defaults, emoji policy, greeting/closer style.

Substance separation matters: tone calibration must never silently
drop a caveat or alter a number. Tone changes how something is said,
not what is said.

## Inputs to tone

For every outgoing message we compute a `tone_profile` from:

1. **Workspace floor** (admin-set baseline: e.g., "this org's
   minimum formality is `neutral`").
2. **Channel policy** (admin or auto-derived; #execs = `formal`,
   #eng-banter = `casual`).
3. **Recipient role(s)** (mentions an exec? a customer? everyone?).
4. **Recent thread tone** (last 5 human messages — if everyone's
   typing in lowercase fragments, match it; if everyone's writing
   structured paragraphs, do too).
5. **Sensitivity of the message** (delivering bad news, a policy
   reminder, an apology — always one notch more formal than
   default).
6. **Speaker's preference** (the user can opt in to "always reply to
   me in a casual tone in DMs" via personal memory).
7. **Skill/task indicator** (a task posting a digest is always
   structured; a chat reply is conversational).

## Tone dimensions

We model tone on a few discrete axes, not free text:

```ts
interface ToneProfile {
  formality: "very_casual" | "casual" | "neutral" | "formal" | "very_formal";
  warmth: "cool" | "neutral" | "warm";
  length: "brief" | "medium" | "detailed";
  structure: "prose" | "loose_bullets" | "structured" | "doc";
  emoji_policy: "none" | "sparse" | "expressive";
  greeting: "none" | "brief" | "named";
  closer: "none" | "brief" | "sign_off";
  caps: "lowercase_ok" | "sentence_case" | "title_case";
}
```

These get assembled into a prompt fragment injected into the system
prompt for this turn. Example:

```
<tone>
formality: formal
warmth: cool
length: medium
structure: prose
emoji_policy: none
greeting: brief
closer: none
caps: sentence_case
</tone>
```

The model's draft is run through one more *tone-check pass* (cheap,
one short LLM call or a smaller model) that nudges register without
re-deriving facts. We can also skip the second pass when the draft
already matches the profile (low-stakes channels especially).

## How channel policy is set

Three layers:

1. **Auto-classification** at install or on channel join: peek at
   recent messages, infer formality. Surface to admin: "I think
   #execs is `formal`; you can change this in /sym channel-policy."
2. **Admin override** via slash command or admin UI.
3. **Default**: workspace floor.

Admins can also tag channels with "audience" labels (`internal`,
`external`, `customer`, `executive`, `dev`, `general`) that the tone
layer reads.

## Examples

Same content, three audiences.

Substance: "The deployment failed at 14:32 because the staging DB
ran out of connections. We've rolled back. Investigating root
cause."

### In #eng-banter (casual)

> rolled back the 14:32 deploy — staging db was out of conns 😅
> looking at it now

### In #leadership (formal)

> The 2:32pm deployment was rolled back. Cause: staging database
> connection exhaustion. We're investigating root cause now and will
> share an update within the hour.

### In a DM to a customer (very_formal)

> Hi Sarah — we briefly saw an issue at 2:32pm PT during a routine
> deployment, which we've already rolled back. Customer impact: none
> observed. We're investigating and I'll follow up by 4pm.

Three messages, same facts. The tone layer made the difference.

## Failure modes & guardrails

- **Don't drop caveats.** A tone pass that converts "we *think* this
  is the cause" into "this is the cause" is wrong. We test for
  this explicitly.
- **Don't change numbers, names, links.** Tone pass operates on the
  prose substrate only; entities are pinned.
- **Default to slightly more formal than ambient.** When in doubt,
  err formal. People rarely complain a teammate was *too*
  professional.
- **Apologies and bad news**: always one notch more formal,
  regardless of channel.
- **Don't mimic offensive ambient tone.** If the channel happens to
  be cursing, Sym does not start cursing. The floor is a floor.

## Personalization without leak

A user can have personal memory: "I prefer brief replies in DMs."
Sym applies this to its DMs with that user — and only there.
Personalization does not bleed into channel responses where others
are watching.

## "Pookie cuteness" mode

For workspaces that explicitly opt in (a small startup that loves
pookie's vibe), the warm/expressive axis can be pushed all the way.
The point is that this is *opt-in workspace policy*, not the
default. A serious org gets a serious teammate by default.

## Implementation sketch

```
agent draft ──► tone needed? ──► no ──► send
                      │
                      yes
                      ▼
              compute tone_profile
                      │
                      ▼
              tone-rewrite pass
              (smaller model, low temp,
               substance-preserving prompt)
                      │
                      ▼
              substance-diff check
              (entities & numbers preserved?)
                      │
              fail ◄─── pass ───► send rewritten draft
                │
                ▼
              send original draft + log mismatch
```

The substance-diff check is a small assertion (extract entities and
numbers from before/after; require equality on those sets).
Counter-intuitively, this matters most for the *cheap* tone passes,
since they're the ones we trust least.

## Cost & latency

Two-pass with a smaller model adds modest latency. We can:

- Skip the second pass when ambient ≈ profile.
- Use a low-latency model (Haiku-equivalent) for the rewrite.
- Cache the prompt prefix across rewrites in a session.
- Stream the rewritten output directly to the user (no double
  buffering).

Budget target: < 200ms additional latency for the tone pass at p50,
< 500ms at p95.

## Decisions

- **Tone is a post-processor**, never a substance-changer.
- **Tone profile is structured**, not free-text.
- **Channel policy** is admin-configurable, with auto-suggestion at
  install.
- **Floor + per-channel + per-message** composition; floor wins on
  conflict.
- **Substance-diff guard** required around any rewrite.
- **Opt-in cuteness**; default is serious.

## Open questions

- Multi-language tone: same approach, different floor per locale?
  Probably yes; locale detection drives a separate locale-tone
  module.
- "Voice" beyond tone: a workspace might want Sym to adopt a
  consistent persona name and self-reference style. Worth a small
  config knob; not for v1.
- Per-channel emoji palette (admin-set "cat-only" or "no-flag-emojis"
  rules) — likely a v2 nice-to-have.
- How loud is the receipt about tone? Probably invisible to users;
  visible in admin trace as a `tone_profile: {…}` event.
