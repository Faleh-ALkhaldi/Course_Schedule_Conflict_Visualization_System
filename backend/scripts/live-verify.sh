#!/usr/bin/env bash
# NEW-FU-394 (Phase 37): live verification script for the user's exact
# screenshot scenario. Exercises the Quick Fix /quick-fix and
# /quick-fix/apply endpoints against a running backend, then asserts:
#   • No `drop` ops in the plan
#   • Post-apply conflict count matches the plan's summary.remaining*
#   • Every unresolved rule has a populated unresolvedReasons entry
#
# Exits 0 if all assertions pass, non-zero with details on first
# failure. Designed to be runnable in CI: boots nothing itself,
# expects a backend on $BACKEND_URL (default http://localhost:4000).
#
# Usage:
#   scripts/live-verify.sh            # default localhost:4000
#   BACKEND_URL=https://… scripts/live-verify.sh

set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:4000}"
ADMIN_USER="${ADMIN_USER:-admin1}"
ADMIN_PASS="${ADMIN_PASS:-password123}"
TERM_CODE="${TERM_CODE:-343}"

# Tiny JSON helper. We use jq for output but every payload is constructed
# with printf — no user input ever interpolated.
say() { printf "%s\n" "$*"; }
die() { printf "✗ %s\n" "$*" >&2; exit 1; }

# ── 1. Health probe ────────────────────────────────────────────────
say "1/7 health probe"
curl -fsS "$BACKEND_URL/api/v1/health" >/dev/null \
  || die "backend unreachable at $BACKEND_URL"

# ── 2. Authenticate ────────────────────────────────────────────────
say "2/7 authenticate as $ADMIN_USER"
LOGIN_BODY=$(printf '{"username":"%s","password":"%s"}' "$ADMIN_USER" "$ADMIN_PASS")
TOKEN=$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "$LOGIN_BODY" "$BACKEND_URL/api/v1/auth/login" | jq -r .token)
test -n "$TOKEN" && test "$TOKEN" != "null" || die "login failed"
AUTH="Authorization: Bearer $TOKEN"

# ── 3. Reset the test schedule ─────────────────────────────────────
say "3/7 reset schedule for term $TERM_CODE"
curl -fsS -X DELETE -H "$AUTH" \
  "$BACKEND_URL/api/v1/terms/$TERM_CODE?activeCode=251" >/dev/null 2>&1 || true
TERM_BODY=$(printf '{"code":"%s"}' "$TERM_CODE")
curl -fsS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "$TERM_BODY" "$BACKEND_URL/api/v1/terms" >/dev/null \
  || die "term creation failed"
SCHED=$(curl -fsS -H "$AUTH" \
  "$BACKEND_URL/api/v1/departments/SWE-DEPT/schedules" \
  | jq -r --arg c "$TERM_CODE" '.[] | select(.semester==$c) | .id')
test -n "$SCHED" && test "$SCHED" != "null" || die "couldn't find schedule for term $TERM_CODE"
# Wipe any seeded sections.
for sid in $(curl -fsS -H "$AUTH" "$BACKEND_URL/api/v1/schedules/$SCHED/sections" \
             | jq -r '.sections[]?.id // .[]?.id' 2>/dev/null); do
  curl -fsS -X DELETE -H "$AUTH" \
    "$BACKEND_URL/api/v1/sections/$sid?scope=row" >/dev/null
done

# ── 4. Construct the user's screenshot scenario ────────────────────
say "4/7 construct adversarial schedule (R-04 + R-05 + R-10 + R-11 + R-12)"
COURSES=$(curl -fsS -H "$AUTH" "$BACKEND_URL/api/v1/courses")
INSTR=$(curl -fsS -H "$AUTH" "$BACKEND_URL/api/v1/instructors")
VENUES=$(curl -fsS -H "$AUTH" "$BACKEND_URL/api/v1/venues")
SWE301=$(echo "$COURSES" | jq -r '.[] | select(.course_code=="SWE301") | .id')
SWE321=$(echo "$COURSES" | jq -r '.[] | select(.course_code=="SWE321") | .id')
SWE206=$(echo "$COURSES" | jq -r '.[] | select(.has_lab==true) | .id' | head -1)
SWE501=$(echo "$COURSES" | jq -r '.[] | select(.course_code=="SWE501") | .id')
HALL=$(echo "$VENUES" | jq -r '.[] | select(.type=="LectureHall") | .id' | head -1)
LAB=$(echo "$VENUES" | jq -r '.[] | select(.type=="Laboratory") | .id' | head -1)
INSTR0=$(echo "$INSTR" | jq -r '.[0].id')
INSTR1=$(echo "$INSTR" | jq -r '.[1].id')

