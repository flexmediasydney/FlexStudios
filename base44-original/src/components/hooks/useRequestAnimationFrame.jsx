import { useEffect, useRef } from "react";

export function useRequestAnimationFrame(callback, shouldRun = true) {
  const frameRef = useRef(null);

  useEffect(() => {
    if (!shouldRun) return;

    const tick = () => {
      callback();
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [callback, shouldRun]);
}