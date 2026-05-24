import { ClerkProvider } from '@clerk/nextjs';

import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Sym', template: '%s · Sym' },
  description: 'Sym control plane — configure and observe your AI teammate.',
};

/**
 * Root layout. ClerkProvider is rendered only when Clerk keys are present
 * so that `next build` passes without live Clerk configuration.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const hasClerkKey = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  return (
    <html lang="en" className="dark">
      <body>{hasClerkKey ? <ClerkProvider>{children}</ClerkProvider> : children}</body>
    </html>
  );
}
