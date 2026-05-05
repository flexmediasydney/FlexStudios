import { useEffect } from "react";

/**
 * Runs `callback` on a setInterval, pausing automatically when the tab is
 * hidden (document.visibilityState === 'hidden') so we don't waste CPU /
 * battery / re-renders for cards the user can't see.
 *
 * On returning to the tab, fires `callback` once immediately so the UI
 * shows current state without waiting for the next tick.
 *
 * `enabled = false` skips the interval entirely (e.g. no running timer).
 *
 * Drift is unaffected: callers should always derive elapsed time from
 * `Date.now() - since`, not from a tick counter, so any missed ticks are
 * recovered the next time the callback fires.
 */
export function useVisibleInterval(callback, ms = 1000, { enabled = true } = {}) {
  useEffect(() => {
    if (!enabled) return undefined;

    let iv = setInterval(callback, ms);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (iv) { clearInterval(iv); iv = null; }
      } else if (!iv) {
        callback(); // immediate refresh on return
        iv = setInterval(callback, ms);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (iv) clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [callback, ms, enabled]);
}
