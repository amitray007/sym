import { signInStates } from "../connections/credentials.ts";
import { hasTokenEnv } from "../connections/names.ts";
import { listConnections } from "../connections/rows.ts";
import type { Sql } from "../db.ts";
import { activeJobs, finishedSince, getJob, type Job } from "../ledger/jobs.ts";
import { ownerUserId } from "../owner.ts";
import type { Pack } from "../pack/load.ts";
import { getStoredPersona, personaStatus } from "../persona-setting.ts";
import { allowedProjects } from "../projects/allowed.ts";
import { getQuietUntil } from "../quiet/quiet.ts";
import { listSchedules } from "../schedules/rows.ts";
import type { SlackApi } from "../slack/api.ts";
import { isSlackUserAllowed } from "../slack/guard.ts";
import {
  type HomeConnection,
  type HomeData,
  type HomeRole,
  homeView,
  type WorkerHealth,
} from "./view.ts";

// Gathers the Home data and publishes the view (decision 052). `views.publish` is not a message
// post, so it does not go through the outbox or `chooseDisplay`.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PING_TIMEOUT_MS = 3000;

type Env = Record<string, string | undefined>;

export interface HomeDeps {
  sql: Sql;
  pack: Pack | undefined;
  env: Env;
  now?: () => Date;
  // The worker sign-in on file, or undefined when none is configured. Cheap: no network.
  worker: () => Promise<{ expiresAt: Date | null } | undefined>;
  // Asks the worker one cheap question. Rejects when it cannot answer.
  ping: () => Promise<void>;
  pingTimeoutMs?: number;
  warn?: (line: string) => void;
}

/** Who this Slack user is to Sym. The owner is the configured owner only. */
export function homeRole(
  deps: Pick<HomeDeps, "pack" | "env" | "warn">,
  userId: string | undefined,
): HomeRole {
  if (!isSlackUserAllowed(deps.pack, deps.env.SYM_SLACK_USERS, userId, deps.warn)) return "denied";
  const owner = ownerUserId(deps.pack, deps.env);
  return owner !== undefined && owner === userId ? "owner" : "member";
}

// The worker state. Any failure or a slow answer gives "unknown"; the view never waits long.
async function workerHealth(deps: HomeDeps): Promise<WorkerHealth> {
  let signIn: { expiresAt: Date | null } | undefined;
  try {
    signIn = await deps.worker();
  } catch {
    return { state: "unknown", expiresAt: null };
  }
  if (!signIn) return { state: "not_signed_in" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      deps.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout")),
          deps.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS,
        );
      }),
    ]);
    return { state: "reachable", expiresAt: signIn.expiresAt };
  } catch {
    return { state: "unknown", expiresAt: signIn.expiresAt };
  } finally {
    clearTimeout(timer);
  }
}

async function connectionRows(sql: Sql, env: Env, now: Date): Promise<HomeConnection[]> {
  const rows = (await listConnections(sql)).filter((row) => row.status !== "disabled");
  const signIns = await signInStates(
    sql,
    rows.filter((row) => row.authKind === "oauth").map((row) => row.id),
    now,
  );
  return rows.map((row) => {
    const signIn = signIns.get(row.id) ?? "missing";
    const auth =
      row.authKind === "env"
        ? `token ${hasTokenEnv(row.envVar, env) ? "set" : "missing"}`
        : row.authKind === "oauth"
          ? `OAuth sign-in ${signIn === "refreshable" ? "valid" : signIn}`
          : "no sign-in";
    return { name: row.name, status: row.status, auth, defaultMode: row.defaultMode ?? null };
  });
}

// Closures can need repair long after they leave the finished-today list.
async function incompleteClosures(sql: Sql): Promise<Job[]> {
  const rows = await sql<{ id: number }[]>`
    select id from jobs where closed_at is not null
      and (worker_settled_at is null or archive_state in ('pending', 'repair')
        or (code_channel and archive_state != 'archived'))
    order by id
  `;
  const jobs = await Promise.all(rows.map((row) => getJob(sql, Number(row.id))));
  return jobs.filter((job): job is Job => Boolean(job));
}

/** Reads everything one role may see. Only the allow-listed project names ever leave here. */
export async function collectHome(deps: HomeDeps, role: HomeRole): Promise<HomeData> {
  const now = (deps.now ?? (() => new Date()))();
  const { sql } = deps;
  const [worker, active, finished, schedules, stored, closures] = await Promise.all([
    workerHealth(deps),
    activeJobs(sql),
    finishedSince(sql, new Date(now.getTime() - DAY_MS)),
    listSchedules(sql),
    getStoredPersona(sql).catch(() => undefined),
    incompleteClosures(sql),
  ]);
  const data: HomeData = {
    now,
    persona: personaStatus(deps.pack, stored, deps.env.SYM_PERSONA, () => {}),
    worker,
    active,
    closures,
    finished,
    schedules,
    projects: allowedProjects(deps.pack, deps.env.SYM_PROJECTS).map((p) => p.name),
  };
  if (role === "owner") {
    data.owner = {
      connections: await connectionRows(sql, deps.env, now),
      quietUntil: await getQuietUntil(sql),
    };
  }
  return data;
}

// A thrown Slack error carries a short code. Keep that code only, never the body.
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[a-z_]+$/.test(code)) return code;
  return error instanceof Error ? error.name : "unknown_error";
}

/** Publishes the Home view for one user. A failure is logged with Slack's error code, not thrown. */
export async function publishHome(
  slack: SlackApi,
  deps: HomeDeps,
  userId: string,
): Promise<boolean> {
  const warn = deps.warn ?? console.warn;
  try {
    const role = homeRole(deps, userId);
    const data = role === "denied" ? undefined : await collectHome(deps, role);
    await slack.call("views.publish", { user_id: userId, view: homeView(role, data) });
    return true;
  } catch (error) {
    warn(`Sym could not publish the Home tab: ${errorCode(error)}.`);
    return false;
  }
}
