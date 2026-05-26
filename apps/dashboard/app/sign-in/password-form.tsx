'use client';

import { useActionState } from 'react';

import { signIn, type SignInResult } from './actions';

const initial: SignInResult = { ok: false };

export function PasswordForm() {
  const [state, formAction, pending] = useActionState(signIn, initial);

  return (
    <form action={formAction} className="card p-5 flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-ink-secondary text-xs font-medium">Password</span>
        <input
          type="password"
          name="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Enter dashboard password"
          className="input"
        />
      </label>

      {state.error ? <p className="text-danger text-xs font-mono">{state.error}</p> : null}

      <button type="submit" disabled={pending} className="btn-primary justify-center">
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
