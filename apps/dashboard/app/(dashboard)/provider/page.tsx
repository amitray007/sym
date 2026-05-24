import { Cpu } from 'lucide-react';

import { PlaceholderSection } from '@/components/placeholder-section';

export const metadata = { title: 'Provider · Sym' };

export default function ProviderPage() {
  return (
    <PlaceholderSection
      icon={Cpu}
      title="AI Provider"
      description="Configure the language model provider — API keys, model selection, temperature, and routing rules. Credentials are encrypted at rest."
      comingSoon="Provider configuration — coming in a future chunk"
    />
  );
}
