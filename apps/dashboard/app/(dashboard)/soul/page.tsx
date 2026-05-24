import { Sparkles } from 'lucide-react';

import { PlaceholderSection } from '@/components/placeholder-section';

export const metadata = { title: 'Soul · Sym' };

export default function SoulPage() {
  return (
    <PlaceholderSection
      icon={Sparkles}
      title="Soul"
      description="Shape Sym's personality — tone, formality, persona name, and style rules. The soul config is applied on every generation through the tone-rewrite pipeline."
      comingSoon="Soul editor — coming in a future chunk"
    />
  );
}
