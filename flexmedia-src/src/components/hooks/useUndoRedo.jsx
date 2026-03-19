import { useState, useCallback } from "react";

export function useUndoRedo(initialValue) {
  const [state, setState] = useState(initialValue);
  const [history, setHistory] = useState([initialValue]);
  const [currentIndex, setCurrentIndex] = useState(0);

  const updateState = useCallback((newValue) => {
    const newHistory = history.slice(0, currentIndex + 1);
    setHistory([...newHistory, newValue]);
    setCurrentIndex(newHistory.length);
    setState(newValue);
  }, [history, currentIndex]);

  const undo = useCallback(() => {
    if (currentIndex > 0) {
      const newIndex = currentIndex - 1;
      setCurrentIndex(newIndex);
      setState(history[newIndex]);
    }
  }, [currentIndex, history]);

  const redo = useCallback(() => {
    if (currentIndex < history.length - 1) {
      const newIndex = currentIndex + 1;
      setCurrentIndex(newIndex);
      setState(history[newIndex]);
    }
  }, [currentIndex, history]);

  return { state, updateState, undo, redo, canUndo: currentIndex > 0, canRedo: currentIndex < history.length - 1 };
}