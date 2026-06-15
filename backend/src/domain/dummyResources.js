// NEW-FU-429 (Phase 106 items 3+4): shared helpers for term-local PLACEHOLDER
// ("dummy") instructors/venues, used by SuggestService, QuickFixService, and
// TermService so the three paths agree on naming and — critically — give every
// dummy instructor a VALID, non-conflicting office-hours block.
//
// Why office hours: a persisted dummy instructor has a real UUID, so the
// engine's R-13 ("instructor has no office hours") would fire against it in the
// main grid / save-time / Quick Fix evaluators. Phase 105 exempted __dummy ids
// in QuickFix's evaluator only; Phase 106 instead gives the placeholder a real
// OH block so it satisfies R-13 EVERYWHERE — without creating R-04 (a section
// overlapping its own instructor's OH), by picking a slot that avoids all of
// the dummy's own teaching slots.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
const OH_WINDOW_START = 8 * 60;   // 08:00
// NEW-FU-496 (Phase 120): office hours may ONLY be held 08:00–16:00 (the same
// window enforced at every input and the API). The previous 22:00 bound could
// mint a placeholder OH outside the legal window (e.g. 20:00–21:00), which then
// read as an out-of-window block the UI/API would never have allowed. 8 one-hour
// slots × 5 days = 40 candidate blocks still make a free, non-overlapping pick
// effectively certain even for a heavily-reused dummy.
const OH_WINDOW_END   = 16 * 60;  // 16:00
const OH_DURATION     = 60;       // a 1-hour block

function toMin(t) {
  const [h, m] = String(t).split(':');
  return Number(h) * 60 + Number(m);
}
function hhmmss(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

// Names follow the existing real formats (ALL-CAPS instructor; building-room
// venue). The "dummy" tag itself lives on the record (is_dummy) and in the UI
// badge — not baked into the name — so a placeholder still reads like a real one.
function dummyInstructorName(n) { return `NEW INSTRUCTOR ${n}`; }
function dummyVenueName(n)      { return `22-${900 + n}`; }

// Pick a valid OH block (Sun–Thu, 08:00–16:00, 60 min) that does NOT overlap any
// of the dummy's own teaching slots. busySlots: [{ day, start, end }] (HH:MM[:SS]).
function pickDummyOfficeHours(busySlots = []) {
  const busy = busySlots
    .filter(s => s && s.day && s.start && s.end)
    .map(s => ({ day: s.day, start: toMin(s.start), end: toMin(s.end) }));
  for (const day of DAYS) {
    for (let t = OH_WINDOW_START; t + OH_DURATION <= OH_WINDOW_END; t += OH_DURATION) {
      const s = t, e = t + OH_DURATION;
      if (!busy.some(b => b.day === day && b.start < e && s < b.end)) {
        return { day, startTime: hhmmss(s), endTime: hhmmss(e) };
      }
    }
  }
  // Fallback (a placeholder can't realistically fill all 40 candidate blocks).
  return { day: 'Monday', startTime: '08:00:00', endTime: '09:00:00' };
}

// NEW-FU-431 (Phase 106): venues.name is UNIQUE, so the per-term "22-9NN"
// sequence collided across terms (two terms each minting 22-901 → 500). Mint a
// GLOBALLY-free building-room name instead. Scans from 901 upward (unbounded, so
// it always terminates), keeping the real "22-NNN" format. Must be called inside
// the same client/transaction that inserts the row so prior mints are visible.
async function nextDummyVenueName(client) {
  // NEW-FU-449 (Phase 107 D2): serialize dummy-venue naming across concurrent
  // applies (Suggest/QuickFix/TermService all mint here) with a transaction-scoped
  // advisory lock. Without it, two transactions could read the same free "22-9NN"
  // and the second INSERT would hit the venues.name UNIQUE constraint → the whole
  // apply 500s. The lock releases at COMMIT/ROLLBACK and is re-entrant within a txn.
  await client.query('SELECT pg_advisory_xact_lock($1)', [428107]);
  const r = await client.query(`SELECT name FROM venues WHERE name LIKE '22-9%'`);
  const used = new Set(r.rows.map(x => x.name));
  for (let n = 901; ; n++) {
    const name = `22-${n}`;
    if (!used.has(name)) return name;
  }
}

module.exports = { dummyInstructorName, dummyVenueName, pickDummyOfficeHours, nextDummyVenueName, DAYS };
