import { redirect } from 'next/navigation';

// Root: authenticated users see dashboard, unauthenticated → Clerk redirect.
// Middleware handles auth gate; this just bounces to the main section.
export default function RootPage() {
  redirect('/activity');
}
