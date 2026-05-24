import { Plug } from 'lucide-react';

import { PlaceholderSection } from '@/components/placeholder-section';

export const metadata = { title: 'Install · Sym' };

export default function InstallPage() {
  return (
    <>
      {/* TODO: "Connect to Slack" button links to apps/agent's /slack/install route.
          The Slack OAuth flow (writing workspaces + slack_installs rows) lives
          in apps/agent, not here. Wire once that route exists. */}
      <PlaceholderSection
        icon={Plug}
        title="Install to Slack"
        description="Connect Sym to your Slack workspace. The OAuth flow will authorize the bot, save credentials, and wire up event handling — all initiated from here."
        comingSoon="Workspace install wizard — coming in the next chunk"
      />
    </>
  );
}
