import { Bell, LogOut, Search, User } from 'lucide-react';

import { signOut } from '@/app/sign-in/actions';
import { authMode } from '@/lib/auth';

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
 * Account control, per auth mode: Clerk UserButton (clerk), a sign-out button
 * (password), or a placeholder icon (open dev / build without credentials).
 */
async function UserButtonOrFallback() {
  const mode = authMode();

  if (mode === 'password') {
    return (
      <form action={signOut}>
        <button type="submit" className="btn-ghost p-1.5" aria-label="Sign out" title="Sign out">
          <LogOut className="w-3.5 h-3.5" />
        </button>
      </form>
    );
  }

  if (mode === 'clerk') {
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

  return (
    <div className="w-6 h-6 rounded-full bg-surface-5 border border-border flex items-center justify-center">
      <User className="w-3.5 h-3.5 text-ink-tertiary" />
    </div>
  );
}
