# Git hooks

Versioned git hooks for this repo.

## Setup (one-time per clone)

Git doesn't read this directory by default — point it here once:

```bash
git config core.hooksPath .githooks
```

To verify:
```bash
git config --get core.hooksPath   # should print: .githooks
```

## Hooks

### `pre-push`

Runs the smoke-test suite (`npm run smoke`) before any push. The suite
exercises the four user-facing handlers that previously had silent-error
bugs (course / instructor / venue / OH delete) plus the OfficeHourModal
render path. See [`scripts/smoke-test.js`](../scripts/smoke-test.js).

**Behavior**
- Dev servers reachable (`localhost:3000` + `localhost:4000`) → run tests;
  push proceeds only if all pass.
- Dev servers NOT reachable → warn and skip (push proceeds). The hook
  doesn't try to start servers itself; an offline push isn't blocked just
  because the suite can't be run.

**Bypass**
- `SKIP_SMOKE=1 git push` — environment variable bypass (handy for scripts).
- `git push --no-verify` — git's built-in bypass for any hook.
