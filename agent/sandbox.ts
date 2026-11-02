import { defineSandbox } from "eve/sandbox";
import { sandboxEnabled } from "../lib/sandbox/config.ts";
import { sandboxEnvironment } from "../lib/sandbox/environment.ts";

// The brain's sandbox (decision 089). One per session, so one per Slack thread. It holds files
// people share and whatever the brain computes. It never holds Sym's secrets or repository
// credentials: workers do repository work. With SYM_SANDBOX off, no sandbox opens. Eve then
// gives the brain a note for each shared file, and the sandbox tools say the sandbox is off.
export const environment = sandboxEnvironment();

export default defineSandbox(() => {
  if (!sandboxEnabled()) throw new Error("The sandbox is off (SYM_SANDBOX).");
  return environment.open();
});
