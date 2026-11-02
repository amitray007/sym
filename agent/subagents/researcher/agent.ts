import { defineAgent, defineDynamic } from "eve";
import { fixtureResearcher } from "../../../lib/brain/fixture-researcher.ts";
import { stepModel } from "../../../lib/brain/model.ts";

export default defineAgent({
  description: "Investigate several sources with read-only tools and return concise evidence.",
  // The authored task checks the caller before opening this child.
  tool: false,
  defaultTools: false,
  model: defineDynamic(() => stepModel(fixtureResearcher, "medium")),
});
