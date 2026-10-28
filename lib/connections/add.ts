import { hasTokenEnv, nameProblem, tokenEnvVar } from "./names.ts";
import { checkServerUrl, type Probe, type ProbeOptions } from "./probe.ts";
import type { AuthKind, NewConnection } from "./rows.ts";
import { type ConnectionTool, recordInstructions, recordTools } from "./tools.ts";

// Plans a new connection from the owner's request (decision 045): checks the name and URL,
// probes the server, and decides the sign-in. It writes nothing; connection_add saves the plan
// as a proposal. Pure apart from the probe, so tests run it against fake servers.

export interface AddRequest {
  name: string;
  url: string;
  description?: string | undefined;
  createdBy: string | null;
}

export interface AddDeps {
  env: Record<string, string | undefined>;
  probe(url: string, options?: ProbeOptions): Promise<Probe>;
}

export type AddPlan =
  | { ok: false; reason: string }
  | { ok: true; connection: NewConnection; notes: string[] };

const MAX_DESCRIPTION = 300;

export async function planConnection(request: AddRequest, deps: AddDeps): Promise<AddPlan> {
  const name = request.name.trim();
  const problem = nameProblem(name);
  if (problem) return { ok: false, reason: problem };
  const url = checkServerUrl(request.url);
  if (!url.ok) return url;

  const anonymous = await deps.probe(url.url);
  if (anonymous.kind === "failed") return { ok: false, reason: anonymous.reason };

  let authKind: AuthKind = "none";
  let envVar: string | null = null;
  let tools: ConnectionTool[] = [];
  let serverInstructions: string | null = null;
  const notes: string[] = [];
  if (anonymous.kind === "tools") {
    tools = recordTools(anonymous.tools);
    serverInstructions = recordInstructions(anonymous.instructions);
  } else if (anonymous.oauth) {
    authKind = "oauth";
    notes.push(
      "The server uses an OAuth sign-in. After the owner approves, call connection_sign_in. " +
        "The sign-in link goes to the owner's DM.",
    );
  } else {
    authKind = "env";
    envVar = tokenEnvVar(name);
    if (!hasTokenEnv(envVar, deps.env)) {
      notes.push(
        `The server needs a token. Tell the owner: set ${envVar} in the deployment ` +
          "environment and redeploy. Never ask for the token in chat.",
      );
    } else {
      notes.push("After the owner approves, Sym lists the server's tools with its token.");
    }
  }

  return {
    ok: true,
    connection: {
      name,
      url: url.url,
      description: (request.description ?? "").trim().slice(0, MAX_DESCRIPTION),
      authKind,
      envVar,
      tools,
      serverInstructions,
      createdBy: request.createdBy,
    },
    notes,
  };
}

// Lists the tools again with the connection's token, keeping the owner's earlier choices, and
// reads the server's instructions again. For a sign-in that just finished, a token that just
// arrived, and a mode change on a tool Sym has not seen yet.
export async function relistTools(
  url: string,
  token: string | undefined,
  previous: readonly ConnectionTool[],
  probe: AddDeps["probe"],
): Promise<
  { ok: true; tools: ConnectionTool[]; instructions: string | null } | { ok: false; reason: string }
> {
  const result = await probe(url, token ? { token } : {});
  if (result.kind === "tools") {
    return {
      ok: true,
      tools: recordTools(result.tools, previous),
      instructions: recordInstructions(result.instructions),
    };
  }
  if (result.kind === "unauthorized")
    return { ok: false, reason: "The server refused the sign-in." };
  return { ok: false, reason: result.reason };
}
