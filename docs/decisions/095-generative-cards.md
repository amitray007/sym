# 095. Generative cards for charts, number grids, and data tables

Status: accepted
Date: 2026-11-07

## Context

Brain replies are Markdown in one `markdown` block. That covers prose, lists, and small tables,
but not a chart, a grid of key numbers, or a long table a person can page through. Slack now has
`data_table` (paginated, up to 200 rows) and `data_visualization` (pie, bar, line, and area
charts, two per message) blocks.

json-render (`@json-render/core` and `@json-render/chat`, Vercel Labs) lets a model fill a JSON
spec from a fixed catalog of components and turns it into a Chat SDK card. The Chat SDK Slack
adapter's `/blocks` entry turns that card into Block Kit. The package's `streamCard` posts and
edits the message through Chat SDK directly. That skips `chooseDisplay` and the outbox, so Sym
does not use it.

## Decision

The brain gets a `present_card` tool. Its input is a spec of `{ root, elements }`, typed by the
catalog's own Zod schema. The tool description lists each component and its props, taken from the
catalog's prompt, so the library stays the one owner of the component shapes.

The catalog is json-render's standard set without `Image` and `Button`: `Card`, `Section`,
`Text`, `Fields`, `Field`, `Table`, `Chart`, `Divider`, `Actions`, and `LinkButton`. `Card`
loses its `imageUrl` prop. Sym has no handler for a card button, choices go through
`offer_choices`, and images become links (decision 071).

`lib/cards/card.ts` validates the spec, rejects a link that is not `http` or `https` and two
buttons with one link, defuses mentions in every prop, and enforces Slack's limits: one table
(100 rows including the header, 20 columns, 10,000 cell characters), two charts (20 categories,
50-character titles, 20-character labels), 10 fields, 3,000 characters of text, a 150-character
title, and 50 blocks. The adapter cuts text, drops fields, and turns a chart or table it can't
draw into a code block without an error, so code refuses those cards and checks that every chart
and table came out as one. Markdown links in text become Slack links, and each link button gets
its own action id. Sym passes no json-render `state`, so the tool rejects `$` expressions,
`repeat`, and `visible`: they would render nothing, and an expression could build a mention after
defusing. `defuse` now strips nested tokens such as `<<!channel>>` until none remain, for every
caller. A bad spec returns its issues to the model, which fixes the spec and calls again. A good
spec becomes Block Kit plus the adapter's fallback text for notifications.

The post goes through `chooseDisplay` (kind `card`) and the outbox like any reply. A card is a
level 1 message: one post, one notification. A card table paginates, so the display rule's
10-row document threshold applies to Markdown tables only; fallback text over 12,000 characters
still refuses the card. Cards do not stream: the outbox posts the finished card once. The card
replaces the reply, so when its send fails the tool gives up on it and tells the brain to answer
in text.

Sym stays a text chat first. The brain uses a card only when the person asks for a chart, graph,
table, or card, or when the data is too much for a few sentences: a trend over about six or more
points, shares of a whole, or five or more items compared on two or more numbers. A few numbers,
a status, or a short comparison stays text, and when unsure the brain uses text. Evals cover
both sides: a few numbers stay text, and a two-week trend becomes a chart. The card is the
reply, so `posted: true` means `no_reply`. Every number comes from the conversation or a tool
result.

## Consequences

Sym can answer "chart deploys per service" with a native Slack chart, and every card still passes
the display rule, the outbox, and the mention guard. The tool adds four dependencies;
`@chat-adapter/slack` brings the Slack Web API client, but only its pure `/blocks` entry is
imported. Cards are static: no streaming, no action buttons, no form inputs, and no state. A
100-row table with long cells can pass 12,000 fallback characters and fall back to text although
Slack would accept it. A later decision can add buttons that route through Sym's own action
handler. How `data_table` and `data_visualization` render in a real workspace waits for the live
run with the test Slack app.
