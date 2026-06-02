import { loadStarterPrompts } from './manifest-prompts.js';

import type { AssistantThreadStarted, SlackClient } from '@sym/adapter-slack';

/** Title shown in the user's left-rail history for a freshly opened panel. */
const WELCOME_TITLE = 'New chat with Sym';

/**
 * One-line greeting posted into the empty panel so the user sees a friendly
 * acknowledgement before they type. Kept short — the suggested prompts
 * underneath already advertise capability.
 */
const WELCOME_MESSAGE = "👋 Hey! I'm Sym — pick a prompt below or ask me anything.";

/**
 * Greet a freshly opened assistant container: set a friendly title and the
 * starter prompts. Both calls are best-effort and independent — a failure in
 * one must never block the other or throw into the event-ACK path.
 *
 * CALLER MUST owner-gate before invoking. This function makes three Slack API
 * calls (setTitle, setSuggestedPrompts, chatPostMessage) on behalf of the
 * opening user with no internal ownership check. The caller is responsible for
 * verifying the event originates from the workspace owner before dispatching
 * here.
 */
export async function handleAssistantThreadStarted(
  slackClient: SlackClient,
  thread: AssistantThreadStarted,
): Promise<void> {
  try {
    await slackClient.assistantThreadsSetTitle({
      channelId: thread.channelId,
      threadTs: thread.threadTs,
      title: WELCOME_TITLE,
    });
  } catch (err) {
    console.warn('[agent] failed to set assistant thread title:', err);
  }

  try {
    // Single source of truth — the Slack manifest's
    // `features.assistant_view.suggested_prompts`. Editing the manifest is
    // the only place to change what these chips say.
    await slackClient.assistantThreadsSetSuggestedPrompts({
      channelId: thread.channelId,
      threadTs: thread.threadTs,
      prompts: loadStarterPrompts(),
    });
  } catch (err) {
    console.warn('[agent] failed to set assistant suggested prompts:', err);
  }

  // Post a brief greeting into the panel so the freshly opened thread isn't
  // an empty box above the suggested-prompts chips. Best-effort.
  try {
    await slackClient.chatPostMessage({
      channel: thread.channelId,
      text: WELCOME_MESSAGE,
      thread_ts: thread.threadTs,
    });
  } catch (err) {
    console.warn('[agent] failed to post assistant welcome message:', err);
  }
}
