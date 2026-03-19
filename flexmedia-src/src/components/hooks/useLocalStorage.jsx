import { useState, useEffect } from "react";

export function useLocalStorage(key, initialValue) {
  // localStorage is not available in Base44. Store in React state only.
  // Data persists for the current session but resets on page reload.
  const [value, setValue] = useState(initialValue);
  return [value, setValue];
}