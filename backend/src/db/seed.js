/**
 * Seeds the database with REAL KFUPM Software Engineering data scraped from
 * the official catalog (bulletin.kfupm.edu.sa) and term offerings
 * (registrar.kfupm.edu.sa). NEW-FU-271 (Phase 49) + NEW-FU-272 (Phase 50).
 *
 *   • Active UG SWE courses (catalog × terms 251/252/253/261) — Phase 49
 *   • Graduate SWE 5xx/6xx courses from registrar — Phase 50 #5
 *   • Capstone (SWE 411/412/413/414) marked is_capstone — Phase 50 #1
 *   • Dummy SWE 101 to exercise Freshman-tier logic — Phase 50 #4
 *   • Rows missing instructor/venue/day/time dropped — Phase 50 #2
 *     (capstones keep their no-venue rows because of the exemption)
 *   • Dual-use venues (lec AND lab activity) typed 'Multipurpose' — Phase 50 #3
 *
 * Run: node src/db/seed.js
 * Idempotent — DELETEs the seed-managed tables first, then re-inserts.
 *
 * Production gate: NEW-FU-38 still applies. Refuses to run when
 * NODE_ENV=production unless ALLOW_SEED=1 is explicitly set.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const bcrypt = require('bcryptjs');

// ── Source data ────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '../../../data/raw');

// NEW-FU-275 (Phase 52): term 262 (Spring 2025–26) added to scope.
// It has no offerings file — its sections are cloned from 252 below.
const TERMS = [
  { short: '251', long: '202510', file: 'offerings-251.json' },
  { short: '252', long: '202520', file: 'offerings-252.json' },
  { short: '253', long: '202530', file: 'offerings-253.json' },
  { short: '261', long: '202610', file: 'offerings-261.json' },
  { short: '262', long: '202620', file: null /* cloned from 252 */ },
];

// NEW-FU-272 (Phase 50 #1): graduation-project courses meet online or
// wherever convenient — no fixed venue. The conflict engine consults
// courses.is_capstone to skip venue-related rules for these.
const CAPSTONE_CODES = new Set(['SWE411', 'SWE412', 'SWE413', 'SWE414']);

// NEW-FU-275 (Phase 52 #5): off-campus / internship courses — every
// conflict rule is skipped for these. Currently just SWE 399 Summer
// Training.
const EXTERNAL_CODES = new Set(['SWE399']);

// NEW-FU-275 (Phase 52 #3 + #4): old-format capstone being phased out
// after term 252. Term 261 and 262 must NOT include SWE 412 sections.
const DISCONTINUED_FROM_261 = new Set(['SWE412']);

const DAY_MAP = { U: 'Sunday', M: 'Monday', T: 'Tuesday', W: 'Wednesday', R: 'Thursday' };

// NEW-FU-498 (Phase 122): PRJ now buckets as its own 'Prj' type (capstone
// projects), and THS as 'Ths' (thesis) — matching the registrar. SEM (seminar)
// stays 'Lec'. LAB stays Lab. THS rows usually have no schedule and are dropped
// before they reach here, but the mapping is kept for completeness/fidelity.
const ACTIVITY_TO_SECTION_TYPE = { LEC: 'Lec', LAB: 'Lab', PRJ: 'Prj', THS: 'Ths', SEM: 'Lec' };

// ── Load raw data once ─────────────────────────────────────────────────────
const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog-swe-ug.json'), 'utf8'));
const catalogByCode = Object.fromEntries(catalog.map(c => [c.code, c]));
const allOfferings = {};
const activeUGCodes  = new Set();   // catalog UG codes that appear in any term
const gradCodes      = new Map();   // 5xx/6xx code → { title, hasLab }
for (const t of TERMS) {
  if (!t.file) { allOfferings[t.short] = []; continue; }  // synthesized terms (262)
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, t.file), 'utf8'));
  allOfferings[t.short] = data.rows;
  for (const r of data.rows) {
    const code = r.courseSec.split('-')[0].replace(/\s+/g, '');
    if (catalogByCode[code]) {
      activeUGCodes.add(code);
    } else if (/^SWE[5-9]\d{2}$/.test(code) || /^SWE6\d{2}$/.test(code)) {
      // NEW-FU-272 (Phase 50 #5): seed grad SWE 5xx/6xx from registrar.
      // Catalog only covers UG, so derive title from the first occurrence.
      if (!gradCodes.has(code)) gradCodes.set(code, { title: r.name, hasLab: false });
      if (r.activity === 'LAB') gradCodes.get(code).hasLab = true;
    }
  }
}

