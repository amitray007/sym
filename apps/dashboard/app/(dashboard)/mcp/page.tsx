import { Globe } from 'lucide-react';

import { PlaceholderSection } from '@/components/placeholder-section';

export const metadata = { title: 'MCP · Sym' };

export default function McpPage() {
  return (
    <PlaceholderSection
      icon={Globe}
      title="MCP Servers"
      description="Connect external MCP (Model Context Protocol) servers to extend Sym's toolset. Add endpoints, manage auth, and inspect the available tool catalog."
      comingSoon="MCP server management — coming in a future chunk"
    />
  );
}
