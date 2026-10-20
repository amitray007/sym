import type { AllowedProject } from "../../lib/projects/allowed.ts";

// The projects the job tests may touch. Without a list, Sym fails closed (decision 042).
export const TEST_PROJECTS: AllowedProject[] = [{ name: "test-repo", workerProject: "test-repo" }];
