'use server';

import { redirect } from 'next/navigation';

import { authMode, endPasswordSession, startPasswordSession, verifyPassword } from '@/lib/auth';

export interface SignInResult {
  ok: boolean;
  error?: string;
}

/**
 * Verify the dashboard password and start a session. Shaped for useActionState:
 * returns an error result on failure, redirects (throws) on success.
 */
export async function signIn(_prev: SignInResult, formData: FormData): Promise<SignInResult> {
  if (authMode() !== 'password') {
    return { ok: false, error: 'Password sign-in is not enabled.' };
  }
  const password = String(formData.get('password') ?? '');
  if (!verifyPassword(password)) {
    return { ok: false, error: 'Incorrect password.' };
  }
  await startPasswordSession();
  redirect('/');
}

/** Clear the session and return to sign-in. */
export async function signOut(): Promise<void> {
  await endPasswordSession();
  redirect('/sign-in');
}
