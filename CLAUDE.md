# CSCVS (SWE 412 Capstone) — Agent Operating Brief (`CLAUDE.md` = `AGENTS.md`)

**Read this first, every session.** Shared context for Claude Code and Codex.

## What this is
**Course Schedule Conflict Visualization System** — a university capstone.
- `backend/` — Node.js backend
- `frontend/` — JS frontend
- `data/` — datasets (e.g. catalog/term data)
- `scripts/` — utilities (e.g. `verify-venue-dedup.js`)
- `render.yaml` — Render deployment config

## Source of truth
- `README.md` — authoritative project description / run instructions
- `PER_TERM_ISOLATION_PLAN.md` — current architecture plan (per-term isolation)
- The `*.docx`/`*.pdf` deliverables in the parent `SWE_412/` folder (SRS, SDD, Test Plan, User Manual) are graded artifacts — keep behavior consistent with them.

## Conventions
- This is graded coursework: do not introduce behavior that contradicts the SRS/SDD without flagging it in `HANDOFF.md`.
- Keep frontend/backend contracts stable; note any API change in `HANDOFF.md`.

---

## 🔄 Cross-Agent Handoff Protocol (Claude Code ⇄ Codex)

`CLAUDE.md` and `AGENTS.md` are the **same file** (one is a symlink to the other), so Claude Code and
Codex read **byte-identical** project context. Never edit "both" — there is only one.

**START of every session (Claude OR Codex):**
1. Read **`HANDOFF.md`** (repo root) — the live baton: what's done, what's next, what's half-finished.
2. If `.remember/now.md` exists, skim it for recent detail (Claude writes it; Codex may read it).
3. Run `git status` and `git log --oneline -12` to see the other agent's latest trail.

**WHILE working:** keep commits small with clear messages so the other agent can follow along.
Do not invent behavior that isn't in the specs this file points to — add an open question instead.

**END of every session (before you stop, switch, or hit a usage limit):**
1. Update **`HANDOFF.md`**: flip statuses, list what you did, what's next, and anything half-done.
2. Commit your work; record the branch name in `HANDOFF.md`.

**Branch discipline:** prefix branches by agent — `claude/<task>` or `codex/<task>` — or share one
branch and rely on small commits. Never leave uncommitted work when handing off.

**Golden rule:** the next agent must be able to continue with ONLY `HANDOFF.md` + this file + git.
If something lives only in your head, write it into `HANDOFF.md`.
