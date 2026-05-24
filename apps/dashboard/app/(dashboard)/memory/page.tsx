import { Brain } from 'lucide-react';

import { PlaceholderSection } from '@/components/placeholder-section';

export const metadata = { title: 'Memory · Sym' };

export default function MemoryPage() {
  return (
    <PlaceholderSection
      icon={Brain}
      title="Memory"
      description="Browse and manage Sym's episodic + semantic memory store. Inspect what Sym remembers about your team, channels, and past interactions."
      comingSoon="Memory explorer — coming in a future chunk"
    />
  );
}
