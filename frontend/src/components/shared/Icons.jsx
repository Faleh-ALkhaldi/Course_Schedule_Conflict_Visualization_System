import React from 'react';

// NEW-FU-503 (Phase 123): shared inline-SVG icon set for app chrome (TopBar,
// view labels, term picker, side panel, dialogs, card popover). Replaces the
// mixed emoji glyphs (⊞ ✦ ✓ ↑ ↓ ⏻ 📋 👤 🏛 ⏱ 🗑 🔒 🔓 📦 ⚠️ …) with one
// consistent family. Same conventions as the SectionModal's Phase-101 local
// set (24×24 Lucide-style stroked paths, currentColor, 2px stroke) — the
// SectionModal keeps its own copy untouched so nothing there is refactored.
// Sizing comes from CSS: .ui-ico is 1em×1em, so every icon scales with the
// font of whatever button / label it sits in.
const ICONS = {
  grid:      'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  sparkles:  'M12 3l1.9 5.7a2 2 0 0 0 1.4 1.4L21 12l-5.7 1.9a2 2 0 0 0-1.4 1.4L12 21l-1.9-5.7a2 2 0 0 0-1.4-1.4L3 12l5.7-1.9a2 2 0 0 0 1.4-1.4L12 3z',
  check:     'M20 6 9 17l-5-5',
  upload:    'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download:  'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  power:     'M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10',
  lock:      'M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 0 1 8 0v4',
  unlock:    'M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 0 1 7.9-.9',
  clipboard: 'M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1zM8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2',
  user:      'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  pin:       'M12 21s-6-5.7-6-10a6 6 0 1 1 12 0c0 4.3-6 10-6 10zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  clock:     'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  alert:     'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  info:      'M12 16v-4M12 8h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  trash:     'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
  archive:   'M3 4h18v5H3zM5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4',
  restore:   'M3 12a9 9 0 1 0 3-6.7M3 3v6h6',
  tag:       'M12 2H2v10l9.3 9.3a1 1 0 0 0 1.4 0l8.6-8.6a1 1 0 0 0 0-1.4L12 2zM7 7h.01',
  book:      'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
};

export default function Ico({ name, className }) {
  const d = ICONS[name];
  if (!d) return null;
  return (
    <svg className={`ui-ico ${className || ''}`} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}
