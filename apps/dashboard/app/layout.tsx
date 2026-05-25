import { ClerkProvider } from '@clerk/nextjs';

import { authMode } from '@/lib/auth';

import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Sym', template: '%s · Sym' },
  description: 'Sym control plane — configure and observe your AI teammate.',
};

/**
 * Root layout. ClerkProvider is rendered only in Clerk auth mode, so password
 * mode and `next build` (no Clerk config) render without it.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const useClerk = authMode() === 'clerk';

  return (
    <html lang="en" className="dark">
      <body>{useClerk ? <ClerkProvider>{children}</ClerkProvider> : children}</body>
    </html>
  );
}
