import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

// Theme: 'light' | 'dark'. The user's explicit choice (if any) is stored in
// localStorage; with no stored choice we follow the OS (prefers-color-scheme)
// and keep tracking it live. The resolved theme is written to <html data-theme>,
// which index.css's [data-theme="dark"] block reads.
const ThemeContext = createContext(null);
const STORAGE_KEY = 'sg-theme';

function readStored() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s === 'light' || s === 'dark' ? s : null;
  } catch { return null; }
}
function osPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

export function ThemeProvider({ children }) {
  const [explicit, setExplicit] = useState(() => readStored());            // user override, or null
  const [theme, setTheme] = useState(() => explicit ?? (osPrefersDark() ? 'dark' : 'light'));

  // Reflect onto <html> so CSS can theme everything from one attribute.
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);

  // While the user hasn't picked explicitly, follow live OS changes.
  useEffect(() => {
    if (explicit || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => setTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [explicit]);

  const toggle = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
      setExplicit(next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, isDark: theme === 'dark', toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
