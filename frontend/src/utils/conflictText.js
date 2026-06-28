// NEW-FU-223 (Phase 96): plain-language conflict descriptions.
//
// The conflict engine identifies clashes by internal rule codes (R-01 … R-15,
// mirrored in backend/src/config/constants.js). Those codes are meaningful to
// developers but are noise to the end user (a scheduler / department admin),
// who only needs to know WHAT kind of clash happened in human terms.
//
// This module is the single place that translates a rule code into a sentence
// a non-technical user understands. Anything that surfaces conflicts to the
// user (the Suggest decision flow, future conflict tooltips, etc.) should go
// through here so the wording stays consistent and no raw "R-05" ever reaches
// the screen.

const RULE_PLAIN = {
  'R-01': 'Two courses for the same student level run at the same time.',
  'R-02': 'Courses for neighbouring student levels overlap in time.',
  'R-04': 'An instructor is booked for two classes at the same time.',
  'R-05': 'A venue is booked for two classes at the same time.',
  'R-06': 'A class is scheduled outside its allowed hours (undergraduate daytime / graduate evening).',
  'R-09': 'A section has no instructor assigned.',
  'R-10': 'A section has no venue assigned.',
  'R-11': 'A lab is placed in a venue that is not a laboratory.',
  'R-12': 'A lecture is placed in a laboratory venue.',
  'R-13': 'An instructor has no office hours set.',
  'R-14': 'A lab course is missing its lecture or its lab part.',
  'R-15': "A section's weekly meeting time is too short for its credit hours.",
};

// Stable display order — hard, time-blocking clashes first; advisory/soft last.
const RULE_ORDER = ['R-01', 'R-04', 'R-05', 'R-06', 'R-02', 'R-10', 'R-11', 'R-12', 'R-09', 'R-13', 'R-14', 'R-15'];

// Map one rule code → human sentence. Unknown codes fall back to a generic
// line (so a future rule never leaks its raw code to the user).
export function ruleToPlain(ruleId) {
  return RULE_PLAIN[ruleId] || 'A scheduling clash was detected.';
}

// Turn a list of rule codes (possibly with duplicates, any order) into a
// deduplicated, sensibly-ordered list of plain-language sentences — ready to
// render as bullet points in the decision dialog.
export function conflictTypesPlain(ruleIds = []) {
  const present = new Set(ruleIds);
  const ordered = RULE_ORDER.filter(r => present.has(r));
  // Append any codes we didn't have an explicit order for (future rules).
  for (const r of present) if (!ordered.includes(r)) ordered.push(r);
  return ordered.map(ruleToPlain);
}

export default { ruleToPlain, conflictTypesPlain };
