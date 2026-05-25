import { redirect } from 'next/navigation';

import { authMode } from '@/lib/auth';

import { PasswordForm } from '../password-form';

export const metadata = { title: 'Sign in · Sym' };

export default async function SignInPage() {
  const mode = authMode();
  if (mode === 'open') redirect('/'); // no auth configured — nothing to sign into

  return (
    <div className="min-h-screen bg-surface-0 flex flex-col items-center justify-center p-6">
      {/* Background grid */}
      <div
        className="fixed inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(#7c6af0 1px, transparent 1px), linear-gradient(90deg, #7c6af0 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      {/* Glow */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] opacity-20 blur-3xl bg-accent-500 rounded-full pointer-events-none" />

      <div className="relative z-10 flex flex-col items-center gap-8 w-full max-w-sm">
        {/* Logo + wordmark */}
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-accent-400 to-accent-700 flex items-center justify-center shadow-glow-accent">
              <span className="text-white font-bold text-xl tracking-tight">S</span>
            </div>
            <div className="absolute -inset-px rounded-xl border border-accent/30" />
          </div>
          <div className="text-center">
            <p className="text-ink-primary font-semibold text-lg tracking-tight">Sym</p>
            <p className="text-ink-tertiary text-xs mt-0.5">Control Plane</p>
          </div>
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
              className="text-accent hover:text-accent-400 transition-colors"
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
          colorBackground: '#14171e',
          colorText: '#f0f2f7',
          colorTextSecondary: '#9ba3b8',
          colorPrimary: '#7c6af0',
          colorInputBackground: '#0f1115',
          colorInputText: '#f0f2f7',
          borderRadius: '8px',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '13.5px',
        },
        elements: {
          card: 'bg-surface-3 border border-border shadow-card rounded-xl',
          headerTitle: 'text-ink-primary font-semibold',
          headerSubtitle: 'text-ink-secondary',
          socialButtonsBlockButton:
            'bg-surface-4 border border-border hover:bg-surface-5 text-ink-primary',
          formFieldInput:
            'bg-surface-1 border border-border text-ink-primary placeholder:text-ink-muted',
          formButtonPrimary: 'bg-accent hover:bg-accent-600 text-white font-medium',
          footerActionLink: 'text-accent hover:text-accent-400',
          dividerLine: 'bg-border',
          dividerText: 'text-ink-tertiary text-xs',
        },
      }}
    />
  );
}
