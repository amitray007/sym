// Applies an adopter pack to the Sym app before `eve build`:
//   node scripts/pack-overlay.ts <pack-dir> <app-dir>
import { applyPackOverlay } from "../lib/pack/overlay.ts";

const [packDir, appDir] = process.argv.slice(2);
if (!packDir || !appDir) {
  console.error("Usage: node scripts/pack-overlay.ts <pack-dir> <app-dir>");
  process.exit(2);
}
try {
  const result = applyPackOverlay(packDir, appDir);
  for (const path of result.instructions) console.info(`instruction: ${path}`);
  for (const path of result.skills) console.info(`skill: ${path}`);
  for (const name of result.replacedSkills) console.info(`replaced built-in skill: ${name}`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
