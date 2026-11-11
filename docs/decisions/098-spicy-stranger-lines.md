# 098. The spicy persona gets its joke lines for strangers back

Status: accepted
Date: 2026-11-12

## Context

Decision 053 gave people off the allow-list a private line, with 15 joke lines for casual and
spicy personas. The conversational redesign (decision 071) replaced them with four mild lines,
and casual and spicy shared both lists. The owner wants the joke lines back for the spicy persona.

## Decision

1. The spicy persona picks a uniform line from the 15 lines of decision 053. The lines joke about
   access and the owner's guest list, not about the person.
2. The casual persona picks from the two mild casual lines. A plain or pack persona keeps the
   straight line, and with no owner every persona gets the no-owner line.
3. The 0.7 mix of spicy and casual lines is gone: the persona alone picks the list.
4. This is an exception to decision 071's rule that spicy never jokes at another person. The
   line goes privately, once an hour per person and channel, to someone the owner has not added.

## Consequences

- An owner who picks spicy accepts that strangers get a joke line. Plain, casual, or
  `SYM_STRANGER_REPLIES=off` avoid it.
