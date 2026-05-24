import { Lock } from 'lucide-react';

import { PlaceholderSection } from '@/components/placeholder-section';

export const metadata = { title: 'Access Control · Sym' };

export default function AclPage() {
  return (
    <PlaceholderSection
      icon={Lock}
      title="Access Control"
      description="Define who can invoke Sym and what it can do on their behalf. Set per-user permission tiers, Slack channel policies, and tool-level ACLs."
      comingSoon="ACL editor — coming in a future chunk"
    />
  );
}
