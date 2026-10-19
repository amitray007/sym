import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";

export default defineAgent({
  // Workers do repository work, so Sym needs no shell or file tools (docs/eve.md).
  defaultTools: false,
  model: anthropic(),
  reasoning: "medium",
});
