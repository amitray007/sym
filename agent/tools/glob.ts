import { glob } from "eve/tools/glob";
import { sandboxTool } from "../../lib/sandbox/tools.ts";

// Eve's `glob`, in Sym's sandbox (decision 089). Workers are refused.
export default sandboxTool(glob);
