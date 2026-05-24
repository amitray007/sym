import { Zap } from 'lucide-react';

import { PlaceholderSection } from '@/components/placeholder-section';

export const metadata = { title: 'Skills · Sym' };

export default function SkillsPage() {
  return (
    <PlaceholderSection
      icon={Zap}
      title="Skills"
      description="Install, configure, and version Sym's skills — reusable capability bundles that extend what your AI teammate can do in Slack."
      comingSoon="Skills registry — coming in a future chunk"
    />
  );
}
