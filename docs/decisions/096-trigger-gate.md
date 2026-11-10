# 096. A decision model checks new messages before message triggers fire

Status: accepted
Date: 2026-11-11

## Context

A message trigger (decision 088) fires on every new top-level message in its watched channel
that passes its keywords. A trigger with no keywords starts a full brain turn for every
message, and most of those turns end in `no_reply`. In a busy channel that spends model tokens
and hourly run slots on chatter. A trigger with keywords misses messages that say the same
thing in other words. Eve 0.88 ships `decide` (`eve/ai`), a cheap typed-question call to a
decision model, and Eve's ambient-listening pattern uses it as a filter before the agent.

## Decision

1. `fireMessageTriggers` asks a decision model about each new message after the keyword check
   and before any run is reserved. One `decide` call per message asks one boolean question per
   trigger that is still a candidate: could this message need what the trigger's instruction
   asks for? The message is untrusted data in the call's state, redacted and clipped as the run
   message is; the instruction and title are the creator's.
2. The gate drops a trigger only when the model is sure: a probability below 0.2. Blank text
   (a file with no caption), an unsure answer, a refusal, a missing answer, an error, or an
   8-second timeout keeps the trigger, so a failure never loses an event. A dropped trigger
   reserves no run, uses none of its hourly cap, and leaves one info log line with its
   reference and the probability. A failure logs a warning with the error name only.
3. Keywords stay as an optional exact filter that costs nothing, and the brain still decides on
   each run whether the event needs anything. Reaction triggers keep their emoji match and get
   no gate: the reaction is the request. The shared-thread rules (decision 050) are unchanged.
4. The gate follows the brain's route (decisions 018, 080). On the AI Gateway it uses Eve's
   default decision model, `typesafe-ai/jev`, with the brain's credential. On the direct
   Anthropic route it uses `anthropic.decisionModel` with `ANTHROPIC_API_KEY` and
   `claude-haiku-5-5`. A message on the gateway route therefore also reaches the decision
   model's provider, TypeSafe AI by default; `SYM_TRIGGER_GATE` can name another gateway
   decision model or `off`. The direct OpenAI route has no decision model, and the fixture brain
   spends nothing, so both run without a gate. `SYM_TRIGGER_GATE=off` turns it off; any other
   value names the decision model.

## Consequences

A busy watched channel costs one small decision call per message instead of one brain turn per
message, and a trigger without keywords is practical. A message the model wrongly rules out
fires nothing, so the threshold is low and every failure keeps the trigger. The decision model
API is experimental in the AI SDK and can change in patch releases. How often the gate drops a
message it should keep waits for the live run with the test Slack app.
