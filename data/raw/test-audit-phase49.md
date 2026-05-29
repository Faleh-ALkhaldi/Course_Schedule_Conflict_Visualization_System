# Test audit — post-Phase-49 data swap

Run: 2026-05-28, against the freshly-seeded DB.

## Headline

| | Suites | Tests |
|---|---:|---:|
| Pass | 12 / 25 | 364 / 490 (74%) |
| Fail | 13 / 25 | 123 / 490 (25%) |
| Skip | — | 3 |

Every unit test passes (3/3). All failures are in integration tests.

## Passing suites (12)

`cooperativeEnforcement`, `healthRoutes`, `r04r05QuickFix`, `r15AndQuickDelete`, `r15QuickFix`, `sectionGroupDelete`, `smartGreedy`, `smartRecommend`, `suggestSmart` (integration) plus all 3 unit tests (`conflictEngine`, `sectionPattern`, `term`).

These are mostly tests that operate on a fresh empty term and don't reference specific seeded entities by name.

## Failing suites (13)

| Suite | # ref'd codes | Primary failure pattern |
|-------|---:|-------------------------|
| `phase37PostApply` | 58 | Hardcoded course codes |
| `phase36QuickFixRedTeam` | 40 | Hardcoded course codes |
| `phase36SuggestRedTeam` | 34 | Hardcoded codes + missing grad courses |
| `suggesterRedTeam` | 24 | Hardcoded course codes |
| `quickFixRedTeam` | 8 | Hardcoded course codes |
| `phase39GeneralizedDrop` | 5 | Hardcoded course codes |
| `quickFixBroad` | 2 | Hardcoded course codes |
| `phase33` | 1 | Hardcoded course code |
| `quickFix` | — | Cascading conflicts from real data |
| `refuseToPlace` | — | Cascading conflicts from real data |
| `suggestConflictFree` | — | Cascading conflicts from real data |
| `suggestPatterns` | — | Hardcoded seed UUIDs + test-isolation issue |
| `terms` | — | Auto-copy of real conflicts into fresh terms |

## Failure categories

### A. Hardcoded missing course codes (≈100 of 123 failures)

Tests reference these 8 codes from the old fictional seed, none of which exist in the new real-KFUPM data:

```
SWE101, SWE201, SWE301, SWE310, SWE321, SWE411, SWE501, SWE510
```

Typical failure shape: `Cannot read properties of undefined (reading 'id')` when `courses.find(c => c.course_code === 'SWE321')` returns undefined.

**Symptom example** (`phase36SuggestRedTeam.test.js` S-28):
```js
const c = courses.find(c => c.course_code === 'SWE321');  // → undefined
.send({ courseConfigs: [{ courseId: c.id, sections: 1 }] });  // TypeError
```

**Mapping table** — real codes that align with the old codes by academic level + lab presence:

| Old (gone) | Closest real KFUPM | Why |
|------------|--------------------|-----|
| SWE101 (Freshman 3cr no-lab) | — none — | new data has no Freshman-level SWE |
| SWE201 (Sophomore 3cr no-lab, 2-section) | **SWE 216** | Sophomore 3cr no-lab |
| SWE206 (Sophomore 3cr **with lab**) | **SWE 206** | identical! preserve |
| SWE301 (Junior 3cr no-lab) | **SWE 316** | Junior 3cr no-lab |
| SWE310 (Junior 3cr no-lab) | **SWE 326** | Junior 3cr no-lab |
| SWE321 (Junior 3cr no-lab) | **SWE 363** | Junior 3cr no-lab |
| SWE411 (Senior 3cr no-lab) | **SWE 414** | Senior project-style |
| SWE422 (Senior 3cr no-lab, 2-section) | **SWE 422** | identical! preserve |
| SWE501 (Graduate) | — none — | new data has no SWE grad courses in scope |
| SWE510 (Graduate) | — none — | same |

### B. Missing grad-level courses (~6 failures)

Tests like `S-27: 4 Graduate courses each 3 sections forced to MW 75min` expect ≥2 graduate-level courses. The new data has 0 SWE UG-catalog courses at the Graduate level (the 9 SWE 5xx/6xx grad codes seen in registrar offerings were skipped as out-of-UG-scope).

