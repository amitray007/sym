import { ArrowLeft, ShieldOff } from 'lucide-react';
import Link from 'next/link';

export const metadata = { title: 'Request Access · Sym' };

export default function RequestAccessPage() {
  return (
    <div className="min-h-screen bg-surface-1 flex flex-col items-center justify-center p-6">
      <div className="flex flex-col items-center gap-6 w-full max-w-sm text-center animate-fade-in">
        {/* Icon */}
        <div className="w-10 h-10 rounded bg-surface-4 border border-border flex items-center justify-center">
          <ShieldOff className="w-5 h-5 text-ink-muted" />
        </div>

        {/* Heading */}
        <div className="space-y-1.5">
          <h1 className="text-ink-primary font-medium text-sm">Access Restricted</h1>
          <p className="text-ink-secondary text-xs leading-relaxed">
            Your account doesn&apos;t have admin access to this Sym workspace. Contact an existing
            admin to be added to the allowlist.
          </p>
        </div>

        {/* Instructions */}
        <div className="card w-full p-5 text-left space-y-3">
          <p className="section-heading">How to get access</p>
          <ol className="space-y-3 text-xs text-ink-secondary">
            <li className="flex gap-3">
              <span className="font-mono text-ink-muted flex-shrink-0">1.</span>
              <span>
                Ask an existing Sym admin to add your email to the{' '}
                <code className="text-accent font-mono bg-surface-4 px-1 py-0.5 rounded-sm">
                  dashboard_admins
                </code>{' '}
                table.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-ink-muted flex-shrink-0">2.</span>
              <span>Sign out and sign back in to pick up the new role.</span>
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-ink-muted flex-shrink-0">3.</span>
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