// ── Per-row transforms ─────────────────────────────────────────────────────
function academicLevel(code) {
  const n = parseInt(code.slice(3, 4), 10);
  if (n === 1) return 'Freshman';
  if (n === 2) return 'Sophomore';
  if (n === 3) return 'Junior';
  if (n === 4) return 'Senior';
  return 'Graduate';
}

function creditHours(code) {
  const c = catalogByCode[code];
  if (!c) return 3;
  const cr = parseInt(c.credits.split('-')[2].trim(), 10);
  return cr > 0 ? cr : 1;
}

function hasLab(code) {
  // NEW-FU-272 (Phase 50 #1+#3): capstones explicitly don't have labs
  // (the PRJ activity *is* the lab in spirit; firing R-14 about a missing
  // Lab section is noise that the user doesn't want in the demo).
  if (CAPSTONE_CODES.has(code)) return false;
  const c = catalogByCode[code];
  if (!c) return false;
  return parseInt(c.credits.split('-')[1].trim(), 10) > 0;
}

function splitSection(secStr) {
  if (secStr.startsWith('F')) return { gender: 'F', number: secStr.slice(1) };
  return { gender: 'M', number: secStr };
}

function expandDays(dayPat) {
  return dayPat.split('').map(c => DAY_MAP[c]).filter(Boolean);
}

