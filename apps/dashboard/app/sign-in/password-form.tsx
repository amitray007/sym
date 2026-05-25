'use client';

import { useActionState } from 'react';

import { signIn, type SignInResult } from './actions';

const initial: SignInResult = { ok: false };

const inputCls =
  'w-full bg-surface-1 border border-border rounded-md px-3 py-2 text-ink-primary text-sm ' +
  'placeholder:text-ink-muted focus:outline-none focus:border-accent-400';

const btnCls =
  'w-full inline-flex items-center justify-center rounded-md bg-accent-500 px-4 py-2 text-sm ' +
  'font-medium text-white hover:bg-accent-400 disabled:opacity-50 transition-colors';

export function PasswordForm() {
  const [state, formAction, pending] = useActionState(signIn, initial);

  return (
    <form action={formAction} className="card p-6 flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-ink-secondary text-xs font-medium">Password</span>
        <input
          type="password"
          name="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Enter dashboard password"
          className={inputCls}
        />
      </label>

      {state.error ? <p className="text-danger text-xs">{state.error}</p> : null}

      <button type="submit" disabled={pending} className={btnCls}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
