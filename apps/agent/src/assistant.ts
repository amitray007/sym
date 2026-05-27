import type { AssistantThreadStarted, SlackClient } from '@sym/adapter-slack';

/** Title shown in the user's left-rail history for a freshly opened panel. */
const WELCOME_TITLE = 'New chat with Sym';

/**
 * Starter prompts shown when a user opens Sym's assistant panel, so the
 * container isn't an empty box. Mix of context-aware tasks + a low-stakes
 * "is anyone home" ping so the user can see Sym respond.
 */
const STARTER_PROMPTS = [
  {
    title: 'Summarize recent activity',
    message: 'Summarize the recent activity in this channel',
  },
  {
    title: 'Recall a decision',
    message: 'What did we decide about <topic> last week?',
  },
  {
    title: 'Thread takeaways',
    message: 'Read this thread and give me the key takeaways',
  },
  { title: 'What time is it?', message: 'What time is it?' },
];

/**
 * Greet a freshly opened assistant container: set a friendly title and the
 * starter prompts. Both calls are best-effort and independent — a failure in
 * one must never block the other or throw into the event-ACK path.
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
    await slackClient.assistantThreadsSetSuggestedPrompts({
      channelId: thread.channelId,
      threadTs: thread.threadTs,
      prompts: STARTER_PROMPTS,
    });
  } catch (err) {
    console.warn('[agent] failed to set assistant suggested prompts:', err);
  }
}
