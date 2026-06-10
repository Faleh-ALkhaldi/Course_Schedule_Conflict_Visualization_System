// Shared Framer Motion config for the app — tuned for "moderate, tasteful" motion
// (academic-formal: noticeable but never gimmicky). ALWAYS pair these with
// useReducedMotion() at the call site so motion-sensitive users get instant
// transitions, mirroring the global prefers-reduced-motion guard in index.css.

export const EASE = [0.16, 1, 0.3, 1]; // gentle ease-out (matches the existing toast-in curve)
export const DUR = { fast: 0.14, base: 0.22, slow: 0.34 };

export const fade = {
  initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 },
  transition: { duration: DUR.base, ease: EASE },
};
export const fadeUp = {
  initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 8 },
  transition: { duration: DUR.base, ease: EASE },
};
export const scaleIn = {
  initial: { opacity: 0, scale: 0.96 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.96 },
  transition: { duration: DUR.base, ease: EASE },
};

// List entrance: parent uses listStagger, children use listItem.
export const listStagger = { animate: { transition: { staggerChildren: 0.035 } } };
export const listItem = {
  initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 },
  transition: { duration: DUR.fast, ease: EASE },
};

// Helper: collapse a variant set to "no motion" when the user prefers reduced motion.
export const motionSafe = (reduce, variants) => (reduce ? {} : variants);
