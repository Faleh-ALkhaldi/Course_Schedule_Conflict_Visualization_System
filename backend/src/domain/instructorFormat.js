// NEW-FU-661: instructor name + email format — the SINGLE SOURCE OF TRUTH shared by
// the API (createInstructor / updateInstructor) AND the import-field validator, so a
// name/email reaching the system through ANY path (direct API or file import) faces the
// exact same rules. Previously these lived inline in the controller; the importer didn't
// check them at all (a hand-edited Instructors sheet could inject a junk name or a
// malformed email). Pure (no DB / no I/O) so it is unit-testable in isolation.

// A well-formed email looks like name@host.tld. RFC-complete validation is famously hard;
// this catches the worst typos (the DB unique index does the rest). Same regex the API
// has used since NEW-M8.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailError(email) {
  // NEW-FU-662: length cap (DB VARCHAR(120)) before the regex — matches the column and
  // bounds the input. EMAIL_RE is linear (no nested quantifiers) so this is belt-and-suspenders.
  if (typeof email !== 'string' || email.trim().length > 120 || !EMAIL_RE.test(email.trim()))
    return 'email must look like name@host.tld.';
  return null;
}

// A real instructor name is letters / spaces / hyphens / apostrophes only, at least a
// first + last name. Auto-generated placeholders ("NEW INSTRUCTOR 1") are exempt (the
// add-instructor panel seeds them). Verbatim from the controller's former local copy.
function instructorNameError(name) {
  const trimmed = String(name ?? '').trim();
  if (/^NEW INSTRUCTOR \d+$/i.test(trimmed)) return null;
  if (trimmed.length > 120) return 'name is too long (max 120 characters).';   // NEW-FU-662: DB VARCHAR(120)
  if (!/^[A-Za-z\s'-]+$/.test(trimmed))
    return 'name may contain only letters, spaces, hyphens and apostrophes.';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || !parts.every(p => /^[A-Za-z][A-Za-z'-]*$/.test(p)))
    return 'Enter a full name — at least a first and last name (English letters only, separated by a space).';
  return null;
}

module.exports = { EMAIL_RE, emailError, instructorNameError };
