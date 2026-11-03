# 092. Voice notes and audio clips reach the brain as transcripts

Status: accepted
Date: 2026-11-03

## Context

People send Slack audio clips and audio uploads. Eve gives the model an audio file as a label
only, not as sound. Eve's voice-notes pattern adds a tool that reads the staged file from the
session sandbox and transcribes it. Sym's sandbox is opt-in (`SYM_SANDBOX`, decision 089). Without
it, Eve cannot stage a file, and that tool would find nothing.

## Decision

1. The Slack channel transcribes audio before the turn starts. After the allow-list check and
   the shared-thread triage pass a message, `lib/voice/notes.ts` downloads each audio file with
   the bot token (`url_private`, through `SlackApi.download`, which refuses any host other than
   Slack's file host). It sends the bytes to a transcription model and adds a "Voice notes"
   context note with the transcript. Audio that is not meant for Sym is never transcribed. This
   is a channel step, not a tool, so a worker thread cannot call it.
2. Audio means an `audio/*` file or a Slack audio clip (`subtype: slack_audio`). Sym accepts the
   formats the transcription models read: WebM, Ogg, MP3, MP4 and M4A, WAV, and FLAC. Each file
   is limited to 25 MB and, when Slack reports the length, to 10 minutes. A message gets at most 3
   transcriptions. A transcript is cut at 8,000 characters. Sym checks the size and length before
   it downloads the file.
3. The route follows the brain's routing (decisions 018, 080). `SYM_TRANSCRIBE_MODEL` names the
   model, default `openai/gpt-transcribe`. OpenAI deprecated `whisper-1`, `gpt-4o-transcribe`,
   and `gpt-4o-mini-transcribe` on 2026-08-26 and removes them on 2027-02-26. It names
   `gpt-transcribe` (finished audio files) or `gpt-live-transcribe` (streaming) as the
   replacement ([OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)).
   The AI Gateway lists it as `openai/gpt-transcribe`
   ([Vercel AI Gateway](https://vercel.com/ai-gateway/models/gpt-transcribe)). Checked
   2026-11-03. With `SYM_MODEL_PROVIDER=openai` and
   `OPENAI_API_KEY`, Sym calls OpenAI directly. Otherwise it uses the AI Gateway when
   `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` is set, then OpenAI directly when only
   `OPENAI_API_KEY` is set. Anthropic has no transcription API, so an Anthropic-only deployment
   has no route. `SYM_TRANSCRIBE_MODEL=off` turns transcription off. `SYM_MODEL=fixture` reads
   the audio bytes as text, for local end-to-end runs.
4. Without a route, or when a file is refused, a download fails, or the model fails, the note
   tells the brain why. The brain says so in one line and asks the person to type it. The
   capability note (decision 068) says whether Sym can hear audio.
5. A transcript is untrusted content with the same standing as the sender's typed text. It can be
   that person's request, because they spoke it. Text in it that quotes or forwards someone else
   is data. Angle brackets are replaced, so a transcript cannot close its tag or forge a mention.
   A spoken "yes" is not a typed approval: Start / Not now still needs a click or a typed reply.
6. The Slack channel's upload policy lets Eve stage every file type except audio. Eve then
   neither opens a sandbox for audio nor shows the brain a bare audio label.
7. Logs name the route and the error class only. They never include a file URL, a transcript, or
   a token.
8. Event trigger runs (decision 088) do not transcribe audio. A trigger message is untrusted
   event text from anyone in the channel, and each transcription costs money, so a run sees the
   message text only. Only a person's own turn with Sym transcribes.

## Consequences

- Each voice note costs one transcription call on the owner's account.
- Eve's thread lookback collects earlier non-audio files for a mention, but Sym transcribes only
  audio on the message that starts the turn. A person who records a clip and then tags Sym in a
  second message must tag Sym in the clip's message, or send the clip in a thread where Sym
  already listens.
- A Slack audio clip with a video container type still reaches Eve as a file label. Sym also
  transcribes it.
- With `SYM_SANDBOX=on`, Eve still stages every non-audio file in the sandbox. Audio stays out
  because the pre-turn step covers it in both modes. A later decision could follow Eve's own
  voice-notes pattern when a sandbox runs: stage audio and let a tool transcribe it on demand.
- Slack's own clip transcription is not used. It may be off in a workspace and arrives later.
