import { grep } from "eve/tools/grep";
import { sandboxTool } from "../../lib/sandbox/tools.ts";

// Eve's `grep`, in Sym's sandbox (decision 089). Workers are refused.
export default sandboxTool(grep);
