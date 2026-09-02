import { useEffect, useState } from 'react';

/**
 * Layouts that differ enough to be different components — a data grid on a
 * desk and a stack of cards at a cutting table — need to be chosen in
 * JavaScript rather than hidden with CSS, so only one set of inputs exists in
 * the DOM and focus, tab order and autofocus behave.
 */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false),
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Below this the twelve-column habits stop working and cards take over. */
export const useHandheld = (): boolean => useMedia('(max-width: 760px)');
