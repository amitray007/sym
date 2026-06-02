/**
 * Server utility helpers — shared by the HTTP surface layer.
 * Pure functions, no side effects, no Slack/external dependencies.
 */

/**
 * POST a JSON payload to a Slack `response_url` and SURFACE failures. Critical
 * subtlety: `fetch` does NOT reject on a 4xx/5xx, so a payload Slack refuses
 * (e.g. an unsupported block type, or `invalid_blocks`) otherwise fails
 * completely silently — the user sees nothing and nothing is logged. Returns
 * true only on a 2xx; logs the status + body (Slack's error string) otherwise.
 */
export async function postToResponseUrl(responseUrl: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '<no body>');
      console.warn(`[agent] response_url POST rejected: HTTP ${res.status} — ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[agent] response_url POST threw (network?):', err);
    return false;
  }
}

/** True for IPv4/IPv6 loopback addresses (and the IPv4-mapped form). */
export function isLoopback(address: string | undefined): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address === 'localhost'
  );
}

/** Cap a logged request string so a pasted wall of text can't flood the logs. */
export function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------------------------------------------------------------------
// OAuth callback page helpers (no external dependencies)
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function htmlPage(title: string, body: string, success: boolean): string {
  const icon = success ? '✅' : '❌';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #1a1a1a; }
    h1 { font-size: 1.4rem; }
    p { color: #444; line-height: 1.6; }
  </style>
</head>
<body>
  <h1>${icon} ${escapeHtml(title)}</h1>
  ${body}
</body>
</html>`;
}

/** Bounded in-memory dedup by Slack `event_id` / `trigger_id`. */
export function createDedup(max = 10_000): (id: string) => boolean {
  const seen = new Set<string>();
  return (id: string): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > max) {
      // Drop the oldest half (insertion order preserved by Set).
      for (const old of [...seen].slice(0, max / 2)) seen.delete(old);
    }
    return false;
  };
}