**Fix options:**
- Include SWE 503/516/555 in the seed despite being out-of-catalog (loosen the "active UG" filter)
- Refactor failing tests to `skip()` when fewer than 2 grad courses exist
- Use a non-SWE grad course from a different department (but the schema is single-dept SWE-DEPT)

### C. Auto-copy cascading conflicts (~10 failures, `terms.test.js`)

Confirmed via curl: `POST /api/v1/terms { code: '271' }` while active term is 251 copies 71 sections into the new term — these are the **real KFUPM 251 sections**, which carry 3 hard conflicts (R-12 for SWE 363 §01 in 22-334, etc.). The `Draft → Finalized` transition gate rejects the term: `Cannot finalize Term 271: 3 hard conflicts must be resolved first.`

The old seed was deliberately conflict-free ("the conflict-free baseline" — see `NEW-FU-99 + NEW-FU-101` comments in old seed.js). Real KFUPM data isn't.

**Fix options:**
- Test calls `freshTermSchedule()` which already clears sections — change `terms.test.js` to do the same instead of relying on raw `POST /terms`
- OR: change the test to delete sections after creating the term and before attempting Finalize
- OR: pass a `copyFromActive: false` flag (if the API supports it; check `controllers/index.js`)

### D. Test isolation issues (~7 failures, `suggestPatterns` + others)

`suggestPatterns.test.js` line 252: after creating a fresh course and asking the suggester to place 1 section on Wednesday only, the assertion fails because the result set contains both Sunday AND Wednesday days. The "Clear any inherited sections" loop on lines 227–233 may not be removing rows fast enough before the suggest runs, or the suggester is allocating based on stale schedule state.

**Fix options:**
- Add `await` synchronization or a small delay after the clear loop
- Investigate whether the cleanup uses correct scope (`?scope=row` vs default)
- Confirm with a `GET /sections` between clear and suggest that the slate is empty

## Proposed fix plan — 3 effort tiers

### Tier 1: Minimal patch (~1–2h) — restore CI green

Sed/edit-driven find-and-replace of the 6 mappable course codes across the 8 test files, plus a targeted fix for `terms.test.js` and `suggestPatterns.test.js`.

```
SWE201 → SWE216       (8 test files)
SWE301 → SWE316
SWE310 → SWE326
SWE321 → SWE363
SWE411 → SWE414
SWE101 → SWE206       (closest fallback for Freshman-level expectations,
                       though SWE 206 is technically Sophomore — flag in PR)
```

Tests that require Graduate courses or Freshman-level invariants would still fail; mark those with `test.skip(...)` and a `// TODO Phase 50` comment. Expected post-patch: ~110 of 123 fixed.

### Tier 2: Seed-agnostic refactor (~4–6h) — durable

Replace `courses.find(c => c.course_code === '...')` with attribute-based queries:

```js
const juniorNoLab = courses.find(c =>
  c.academic_level === 'Junior' && !c.has_lab && c.credits === 3
);
```

The tests stop caring about specific seed codes. Any future data swap (Phase 50, 60, etc.) won't break them. Higher effort because some tests need 2–6 specific courses with distinct properties.

### Tier 3: Test-fixture isolation (~1–2d) — gold standard

Add `tests/fixtures.js` that creates a private test-only schedule with deterministic courses/sections via the API in `beforeAll`, and tears it down in `afterAll`. Tests reference fixture-created entities, never the seed. The seed serves UI/demo only.

This is what a graded project should aim for long-term but is overkill if the demo is in days.

## Recommendation

For your submission timeline, **Tier 1 + targeted Tier 2 on the grad-course tests** is the sweet spot:

1. Map the 6 codes via a search-and-replace pass (Tier 1, ~30 min).
2. For the 3 grad-course tests, either include SWE 503/516/555 in the seed (loosen filter — 5 min) or skip them.
3. Fix `terms.test.js` by adding section cleanup after term creation (~10 min).
4. Investigate `suggestPatterns.test.js` isolation issue (~30 min).

Estimated total: ~1.5h to restore CI green without compromising the data-layer authenticity Phase 49 achieved.
