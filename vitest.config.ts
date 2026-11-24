import { defineConfig } from "vitest/config";

// Unit tests never call a paid model, so the reply rewrite pass (decision 103) stays off unless
// a test passes its own fake.
export default defineConfig({
  test: { env: { SYM_READABLE: "off" } },
});
