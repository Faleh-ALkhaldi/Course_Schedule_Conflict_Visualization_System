import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useTheme } from '../../context/ThemeContext.jsx';

// Sun/moon icons inline (1em squares, like the shared Icons set) so the toggle
// has no extra coupling.
const Sun = () => (
  <svg className="ui-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg className="ui-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
  </svg>
);

export default function ThemeToggle() {
  const ctx = useTheme();
  const reduce = useReducedMotion();
  if (!ctx) return null;
  const { isDark, toggle } = ctx;
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <motion.button
      type="button"
      className="topbar-theme-toggle"
      onClick={toggle}
      whileTap={reduce ? undefined : { scale: 0.9 }}
      title={label}
      aria-label={label}
    >
      {isDark ? <Sun /> : <Moon />}
    </motion.button>
  );
}
