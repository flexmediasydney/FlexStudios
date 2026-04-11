import React, { createContext, useContext, useEffect, useState } from "react";

const ThemeContext = createContext({
  theme: "system",
  setTheme: () => {},
  resolvedTheme: "light",
});

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try {
      return localStorage.getItem("flexstudios-theme") || "system";
    } catch {
      return "system";
    }
  });

  const [resolvedTheme, setResolvedTheme] = useState("light");

  useEffect(() => {
    const root = document.documentElement;

    const applyTheme = (mode) => {
      if (mode === "dark") {
        root.classList.add("dark");
        setResolvedTheme("dark");
      } else {
        root.classList.remove("dark");
        setResolvedTheme("light");
      }
    };

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      applyTheme(mq.matches ? "dark" : "light");

      const handler = (e) => applyTheme(e.matches ? "dark" : "light");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }

    applyTheme(theme);
  }, [theme]);

  const setTheme = (newTheme) => {
    setThemeState(newTheme);
    try {
      localStorage.setItem("flexstudios-theme", newTheme);
    } catch {
      // localStorage unavailable
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * Access the current theme context.
 * @returns {{ theme: 'light' | 'dark' | 'system', setTheme: (t: 'light' | 'dark' | 'system') => void, resolvedTheme: 'light' | 'dark' }}
 */
export function useTheme() {
  return useContext(ThemeContext);
}
