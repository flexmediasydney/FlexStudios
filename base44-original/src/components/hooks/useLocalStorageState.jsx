import { useState, useEffect } from "react";

export function useLocalStorageState(key, initialValue) {
  // localStorage is not available in Base44. Store in React state only.
  // Data persists for the current session but resets on page reload.
  const [state, setState] = useState(initialValue);
  return [state, setState];
}