// Reads an adopter pack from disk (docs/adopting.md). Errors name the file and the field.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { findSecretFields, type PackConfig, packSchema } from "./schema.ts";

export const MANIFEST_NAME = "sym.config.yaml";

export class PackError extends Error {
  override name = "PackError";
}

export interface PackFile {
  // The path as written in the manifest.
  path: string;
  content: string;
}

export interface Pack {
  dir: string;
  config: PackConfig;
  instructions: PackFile[];
  playbooks: PackFile[];
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PackError(`Cannot read ${path}: ${code ?? (error as Error).message}`);
  }
}

function isInside(root: string, target: string): boolean {
  const inside = relative(root, target);
  return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

// Containment holds on real paths: a symlink inside the pack must not lead to a file outside it.
// Only regular files are read.
function readReferenced(dir: string, paths: string[], field: string): PackFile[] {
  const outside = (path: string) =>
    new PackError(`${join(dir, MANIFEST_NAME)}: ${field} "${path}" is outside the pack folder`);
  let realRoot: string;
  try {
    realRoot = realpathSync(dir);
  } catch {
    throw new PackError(`Cannot read the pack folder ${dir}`);
  }
  return paths.map((path) => {
    const full = resolve(dir, path);
    if (!isInside(dir, full)) throw outside(path);
    let real: string;
    try {
      real = realpathSync(full);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new PackError(`Cannot read ${full}: ${code ?? (error as Error).message}`);
    }
    if (!isInside(realRoot, real)) throw outside(path);
    if (!statSync(real).isFile()) {
      throw new PackError(`${join(dir, MANIFEST_NAME)}: ${field} "${path}" is not a regular file`);
    }
    return { path, content: read(real) };
  });
}

export function loadPack(dir: string): Pack {
  const root = resolve(dir);
  const manifest = join(root, MANIFEST_NAME);
  let raw: unknown;
  try {
    raw = parse(read(manifest));
  } catch (error) {
    if (error instanceof PackError) throw error;
    throw new PackError(`${manifest} is not valid YAML: ${(error as Error).message}`);
  }

  const secrets = findSecretFields(raw);
  if (secrets.length > 0) {
    throw new PackError(
      `${manifest}: ${secrets.join(", ")} looks like a secret field. Secrets never go in a pack. Put them in the deployment environment.`,
    );
  }

  const parsed = packSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new PackError(`${manifest} is invalid: ${issues}`);
  }

  const config = parsed.data;
  return {
    dir: root,
    config,
    instructions: readReferenced(root, config.instructions, "instructions"),
    playbooks: readReferenced(root, config.playbooks, "playbooks"),
  };
}

// The pack named by SYM_PACK_DIR, or undefined when the variable is unset.
export function packFromEnv(env: NodeJS.ProcessEnv = process.env): Pack | undefined {
  const dir = env.SYM_PACK_DIR?.trim();
  return dir ? loadPack(dir) : undefined;
}
