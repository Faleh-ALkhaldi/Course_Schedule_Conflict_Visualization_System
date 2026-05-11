class Section {
  constructor({
    id, scheduleId, courseId, instructorId, venueId,
    sectionNumber, day, startTime, endTime,
    courseCode, courseName, academicLevel, category, numSections,
    instructorName, venueName,
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
    this.createdAt      = createdAt;
    this.updatedAt      = updatedAt;
  }

  /** Convert "HH:MM" or "HH:MM:SS" to total minutes from midnight. */
  static toMinutes(timeStr) {
    if (!timeStr) return 0;
    const clean = typeof timeStr === 'string' ? timeStr : String(timeStr);
    const [h, m] = clean.substring(0, 5).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
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
    return `${this.courseCode ?? this.courseId} (${this.sectionNumber}) on ${this.day} ${this.startTime}–${this.endTime}`;
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
    };
  }
}

module.exports = Section;