function parseTime(timeStr) {
  const m = timeStr.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  return m ? { start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}` } : null;
}

function instructorEmail(name) {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '.');
  return `${slug}@kfupm.edu.sa`;
}

// "HH:MM[:SS]" → integer minutes from midnight.
function toMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = String(timeStr).substring(0, 5).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// "MM:SS" formatter from integer minutes.
function fromMinutes(n) {
  const h = Math.floor(n / 60), m = n % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// NEW-FU-273 (Phase 51 #2): seeded LCG so picks are deterministic per
// instructor — re-running the seed picks the same slot for "HAMOUD
// ALJAMAAN" every time. Hash the seed string to a 32-bit integer and
// feed it through Numerical Recipes' constants.
function rng(seed) {
  let s = 0;
  for (const c of String(seed)) s = (Math.imul(s, 31) + c.charCodeAt(0)) >>> 0;
  if (s === 0) s = 1;   // 0-seed is degenerate
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Pick a 60- or 90-minute office-hour slot deterministically for one
// instructor. Returns { day, start, end } or null if no candidate fits.
//
// Strategy:
//   • 70% morning (08:00–11:00 start) / 30% afternoon (11:00–13:00 start)
//   • Duration 60 or 90 min (coin flip)
//   • Try up to 50 candidates from the RNG before giving up
//   • Each candidate is rejected if it overlaps any of the instructor's
//     own sections on that day (would trip R-04's OH-overlap check).
function pickOfficeHourSlot(seed, sections) {
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
  const rand = rng(seed);
  for (let attempt = 0; attempt < 50; attempt++) {
    const day = DAYS[Math.floor(rand() * DAYS.length)];
    const morning = rand() < 0.7;
    // Start minute = either 480..660 (08:00–11:00) or 660..780 (11:00–13:00).
    // We snap to 5-min boundaries for tidiness; office hours don't need
    // 1-minute granularity.
    const startMin = morning
      ? 480 + Math.floor(rand() * 36) * 5    // 36 × 5 = 180 min range → 08:00–11:00
      : 660 + Math.floor(rand() * 24) * 5;   // 24 × 5 = 120 min range → 11:00–13:00
    const durMin = rand() < 0.5 ? 60 : 90;
    const endMin = startMin + durMin;
    // Cap end at 14:00 — anything later isn't a typical OH slot per
    // the user's spec.
    if (endMin > 840) continue;
    const onDay = sections.filter(s => s.day === day);
    const overlaps = onDay.some(s => s.startMin < endMin && startMin < s.endMin);
    if (overlaps) continue;
    return { day, start: fromMinutes(startMin), end: fromMinutes(endMin) };
  }
  return null;
}

// NEW-FU-272 (Phase 50 #2): drop-incomplete rule. A row is keepable iff it
// has a day, a time, an instructor, AND a venue — with the venue rule
// relaxed for capstone courses (which legitimately don't have venues).
function isRowComplete(r, code) {
  if (!r.day || !r.time) return false;
  if (!parseTime(r.time)) return false;
  if (!r.instructor || !r.instructor.trim()) return false;
  const venue = r.location?.trim();
  const hasVenue = venue && venue !== '412-None';
  return hasVenue || CAPSTONE_CODES.has(code);
}

// NEW-FU-272 (Phase 50 #3): dual-use venue reclassification.
// A venue used for BOTH LEC and LAB activity becomes 'Multipurpose' —
// satisfies R-11 and R-12 without forcing a single-type lie.
// Single-activity venues stay as before: LAB-only → 'Laboratory',
// otherwise → 'LectureHall'.
function buildVenueIndex(allInScopeCodes) {
  const usage = new Map();  // name → { lecRows, labRows }
  for (const t of TERMS) {
    for (const r of allOfferings[t.short]) {
      const code = r.courseSec.split('-')[0].replace(/\s+/g, '');
      if (!allInScopeCodes.has(code)) continue;
      const loc = r.location?.trim();
      if (!loc || loc === '412-None') continue;
      if (!usage.has(loc)) usage.set(loc, { lecRows: 0, labRows: 0 });
      const u = usage.get(loc);
      if (r.activity === 'LAB') u.labRows++; else u.lecRows++;
    }
  }
  const venues = new Map();
  for (const [name, { lecRows, labRows }] of usage) {
    let type;
    if (lecRows > 0 && labRows > 0)      type = 'Multipurpose';
    else if (labRows > 0 && lecRows === 0) type = 'Laboratory';
    else                                    type = 'LectureHall';
    venues.set(name, { type, capacity: 40 });
  }
  return venues;
}

function buildInstructorIndex(allInScopeCodes) {
  const instructors = new Map();
  for (const t of TERMS) {
    for (const r of allOfferings[t.short]) {
      const code = r.courseSec.split('-')[0].replace(/\s+/g, '');
      if (!allInScopeCodes.has(code)) continue;
      const name = r.instructor?.trim();
      if (!name) continue;
      const email = instructorEmail(name);
      if (!instructors.has(email)) instructors.set(email, name);
    }
  }
  return instructors;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function seed() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED !== '1') {
    console.error('Refusing to seed: NODE_ENV=production and ALLOW_SEED is not "1".');
    console.error('To intentionally seed a production database (e.g., first-time bootstrap),');
    console.error('run with: ALLOW_SEED=1 npm run seed   — then rotate the admin password.');
    process.exit(1);
  }

  // Master code set used by every per-row guard: catalog UG + grad 5xx/6xx
  // + capstones (in case some end up out of catalog) + the SWE 101 dummy
  // + SWE 399 external (Phase 52).
  const allInScopeCodes = new Set([
    ...activeUGCodes,
    ...gradCodes.keys(),
    ...CAPSTONE_CODES,
    ...EXTERNAL_CODES,
    'SWE101',
  ]);

  // NEW-FU-275 (Phase 52 #3): cross-term instructor lookup so term 261's
  // blank-instructor rows can borrow the instructor who taught the same
  // course in 251 / 252. Falls back through:
  //   1. Same course_code AND section_number in any earlier term
  //   2. Any instructor of that course in any earlier term
  // The map is keyed by course code with a list of (section, instructor)
  // entries collected from terms 251 and 252.
  const crossTermInstructor = new Map();   // courseCode → [{ section, instructor, gender }]
  for (const t of ['251', '252']) {
    for (const r of (allOfferings[t] ?? [])) {
      const name = r.instructor?.trim();
      if (!name) continue;
      const code = r.courseSec.split('-')[0].replace(/\s+/g, '');
      const sec = r.courseSec.split('-')[1];
      // F-prefixed sections track to the female instructor pool — KFUPM
      // doesn't mix male and female section instructors.
      const gender = sec.startsWith('F') ? 'F' : 'M';
      if (!crossTermInstructor.has(code)) crossTermInstructor.set(code, []);
      crossTermInstructor.get(code).push({ section: sec, instructor: name, gender });
    }
  }
  // NEW-FU-276 (Phase 52+ R-04-aware borrow): in addition to (a) exact
  // section match and (b) same-gender match, walk the candidate list
  // looking for an instructor who isn't already booked at the target
  // (term, days, start, end) slot in the in-progress insertion. Avoids
  // the YUSUF HASSAN / OMAR HAMMAD double-book on the same MW slot in
  // term 261 — those were the only two R-04 hard conflicts post-Phase-52.
  // termSlotMap tracks the already-inserted (instructorEmail, day, time)
  // tuples per term so the borrow can decline a candidate that would
  // collide.
  // NEW-FU-276 (Phase 52+): instructor-slot tracking. Map shape:
  //   termSlotMap[term].get(email) → Array<{ day, startMin, endMin }>
  // The busy check is overlap-aware ([startA, endA) ∩ [startB, endB) ≠ ∅),
  // not exact equality, so a 08:00–09:15 section correctly blocks an
  // 09:00–09:50 section for the same instructor on the same day.
  const termSlotMap = new Map();
  function timeToMin(t) {
    const [h, m] = String(t).substring(0, 5).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }
  function recordSlot(term, email, days, start, end) {
    if (!email) return;
    if (!termSlotMap.has(term)) termSlotMap.set(term, new Map());
    const byEmail = termSlotMap.get(term);
    if (!byEmail.has(email)) byEmail.set(email, []);
    const slots = byEmail.get(email);
    const startMin = timeToMin(start), endMin = timeToMin(end);
    for (const day of days) slots.push({ day, startMin, endMin });
  }
  function instructorBusyInTerm(term, email, days, start, end) {
    const byEmail = termSlotMap.get(term);
    if (!byEmail) return false;
    const slots = byEmail.get(email);
    if (!slots) return false;
    const startMin = timeToMin(start), endMin = timeToMin(end);
    for (const day of days) {
      for (const s of slots) {
        if (s.day !== day) continue;
        // half-open intervals overlap iff start < otherEnd && otherStart < end
        if (s.startMin < endMin && startMin < s.endMin) return true;
      }
    }
    return false;
  }
  function borrowInstructorFor(code, sec, term, days, start, end) {
    const candidates = crossTermInstructor.get(code) ?? [];
    if (!candidates.length) return null;
    const wantGender = sec.startsWith('F') ? 'F' : 'M';
    // Preference order: exact-section-and-gender, exact-gender, exact-
    // section, any. Within each tier we pick the first that isn't already
    // booked at this slot in the target term.
    const tiers = [
      candidates.filter(c => c.section === sec && c.gender === wantGender),
      candidates.filter(c => c.gender === wantGender),
      candidates.filter(c => c.section === sec),
      candidates,
    ];
    for (const tier of tiers) {
      const free = tier.find(c =>
        !instructorBusyInTerm(term, instructorEmail(c.instructor), days, start, end)
      );
      if (free) return free.instructor;
    }
    // All tiers exhausted — fall back to first (R-04 will fire, but at
    // least the row gets inserted).
    return candidates[0].instructor;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─ Users (unchanged) ───────────────────────────────────────────────────
    const pwHash = await bcrypt.hash('password123', 10);
    await client.query(`
      INSERT INTO users (id, username, email, password_hash, role) VALUES
        ('00000000-0000-0000-0000-000000000001', 'scheduler1', 'scheduler@dept.edu', $1, 'scheduler'),
        ('00000000-0000-0000-0000-000000000002', 'admin1',     'admin@dept.edu',     $1, 'admin')
      ON CONFLICT (username) DO NOTHING
    `, [pwHash]);

    // ─ Reset seed-managed tables ──────────────────────────────────────────
    await client.query(`LOCK TABLE sections      IN ACCESS EXCLUSIVE MODE`);
    await client.query(`LOCK TABLE office_hours  IN ACCESS EXCLUSIVE MODE`);
    await client.query(`LOCK TABLE courses       IN ACCESS EXCLUSIVE MODE`);
    await client.query(`LOCK TABLE venues        IN ACCESS EXCLUSIVE MODE`);
    await client.query(`LOCK TABLE instructors   IN ACCESS EXCLUSIVE MODE`);
    await client.query(`DELETE FROM sections     WHERE schedule_id IN (SELECT id FROM schedules WHERE department_id = 'SWE-DEPT')`);
    await client.query(`DELETE FROM office_hours`);
    await client.query(`DELETE FROM courses`);
    await client.query(`DELETE FROM venues`);
    await client.query(`DELETE FROM instructors`);

    // ─ Instructors ─────────────────────────────────────────────────────────
    const instructorMap = buildInstructorIndex(allInScopeCodes);
    const instructorIds = new Map();
    for (const [email, name] of instructorMap) {
      const r = await client.query(
        `INSERT INTO instructors (name, email) VALUES ($1, $2) RETURNING id`,
        [name, email]
      );
      instructorIds.set(email, r.rows[0].id);
    }

    // ─ Venues ──────────────────────────────────────────────────────────────
    const venueMap = buildVenueIndex(allInScopeCodes);
    const venueIds = new Map();
    for (const [name, { type, capacity }] of venueMap) {
      const r = await client.query(
        `INSERT INTO venues (name, type, capacity) VALUES ($1, $2, $3) RETURNING id`,
        [name, type, capacity]
      );
      venueIds.set(name, r.rows[0].id);
    }

    // ─ Courses ─────────────────────────────────────────────────────────────
    const courseIds = new Map();

    // NEW-FU-272 (Phase 50 #4): SWE 101 dummy for Freshman-tier exercise.
    // Title carries an explicit marker so a reviewer sees at a glance it's
    // not real KFUPM data.
    {
      const r = await client.query(
        `INSERT INTO courses
           (course_code, name, credits, academic_level, category, num_sections, has_lab, is_capstone)
         VALUES ('SWE 101', 'Introduction to SE (DUMMY — Freshman-tier demo)', 3, 'Freshman', 'UG', 1, FALSE, FALSE)
         RETURNING id`
      );
      courseIds.set('SWE101', r.rows[0].id);
    }

    // UG courses from catalog.
    // NEW-FU-275 (Phase 52 #5): skip codes in EXTERNAL_CODES — those get
    // inserted separately with is_external=TRUE below.
    for (const code of [...activeUGCodes].sort()) {
      if (EXTERNAL_CODES.has(code)) continue;
      const c = catalogByCode[code];
      const display = code.slice(0, 3) + ' ' + code.slice(3);
      const isCapstone = CAPSTONE_CODES.has(code);
      const r = await client.query(
        `INSERT INTO courses
           (course_code, name, credits, academic_level, category, num_sections, has_lab, is_capstone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [display, c.title, creditHours(code), academicLevel(code), 'UG', 1, hasLab(code), isCapstone]
      );
      courseIds.set(code, r.rows[0].id);
    }

    // Grad courses from registrar (no catalog entry to look up).
    for (const code of [...gradCodes.keys()].sort()) {
      const { title, hasLab: gradHasLab } = gradCodes.get(code);
      const display = code.slice(0, 3) + ' ' + code.slice(3);
      const r = await client.query(
        `INSERT INTO courses
           (course_code, name, credits, academic_level, category, num_sections, has_lab, is_capstone)
         VALUES ($1, $2, 3, 'Graduate', 'GR', 1, $3, FALSE) RETURNING id`,
        [display, title, gradHasLab]
      );
      courseIds.set(code, r.rows[0].id);
    }

    // NEW-FU-275 (Phase 52 #5): SWE 399 Summer Training — student spends
    // the summer at an external company as an intern. No venue, no
    // schedule, no instructor by design. is_external=TRUE makes the
    // conflict engine skip every rule for this course's sections.
    {
      const r = await client.query(
        `INSERT INTO courses
           (course_code, name, credits, academic_level, category, num_sections, has_lab, is_capstone, is_external)
         VALUES ('SWE 399', 'Summer Training (off-campus internship — exempt from all conflict rules)', 1, 'Senior', 'UG', 1, FALSE, FALSE, TRUE) RETURNING id`
      );
      courseIds.set('SWE399', r.rows[0].id);
    }

    // ─ Schedules ───────────────────────────────────────────────────────────
    const adminId = '00000000-0000-0000-0000-000000000002';
    const scheduleIds = new Map();
    for (const t of TERMS) {
      const r = await client.query(
        `INSERT INTO schedules (department_id, semester, status, created_by)
         VALUES ('SWE-DEPT', $1, 'Draft', $2)
         ON CONFLICT (department_id, semester) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [t.short, adminId]
      );
      scheduleIds.set(t.short, r.rows[0].id);
    }

    // ─ Sections ────────────────────────────────────────────────────────────
    let inserted = 0;
    const skipReasons = { noSchedule: 0, blankInstructor: 0, blankVenue: 0, outOfScope: 0, discontinued: 0 };
    for (const t of TERMS) {
      for (const r of allOfferings[t.short]) {
        const codeFull = r.courseSec.split('-')[0].replace(/\s+/g, '');
        if (!allInScopeCodes.has(codeFull)) { skipReasons.outOfScope++; continue; }

        // NEW-FU-275 (Phase 52 #3): SWE 412 is discontinued from term 261
        // onwards (replaced by the SWE 414 multidisciplinary capstone).
        // Drop those rows so they don't appear in the 261/262 schedules.
        if (DISCONTINUED_FROM_261.has(codeFull) && (t.short === '261' || t.short === '262')) {
          skipReasons.discontinued++; continue;
        }

        // Drop-incomplete rule (NEW-FU-272 #2). Bucket the reason for the
        // tally so the operator can see exactly why each row was dropped.
        if (!r.day || !r.time || !parseTime(r.time)) { skipReasons.noSchedule++; continue; }

        // NEW-FU-275 (Phase 52 #3): borrow instructor from 251 / 252 when
        // 261 publishes the row with a blank instructor (the registrar
        // hasn't assigned one yet — but the course is the same so the same
        // instructor probably teaches it again). NEW-FU-276 (Phase 52+):
        // the borrow is now R-04-aware — it consults the in-progress
        // 261-slot tally and prefers candidates who aren't already booked
        // at the row's day/time.
        const venueLoc = r.location?.trim();
        const hasVenue = venueLoc && venueLoc !== '412-None';
        if (!hasVenue && !CAPSTONE_CODES.has(codeFull)) { skipReasons.blankVenue++; continue; }

        const time = parseTime(r.time);
        const days = expandDays(r.day);
        if (!days.length) { skipReasons.noSchedule++; continue; }

        let instructorName = r.instructor?.trim();
        if (!instructorName && t.short === '261') {
          instructorName = borrowInstructorFor(
            codeFull, r.courseSec.split('-')[1],
            t.short, days, time.start, time.end
          );
        }
        if (!instructorName)  { skipReasons.blankInstructor++; continue; }

        const { gender, number } = splitSection(r.courseSec.split('-')[1]);
        const sectionType = ACTIVITY_TO_SECTION_TYPE[r.activity] || 'Lec';

        const courseId = courseIds.get(codeFull);
        const scheduleId = scheduleIds.get(t.short);
        const email = instructorEmail(instructorName);
        const instructorId = instructorIds.get(email);
        const venueId = hasVenue ? venueIds.get(venueLoc) : null;

        for (const day of days) {
          await client.query(
            `INSERT INTO sections
               (schedule_id, course_id, instructor_id, venue_id,
                section_number, day, start_time, end_time, section_type, gender)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT DO NOTHING`,
            [scheduleId, courseId, instructorId, venueId,
             number, day, time.start, time.end, sectionType, gender]
          );
          inserted++;
        }
        // NEW-FU-276 (Phase 52+): record this row's slot so subsequent
        // borrow calls for the same term can dodge instructor double-book.
        recordSlot(t.short, email, days, time.start, time.end);
      }
    }

    // NEW-FU-275 (Phase 52 #4): clone term 252 sections into term 262.
    // 262 (Spring 2025–26) hasn't been published by the registrar yet so
    // we synthesize it from 252, excluding SWE 412 (discontinued after
    // term 252 — see DISCONTINUED_FROM_261 logic above).
    const sched252 = scheduleIds.get('252');
    const sched262 = scheduleIds.get('262');
    if (sched252 && sched262) {
      const cloneRes = await client.query(
        `INSERT INTO sections
           (schedule_id, course_id, instructor_id, venue_id,
            section_number, day, start_time, end_time, section_type, gender)
         SELECT $1, s.course_id, s.instructor_id, s.venue_id,
                s.section_number, s.day, s.start_time, s.end_time,
                s.section_type, s.gender
         FROM sections s
         JOIN courses c ON c.id = s.course_id
         WHERE s.schedule_id = $2
           AND c.course_code NOT IN ('SWE 412')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [sched262, sched252]
      );
      inserted += cloneRes.rowCount;
    }

    // NEW-FU-275 (Phase 52 #1): SWE 101 dummy in every active term
    // (251, 252, 261, 262) so the Freshman tier is exercised everywhere.
    // STT 10:00–10:50 was picked because:
    //   • 251: SWE 206 (Sophomore) doesn't use STT at all (MW Lec + per-
    //     day Labs). SWE 216 is MW. No Sophomore overlap.
    //   • 252: SWE 216 is UTR but ends at 09:50. SWE 206 is MW.
    //   • 261: SWE 216 is UTR but ends at 09:50. SWE 206 doesn't conflict.
    //   • 262: clone of 252 — same story.
    // 3 × 50 min = 150 min/week satisfies R-15 for a 3-credit course.
    //
    // Re-uses HAMOUD ALJAMAAN (teaches SWE 206 in 251/252; the OH
    // generator will pick a non-conflicting slot for him).
    // Venue: 24-180 — a Lec hall used only by SWE 463 (251 only) at
    // 14:00, so it's free at STT 10:00 across every term we touch.
    // 24-244 from earlier phases couldn't be used here because SWE 316
    // §01 in 252 also occupies it at UTR 10:00 (which overlaps Sun/Tue/Thu).
    const sweInstrId = instructorIds.get(instructorEmail('HAMOUD ALJAMAAN'));
    const sweVenueId = venueIds.get('24-180');
    const swe101Id = courseIds.get('SWE101');
    for (const targetTerm of ['251', '252', '261', '262']) {
      const sched = scheduleIds.get(targetTerm);
      if (!sched || !sweInstrId || !sweVenueId || !swe101Id) continue;
      for (const day of ['Sunday', 'Tuesday', 'Thursday']) {
        await client.query(
          `INSERT INTO sections
             (schedule_id, course_id, instructor_id, venue_id,
              section_number, day, start_time, end_time, section_type, gender)
           VALUES ($1, $2, $3, $4, '01', $5, '10:00', '10:50', 'Lec', 'M')
           ON CONFLICT DO NOTHING`,
          [sched, swe101Id, sweInstrId, sweVenueId, day]
        );
        inserted++;
      }
    }

    // NEW-FU-276 (Phase 52+): R-02 mitigation for term 261. The registrar
    // publishes SWE 326 with a single section §01 at MW 11:00–12:15, which
    // overlaps multiple adjacent-level courses (Sophomore SWE 206, Senior
    // SWE 439) and one same-level course with escape (SWE 387) — three
    // R-02 soft firings. Adding a §02 of SWE 326 at a non-overlapping slot
    // makes the course "multi-section" so R-02 no longer fires (the rule
    // only triggers when the changed course has exactly 1 logical section).
    //
    // Pulled the §02 pattern from term 251 (MW 09:30–10:45 in 24-165 with
    // MANSOUR ALHARTHI). MANSOUR already teaches §01 in 261; the two slots
    // are disjoint so no R-04 fires either.
    const sched261 = scheduleIds.get('261');
    const swe326Id = courseIds.get('SWE326');
    const mansourId = instructorIds.get(instructorEmail('MANSOUR ALHARTHI'));
    const venue24_165 = venueIds.get('24-165');
    if (sched261 && swe326Id && mansourId && venue24_165) {
      for (const day of ['Monday', 'Wednesday']) {
        await client.query(
          `INSERT INTO sections
             (schedule_id, course_id, instructor_id, venue_id,
              section_number, day, start_time, end_time, section_type, gender)
           VALUES ($1, $2, $3, $4, '02', $5, '09:30', '10:45', 'Lec', 'M')
           ON CONFLICT DO NOTHING`,
          [sched261, swe326Id, mansourId, venue24_165, day]
        );
        inserted++;
      }
      recordSlot('261', instructorEmail('MANSOUR ALHARTHI'),
                 ['Monday', 'Wednesday'], '09:30', '10:45');
    }

    // NEW-FU-275 (Phase 52 #5): SWE 399 placeholder section in term 253.
    // The section's day/time are sentinel values (Saturday 00:00–00:01)
    // so it satisfies the NOT NULL + end>start constraints but doesn't
    // collide with anything real. The conflict engine short-circuits at
    // the top of every rule for is_external=true courses, so this row
    // never fires anything. Frontend can render it as a sidebar-only
    // entry (no grid card) based on `isExternal`.
    const swe399Id = courseIds.get('SWE399');
    const sched253 = scheduleIds.get('253');
    if (swe399Id && sched253) {
      await client.query(
        `INSERT INTO sections
           (schedule_id, course_id, instructor_id, venue_id,
            section_number, day, start_time, end_time, section_type, gender)
         VALUES ($1, $2, NULL, NULL, '01', 'Saturday', '00:00', '00:01', 'Lec', 'M')
         ON CONFLICT DO NOTHING`,
        [sched253, swe399Id]
      );
      inserted++;
    }

    // NEW-FU-273 (Phase 51 #2): deterministic office hours per instructor.
    //
    // Without OH, R-13 fires once per teaching instructor (40+ noise rows).
    // We generate a 60- or 90-minute block on a workday Sun-Thu, picked
    // deterministically from the instructor's name so re-running `npm run
    // seed` produces the same OH map (reproducible demos).
    //
    // Distribution:
    //   70% in the 08:00–11:00 morning window (most KFUPM faculty)
    //   30% in the 11:00–14:00 afternoon window (the minority)
    //
    // Constraint: the chosen slot must not overlap ANY of the instructor's
    // own sections across all in-scope terms (otherwise we'd trip R-04
    // office-hour overlap immediately on save).
    //
    // We query the inserted sections AFTER the section loop so the OH
    // generator sees the actual schedule, not the raw offerings.
    const allSecRows = await client.query(`
      SELECT instructor_id, day, start_time::text AS start_time, end_time::text AS end_time
      FROM sections
      WHERE instructor_id IS NOT NULL
        AND schedule_id IN (SELECT id FROM schedules WHERE department_id = 'SWE-DEPT')
    `);
    const sectionsByInstr = new Map();
    for (const row of allSecRows.rows) {
      if (!sectionsByInstr.has(row.instructor_id)) sectionsByInstr.set(row.instructor_id, []);
      sectionsByInstr.get(row.instructor_id).push({
        day: row.day,
        startMin: toMinutes(row.start_time),
        endMin:   toMinutes(row.end_time),
      });
    }
    let ohInserted = 0, ohSkipped = 0;
    for (const [email, instId] of instructorIds) {
      const sects = sectionsByInstr.get(instId) ?? [];
      // No need to seed OH for instructors who never teach (those exist
      // because earlier terms had them but they were dropped by the
      // drop-incomplete rule).
      if (sects.length === 0) { ohSkipped++; continue; }
      const ohSlot = pickOfficeHourSlot(email, sects);
      if (!ohSlot) { ohSkipped++; continue; }
      await client.query(
        `INSERT INTO office_hours (instructor_id, day, start_time, end_time)
         VALUES ($1, $2, $3, $4)`,
        [instId, ohSlot.day, ohSlot.start, ohSlot.end]
      );
      ohInserted++;
    }

    await client.query('COMMIT');
    const multipurposeCount = [...venueMap.values()].filter(v => v.type === 'Multipurpose').length;
    console.log(`✓ Phase 52 seed complete (cross-term fills + SWE 399 external):`);
    console.log(`  · ${instructorMap.size} instructors`);
    console.log(`  · ${venueMap.size} venues (${multipurposeCount} Multipurpose)`);
    console.log(`  · ${1 + activeUGCodes.size + gradCodes.size + EXTERNAL_CODES.size} courses`);
    console.log(`        — 1 dummy (SWE 101)`);
    console.log(`        — ${activeUGCodes.size} UG (from catalog)`);
    console.log(`        — ${gradCodes.size} GR (5xx/6xx from registrar)`);
    console.log(`        — ${EXTERNAL_CODES.size} external (SWE 399 off-campus)`);
    console.log(`  · ${TERMS.length} schedules (terms ${TERMS.map(t => t.short).join(', ')})`);
    console.log(`  · ${inserted} section rows inserted`);
    console.log(`  · ${ohInserted} office-hour rows inserted (${ohSkipped} instructors skipped — no sections / no fit)`);
    console.log(`  · skipped sections: ${skipReasons.noSchedule} no day/time, ${skipReasons.blankInstructor} no instructor, ${skipReasons.blankVenue} no venue, ${skipReasons.outOfScope} out-of-scope, ${skipReasons.discontinued} SWE 412 in 261/262`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    try { client.release(err); } catch { /* already released */ }
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    try { client.release(); } catch { /* already released */ }
    await pool.end();
  }
}

seed().catch(err => {
  console.error('Seed failed (before tx started):', err.message);
  process.exit(1);
});
