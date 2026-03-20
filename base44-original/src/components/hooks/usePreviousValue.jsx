import { useEffect, useRef } from "react";

export function usePreviousValue(value) {
  const ref = useRef(null);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref.current;
}