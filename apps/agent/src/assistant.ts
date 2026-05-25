import type { AssistantThreadStarted, SlackClient } from '@sym/adapter-slack';

/**
 * Starter prompts shown when a user opens Sym's assistant panel, so the
 * container isn't an empty box. Kept generic — context-aware prompts (e.g.
 * "summarize #the-channel-you're-viewing") come once we track thread context.
 */
const STARTER_PROMPTS = [
  { title: 'What can you do?', message: 'What can you help me with?' },
  { title: 'Summarize a thread', message: 'Summarize this thread for me' },
  { title: 'Draft a reply', message: 'Help me draft a reply to this' },
];

/**
 * Greet a freshly opened assistant container by setting Sym's suggested prompts.
 * Best-effort: a failed greeting must never throw into the event-ACK path.
 */
export async function handleAssistantThreadStarted(
  slackClient: SlackClient,
  thread: AssistantThreadStarted,
): Promise<void> {
  try {
    await slackClient.assistantThreadsSetSuggestedPrompts({
      channelId: thread.channelId,
      threadTs: thread.threadTs,
      prompts: STARTER_PROMPTS,
    });
  } catch (err) {
    console.warn('[agent] failed to set assistant suggested prompts:', err);
  }
}
