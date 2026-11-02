import { bash } from "eve/tools/bash";
import { sandboxTool } from "../../lib/sandbox/tools.ts";

// Eve's `bash`, in Sym's sandbox (decision 089): compute, shared files, small scripts. No
// per-command approval: the sandbox holds no secrets and no repository credentials, and has no
// network unless the owner turns it on. Workers are refused.
export default sandboxTool({
  ...bash,
  description: `${bash.description} The sandbox has no secrets, no repository credentials, and no network unless this deployment turns it on. Its files last only while it is active: 30 minutes with no sandbox call removes it with its files. Output past 8 MB stops the command. Never clone a repository to change it: code changes go to the worker.`,
});
