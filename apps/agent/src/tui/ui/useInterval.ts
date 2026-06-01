/**
 * useInterval — a declarative setInterval for auto-refreshing screens.
 * Pass `ms = null` to pause. The callback ref is kept current so the latest
 * closure runs without resetting the timer.
 */

import { useEffect, useRef } from 'react';

export function useInterval(callback: () => void, ms: number | null): void {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  });
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
