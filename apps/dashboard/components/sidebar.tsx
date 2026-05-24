'use client';

import {
  Activity,
  Brain,
  ChevronRight,
  Cpu,
  Globe,
  LayoutGrid,
  Lock,
  Plug,
  Shield,
  Sparkles,
  Zap,
} from 'lucide-react';
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
      { href: '/acl', label: 'Access Control', icon: Lock },
      { href: '/provider', label: 'Provider', icon: Cpu },
      { href: '/mcp', label: 'MCP', icon: Globe },
      { href: '/skills', label: 'Skills', icon: Zap },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { href: '/soul', label: 'Soul', icon: Sparkles },
      { href: '/memory', label: 'Memory', icon: Brain },
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
      <div className="px-4 py-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent-400 to-accent-700 flex items-center justify-center flex-shrink-0 shadow-glow-accent">
            <span className="text-white font-bold text-sm">S</span>
          </div>
          <div className="min-w-0">
            <p className="text-ink-primary font-semibold text-sm leading-none tracking-tight">
              Sym
            </p>
            {workspaceName && (
              <p className="text-ink-tertiary text-[10px] mt-0.5 truncate leading-none">
                {workspaceName}
              </p>
            )}
          </div>
        </div>
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
