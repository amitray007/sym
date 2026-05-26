import { LogOut, User } from 'lucide-react';

import { signOut } from '@/app/sign-in/actions';
import { authMode } from '@/lib/auth';

interface TopbarProps {
  pageTitle: string;
}

/**
 * Topbar — page title left, account control right.
 * No fake/inert controls (search, notifications removed).
 */
export function Topbar({ pageTitle }: TopbarProps) {
  return (
    <header className="h-11 border-b border-border bg-surface-2 sticky top-0 z-10 flex items-center px-5 gap-4">
      {/* Title */}
      <p className="text-ink-tertiary text-xs font-mono flex-1 truncate">{pageTitle}</p>

      {/* Account */}
      <UserButtonOrFallback />
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
            colorBackground: 'var(--color-surface-3)',
            colorText: 'var(--color-ink-primary)',
            colorPrimary: 'var(--color-accent)',
          },
          elements: {
            avatarBox: 'w-6 h-6',
          },
        }}
      />
    );
  }

  return (
    <div className="w-6 h-6 rounded-full bg-surface-4 border border-border flex items-center justify-center">
      <User className="w-3 h-3 text-ink-tertiary" />
    </div>
  );
}
