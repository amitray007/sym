import { basename } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { PackError, type PackFile } from "./load.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SKILL_BYTES = 64 * 1024;
const frontmatter = z.looseObject({
  description: z.string().trim().min(1).optional(),
  deferred: z.boolean().optional(),
  license: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

function splitMarkdown(content: string, legacy: boolean) {
  if (!/^---\r?\n/.test(content)) return { body: content };
  const match = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m.exec(content);
  if (!match) {
    if (legacy) return { body: content };
    throw new Error("unclosed frontmatter");
  }
  let raw: unknown;
  try {
    raw = parse(match[1] as string) ?? {};
  } catch {
    throw new Error("invalid skill frontmatter");
  }
  // Legacy playbooks can begin with Markdown rules rather than YAML metadata.
  if (legacy && (typeof raw !== "object" || Array.isArray(raw))) return { body: content };
  const parsed = frontmatter.safeParse(raw);
  if (!parsed.success) throw new Error("invalid skill frontmatter");
  return { body: content.slice(match[0].length), header: match[0], metadata: parsed.data };
}

export function validatePackSkills(playbooks: PackFile[], skills: PackFile[]): void {
  const names = new Set<string>();
  for (const [field, files] of [
    ["playbooks", playbooks],
    ["skills", skills],
  ] as const) {
    for (const file of files) {
      const name = basename(file.path, ".md");
      const canonical = name.toLowerCase();
      const where = `${field} "${file.path}"`;
      if (!NAME.test(name) || canonical === "eve" || canonical.startsWith("eve__")) {
        throw new PackError(`${where}: invalid or reserved skill name "${name}"`);
      }
      if (names.has(canonical))
        throw new PackError(`${where}: Two pack skills are named "${name}"`);
      names.add(canonical);
      if (Buffer.byteLength(file.content, "utf8") > MAX_SKILL_BYTES) {
        throw new PackError(`${where}: skill exceeds ${MAX_SKILL_BYTES} bytes`);
      }
      try {
        if (!splitMarkdown(file.content, field === "playbooks").body.trim()) {
          throw new Error("skill body is empty");
        }
      } catch (error) {
        throw new PackError(`${where}: ${(error as Error).message}`);
      }
    }
  }
}

function firstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/^[#>*\-\s]+/, "").trim();
    if (text && !text.startsWith("```")) return text;
  }
  return "";
}

export function skillMarkdown(name: string, content: string, legacy = true): string {
  const { body, header, metadata } = splitMarkdown(content, legacy);
  if (metadata?.description) return content;
  const description = JSON.stringify(firstLine(body) || `Playbook ${name}.`);
  if (header) return content.replace(/^---\r?\n/, `---\ndescription: ${description}\n`);
  return `---\ndescription: ${description}\n---\n\n${content}`;
}
