// Copies a pack's instructions and playbooks into an Eve agent folder before `eve build`
// (docs/adopting.md). Instructions are added under agent/instructions/. Playbooks become flat
// skills under agent/skills/ and replace a built-in skill of the same name.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadPack, PackError } from "./load.ts";
import { skillMarkdown } from "./skills.ts";

export interface OverlayResult {
  instructions: string[];
  skills: string[];
  replacedSkills: string[];
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
    const name = basename(file.path);
    if (instructions.has(name)) {
      throw new PackError(`Two pack instruction files are named "${name}"`);
    }
    instructions.set(name, file.content);
  }

  const skills = new Map<string, string>();
  for (const [field, files] of [
    ["playbooks", pack.playbooks],
    ["skills", pack.skills],
  ] as const) {
    for (const file of files) {
      const name = basename(file.path, ".md");
      skills.set(name, skillMarkdown(name, file.content, field === "playbooks"));
    }
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
