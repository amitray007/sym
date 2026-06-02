/**
 * Shared TUI theme — colors + health glyphs, so every screen reads the same.
 */

export const COLORS = {
  accent: 'cyan',
  ok: 'green',
  warn: 'yellow',
  bad: 'red',
  dim: 'gray',
} as const;

/** Map a connector's health to a status glyph + color. */
export function healthGlyph(d: { ok: boolean; error?: string }): { glyph: string; color: string } {
  if (d.ok) return { glyph: '●', color: COLORS.ok };
  if (d.error !== undefined) return { glyph: '⚠', color: COLORS.warn };
  return { glyph: '○', color: COLORS.dim };
}
