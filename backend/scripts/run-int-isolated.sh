#!/usr/bin/env bash
# NEW-FU-673: run each integration test FILE in its OWN jest process.
#
# Why: the integration suite is per-file by design. Jest's globalSetup drops+recreates+seeds the
# test DB ONCE per `jest` invocation, so running every file in a single invocation (the plain
# `test:int`) makes all 33 files share one DB. They reuse term codes (251–343, season digit 1/2/3
# — too few to make globally unique), so a code one file creates/deletes collides with another
# file's use of the same code → cross-file contention (~29 failures) that has nothing to do with
# the code under test. Giving each file its own jest process = its own fresh globalSetup DB = full
# isolation, which is how the suite is meant to run (`npm run test:int -- <file>`).
#
# One retry per file absorbs transient DB-contention flakes (e.g. the long-standing archived-
# schedule timing flake in terms.test.js) without masking a real, repeatable failure.
set -u
cd "$(dirname "$0")/.."

pass=0; failed=()
for f in tests/integration/*.test.js; do
  base=$(basename "$f")
  if NODE_ENV=test npx jest "$f" --runInBand --forceExit >/tmp/intiso_last.log 2>&1; then
    printf "  PASS  %s\n" "$base"; pass=$((pass+1))
  elif NODE_ENV=test npx jest "$f" --runInBand --forceExit >/tmp/intiso_last.log 2>&1; then
    printf "  PASS  %s (retry)\n" "$base"; pass=$((pass+1))
  else
    printf "  FAIL  %s\n" "$base"; failed+=("$base")
    grep -E "^Tests:|✕ " /tmp/intiso_last.log | head -6 | sed 's/^/        /'
  fi
done

echo "------------------------------------------------------------"
echo "isolated integration run: ${pass} files passed, ${#failed[@]} failed"
if [ ${#failed[@]} -ne 0 ]; then echo "FAILED: ${failed[*]}"; exit 1; fi
echo "ALL INTEGRATION FILES PASS (per-file isolated)"
