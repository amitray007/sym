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
        {/* Icon */}
        <div className="w-10 h-10 rounded bg-surface-4 border border-border flex items-center justify-center">
          <Icon className="w-5 h-5 text-ink-muted" />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-ink-primary font-medium text-sm">{title}</h2>
          <p className="text-ink-secondary text-xs leading-relaxed">{description}</p>
        </div>

        {comingSoon && <span className="badge font-mono text-[10px]">{comingSoon}</span>}
      </div>
    </div>
  );
}
