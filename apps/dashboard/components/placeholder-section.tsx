import { Clock } from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

interface PlaceholderSectionProps {
  icon: LucideIcon;
  title: string;
  description: string;
  comingSoon?: string;
}

export function PlaceholderSection({
  icon: Icon,
  title,
  description,
  comingSoon,
}: PlaceholderSectionProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-0 p-12">
      <div className="flex flex-col items-center gap-5 max-w-sm text-center animate-fade-in">
        {/* Icon with glow effect */}
        <div className="relative">
          <div className="w-14 h-14 rounded-2xl bg-surface-4 border border-border flex items-center justify-center">
            <Icon className="w-6 h-6 text-ink-tertiary" />
          </div>
          <div className="absolute -inset-4 bg-accent/5 rounded-full blur-xl pointer-events-none" />
        </div>

        <div className="space-y-2">
          <h2 className="text-ink-primary font-semibold text-base">{title}</h2>
          <p className="text-ink-secondary text-sm leading-relaxed">{description}</p>
        </div>

        {comingSoon && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-surface-3">
            <Clock className="w-3 h-3 text-ink-tertiary" />
            <span className="text-ink-tertiary text-xs">{comingSoon}</span>
          </div>
        )}
      </div>
    </div>
  );
}
