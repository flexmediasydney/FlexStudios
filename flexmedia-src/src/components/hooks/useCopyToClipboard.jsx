import { useState, useCallback, useRef, useEffect } from "react";

// BUG FIX: The previous implementation used setTimeout without a cleanup ref.
// If the component unmounted before the 2s timeout, setCopied would fire on an
// unmounted component. Multiple rapid clicks also accumulated orphaned timeouts.
// Now the timer is tracked in a ref and cleared on unmount + before each new copy.
export function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const copy = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, 2000);
      return true;
    } catch {
      return false;
    }
  }, []);

  return { copied, copy };
}