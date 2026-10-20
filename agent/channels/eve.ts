import { type AuthFn, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { bearerToken } from "../../lib/bearer-auth.ts";

// Static bearer token for scripts, CI, and operators (SYM_API_TOKEN).
const symApiToken = bearerToken({
  variable: "SYM_API_TOKEN",
  authenticator: "sym-api-token",
  principalId: "sym-operator",
});

// Eval sessions replace tools with stubs (evals/, decision 039). Eve allows that only when the
// route auth grants it, so the grant goes on the dev-server caller alone. `localDev` accepts
// nobody in production, so a deployed Sym never allows stubs.
const devAuth = localDev();
const localDevWithStubs: AuthFn<Request> = async (request) => {
  const caller = await devAuth(request);
  return caller ? { ...caller, allowToolStubs: true } : null;
};

export default eveChannel({
  auth: [
    symApiToken,
    // Open on localhost for `eve dev`, the REPL, and `eve eval`; ignored in production.
    localDevWithStubs,
  ],
});
