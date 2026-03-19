import { useRef, useCallback } from "react";

export function useFocus() {
  const ref = useRef(null);

  const setFocus = useCallback(() => {
    ref.current?.focus();
  }, []);

  const blur = useCallback(() => {
    ref.current?.blur();
  }, []);

  return { ref, setFocus, blur };
}