// NEW-FU-661: per-field "well-formedness" validation for the IMPORT path — the strict
// whitelist gate that rejects any malformed value/cell on BOTH import paths (whole-term
// REPLACE and scoped MERGE) with precise, row-aware messages, run BEFORE any DB write so a
// bad file changes nothing.
//
// It deliberately validates FIELD shape / range / whitelist ONLY — NOT course COMPLETENESS
// (credit-coverage, lab-pairing, the credits×days×duration pattern). That completeness layer
// (validateImportRows → validateSectionPattern) is correct for a whole-term file but WRONG
// for a scoped merge, which legitimately carries PARTIAL course data (an instructor's Lec
// without the Lab a colleague teaches). So this module is the common floor both paths run;
// the replace path stacks the completeness layer on top.
//
// Pure (no DB / no I/O) → unit-testable. Validators are the shared domain single-source-of-
// truth (courseFormat / importValidation / instructorFormat / constants), never re-implemented.
const { courseCodeError, courseFlagError, seminarFlagError } = require('./courseFormat');
const { RANGE_BY_TYPE } = require('./importValidation');
const { emailError, instructorNameError } = require('./instructorFormat');
const { TIME_WINDOWS, OFFICE_HOURS_WINDOW } = require('../config/constants');
const labels = require('./exportLabels');   // NEW-FU-666: accept end-user labels (Lecture/Female/…) as well as codes

const VALID_DAYS         = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
const VALID_DAY_SET      = new Set(VALID_DAYS);
// NEW-FU-688: the RECOGNIZED section-type labels an import file may carry. Lec/Lab/Prj/Ths/Sem
// are stored as-is; the off-campus activity labels St (Summer Training) / Int (Internship) and
// Res (Research) round-trip from the export but are STORED as 'Lec' (their meaning lives on the
// course's external/research flag — see ImportParserService) — they are accepted here only so a
// legitimate exported file is not rejected as garbage.
const VALID_SECTION_TYPES = new Set(['Lec', 'Lab', 'Prj', 'Ths', 'Sem', 'St', 'Int', 'Res']);
const VALID_VENUE_TYPES   = new Set(['Laboratory', 'LectureHall', 'Multipurpose']);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MIN = TIME_WINDOWS.UG.start;   // 07:00 — first schedulable minute
const DAY_MAX = TIME_WINDOWS.GR.end;     // 22:00 — last schedulable minute
const hm = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const ref = (row, n) => `Row ${n ?? row.__row ?? '?'}`;

// NEW-FU-664: a UNIVERSAL "no prohibited characters" check applied to every name-ish value,
// independent of the known-code leniency that lets legitimate seed titles ("Thesis", an
// em-dash demo name) round-trip. NO legitimate name leads with a spreadsheet-formula
// character or carries a control / zero-width / bidi-override character — those are the
// classic injection / homograph / hidden-text vectors — so reject them outright.
const FORMULA_LEAD = /^[=+\-@\t\r]/;                                   // CSV/Excel formula injection
const CONTROL_RE   = /[\u0000-\u001F\u007F-\u009F]/;          // C0/C1 control chars (incl tab/newline)
const HIDDEN_RE    = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/; // zero-width + bidi
// NEW-FU-664: unusual unicode spaces (NBSP, en/em spaces, ideographic space …) — a real name
// uses the plain ASCII space; these are homoglyph / "looks-like-two-words-but-isn't" vectors.
const ODD_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/;
function prohibitedCharsError(value) {
  const s = String(value ?? '');
  // NEW-FU-669: anchor the formula check to the first NON-blank char so a leading space/tab
  // before the payload (" =1+1", " @SUM()") can't smuggle a formula past it. trimStart()
  // strips the full Unicode-whitespace + BOM set; the odd-space/control checks below still see
  // the untrimmed string so interior hidden chars remain caught.
  if (FORMULA_LEAD.test(s.trimStart())) return 'must not start with =, +, -, or @ (it looks like a spreadsheet formula)';
  if (CONTROL_RE.test(s))   return 'contains control characters';
  if (HIDDEN_RE.test(s))    return 'contains hidden zero-width or text-direction characters';
  if (ODD_SPACE_RE.test(s)) return 'contains an unusual (non-standard) space character';
  return null;
}

