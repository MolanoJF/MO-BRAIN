# Handoff — read this first

Written 2026-09-15, mid-Slice-1. Supersedes the Slice-0 handoff of the same day.

---

## What this project is

**brainstand** (codename — rename before any public artifact) wraps [gbrain](https://github.com/garrytan/gbrain) — a 415K-LOC Bun/TypeScript knowledge system — into a product a team deploys with one `docker compose up` and operates from a web console.

The whole strategy rests on one bet: **gbrain is a pinned upstream dependency driven only through its published contracts. Never forked.** Its CLI is the control lane, its HTTP MCP is the data lane, and a small file plane covers what `config set` refuses. If you find yourself editing gbrain's source or reading its tables directly, stop — that's the failure mode this design exists to prevent.

`C:\Users\juanp\Desktop\gbrain` is a **read-only reference checkout**. Read it freely to diagnose behavior. Never edit it.

---

## Where things stand

**Slice 0: COMPLETE** (25 commits, on `main`, HEAD `fbd0e95`).

**Slice 1: IN PROGRESS** on branch **`slice-1-deploy-one-brain`** (13 commits, base `fbd0e95`, tree clean).

| Task | State |
|---|---|
| 1 — two-database Postgres + production compose | **complete** (`2c1a7ac..37fbe14`, review clean) |
| 2 — Caddyfile, `/admin` sealed | **complete** (`4fff74a..b58faf9`, review clean) |
| 3 — advisory lock + file-plane writer | **code done and controller-verified; scoped re-review NOT yet run** |
| 4–15 | not started |

### ⚠️ Resume exactly here

Task 3's fix rounds 1 and 2 are committed (`a1c1989`, `3a5a360`) and I verified all three required states myself. **The scoped re-review was never dispatched** — I was about to generate it when the session ended. Do that first:

```bash
bash "C:/Users/juanp/.claude/plugins/cache/superpowers-dev/superpowers/6.3.0/skills/subagent-driven-development/scripts/review-package" "docs/superpowers/plans/2026-09-14-slice-1-deploy-one-brain.md" e48f751 3a5a360
```

Then dispatch `re-review-prompt.md` with the four findings from the Task 3 review (they are in the ledger), the brief, the report, and that diff path. Only after it comes back clean is Task 3 complete.

**Do not re-dispatch Tasks 1, 2, or Task 3's implementation.** They are done and in git.

### The working ledger is the real record

`.superpowers/sdd/2026-09-14-slice-1-deploy-one-brain/progress.md`

It is **git-ignored scratch**, so it does not survive `git clean -fdx`. It holds every ruling with its reasoning and cost-if-wrong, per-task state, deferred minors, and the verification evidence behind each claim. **Read it before resuming and trust it over any summary, including this one.** Task briefs, agent reports and review packages live beside it.

---

## Verified state as of this writing

```
bun test test/unit          52 pass
bun test test/integration   37 pass, 1 skip, 0 fail   (needs Postgres — see below)
bun run lint:forbidden      clean
bunx tsc --noEmit           clean
bun test test/contract      NOT re-run since Task 2; needs `bun run stack:up` first
```

The 1 skip is deliberate: the `config.json is written 0600` assertion cannot be expressed on NTFS. It **runs and passes for real** in a Linux container — verified this session.

---

## Environment

**Docker Desktop must be started manually** after a reboot. This session needed **no** PATH workaround (`docker compose version` → v5.5.1 directly). If yours fails but Docker is running, your session predates the install:

```bash
export PATH="/c/Users/juanp/AppData/Local/Programs/DockerDesktop/resources/bin:$PATH"
```

Subagents inherit the parent session's environment — if you need it, put it in their prompts too.

**Container state right now:** a scratch Postgres named `bs-fp-pg` is **running** on host port 5432 (user `gbrain`, password `ci-not-a-real-secret`, db `control`). `test/integration/fileplane.test.ts` needs it. Remove it when you no longer do:

```bash
docker rm -f bs-fp-pg
```

**The Slice 0 stack is DOWN.** The contract suite's own teardown stops it. Bring it back before running contract tests:

```bash
bun run stack:up
```

Expect this to be slow on a fresh volume. Note that `compose/initdb/` is now **shared by both compose files**, so `bun run stack:up` also exercises Task 1's `\gexec` guard.

---

## Rulings I made on your behalf

These were mine to make, not yours. Each names what it costs if I got it wrong. Rework whatever you disagree with — full reasoning is in the ledger.

1. **Branch, not worktree.** Slice 1 is on `slice-1-deploy-one-brain` in the primary directory. A git worktree would lack the gitignored `.env` and start a second compose project. *Cost: must merge at the end rather than committing straight to `main`.*
2. **Task 9's `/space` gap** → add `seedSpaceRepo` to `fileplane.ts`, expose as `POST /fileplane/seed-space`, call before `sources.add`. Lands in **Task 9**, not Task 4. *Cost: if a later slice needs seeding outside the wizard, it's a move, not a rewrite.* **Still unimplemented — this is the known blocker.**
3. **Tasks 10 ↔ 11 mount order.** Task 11 must mount `app.route('/api', backup)` **above** Task 10's SPA catch-all, or `GET /api/backup` returns index.html. *Cost: none identified; it's the only ordering satisfying both tests.*
4. **Code blocks beat Interfaces summaries** wherever a task's prose contradicts its own code. *Cost: a stale planning-doc line.*
5. **Task 8's commented-out wizard route is deliberate**; Task 9 must uncomment it, and Task 9 Step 9 is the proof. *Cost: a review round re-flagging an intentional comment.*
6. **`lint:forbidden` exemptions narrowed scope, never rules** — `.superpowers/` skipped, root `HANDOFF.md` exempt by name. *Cost: a forbidden pattern could land in HANDOFF.md unnoticed; every code file and other markdown still linted, with tests pinning that.*
7. **Kept `${DOMAIN:?required}`** in the base compose and fixed the dev override's false claim instead. Rejected the reviewer's suggestion to relax it. *Cost: a blank `DOMAIN` gives an explicit compose error instead of a working localhost stack.*
8. **`/admin` seal must be a `handle` block** (see below). *Cost: none; both forms were compiled and compared.*
9. **Task 3's lock reserves its connection.** *Cost: a few lines of connection management that weren't strictly required.*
10. **Silently-skipped gates must fail loudly** unless explicitly opted out — rejected `console.warn`. Scope widened to fix the precedent in Task 1's file. *Cost: one extra always-on test per suite.*
11. **`mergeConfigJson` moved to `fileplane.ts`.** The plan contradicts itself: its File Structure table binds `lock.ts` to "pure lock mechanics, no gbrain knowledge". The constraint won. *Cost: it lives in a different file than Task 3's text says; consumers import by name, so nothing downstream breaks.*
12. **Fixed `atomicWrite`'s docstring rather than adding fsync.** S3 requires atomicity, which `rename` gives; durability is a claim S3 doesn't make and secrets' source of truth is the control DB. *Cost: a crash between rename and flush loses the latest `config.json` write — recoverable, no key lost.*
13. **A guard must not fire for a categorical impossibility.** I first told Task 3 to apply the fail-unless-opted-out convention to the Windows 0600 check; that left the suite **permanently red**, so I reversed it. Fail on POSIX where a skip is anomalous; skip visibly on win32 where it can never pass. *Cost: a Windows-only dev never sees the 0600 check locally; Linux/CI enforces it.*

---

## The most important lesson, now confirmed twice

**Executing the plan finds defects in the plan.** Slice 0 found ~20. Slice 1 has found **ten in three tasks**, all patched back into the plan file with evidence blockquotes (`4fff74a`, `de648f6`, `1841f50`) so a fresh run hits none of them.

Two are worth internalizing, because in both cases **the test would have certified the bug**:

- **The `/admin` seal was decorative.** A bare top-level `respond @admin_denied 404` compiles *behind* the catch-all, because Caddy sorts `respond` after `handle`. Real `caddy adapt` put the 404 at route 4, behind a route-3 catch-all matching everything — unreachable dead config. S1 and a Slice 1 exit-gate item both unmet. **And the drafted test parsed Caddyfile *text*,** so it found the `respond` line present and went green. Now a `handle` block (route 1), and the test asserts compiled route *order*.
- **The advisory lock proved nothing.** It passed single-threaded while saying nothing about mutual exclusion — the one property it exists to provide. The test now runs 4 concurrent callers asserting `maxActive === 1`.

The generalisation: **a test that reads the artifact is not a test of the artifact's behavior**, and **a concurrency primitive tested serially is untested**. Ask of every gate: would this fail if the thing it guards were broken?

---

## Working conventions that earned their keep

**Execution goes to Sonnet subagents; the main session orchestrates and verifies.** One task per dispatch.

**Verify every subagent claim independently — this paid off repeatedly this session.** Task 3's report described one problem; running the suite myself found two. An "Approved" review carried an Important finding in its own body. Re-run the command yourself, and prefer testing the artifact over reading the report.

**Make agents prove a guard by exercising its failure path.** Ask for the red run, not just the green one. Every guard added this session was verified failing before being trusted.

**Tell subagents to stop rather than weaken a gate.** This keeps producing the session's best moments — Task 1's agent found `lint:forbidden` already broken and refused to touch it, which is exactly right.

**Give reviewers verified facts, never verdicts.** Handing over "I ran X and got Y, judge its significance" got sharper reviews than pre-judging would have. Never tell a reviewer what not to flag.

**Commit per task, with honest annotations.** Patch plan defects back into the plan file with a blockquote citing the evidence.

**Attribution:** main session signs `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Subagents sign as their own session reminder specifies (Sonnet). Commit examples inside the plan files are stale — ignore their attribution lines.

---

## Secrets

`.env` holds a **real `OPENAI_API_KEY`**. Gitignored, never staged, no key value in any commit — still true.

- Never print, echo, or `cat` its value; never paste the expansion into a command; never `git add .env`.
- `sk-`-shaped strings in the repo are deliberate fakes (`sk-contract-test-not-a-real-key`, `sk-should-not-appear`, `sk-alpha`/`sk-beta` in fileplane tests). Not leaks.
- One open question for Task 4, unanswered: `OpsResponse` returns `stdout` **raw**. `redactArgv` scrubs secret flags from `argv`, but nothing scrubs stdout — and `config.show`/`config.get` are both allowlisted. **If either prints a provider key, it crosses the S2 boundary unredacted.** I could not test it (stack was down). Carry it into Task 4 as a named risk.

I did check one adjacent worry and found nothing: Bun's Postgres errors do **not** echo the password (bad host/port → "Connection closed"; bad auth → "password authentication failed for user"), and every `buildArgv` throw carries param *names*, never values. So Task 4's catch-all returning `e.message` is not a confirmed leak. Recorded so nobody redoes it.

---

## Known open items

- **Task 9's `/space` git-seeding gap** — ruled (see #2 above) but **not implemented**. Still the guaranteed failure if written as drafted.
- **Task 4's raw-stdout question** — above.
- **Deferred minors** (ledger has both, final review should triage): `compose/initdb/01-extensions.sh` also installs extensions into the literal `postgres` maintenance DB under the production compose (idempotent, harmless); and no `package.json` script wires `test/integration`, though Task 15 invokes it directly.
- **Slice 0's wrong-pin nuance** still unclosed: the tripwire fires in `composeUp()`'s Docker build rather than through `version.contract.test.ts`'s runtime assertion.

---

## What not to do

- Don't fork gbrain, import past its `exports` map, read its tables directly, or screen-scrape human-readable CLI output.
- Don't run `gbrain autopilot --install` in a container — `lint:forbidden` catches it.
- Don't invoke `gbrain` through a shell string. Argv arrays only.
- **Don't weaken a test or gate to make it pass.** If it can't pass legitimately, that's a finding.
- Don't add a gate that can never pass on the developer's platform — a permanently-red gate trains people to ignore red.
- Don't trust an agent's report over the repo. Check `git log`, run the tests.

---

## Quick reference

| | |
|---|---|
| Project root | `C:\Users\juanp\Desktop\Company Brain` |
| gbrain reference (read-only) | `C:\Users\juanp\Desktop\gbrain` |
| Branch | `slice-1-deploy-one-brain` (base `fbd0e95`) |
| Working ledger (git-ignored) | `.superpowers/sdd/2026-09-14-slice-1-deploy-one-brain/progress.md` |
| Slice 1 plan (patched) | `docs/superpowers/plans/2026-09-14-slice-1-deploy-one-brain.md` |
| Progress doc | `docs/superpowers/plans/PROGRESS.md` |
| Slice 0 risk register | `docs/slice-0-findings.md` |
| Original spec | `C:\Users\juanp\.claude\plans\we-want-to-do-snug-wolf.md` |
| gbrain pin | `v0.50.0.0` (exact, never a moving tag) |
| Stack | `bun run stack:up` / `stack:down` |
| Scratch PG for fileplane tests | `docker run -d --name bs-fp-pg -e POSTGRES_USER=gbrain -e POSTGRES_PASSWORD=ci-not-a-real-secret -e POSTGRES_DB=control -p 5432:5432 pgvector/pgvector:pg16` |
