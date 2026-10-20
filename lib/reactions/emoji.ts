import type { SlackApi } from "../slack/api.ts";
import { SlackApiError } from "../slack/api.ts";

// Emoji names for reactions (decision 051). Slack takes a name without colons. The standard
// names are checked by Slack itself (`invalid_name`), so Sym bundles no full list. The workspace's
// custom emoji and aliases come from `emoji.list` (scope `emoji:read`), cached for an hour.

export const EMOJI_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
export const SEARCH_LIMIT = 20;

// Sym never uses the "seen" reaction (decision 051).
const FORBIDDEN = new Set(["eyes", "eye"]);

// Common unicode emoji and their Slack names. Anything else must come as a name.
const UNICODE_NAMES: Record<string, string> = {
  "👀": "eyes",
  "👍": "+1",
  "👎": "-1",
  "✅": "white_check_mark",
  "✔": "heavy_check_mark",
  "🙏": "pray",
  "🙌": "raised_hands",
  "👏": "clap",
  "😂": "joy",
  "🤣": "rolling_on_the_floor_laughing",
  "😄": "smile",
  "😅": "sweat_smile",
  "🙂": "slightly_smiling_face",
  "🤔": "thinking_face",
  "💡": "bulb",
  "🫡": "saluting_face",
  "🎉": "tada",
  "🚀": "rocket",
  "🔥": "fire",
  "❤": "heart",
  "💯": "100",
  "✨": "sparkles",
  "💪": "muscle",
  "👌": "ok_hand",
  "😬": "grimacing",
  "🤝": "handshake",
  "🙈": "see_no_evil",
  "😮": "open_mouth",
  "🤯": "exploding_head",
  "🥳": "partying_face",
  "😎": "sunglasses",
};

export type EmojiName = { ok: true; name: string } | { ok: false; message: string };

const NAME_PATTERN = /^[a-z0-9_+'-]+$/;

// Turns what the brain passes (`:tada:`, `tada`, `🎉`) into a Slack emoji name, or says why not.
export function normalizeEmoji(input: string): EmojiName {
  const trimmed = input.trim().replaceAll("️", "");
  const fromUnicode = UNICODE_NAMES[trimmed];
  const bare = fromUnicode ?? trimmed.replace(/^:+|:+$/g, "").toLowerCase();
  if (!bare) return { ok: false, message: "Give an emoji name such as tada." };
  if (FORBIDDEN.has(bare)) {
    return { ok: false, message: "Sym does not use the eyes emoji. Pick another or stay silent." };
  }
  if (!NAME_PATTERN.test(bare)) {
    return {
      ok: false,
      message:
        "Use the emoji name without colons, such as tada or white_check_mark. " +
        "Call slack_emoji to find a custom emoji.",
    };
  }
  return { ok: true, name: bare };
}

export interface EmojiList {
  names: string[];
  // A Slack error code when the list could not load, such as missing_scope.
  error?: string;
}

export interface EmojiCache {
  list(): Promise<EmojiList>;
  // Custom emoji and alias names that contain `keyword`, best matches first, at most 20.
  search(keyword: string): Promise<EmojiList>;
}

export function createEmojiCache(
  api: SlackApi | undefined,
  now: () => number = Date.now,
): EmojiCache {
  let cached: { list: EmojiList; expires: number } | undefined;

  async function list(): Promise<EmojiList> {
    if (cached && cached.expires > now()) return cached.list;
    if (!api) return { names: [], error: "no_slack_access" };
    try {
      const response = await api.call("emoji.list", {});
      const emoji = (response.emoji ?? {}) as Record<string, unknown>;
      const loaded = { names: Object.keys(emoji).sort() };
      cached = { list: loaded, expires: now() + EMOJI_TTL_MS };
      return loaded;
    } catch (error) {
      const code = error instanceof SlackApiError ? error.code : "request_failed";
      console.warn(`Sym could not list custom emoji: ${code}`);
      const failed = { names: [], error: code };
      cached = { list: failed, expires: now() + FAILURE_TTL_MS };
      return failed;
    }
  }

  return {
    list,
    async search(keyword) {
      const loaded = await list();
      const needle = keyword
        .trim()
        .toLowerCase()
        .replace(/^:+|:+$/g, "");
      const hits = loaded.names.filter((name) => name.includes(needle));
      hits.sort((a, b) => Number(b.startsWith(needle)) - Number(a.startsWith(needle)));
      return { ...loaded, names: hits.slice(0, SEARCH_LIMIT) };
    },
  };
}
