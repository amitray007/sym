import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { postgresMemory } from "../../lib/memory/provider.ts";

// Layer 1 memory (docs/learning.md): a person's durable preferences and facts, kept in the
// ledger database. Eve scopes the slot to the authenticated principal, so each person's facts
// load for that person's turns and for nobody else's. A Slack person is `slack:<team>:<user>`.
//
// Schedule sessions run as the app principal. `byPrincipal` returns null for it, so Eve skips
// the slot and its tools: a schedule turn has no memory and cannot read or write a person's
// facts. Anything a schedule needs comes from its own job brief or ledger rows.
export default defineMemory({
  description:
    "Durable preferences and facts about the person Sym is talking to, such as how they want " +
    "pull requests opened or which team owns a repository. Short, one fact per memory.",
  provider: postgresMemory(),
  scope: byPrincipal,
});
