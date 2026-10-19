// Copies a pack's instructions and playbooks into an Eve agent folder before `eve build`
// (docs/adopting.md). Instructions are added under agent/instructions/. Playbooks become flat
// skills under agent/skills/ and replace a built-in skill of the same name.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { loadPack, PackError, type PackFile } from "./load.ts";

// Eve accepts ASCII letters, digits, underscores, and dashes, starting with a letter or digit.
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;
const DESCRIPTION = /^description\s*:\s*\S/m;

export interface OverlayResult {
  instructions: string[];
  skills: string[];
  replacedSkills: string[];
}

function fileName(file: PackFile, field: string): string {
  const name = basename(file.path);
  if (extname(name) !== ".md") {
    throw new PackError(`${field} "${file.path}" must be a .md file`);
  }
  return name;
}

function firstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/^[#>*\-\s]+/, "").trim();
    if (text && !text.startsWith("```")) return text;
  }
  return "";
}

// Eve routes on the description. Add one when the playbook has no frontmatter description.
export function skillMarkdown(name: string, content: string): string {
  const match = FRONTMATTER.exec(content);
  if (match) {
    if (DESCRIPTION.test(match[0])) return content;
    const body = content.slice(match[0].length);
    const description = JSON.stringify(firstLine(body) || `Playbook ${name}.`);
    return `---\ndescription: ${description}\n${match[0].slice(4)}${body}`;
  }
  const description = JSON.stringify(firstLine(content) || `Playbook ${name}.`);
  return `---\ndescription: ${description}\n---\n\n${content}`;
}

// Validates the pack, then writes its files into <appDir>/agent. Throws PackError on any problem
// before it writes anything.
export function applyPackOverlay(packDir: string, appDir: string): OverlayResult {
  const pack = loadPack(packDir);
  const agentDir = join(appDir, "agent");
  if (!existsSync(join(agentDir, "instructions.md"))) {
    throw new PackError(`${agentDir} has no instructions.md. Pass the Sym app folder.`);
  }

  const instructions = new Map<string, string>();
  for (const file of pack.instructions) {
    const name = fileName(file, "instructions");
    if (instructions.has(name)) {
      throw new PackError(`Two pack instruction files are named "${name}"`);
    }
    instructions.set(name, file.content);
  }

  const skills = new Map<string, string>();
  for (const file of pack.playbooks) {
    const name = fileName(file, "playbooks").slice(0, -".md".length);
    if (!SKILL_NAME.test(name)) {
      throw new PackError(
        `playbooks "${file.path}": the skill name "${name}" must use ASCII letters, digits, underscores, and dashes, and at most 64 characters`,
      );
    }
    if (skills.has(name)) throw new PackError(`Two pack playbooks are named "${name}"`);
    skills.set(name, skillMarkdown(name, file.content));
  }

  const result: OverlayResult = { instructions: [], skills: [], replacedSkills: [] };

  const instructionsDir = join(agentDir, "instructions");
  if (instructions.size > 0) mkdirSync(instructionsDir, { recursive: true });
  for (const [name, content] of instructions) {
    // Pack instructions are added. They never replace another instruction file, core or pack.
    const target = join(instructionsDir, name);
    if (existsSync(target)) {
      throw new PackError(`Refusing to overwrite agent/instructions/${name}`);
    }
    writeFileSync(target, content);
    result.instructions.push(`agent/instructions/${name}`);
  }

  const skillsDir = join(agentDir, "skills");
  if (skills.size > 0) mkdirSync(skillsDir, { recursive: true });
  for (const [name, content] of skills) {
    // A playbook replaces a built-in skill of the same name, flat or packaged.
    const flat = join(skillsDir, `${name}.md`);
    const packaged = join(skillsDir, name);
    if (existsSync(flat) || existsSync(packaged)) {
      rmSync(packaged, { recursive: true, force: true });
      result.replacedSkills.push(name);
    }
    writeFileSync(flat, content);
    result.skills.push(`agent/skills/${name}.md`);
  }
  return result;
}
