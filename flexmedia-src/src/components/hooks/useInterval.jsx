import { useEffect } from "react";

export function useInterval(callback, delay) {
  useEffect(() => {
    if (delay === null || delay === undefined) return;
    const id = setInterval(callback, delay);
    return () => clearInterval(id);
  }, [callback, delay]);
}