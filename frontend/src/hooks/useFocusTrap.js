import { useEffect } from 'react';

// NEW-FU-561 (audit P3): shared modal focus management.
//
// Keyboard users could previously Tab out of a modal into the page behind it (no focus
// trap), and on close focus was left wherever it happened to be. A modal calls
// useFocusTrap() once; on mount it:
//   • finds the dialog it belongs to — the LAST [role="dialog"] in the DOM. Effects run in
//     mount order, so a nested sub-modal (which mounts after its parent and renders later
//     in document order) is always "last" → each modal traps its OWN card;
//   • moves focus into that dialog, but ONLY if focus isn't already inside (so it never
//     fights a modal's own autoFocus input);
//   • traps Tab / Shift+Tab so focus cycles within the dialog;
//   • restores focus to the element focused before the modal opened, on close.
//
// Defensive: a no-op if no dialog is found; ignores hidden elements; touches nothing but
// focus + one keydown listener scoped to the dialog node. Requires the modal's card to
// carry role="dialog" (all modals do).
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),' +
  'select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useFocusTrap() {
  useEffect(() => {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    const node = dialogs[dialogs.length - 1];
    if (!node) return undefined;

    const prevActive = document.activeElement;
    const visible = () =>
      Array.from(node.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null);

    if (!node.contains(document.activeElement)) {
      const items = visible();
      (items[0] ?? node).focus?.();
    }

    function onKeyDown(e) {
      if (e.key !== 'Tab') return;
      const items = visible();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      if (prevActive && typeof prevActive.focus === 'function' && document.contains(prevActive)) {
        prevActive.focus();
      }
    };
  }, []);
}
