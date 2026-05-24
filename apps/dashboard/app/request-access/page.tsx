import { ArrowLeft, ShieldAlert } from 'lucide-react';
import Link from 'next/link';

export const metadata = { title: 'Request Access · Sym' };

export default function RequestAccessPage() {
  return (
    <div className="min-h-screen bg-surface-0 flex flex-col items-center justify-center p-6">
      {/* Background grid */}
      <div
        className="fixed inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(#ef4444 1px, transparent 1px), linear-gradient(90deg, #ef4444 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      {/* Glow */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[400px] h-[200px] opacity-15 blur-3xl bg-danger rounded-full pointer-events-none" />

      <div className="relative z-10 flex flex-col items-center gap-6 w-full max-w-md">
        {/* Icon */}
        <div className="w-16 h-16 rounded-2xl bg-danger/10 border border-danger/20 flex items-center justify-center">
          <ShieldAlert className="w-7 h-7 text-danger" />
        </div>

        {/* Content */}
        <div className="text-center space-y-2">
          <h1 className="text-xl font-semibold text-ink-primary">Access Restricted</h1>
          <p className="text-ink-secondary text-sm leading-relaxed max-w-sm">
            Your account doesn&apos;t have admin access to this Sym workspace. Contact an existing
            admin to be added to the allowlist.
          </p>
        </div>

        {/* Card with instructions */}
        <div className="card w-full p-5 space-y-4">
          <h2 className="text-xs font-semibold text-ink-secondary uppercase tracking-wider">
            How to get access
          </h2>
          <ol className="space-y-3 text-sm text-ink-secondary">
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-surface-5 border border-border flex items-center justify-center text-[10px] font-bold text-ink-tertiary">
                1
              </span>
              <span>
                Ask an existing Sym admin to add your email to the{' '}
                <code className="text-accent font-mono text-xs bg-surface-4 px-1 py-0.5 rounded">
                  dashboard_admins
                </code>{' '}
                table.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-surface-5 border border-border flex items-center justify-center text-[10px] font-bold text-ink-tertiary">
                2
              </span>
              <span>Sign out and sign back in to pick up the new role.</span>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-surface-5 border border-border flex items-center justify-center text-[10px] font-bold text-ink-tertiary">
                3
              </span>
              <span>
                First-time setup? Complete the Slack workspace install — the initiating admin
                automatically becomes owner.
              </span>
            </li>
          </ol>
        </div>

        <Link href="/sign-in" className="btn-ghost">
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
