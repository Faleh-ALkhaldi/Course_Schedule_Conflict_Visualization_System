// Schedule Undo/Redo — snapshot + reconcile (NEW-FU-549, Batch 16)
// ─────────────────────────────────────────────────────────────────────────────
// Undo/redo for schedule SECTION edits is implemented as full-schedule SNAPSHOTS
// plus a group-level RECONCILE, rather than per-action inverse commands. A snapshot
// is keyed by STABLE identity (courseCode|sectionNumber), so it is immune to the
// id-churn that inverse-command undo suffers (a recreated section gets a new id).
// Because each snapshot captures the WHOLE schedule, a compound action (e.g. a Quick
// Fix that retimed several sections) is one snapshot delta — a single undo step.
//
// reconcileSchedule(target) brings the live schedule to match `target` by:
//   • deleting section-GROUPS that are absent in target or differ from it,
//   • (re)creating section-GROUPS that target has but the live schedule doesn't.
// Deleting-then-creating whole groups (never partial day rows) keeps every create
// pattern-valid (the KFUPM credits×duration×days rule needs the full day-set) and
// avoids the UNIQUE(schedule,course,section_number,day) collision (same lesson as the
// restructure fix). Unchanged groups are left untouched, so a typical undo touches
// just the one group that changed.

// Build a stable, comparable snapshot (array of section-GROUPS) from a flat sections list.
export function snapshotSchedule(sections) {
  const groups = new Map();
  for (const s of (sections || [])) {
    const courseCode    = s.courseCode    ?? s.course_code    ?? '';
    const sectionNumber = String(s.sectionNumber ?? s.section_number ?? '');
    // audit P2-9: gender is part of section identity (UNIQUE includes gender) — a male
    // §01 and a female §01 of one course must stay distinct groups, else undo/redo
    // collapses the dual-audience pair and corrupts the restored state.
    const gender        = s.gender ?? 'M';
    const key = `${courseCode}|${sectionNumber}|${gender}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key, courseCode, sectionNumber,
        sectionType:    s.sectionType    ?? s.section_type    ?? 'Lec',
        gender:         s.gender         ?? 'M',
        startTime:     (s.startTime ?? s.start_time ?? '').toString().slice(0, 5),
        endTime:       (s.endTime   ?? s.end_time   ?? '').toString().slice(0, 5),
        instructorName: s.instructorName ?? s.instructor_name ?? null,
        venueName:      s.venueName      ?? s.venue_name      ?? null,
        days: [],
      });
    }
    groups.get(key).days.push(s.day);
  }
  const out = [...groups.values()];
  for (const g of out) g.days = [...new Set(g.days)].sort();
  // Stable order so two equivalent schedules serialize identically.
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

// Two GROUPS describe the same scheduled state (ignoring id).
function sameGroup(a, b) {
  return !!a && !!b
    && a.days.join(',') === b.days.join(',')
    && a.startTime === b.startTime
    && a.endTime === b.endTime
    && (a.instructorName || '') === (b.instructorName || '')
    && (a.venueName || '') === (b.venueName || '')
    && a.sectionType === b.sectionType
    && (a.gender || 'M') === (b.gender || 'M');
}

// Two whole snapshots are equal → nothing changed (skip recording an empty step).
export function sameSnapshot(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || !sameGroup(a[i], b[i])) return false;
  }
  return true;
}

// A short, human-readable description of how `from` differs from `to` — used for the
// undo/redo tooltips and toasts ("Undo move SWE 206 §01").
export function describeDelta(from, to) {
  const fromByKey = new Map((from || []).map(g => [g.key, g]));
  const toByKey   = new Map((to   || []).map(g => [g.key, g]));
  const changed = [];
  for (const g of (to || []))   if (!sameGroup(fromByKey.get(g.key), g)) changed.push(g);
  for (const g of (from || [])) if (!toByKey.has(g.key)) changed.push(g);
  if (changed.length === 0) return 'change';
  const g = changed[0];
  const label = `${g.courseCode} §${g.sectionNumber}`;
  return changed.length === 1 ? label : `${label} +${changed.length - 1} more`;
}

// Bring the live schedule to match `target`. `resolvers` maps stable names/codes to
// current ids: { courseIdByCode, instructorIdByName, venueIdByName }.
export async function reconcileSchedule(api, scheduleId, target, resolvers) {
  const rawRows = (await api.getSections(scheduleId, 'course', null)).sections ?? [];
  const live = snapshotSchedule(rawRows);

  // Map each group key → a live row id so we can delete the group.
  const repIdByKey = new Map();
  for (const s of rawRows) {
    const key = `${s.courseCode ?? s.course_code ?? ''}|${String(s.sectionNumber ?? s.section_number ?? '')}|${s.gender ?? 'M'}`;
    if (!repIdByKey.has(key)) repIdByKey.set(key, s.id);
  }

  const liveByKey = new Map(live.map(g => [g.key, g]));
  const tgtByKey  = new Map(target.map(g => [g.key, g]));

  // NEW-FU-561 (audit P2-11): a snapshot stores instructor/venue by NAME. If that
  // resource was deleted since the snapshot, the old code silently recreated the section
  // WITHOUT it (instructorId/venueId → undefined) — data loss that then surfaced as a
  // phantom R-09/R-10 "missing instructor/venue". Validate that EVERY required name still
  // resolves BEFORE any delete/create, so the undo is atomic: it either fully restores or
  // aborts cleanly (caught by applySnapshot → SET_ERROR) with no half-applied schedule.
  for (const g of target) {
    if (liveByKey.has(g.key) && sameGroup(liveByKey.get(g.key), g)) continue; // unchanged → not recreated
    if (!resolvers.courseIdByCode(g.courseCode)) continue;                     // course gone → skipped at create
    if (g.instructorName && !resolvers.instructorIdByName(g.instructorName))
      throw new Error(`Can't restore ${g.courseCode} §${g.sectionNumber}: instructor “${g.instructorName}” no longer exists. Re-add it, then try again.`);
    if (g.venueName && !resolvers.venueIdByName(g.venueName))
      throw new Error(`Can't restore ${g.courseCode} §${g.sectionNumber}: venue “${g.venueName}” no longer exists. Re-add it, then try again.`);
  }

  // 1) Delete groups that are gone in target OR differ (delete-first frees the
  //    UNIQUE(course,section_number,day) keys before we re-create).
  for (const g of live) {
    if (!tgtByKey.has(g.key) || !sameGroup(g, tgtByKey.get(g.key))) {
      const repId = repIdByKey.get(g.key);
      if (repId) await api.deleteSection(repId);
    }
  }

  // 2) Create groups that target has but live lacks OR that differed (just deleted).
  for (const g of target) {
    if (liveByKey.has(g.key) && sameGroup(liveByKey.get(g.key), g)) continue;
    const courseId = resolvers.courseIdByCode(g.courseCode);
    if (!courseId) continue;   // course no longer exists — can't restore this group
    const instructorId = g.instructorName ? resolvers.instructorIdByName(g.instructorName) : null;
    const venueId      = g.venueName      ? resolvers.venueIdByName(g.venueName)           : null;
    await api.createSection(scheduleId, {
      courseId,
      instructorId: instructorId || undefined,
      venueId:      venueId      || undefined,
      sectionNumber: g.sectionNumber,
      sectionType:   g.sectionType,
      days:          g.days,
      day:           g.days[0],
      startTime:     g.startTime,
      endTime:       g.endTime,
      gender:        g.gender || 'M',
    });
  }
}
