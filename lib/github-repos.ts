import type { Pack } from "./pack/load.ts";

// The GitHub repositories Sym may read events from (decision 091). The owner lists them: the
// pack's `githubRepositories`, or without a pack SYM_GITHUB_REPOS, comma-separated `owner/name`.
// It is deployment config, like the project list (decision 042), so no trigger needs approval.
// With no list, nothing is allowed. Pure, so any bundle can import it.

const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

export function allowedGitHubRepos(
  pack: Pack | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const listed = pack ? pack.config.githubRepositories : (env.SYM_GITHUB_REPOS ?? "").split(",");
  return [...new Set(listed.map((r) => r.trim().toLowerCase()).filter((r) => REPOSITORY.test(r)))];
}

export function isGitHubRepoAllowed(
  repository: string,
  pack: Pack | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return allowedGitHubRepos(pack, env).includes(repository.trim().toLowerCase());
}
