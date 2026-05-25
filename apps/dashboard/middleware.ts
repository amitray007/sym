import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

import type { NextFetchEvent, NextRequest } from 'next/server';

// Clerk middleware runs only in Clerk auth mode. In password/open mode it is a
// pass-through — the dashboard layout + /setup page enforce the session gate
// server-side (see lib/auth.ts → dashboardGate). Password takes precedence.
const usePassword = Boolean(process.env['SYM_DASHBOARD_PASSWORD']);
const clerkConfigured = Boolean(
  process.env['CLERK_SECRET_KEY'] && process.env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'],
);

const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/request-access(.*)', '/api/health']);

const clerkHandler =
  !usePassword && clerkConfigured
    ? clerkMiddleware(async (auth, request) => {
        if (!isPublicRoute(request)) {
          await auth.protect();
        }
      })
    : null;

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  if (clerkHandler) return clerkHandler(request, event);
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip static files + Next internals, but catch everything else
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