// NEW-FU-664: venue name format — every real venue is alphanumeric with spaces / dots /
// hyphens / slashes (e.g. "22-120", "04-001-A", "42-AUD"), starting with a letter or digit.
// (Calibrated against every real venue; 0 violations.) Bounded to the DB VARCHAR(80).
const VENUE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 .\-/]*$/;
function venueNameError(name) {
  const n = String(name ?? '').trim();
  if (!n) return null;                                  // an empty venue (no room yet) is allowed
  if (n.length > 80) return 'venue name is too long (max 80 characters)';
  if (!VENUE_NAME_RE.test(n)) return 'venue name may use only letters, numbers, spaces, dots, hyphens and slashes';
  // NEW-FU-672: reject CONSECUTIVE spaces (same look-alike-duplicate vector as instructor names —
  // the venue dedup key doesn't collapse interior whitespace, so "22  120" would forge a second
  // venue row distinct from "22 120"). Real room codes have no double spaces (0 in the live data).
  if (/ {2,}/.test(n)) return 'venue name has consecutive spaces — use a single space';
  return null;
}

/**
 * @param {{rows:object[], instructors:object[], venues:object[], officeHours:object[]}} data
 * @returns {{errors: string[]}} empty ⇒ every field is well-formed and in range.
 */
function validateImportFields({ rows = [], instructors = [], venues = [], officeHours = [] } = {}) {
  const errors = [];
  const push = (m) => errors.push(m);

  rows.forEach((r, i) => {
    const n   = r.__row ?? (i + 1);
    const raw = r.__raw || {};
    const code = r.courseCode ?? '';

    // Course code — the authoritative identity. If it's malformed, report only that for
    // this row (the dependent checks below would be noise on a row that can't exist).
    const ce = courseCodeError(code);
    if (ce) { push(`${ref(r, n)}, Course Code "${code}": ${ce}`); return; }

    // NOTE: academic level ↔ number agreement is NOT checked here. It is enforced in the
    // commit path with the SAME "known-code" leniency the course-name gate uses — a NEW
    // course code must carry a consistent level, but an already-stored code (re-import) is
    // tolerated, because real legacy data carries level/number mismatches (e.g. SWE 201
    // stored as Junior) that must still round-trip. (The pure gate can't see known codes.)

    // Credits — a whole number in {0,1,2,3,4}. (Lab-pairing / coverage is checked elsewhere.)
    const rawCr = raw.credits;
    if (rawCr != null && String(rawCr).trim() !== '' && !/^-?\d+$/.test(String(rawCr).trim()))
      push(`${ref(r, n)}, Credits "${rawCr}" for ${code}: must be a whole number 0–4.`);
    else if (![0, 1, 2, 3, 4].includes(Number(r.credits)))
      push(`${ref(r, n)}, Credits ${r.credits} for ${code}: must be 0, 1, 2, 3, or 4.`);

    const normalizedSectionTypeForFlags = labels.sectionTypeCode(String(raw.sectionType ?? '').trim());
    const rowIsSeminar = Boolean(r.isSeminar || r.sectionType === 'Sem' || normalizedSectionTypeForFlags === 'Sem');

    // Course type — at most ONE of Has-lab / Project / External / Thesis / Research / Seminar.
    const fe = courseFlagError({
      hasLab: r.hasLab || r.courseTypeHasLab,
      isCapstone: r.isCapstone,
      isExternal: r.isExternal,
      isThesis: r.isThesis,
      isResearch: r.isResearch,
      isSeminar: rowIsSeminar,
    });
    if (fe) push(`${ref(r, n)}, Course Type for ${code}: ${fe}`);
    const sfe = seminarFlagError({
      courseCode: code,
      academicLevel: r.academicLevel,
      category: r.category,
      credits: r.credits,
      isSeminar: rowIsSeminar,
    });
    if (sfe) push(`${ref(r, n)}, Course Type for ${code}: ${sfe}`);

    // Gender — Male/Female (or the M/F codes). Empty defaults to M (back-compat with
    // pre-gender files); a STATED value that isn't either is rejected, not silently coerced.
    const g = (raw.gender ?? '').trim();
    const gCode = labels.genderCode(g);
    if (g !== '' && gCode !== 'M' && gCode !== 'F')
      push(`${ref(r, n)}, Gender "${g}" for ${code}: must be Male or Female.`);

    // Section type — Lecture/Laboratory/Project/Thesis/Seminar (or their codes), plus the
    // off-campus activity labels. Empty defaults to Lecture; a stated unknown is rejected.
    const stRaw = (raw.sectionType ?? '').trim();
    const stCode = labels.sectionTypeCode(stRaw);
    if (stRaw !== '' && !VALID_SECTION_TYPES.has(stCode))
      push(`${ref(r, n)}, Section Type "${stRaw}" for ${code}: must be Lecture, Laboratory, Project, Thesis, Seminar, Summer Training, Internship, or Research.`);

    // Section number — range scoped to the (normalized) type.
    const type = rowIsSeminar ? 'Sem' : (r.sectionType ?? 'Lec');
    const rangeRe = RANGE_BY_TYPE[type];
    if (rangeRe && !rangeRe.test(String(r.sectionNumber ?? '')))
      push(`${ref(r, n)}, Section # "${r.sectionNumber}" for ${code}: must be ${type === 'Lab' ? '50–99' : '01–49'} for a ${type} section.`);

    // Days/time semantics. Info-only activities never carry a schedule or venue.
    // Projects may be untimed; when timed, they are one-day blocks and venue is optional.
    const infoOnly = !!(r.isExternal || r.isThesis || r.isResearch);
    const project = !!(r.isCapstone || type === 'Prj');
    const days = Array.isArray(r.days) ? r.days : [];
    const s = String(r.startTime ?? '').slice(0, 5), e = String(r.endTime ?? '').slice(0, 5);
    const hasStart = String(r.startTime ?? '').trim() !== '';
    const hasEnd = String(r.endTime ?? '').trim() !== '';
    const hasAnyTime = hasStart || hasEnd;
    const hasTime = hasStart && hasEnd;
    const rawVenueName = String(r.venueName ?? raw.venueName ?? '').trim();

    if ((infoOnly || project) && !String(r.instructorName ?? '').trim()) {
      push(`${ref(r, n)}, Instructor for ${code}: an instructor is required for ${infoOnly ? 'information-only activities' : 'Project sections'}.`);
    }

    // Days — a non-empty subset of Sun–Thu, no duplicates (the app week is Sun–Thu; the DB
    // column tolerates Fri/Sat but they aren't schedulable here).
    if (!days.length) {
      if (!infoOnly && (!project || hasTime)) push(`${ref(r, n)}, Days for ${code}: at least one day is required.`);
    } else {
      const bad = days.filter(d => !VALID_DAY_SET.has(d));
      if (bad.length) push(`${ref(r, n)}, Days "${bad.join(', ')}" for ${code}: only Sunday–Thursday are allowed.`);
      if (new Set(days).size !== days.length) push(`${ref(r, n)}, Days for ${code}: a day is repeated.`);
    }

    // Times — valid HH:MM, end strictly after start, inside the 07:00–22:00 schedulable day.
    if (infoOnly) {
      if (days.length) push(`${ref(r, n)}, Days for ${code}: information-only activities must not have meeting days.`);
      if (hasAnyTime) push(`${ref(r, n)}, Time for ${code}: information-only activities must not have a start or end time.`);
      if (rawVenueName) push(`${ref(r, n)}, Venue for ${code}: information-only activities must not have a venue.`);
    } else if (!hasTime) {
      if (hasAnyTime) push(`${ref(r, n)}, Time for ${code}: start and end time must be provided together.`);
      else if (!project) push(`${ref(r, n)}, Time for ${code}: a start and end time are required.`);
      if (project && rawVenueName) push(`${ref(r, n)}, Venue for ${code}: a Project venue requires a meeting time.`);
    } else if (!TIME_RE.test(s) || !TIME_RE.test(e)) {
      push(`${ref(r, n)}, Time "${s}–${e}" for ${code}: times must be HH:MM (00:00–23:59).`);
    } else {
      if (hm(e) <= hm(s)) push(`${ref(r, n)}, Time for ${code}: end (${e}) must be after start (${s}).`);
      if (hm(s) < DAY_MIN || hm(e) > DAY_MAX) push(`${ref(r, n)}, Time "${s}–${e}" for ${code}: must be within 07:00–22:00.`);
      if (project) {
        const duration = hm(e) - hm(s);
        if (days.length !== 1) push(`${ref(r, n)}, Days for ${code}: timed Project sections must have exactly one day.`);
        if (![50, 75, 100, 160].includes(duration))
          push(`${ref(r, n)}, Time for ${code}: Project duration must be 50, 75, 100, or 160 minutes.`);
      } else if (rowIsSeminar) {
        const duration = hm(e) - hm(s);
        if (days.length !== 1) push(`${ref(r, n)}, Days for ${code}: Seminar sections must have exactly one day.`);
        if (duration !== 75)
          push(`${ref(r, n)}, Time for ${code}: Seminar duration must be 75 minutes.`);
      }
    }

    // Venue type, when stated — one of the three.
    const vt = (r.venueType ?? '').trim();
    if (vt !== '' && !VALID_VENUE_TYPES.has(vt))
      push(`${ref(r, n)}, Venue Type "${vt}" for ${code}: must be Laboratory, Lecture Hall, or Multipurpose.`);

    // NEW-FU-662: length caps aligned with the DB columns (oversize/ReDoS guard — an over-long
    // value would otherwise abort the insert transaction mid-loop).
    if (String(r.courseName ?? '').length > 120)     push(`${ref(r, n)}, Course Name for ${code} is too long (max 120 characters).`);
    if (String(r.instructorName ?? '').length > 120) push(`${ref(r, n)}, Instructor for ${code} is too long (max 120 characters).`);
    if (String(r.venueName ?? '').length > 80)       push(`${ref(r, n)}, Venue for ${code} is too long (max 80 characters).`);

    // NEW-FU-664: NAME-cell content. The full course-name title check stays in the commit path
    // (with known-code leniency for legit seed titles), but a course name must NEVER carry a
    // formula-leading / control / hidden character regardless of leniency. The section's
    // instructor and venue names ARE format-validated here (a real export's are always clean
    // full names / NN-NNN room codes), closing the gap where a junk instructor/venue smuggled
    // in via a section row that the reference sheets don't list.
    const cnp = prohibitedCharsError(r.courseName);
    if (cnp) push(`${ref(r, n)}, Course Name "${String(r.courseName).slice(0, 24)}…" for ${code}: ${cnp}.`);
    if (r.instructorName) { const ie = instructorNameError(r.instructorName); if (ie) push(`${ref(r, n)}, Instructor "${r.instructorName}" for ${code}: ${ie}`); }
    const ve = venueNameError(r.venueName);
    if (ve) push(`${ref(r, n)}, Venue "${r.venueName}" for ${code}: ${ve}.`);
  });

  // Instructors reference sheet — name + email.
  instructors.forEach((it) => {
    if (!it || !it.name) return;
    const ne = instructorNameError(it.name);
    if (ne) push(`Instructor "${it.name}": ${ne}`);
    if (it.email != null && String(it.email).trim() !== '') {
      const ee = emailError(it.email);
      if (ee) push(`Instructor "${it.name}" email "${it.email}": ${ee}`);
    }
  });

  // Venues reference sheet — name + type + capacity.
  venues.forEach((v) => {
    if (!v || !v.name) return;
    const vne = venueNameError(v.name);   // NEW-FU-664: name format (length + charset) — closes the ref-sheet venue gap
    if (vne) push(`Venue "${String(v.name).slice(0, 40)}": ${vne}.`);
    const vt = (v.type ?? '').trim();
    if (vt !== '' && !VALID_VENUE_TYPES.has(vt))
      push(`Venue "${v.name}" type "${vt}": must be Laboratory, Lecture Hall, or Multipurpose.`);
    if (v.capacity != null) {
      const c = Number(v.capacity);
      if (!Number.isInteger(c) || c <= 0 || c > 100000)
        push(`Venue "${v.name}" capacity "${v.capacity}": must be a positive whole number.`);
    }
  });

  // NEW-FU-665: OFFICE HOURS rows. Office hours ride along in the same file (the OfficeHours
  // sheet / table), but were NEVER run through this gate — so a malformed OH (out-of-window,
  // a non-schedulable day, end ≤ start, a junk/formula instructor) slipped past the pre-write
  // check and was then either silently dropped OR committed alongside the rest of the file: a
  // partial, NON-ATOMIC import. (An out-of-window block is exactly the R-04 storm the
  // OFFICE_HOURS_WINDOW exists to prevent — and the DB has no CHECK for that window, so it
  // would persist.) Validate them here so a bad OH cell rejects the WHOLE file before any DB
  // write, on BOTH the replace and merge paths. Calibrated against all 214 real OH rows
  // (0 violations: every one is Sunday–Thursday, inside 08:00–16:00, end > start).
  const OH_MIN = OFFICE_HOURS_WINDOW.start;   // 08:00
  const OH_MAX = OFFICE_HOURS_WINDOW.end;     // 16:00
  // The instructor names the file legitimately defines (its section rows + the Instructors
  // reference sheet). An OH naming anyone outside this set is orphaned — the commit would
  // silently skip it — so reject it rather than let it vanish.
  const knownInstr = new Set();
  rows.forEach(r => { const nm = String(r.instructorName ?? '').trim().toLowerCase(); if (nm) knownInstr.add(nm); });
  instructors.forEach(it => { const nm = String(it?.name ?? '').trim().toLowerCase(); if (nm) knownInstr.add(nm); });
  officeHours.forEach((oh) => {
    if (!oh) return;
    const who = String(oh.instructorName ?? '').trim();
    const at  = `Office hour ${who || '(no instructor)'}${oh.day ? ' ' + oh.day : ''}`;
    // Instructor — present + well-formed (formula-leading / control / junk names rejected by
    // the same validator the section rows use; placeholder "NEW INSTRUCTOR n" exempt).
    if (!who) { push(`${at}: an office hour must name an instructor.`); return; }
    const ie = instructorNameError(who); if (ie) push(`Office hour instructor "${who}": ${ie}`);
    // Must be one of the file's own instructors (else the commit silently drops the OH).
    else if (!knownInstr.has(who.toLowerCase())) push(`${at}: "${who}" is not one of the file's instructors.`);
    // Day — the schedulable week is Sunday–Thursday (the DB tolerates Fri/Sat, the app cannot place them).
    if (!VALID_DAY_SET.has(oh.day)) push(`${at}: day "${oh.day ?? ''}" must be Sunday–Thursday.`);
    // Times — valid HH:MM, end strictly after start, inside the 08:00–16:00 office-hours window.
    const s = String(oh.startTime ?? '').slice(0, 5), e = String(oh.endTime ?? '').slice(0, 5);
    if (!TIME_RE.test(s) || !TIME_RE.test(e)) {
      push(`${at}: time "${s}–${e}" must be HH:MM.`);
    } else {
      if (hm(e) <= hm(s)) push(`${at}: end (${e}) must be after start (${s}).`);
      if (hm(s) < OH_MIN || hm(e) > OH_MAX) push(`${at}: must be within the office-hours window 08:00–16:00.`);
    }
  });

  // NEW-FU-665: an instructor cannot hold two OVERLAPPING office hours on the same day. The
  // app's add/edit path enforces this (the FU-64 SELECT … FOR UPDATE overlap pre-check), but
  // the import path's addOfficeHour bypasses it — so a fabricated/hand-edited file could smuggle
  // self-overlapping blocks past the gate. Calibrated against all 214 real OH (0 overlaps; the 9
  // legit same-day multi-block instructors are disjoint, so strict overlap leaves them valid).
  const ohByInstrDay = new Map();   // instructorLc|day → [{s,e,raw}]
  officeHours.forEach((oh) => {
    if (!oh) return;
    const who = String(oh.instructorName ?? '').trim();
    const s = String(oh.startTime ?? '').slice(0, 5), e = String(oh.endTime ?? '').slice(0, 5);
    if (!who || !VALID_DAY_SET.has(oh.day) || !TIME_RE.test(s) || !TIME_RE.test(e) || hm(e) <= hm(s)) return; // only well-formed OH
    const key = `${who.toLowerCase()}|${oh.day}`;
    const list = ohByInstrDay.get(key) || [];
    if (list.some(p => hm(s) < p.e && p.s < hm(e)))
      push(`Office hour ${who} ${oh.day}: overlaps another office hour for the same instructor that day.`);
    else { list.push({ s: hm(s), e: hm(e) }); ohByInstrDay.set(key, list); }
  });

  // NEW-FU-662: COHERENCE — reject a file that isn't a self-consistent schedule (the
  // "fabricated / hallucinated data" guard), beyond per-field format:
  //   • duplicate identity — the same logical section (course|section#|gender) listed twice
  //     (a real export lists each exactly once; the DB UNIQUE key would reject the 2nd row too);
  //   • inconsistent course attributes — the same course code carrying DIFFERENT academic
  //     level / category / credits across rows (a course has ONE level/credits — divergence
  //     means the file was fabricated/stitched and doesn't describe a real catalog).
  const seenSection = new Map();   // course|sec|gender → row#
  const courseAttr  = new Map();   // course → {level, cat, credits, row#}
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const n = r.__row ?? (i + 1);
    const codeLc = String(r.courseCode ?? '').trim().toLowerCase();
    if (!codeLc) continue;
    const id = `${codeLc}|${r.sectionNumber}|${(r.gender || 'M')}`;
    if (seenSection.has(id))
      push(`Row ${n}: duplicate section — ${r.courseCode} §${r.sectionNumber} (${r.gender || 'M'}) is already defined on row ${seenSection.get(id)}.`);
    else seenSection.set(id, n);

    const a = { level: String(r.academicLevel ?? '').toLowerCase(), cat: String(r.category ?? '').toLowerCase(), credits: Number(r.credits) };
    const prev = courseAttr.get(codeLc);
    if (prev) {
      if (prev.level !== a.level || prev.cat !== a.cat || prev.credits !== a.credits)
        push(`Row ${n}: ${r.courseCode} has inconsistent details vs row ${prev.row} (a course must have the same level, category, and credits in every row).`);
    } else courseAttr.set(codeLc, { ...a, row: n });
  }

  return { errors: [...new Set(errors)] };
}

module.exports = { validateImportFields, prohibitedCharsError, venueNameError, VALID_DAYS, VALID_SECTION_TYPES, VALID_VENUE_TYPES };
