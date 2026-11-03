import { transcribe } from "ai";

// Which model turns voice notes and audio clips into text (decision 092). It follows the brain's
// routing (decisions 018, 080): the AI Gateway when it has a credential, or OpenAI directly with
// OPENAI_API_KEY. Anthropic has no transcription API, so an Anthropic-only deployment has no
// route and Sym tells the person it cannot hear audio. SYM_TRANSCRIBE_MODEL=off turns it off.
export const DEFAULT_TRANSCRIBE_MODEL = "openai/gpt-transcribe";

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";

export interface Audio {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}

export interface TranscriptionRoute {
  // For the capability note and logs. Never a credential.
  name: "gateway" | "openai" | "fixture";
  model: string;
  transcribe(audio: Audio, signal: AbortSignal): Promise<string>;
}

export function transcriptionRoute(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): TranscriptionRoute | undefined {
  const configured = env.SYM_TRANSCRIBE_MODEL?.trim();
  if (configured?.toLowerCase() === "off") return undefined;
  // A test fixture, like the fixture brain: it reads the audio bytes as UTF-8 text, so local
  // end-to-end runs need no provider.
  if (env.SYM_MODEL?.trim() === "fixture") {
    return {
      name: "fixture",
      model: "fixture",
      transcribe: async (audio) => new TextDecoder().decode(audio.bytes),
    };
  }
  const model = configured || DEFAULT_TRANSCRIBE_MODEL;
  const provider = env.SYM_MODEL_PROVIDER?.trim().toLowerCase() || "gateway";
  const hasGateway = Boolean(env.AI_GATEWAY_API_KEY?.trim() || env.VERCEL_OIDC_TOKEN?.trim());
  const openaiKey = env.OPENAI_API_KEY?.trim();
  const openaiModel = openaiModelId(model);
  const direct =
    openaiKey && openaiModel ? openaiRoute(openaiKey, openaiModel, fetchImpl) : undefined;
  // An owner who chose the direct OpenAI route keeps audio on it too.
  if (provider === "openai" && direct) return direct;
  if (hasGateway) return gatewayRoute(model);
  return direct;
}

function gatewayRoute(model: string): TranscriptionRoute {
  return {
    name: "gateway",
    model,
    async transcribe(audio, signal) {
      // A gateway model ID resolves through the AI SDK's default provider, the gateway, with
      // the same credential as the brain. The SDK detects the format from the bytes.
      const { text } = await transcribe({
        model,
        audio: audio.bytes,
        abortSignal: signal,
        maxRetries: 1,
      });
      return text;
    },
  };
}

// The OpenAI model ID: a bare ID, or a gateway ID under `openai/`. Another vendor's model has no
// direct route.
function openaiModelId(model: string): string | undefined {
  if (!model.includes("/")) return model;
  return model.startsWith("openai/") ? model.slice("openai/".length) : undefined;
}

function openaiRoute(apiKey: string, model: string, fetchImpl: typeof fetch): TranscriptionRoute {
  return {
    name: "openai",
    model,
    async transcribe(audio, signal) {
      const form = new FormData();
      // OpenAI reads the format from the file name's extension.
      form.append(
        "file",
        new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType }),
        audio.name,
      );
      form.append("model", model);
      form.append("response_format", "json");
      const response = await fetchImpl(OPENAI_TRANSCRIPTIONS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal,
      });
      if (!response.ok) throw new Error(`OpenAI transcription failed: HTTP ${response.status}`);
      const body = (await response.json()) as { text?: unknown };
      if (typeof body.text !== "string") throw new Error("OpenAI transcription returned no text.");
      return body.text;
    },
  };
}
