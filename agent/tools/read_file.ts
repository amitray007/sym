import { readFile } from "eve/tools/read_file";
import { sandboxTool } from "../../lib/sandbox/tools.ts";

// Eve's `read_file`, in Sym's sandbox (decision 089). It opens files people share in Slack, which
// Eve stages under .eve/attachments. Workers are refused.
export default sandboxTool(readFile);
