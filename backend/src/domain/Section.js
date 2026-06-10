class Section {
  constructor({
    id, scheduleId, courseId, instructorId, venueId,
    sectionNumber, day, startTime, endTime,
    courseCode, courseName, academicLevel, category, numSections,
    instructorName, venueName,
    // NEW-FU-93: section_type / venue_type / course has_lab carry the
    // joined metadata needed by R-11 / R-12 evaluations. Defaults preserve
    // backward compatibility for callers that don't populate them.
    sectionType, venueType, hasLab,
    // NEW-FU-270: course.credits joined for R-15 (InsufficientCreditCoverage).
    // The rule needs to compute required weekly minutes per section group;
    // we carry it on the section row so the rule has zero extra queries.
    credits,
    // NEW-FU-272 (Phase 50 #1): course.venue_exempt — capstone-style
    // courses that legitimately don't have a venue. Rules R-05, R-10,
    // R-11, R-12 consult this flag to skip the section.
    isCapstone,
    // NEW-FU-272 (Phase 50 #3): sections.gender. The conflict engine uses
    // this to recognize a male/female sibling pair of the same course at
    // the same slot as a single co-scheduled class (KFUPM convention),
    // not as two overlapping sections firing R-04 / R-05.
    gender,
    // NEW-FU-275 (Phase 52 #5): course.is_external — student is placed
    // off-campus (SWE 399 internship). Every conflict rule skips these.
    isExternal,
    createdAt, updatedAt,
  }) {
    this.id             = id;
    this.scheduleId     = scheduleId;
    this.courseId       = courseId;
    this.instructorId   = instructorId  ?? null;
    this.venueId        = venueId       ?? null;
    this.sectionNumber  = sectionNumber;
    this.day            = day;
    this.startTime      = startTime ?? null;
    this.endTime        = endTime   ?? null;
    this.courseCode     = courseCode    ?? null;
    this.courseName     = courseName    ?? null;
    this.academicLevel  = academicLevel ?? null;
    this.category       = category      ?? null;
    this.numSections    = numSections   ?? null;
    this.instructorName = instructorName ?? null;
    this.venueName      = venueName     ?? null;
    // NEW-FU-93
    this.sectionType    = sectionType   ?? 'Lec';
    this.venueType      = venueType     ?? null;
    this.hasLab         = hasLab        ?? false;
    // NEW-FU-270: number coercion so toJSON emits a number not a string
    // (pg returns numeric/int columns as JS numbers already, but defensive
    // for callers that build Section() from plain objects).
    this.credits        = credits != null ? Number(credits) : null;
    // NEW-FU-272 (Phase 50 #1)
    this.isCapstone    = isCapstone === true;
    // NEW-FU-272 (Phase 50 #3)
    this.gender         = gender ?? 'M';
    // NEW-FU-275 (Phase 52 #5)
    this.isExternal     = isExternal === true;
    this.createdAt      = createdAt;
    this.updatedAt      = updatedAt;
  }

  /** Convert "HH:MM" or "HH:MM:SS" to total minutes from midnight. */
  static toMinutes(timeStr) {
    if (!timeStr) return 0;
    const clean = typeof timeStr === 'string' ? timeStr : String(timeStr);
    const [h, m] = clean.substring(0, 5).split(':').map(Number);
    // NEW-FU-466 (Phase 112): a MALFORMED non-empty time (e.g. "8", "ab:cd")
    // used to coerce to 0 = midnight via `(h||0)`, which made a bad office-hours
    // value silently overlap the whole morning (a phantom R-04 storm). Return
    // NaN instead so every overlap comparison (`x < NaN`) is false — a malformed
    // value can never manufacture a conflict. Valid times are unaffected.
    if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
    return h * 60 + m;
  }

  get startMinutes() { return Section.toMinutes(this.startTime); }
  get endMinutes()   { return Section.toMinutes(this.endTime);   }

  overlaps(other) {
    if (!this.day || !other.day) return false;
    if (this.day !== other.day) return false;
    if (!this.startTime || !this.endTime || !other.startTime || !other.endTime) return false;
    return this.startMinutes < other.endMinutes &&
           other.startMinutes < this.endMinutes;
  }

  get label() {
    // NEW-FU-282 (Phase 56): use sectionLabel so female sections render
    // as "§F-XX". The helper handles the gender flag picked up from the
    // section_gender column (set at construction time).
    const { sectionLabel } = require('./sectionLabel');
    return `${this.courseCode ?? this.courseId} (${sectionLabel(this)}) on ${this.day} ${this.startTime}–${this.endTime}`;
  }

  toJSON() {
    return {
      id: this.id, scheduleId: this.scheduleId,
      courseId: this.courseId, courseCode: this.courseCode,
      courseName: this.courseName, academicLevel: this.academicLevel,
      category: this.category, numSections: this.numSections,
      instructorId: this.instructorId, instructorName: this.instructorName,
      venueId: this.venueId, venueName: this.venueName,
      sectionNumber: this.sectionNumber,
      day: this.day, startTime: this.startTime, endTime: this.endTime,
      // NEW-FU-93: surface section + venue type info to the frontend so
      // the section card can show the Lec/Lab badge and the SectionModal
      // can gate the type selector on course.has_lab.
      sectionType: this.sectionType,
      venueType: this.venueType,
      hasLab: this.hasLab,
      // NEW-FU-270: surface credits so the frontend can render the same
      // R-15 message in tooltips without a second courses fetch.
      credits: this.credits,
      // NEW-FU-272 (Phase 50): so the frontend can suppress venue-related
      // UI affordances (assign-venue button, etc.) for exempt courses.
      isCapstone: this.isCapstone,
      // NEW-FU-272 (Phase 50 #3): so the frontend can reconstruct the
      // display label (e.g., "F11" from section_number='11' + gender='F').
      gender: this.gender,
      // NEW-FU-275 (Phase 52 #5): so the frontend can render external
      // sections with a dedicated badge (e.g., "Off-campus internship").
      isExternal: this.isExternal,
    };
  }
}

module.exports = Section;
