import { basename } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { PackError, type PackFile } from "./load.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const frontmatter = z.looseObject({
  description: z.string().trim().min(1).optional(),
  deferred: z.boolean().optional(),
  license: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export function validatePackSkills(files: PackFile[]): void {
  const names = new Set<string>();
  for (const file of files) {
    const name = basename(file.path, ".md");
    if (!NAME.test(name) || name === "eve" || name.startsWith("eve__")) {
      throw new PackError(`skills "${file.path}": invalid or reserved skill name "${name}"`);
    }
    if (names.has(name)) throw new PackError(`Two pack skills are named "${name}"`);
    names.add(name);
    let body = file.content;
    if (/^---\r?\n/.test(body)) {
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
      if (!match) throw new PackError(`skills "${file.path}": unclosed frontmatter`);
      try {
        frontmatter.parse(parse(match[1] as string));
      } catch {
        throw new PackError(`skills "${file.path}": invalid skill frontmatter`);
      }
      body = body.slice(match[0].length);
    }
    if (!body.trim()) throw new PackError(`skills "${file.path}": skill body is empty`);
  }
}
