import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-surface-1 flex flex-col items-center justify-center p-6">
      <div className="flex flex-col items-center gap-4 text-center animate-fade-in">
        <span className="text-5xl font-medium text-ink-muted font-mono tabular-nums">404</span>
        <p className="text-ink-secondary text-xs">Page not found.</p>
        <Link href="/" className="btn-ghost">
          Go home
        </Link>
      </div>
    </div>
  );
}