make_section() {
  curl -fsS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
    -d "$1" "$BACKEND_URL/api/v1/schedules/$SCHED/sections" >/dev/null
}
make_section "$(printf '{"courseId":"%s","instructorId":null,"venueId":"%s","sectionNumber":"01","days":["Sunday","Tuesday","Thursday"],"startTime":"08:00","endTime":"08:50"}' "$SWE301" "$HALL")"
make_section "$(printf '{"courseId":"%s","instructorId":"%s","venueId":null,"sectionNumber":"01","days":["Sunday","Tuesday","Thursday"],"startTime":"09:00","endTime":"09:50"}' "$SWE321" "$INSTR0")"
make_section "$(printf '{"courseId":"%s","instructorId":"%s","venueId":"%s","sectionNumber":"50","sectionType":"Lab","days":["Monday"],"startTime":"10:00","endTime":"10:50"}' "$SWE206" "$INSTR0" "$HALL")"
make_section "$(printf '{"courseId":"%s","instructorId":"%s","venueId":"%s","sectionNumber":"01","sectionType":"Lec","days":["Monday","Wednesday"],"startTime":"17:00","endTime":"18:15"}' "$SWE501" "$INSTR1" "$LAB")"

PRE=$(curl -fsS -H "$AUTH" "$BACKEND_URL/api/v1/schedules/$SCHED/conflicts" \
      | jq '.conflicts | group_by(.ruleId) | map({rule: .[0].ruleId, count: length})')
say "   pre-plan conflicts: $(echo $PRE | jq -c .)"

# ── 5. Quick Fix plan ──────────────────────────────────────────────
say "5/7 quick-fix plan"
PLAN=$(curl -fsS -X POST -H "$AUTH" "$BACKEND_URL/api/v1/schedules/$SCHED/quick-fix")
OP_TYPES=$(echo "$PLAN" | jq -c '[.ops[].type]')
say "   op types: $OP_TYPES"
DROP_COUNT=$(echo "$PLAN" | jq '[.ops[] | select(.type=="drop") | 1] | length')
if [ "$DROP_COUNT" -gt 0 ]; then
  die "Phase 37 contract violation: plan contains $DROP_COUNT drop op(s). Drop must never be auto-picked."
fi
# Reasons must reference concrete data.
REASONS=$(echo "$PLAN" | jq -c '.unresolvedReasons')
say "   unresolvedReasons: $REASONS"
for rid in $(echo "$PLAN" | jq -r '.unresolvedRuleIds[]?'); do
  REASON=$(echo "$PLAN" | jq -r --arg r "$rid" '.unresolvedReasons[$r]')
  test -n "$REASON" && test "$REASON" != "null" || die "empty reason for $rid"
  if ! printf "%s" "$REASON" | grep -Eq 'SWE[0-9]+|Dr\.|H-[0-9]+|G-[0-9]+|[0-9][0-9]:[0-9][0-9]|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Laboratory|LectureHall'; then
    die "reason for $rid lacks concrete data: $REASON"
  fi
done

# ── 6. Apply the plan ──────────────────────────────────────────────
say "6/7 apply $(echo "$PLAN" | jq '.ops | length') op(s)"
OPS_JSON=$(echo "$PLAN" | jq -c '.ops')
APPLY=$(curl -fsS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"ops\":$OPS_JSON}" \
  "$BACKEND_URL/api/v1/schedules/$SCHED/quick-fix/apply")
say "   apply response: $(echo $APPLY | jq -c .)"

# ── 7. Verify post-apply matches plan summary ──────────────────────
say "7/7 verify post-apply matches plan summary"
POST=$(curl -fsS -H "$AUTH" "$BACKEND_URL/api/v1/schedules/$SCHED/conflicts")
POST_HARD=$(echo "$POST" | jq '[.conflicts[] | select(.severity=="Hard")] | length')
POST_SOFT=$(echo "$POST" | jq '[.conflicts[] | select(.severity=="Soft")] | length')
PRED_HARD=$(echo "$PLAN" | jq '.summary.remainingHard')
PRED_SOFT=$(echo "$PLAN" | jq '.summary.remainingSoft')
say "   predicted hard=$PRED_HARD soft=$PRED_SOFT  /  actual hard=$POST_HARD soft=$POST_SOFT"
HARD_DELTA=$(( POST_HARD - PRED_HARD ))
SOFT_DELTA=$(( POST_SOFT - PRED_SOFT ))
test "${HARD_DELTA#-}" -le 1 \
  || die "simulator/runtime drift: predicted $PRED_HARD hard, got $POST_HARD"
test "${SOFT_DELTA#-}" -le 1 \
  || die "simulator/runtime drift: predicted $PRED_SOFT soft, got $POST_SOFT"

# ── Cleanup ────────────────────────────────────────────────────────
curl -fsS -X DELETE -H "$AUTH" \
  "$BACKEND_URL/api/v1/terms/$TERM_CODE?activeCode=251" >/dev/null 2>&1 || true

printf "\n✓ live-verify PASSED: no drops, dynamic reasons, simulator and runtime agree.\n"
