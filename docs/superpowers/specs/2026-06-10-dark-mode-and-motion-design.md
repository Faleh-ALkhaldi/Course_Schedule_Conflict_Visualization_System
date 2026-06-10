# CSCVS — Dark Mode + Motion Design Upgrade

Date: 2026-06-10
Status: Approved (plan), implementation in progress

## Goal
A polished, professional visual + interaction upgrade for SchedulerSWE: a complete
dark theme and tasteful Framer Motion animations, suitable for a formal academic
project. Refined, not gimmicky. All existing functionality, accessibility, and the
responsive layer are preserved.

## Locked decisions
- Dark mode default: **follow OS** (`prefers-color-scheme`), with a manual toggle
  that persists to `localStorage`.
- Accent: **indigo** (new refined accent) — `#4f46e5` light / `#818cf8` dark.
- Motion: **moderate** — noticeable, polished, still tasteful; all motion gated
  behind `prefers-reduced-motion` (Framer Motion `useReducedMotion`).
- Build order: dark mode + motion **interleaved per phase**.

## Architecture
- **Theming**: introduce a semantic token layer in `index.css` (`--bg-app`,
  `--bg-surface`, `--bg-elevated`, `--border-subtle`, `--border-strong`,
  `--accent`, `--accent-hover`, `--accent-soft`). In `:root` they alias the
  current colors (light = unchanged). A `[data-theme="dark"]` block overrides the
  semantic tokens, the `--text-*` tokens, and the `--slate-*` scale to dark values.
  `--white` is NOT remapped (it is used as foreground on the navy chrome); surfaces
  are migrated to `--bg-surface` per phase instead.
- **Theme control**: `ThemeContext` + `useTheme()` set `data-theme` on
  `<html>`; default resolves from OS, override persists in `localStorage`.
- **Motion**: `framer-motion` + a shared `motion-config` (durations/easings) that
  honors `useReducedMotion`.

## Phases (each verified live before the next)
0. Foundation — semantic tokens + dark overrides + indigo accent; `useTheme` +
   toggle in TopBar; install framer-motion + motion config. Endpoint: working
   OS-default toggle, zero light-mode regression.
1. Chrome (TopBar + Sidebar) — dark theme + entrance/stagger motion.
2. Grid + cards — dark grid/level-colors (AA), card + view-transition motion.
3. Modals + overlays — dark theme + AnimatePresence enter/exit.
4. States + final pass — skeletons, empty/error/toast polish; contrast +
   reduced-motion + responsive re-verify in dark. Endpoint: 178/178, builds clean.

## Constraints
- Preserve all behavior; no logic changes.
- Contrast >= AA (chrome >= 7:1); reduced-motion respected; responsive at
  390/768/1440 in both themes.
- Commit phase by phase under the user's identity, no AI trailers.
