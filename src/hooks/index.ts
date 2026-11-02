import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/** Reactive media query, e.g. useMediaQuery('(max-width: 600px)'). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof matchMedia !== 'function') return () => {};
      const list = matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
    () => false,
  );
}

/**
 * Returns a callback ref; `callback` runs whenever the (possibly conditionally rendered) element
 * scrolls near the viewport.
 */
export function useInfiniteTrigger(callback: () => void) {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  return useCallback((element: HTMLElement | null) => {
    if (!element || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
}
