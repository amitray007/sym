import { Bell, Search, User } from 'lucide-react';

interface TopbarProps {
  pageTitle: string;
}

/**
 * Topbar with Clerk UserButton (lazy-loaded when Clerk keys are present).
 * Falls back to a generic user icon in build/test environments.
 */
export function Topbar({ pageTitle }: TopbarProps) {
  return (
    <header className="h-11 border-b border-border bg-surface-2/80 backdrop-blur-sm sticky top-0 z-10 flex items-center px-5 gap-4">
      {/* Title */}
      <h1 className="text-ink-secondary text-xs font-medium flex-1">{pageTitle}</h1>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button className="btn-ghost p-1.5" aria-label="Search">
          <Search className="w-3.5 h-3.5" />
        </button>

        <button className="btn-ghost p-1.5 relative" aria-label="Notifications">
          <Bell className="w-3.5 h-3.5" />
        </button>

        <div className="w-px h-4 bg-border mx-0.5" />

        <UserButtonOrFallback />
      </div>
    </header>
  );
}

/**
 * Server component: renders Clerk UserButton when keys are present,
 * or a placeholder user icon when building without credentials.
 */
async function UserButtonOrFallback() {
  const hasClerkKey = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  if (!hasClerkKey) {
    return (
      <div className="w-6 h-6 rounded-full bg-surface-5 border border-border flex items-center justify-center">
        <User className="w-3.5 h-3.5 text-ink-tertiary" />
      </div>
    );
  }

  const { UserButton } = await import('@clerk/nextjs');

  return (
    <UserButton
      appearance={{
        variables: {
          colorBackground: '#14171e',
          colorText: '#f0f2f7',
          colorPrimary: '#7c6af0',
        },
        elements: {
          avatarBox: 'w-6 h-6',
        },
      }}
    />
  );
}
