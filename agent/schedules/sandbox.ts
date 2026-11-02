import { defineSchedule } from "eve/schedules";
import { sandboxEnabled, sandboxProvider } from "../../lib/sandbox/config.ts";
import { createDockerCli, reapIdleSandboxes } from "../../lib/sandbox/docker.ts";

// Sandbox idle limit (decision 089): every minute, remove each sandbox container Sym has not
// touched for 30 minutes, with its files and any command still running. Sym enforces it here,
// outside the sandbox, because a command could stop the container's own idle loop. It keeps no
// state, so any Sym process that runs schedules can run it. just-bash (eve dev) has no
// containers.
export default defineSchedule({
  cron: "* * * * *",
  async run() {
    if (!sandboxEnabled() || sandboxProvider() !== "docker") return;
    const removed = await reapIdleSandboxes(createDockerCli());
    if (removed.length > 0) console.info(`Removed ${removed.length} idle sandbox container(s).`);
  },
});
