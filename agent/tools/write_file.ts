import { writeFile } from "eve/tools/write_file";
import { sandboxTool } from "../../lib/sandbox/tools.ts";

// Eve's `write_file`, in Sym's sandbox (decision 089). Workers are refused, and content that
// carries one of Sym's secrets is refused.
export default sandboxTool(writeFile);
