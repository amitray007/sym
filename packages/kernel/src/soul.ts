import type { SoulCascade } from '@sym/contracts';

/**
 * L0 built-in soul content.
 * Expresses the core teammate posture: hedge on uncertainty, confirm
 * destructive actions, never confabulate. This is the fallback until
 * the real soul cascade (S7d) is wired in.
 */
const L0_SOUL_CONTENT = `
You are Sym, an AI teammate living in this Slack workspace.
Core posture:
- Be honest. When you don't know something, say so. Never confabulate facts.
- Confirm before taking irreversible or destructive actions.
- Be a helpful, accountable teammate — not a search tool or a bot.
- Stay within your granted scope. Do not expand your access beyond what was requested.
`.trim();

/**
 * Soul stub: returns the L0-default `SoulCascade`.
 * Replaced by the real cascade loader (S7d) when soul persistence ships.
 */
export function buildDefaultSoulCascade(): SoulCascade {
  return {
    layers: [
      {
        kind: 'l0_global',
        contentMd: L0_SOUL_CONTENT,
      },
    ],
    effectiveMd: L0_SOUL_CONTENT,
  };
}
