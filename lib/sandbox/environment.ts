import { JustBashSandbox } from "eve/sandbox/just-bash";
import { sandboxImage, sandboxMemoryBytes, sandboxNetwork, sandboxProvider } from "./config.ts";
import { SymDockerSandbox } from "./docker.ts";

// The sandbox environment for this process (decision 089): Sym's Docker provider for `eve build`
// and `eve start`, and just-bash for `eve dev`, `eve eval`, and the local end-to-end run. just-bash
// is a JavaScript shell with a virtual filesystem: no Docker, but no process or network
// isolation, so production never uses it.
export function sandboxEnvironment(env: Record<string, string | undefined> = process.env) {
  if (sandboxProvider(env) === "just-bash") {
    return JustBashSandbox.environment({ autoInstall: false });
  }
  return SymDockerSandbox.environment({
    image: sandboxImage(env),
    network: sandboxNetwork(env),
    memoryBytes: sandboxMemoryBytes(env),
  });
}
