'use client';

import { Activity, ChevronRight, Cpu, Globe, LayoutGrid, Plug, Shield, Zap } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

interface NavSection {
  label: string;
  items: NavItem[];
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

const NAV: NavSection[] = [
  {
    label: 'Workspace',
    items: [
      { href: '/activity', label: 'Activity', icon: Activity },
      { href: '/audit', label: 'Audit Log', icon: Shield },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { href: '/install', label: 'Install', icon: Plug },
      { href: '/provider', label: 'Provider', icon: Cpu },
      { href: '/connectors', label: 'Connectors', icon: Globe },
      { href: '/skills', label: 'Skills', icon: Zap },
    ],
  },
];

interface SidebarProps {
  workspaceName: string | null;
}

export function Sidebar({ workspaceName }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="w-56 flex-shrink-0 bg-surface-1 border-r border-border flex flex-col h-screen sticky top-0 overflow-y-auto">
      {/* Logo + workspace */}
      <div className="px-4 py-5 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="wordmark text-[15px] leading-none">SYM</span>
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
        </div>
        {workspaceName && (
          <p className="text-ink-tertiary text-[11px] mt-2 truncate leading-none font-mono">
            {workspaceName}
          </p>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-4">
        {NAV.map((section) => (
          <div key={section.label}>
            <p className="section-heading">{section.label}</p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link href={item.href} className={cn('nav-item w-full', isActive && 'active')}>
                      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.badge && <span className="badge-accent">{item.badge}</span>}
                      {isActive && (
                        <ChevronRight className="w-3 h-3 text-accent opacity-50 flex-shrink-0" />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border">
        <div className="flex items-center gap-2">
          <LayoutGrid className="w-3 h-3 text-ink-muted" />
          <span className="text-[10px] text-ink-muted font-mono">
            {process.env.NODE_ENV === 'development' ? 'dev' : 'prod'}
          </span>
        </div>
      </div>
    </aside>
  );
}
