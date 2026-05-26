import { redirect } from 'next/navigation';

import { authMode } from '@/lib/auth';

import { PasswordForm } from '../password-form';

export const metadata = { title: 'Sign in · Sym' };

export default async function SignInPage() {
  const mode = authMode();
  if (mode === 'open') redirect('/'); // no auth configured — nothing to sign into

  return (
    <div className="min-h-screen bg-surface-1 flex flex-col items-center justify-center p-6">
      <div className="flex flex-col items-center gap-8 w-full max-w-xs">
        {/* Wordmark */}
        <div className="flex flex-col items-center gap-2">
          <span className="wordmark text-[18px] leading-none">SYM</span>
          <p className="text-ink-muted text-[10px] font-mono">control plane</p>
        </div>

        {/* Password form (password mode) or Clerk sign-in (clerk mode) */}
        <div className="w-full">{mode === 'password' ? <PasswordForm /> : <ClerkSignIn />}</div>

        {/* Fine print */}
        {mode === 'clerk' ? (
          <p className="text-ink-muted text-[11px] text-center">
            Access is restricted to approved admins.
            <br />
            Not an admin?{' '}
            <a
              href="/request-access"
              className="text-accent hover:text-accent-300 transition-colors"
            >
              Request access
            </a>
          </p>
        ) : (
          <p className="text-ink-muted text-[11px] text-center">Single-tenant dashboard access.</p>
        )}
      </div>
    </div>
  );
}

async function ClerkSignIn() {
  const { SignIn } = await import('@clerk/nextjs');

  return (
    <SignIn
      appearance={{
        variables: {
          colorBackground: 'var(--color-surface-3)',
          colorText: 'var(--color-ink-primary)',
          colorTextSecondary: 'var(--color-ink-secondary)',
          colorPrimary: 'var(--color-accent)',
          colorInputBackground: 'var(--color-surface-2)',
          colorInputText: 'var(--color-ink-primary)',
          borderRadius: '6px',
          fontFamily: 'Geist, system-ui, sans-serif',
          fontSize: '13px',
        },
        elements: {
          card: 'bg-surface-3 border border-border shadow-none rounded-md',
          headerTitle: 'text-ink-primary font-medium',
          headerSubtitle: 'text-ink-secondary',
          socialButtonsBlockButton:
            'bg-surface-4 border border-border hover:bg-surface-5 text-ink-primary',
          formFieldInput:
            'bg-surface-2 border border-border text-ink-primary placeholder:text-ink-muted font-mono',
          formButtonPrimary: 'bg-ink-primary text-surface-0 hover:opacity-90 font-medium',
          footerActionLink: 'text-accent hover:text-accent-300',
          dividerLine: 'bg-border',
          dividerText: 'text-ink-tertiary text-xs',
        },
      }}
    />
  );
}
