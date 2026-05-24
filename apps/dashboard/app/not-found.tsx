import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-surface-0 flex flex-col items-center justify-center p-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="text-6xl font-bold text-ink-muted font-mono">404</span>
        <p className="text-ink-secondary text-sm">Page not found.</p>
        <Link href="/" className="btn-ghost">
          Go home
        </Link>
      </div>
    </div>
  );
}
