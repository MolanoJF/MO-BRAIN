# Handoff — read this first

Written 2026-09-15, end of the session that completed Slice 0.

---

## What this project is

**brainstand** (codename — rename before any public artifact) wraps [gbrain](https://github.com/garrytan/gbrain) — a 415K-LOC Bun/TypeScript knowledge system — into a product a team deploys with one `docker compose up` and operates from a web console.

The whole strategy rests on one bet: **gbrain is a pinned upstream dependency driven only through its published contracts. Never forked.** Its CLI is the control lane, its HTTP MCP is the data lane, and a small file plane covers what `config set` refuses. If you find yourself editing gbrain's source or reading its tables directly, stop — that's the failure mode this design exists to prevent.

`C:\Users\juanp\Desktop\gbrain` is a **read-only reference checkout**. Read it freely to diagnose behavior. Never edit it.

---

## Where things stand

**Slice 0 is COMPLETE.** 25 commits on `main`, clean tree, HEAD `5ec3602`.

Slice 0's job was to prove — in Docker, against real Postgres, at an exact pin, with zero human interaction — that every control-plane operation the product needs is actually reachable. It does. The headline: `gbrain init --non-interactive` works headlessly against Postgres (this was make-or-break), and the whole 90-minute company-brain tutorial now runs unattended in **39 seconds**.

**Slice 1 has not started. Its entry gate is met.**

Read these two before doing anything:

1. [`docs/superpowers/plans/PROGRESS.md`](docs/superpowers/plans/PROGRESS.md) — task-by-task state, exit-gate results, environment notes.
2. [`docs/slice-0-findings.md`](docs/slice-0-findings.md) — **the risk register Slice 0 existed to produce.** 13 verified constraints with evidence, and the ones that change later slices.

Then [`docs/superpowers/plans/2026-09-14-slice-1-deploy-one-brain.md`](docs/superpowers/plans/2026-09-14-slice-1-deploy-one-brain.md) — 15 tasks, already patched with three Slice-0 findings.

---

## First moves in a new session

**1. Start Docker Desktop.** Its daemon does not survive a reboot and must be launched manually. Until it is, every Docker command fails with `failed to connect to the docker API at npipe:...`.

**2. Check whether you need the PATH workaround.**

```bash
docker compose version
```

If that fails but Docker Desktop is running, your session's environment predates the Docker install. Prefix every Docker-touching shell call with:

```bash
export PATH="/c/Users/juanp/AppData/Local/Programs/DockerDesktop/resources/bin:$PATH"
```

A freshly started session should not need this — the directory is already in the user PATH. **Subagents inherit the parent session's environment, so if you need it, they do too — put it in their prompt.**

**3. Bring the stack up and confirm the baseline still holds.**

```bash
bun run stack:up
```

```bash
bun run lint:forbidden && bun test test/unit && bunx tsc --noEmit && bun test test/contract
```

Expect: lint clean · 41 unit · 45 contract across 9 files · `tsc` clean. The contract suite takes ~3 minutes; that's normal, each `beforeAll` resets and re-inits the brain.

If the contract suite is red, **diagnose before touching anything** — the stack's Postgres volume persists between sessions, so state drift is the first thing to suspect.

---

## Working conventions established this session

These were set by the user and proved their worth. Keep them.

**Execution goes to Sonnet subagents; the main session orchestrates and verifies.** One task per dispatch. The Agent tool has a `model` parameter but **no reasoning-effort parameter** — effort comes from the agent definition's frontmatter, so compensate with tightly-specified prompts.

**Verify every subagent claim independently.** This is not ceremony. One agent reported a build fix as working when its own first attempt would have produced a permanently-passing fake gate; it caught that only by testing the failure path. Another's test count didn't match what its file actually contained. Re-run the command yourself.

**Subagents start cold.** Give them: project root, plan file path, the PATH export, what's already done (so they don't redo it), what's explicitly out of scope, and the secret-handling rules. A vague prompt costs a full round trip.

**Tell subagents to stop rather than weaken a gate.** The single most valuable moment this session: an agent hit a failing lint rule, and instead of quietly adding an exclusion, it halted and reported — which kept the judgment call where it belonged. Put that instruction in every prompt.

**Commit per task, with honest annotations.** When a step was skipped, say so in the commit message.

**Attribution:** the main session signs `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Subagents sign as whatever their own session reminder specifies (Sonnet). Don't copy attribution lines out of the plan files — those examples are stale.

---

## Secrets

`.env` holds a **real `OPENAI_API_KEY`**. It is gitignored, was never staged, and no key value appears in any commit — verified. Keep it that way:

- Never print, echo, or `cat` its value; never paste the expansion into a command.
- Never `git add .env`.
- The compose passes it into `gbrain-ops` as `OPENAI_API_KEY: ${OPENAI_API_KEY:-}`; gbrain reads it ambiently, so it never reaches a command line.
- Two `sk-` strings DO appear in git history — `sk-contract-test-not-a-real-key` and `sk-should-not-appear`. Both are deliberate fixtures in the plans' own test code. Not leaks.

---

## The most important lesson from Slice 0

**Executing the plan found ~20 defects in the plan.** Not typos — factual errors about how gbrain actually behaves. A sample:

- `gbrain --version` prints `gbrain 0.50.0.0`, not a bare version, which broke the pin gate and three call sites.
- `gbrain config list` doesn't exist; it's `config show`.
- `schema list` silently *ignores* `--json` and always prints prose.
- `sources add` doesn't support `--json` at all.
- The pinned image has no `curl` or `wget`.
- `doctor --json` has no `blockers` key in this version — the upgrade gate I designed around it was checking a field that isn't there.

**Every one was fixed in both the repo and the plan file**, so a fresh run from scratch hits none of them. Expect Slice 1 to behave the same way. When reality contradicts the plan: diagnose against the read-only gbrain source, fix the *expectation*, patch the plan file with a short blockquote citing evidence, and report it. Do not bend reality to match the document.

---

## Known open gaps for Slice 1

**Resolve this one early — it's a guaranteed failure as written:**

> Slice 1 Task 9's `/space` handler calls `sources.add` against a path that was never `git init`'d or committed. V12 proves that fails. It needs a file-plane primitive to seed and commit the repo first. Flagged in the Slice 1 plan, deliberately not silently patched.

Also carried forward into Slice 1's plan already:

- `/api/wizard/schema-packs` must parse prose, not JSON (`schema list` ignores `--json`).
- Provider-key routing needs to be deliberate — the compose passthrough added in Slice 0 was a Slice-0 expedient; Slice 1 moves keys to the file plane under an advisory lock.

**One caveat on Slice 0's own result:** the wrong-pin tripwire does go red, but the failure fires in `composeUp()`'s Docker build rather than through `version.contract.test.ts`'s runtime assertion, which never gets to run. That assertion only becomes the operative gate when a stale image is already tagged with the wrong pin — a case not yet exercised. Worth closing when convenient.

---

## What not to do

- Don't fork gbrain, import past its `exports` map, read its tables directly, or screen-scrape human-readable CLI output.
- Don't run `gbrain autopilot --install` in a container — `lint:forbidden` will catch it.
- Don't invoke `gbrain` through a shell string. Argv arrays only; the linter enforces this.
- Don't weaken a test or gate to make it pass. If it can't pass legitimately, that's a finding.
- Don't skip the `docs/` exclusion in `lint-forbidden` — planning documents necessarily quote the patterns they forbid.
- Don't trust an agent's report over the repo. Check `git log`, run the tests.

---

## Quick reference

| | |
|---|---|
| Project root | `C:\Users\juanp\Desktop\Company Brain` |
| gbrain reference (read-only) | `C:\Users\juanp\Desktop\gbrain` |
| Original spec | `C:\Users\juanp\.claude\plans\we-want-to-do-snug-wolf.md` |
| gbrain pin | `v0.50.0.0` (exact, never a moving tag) |
| Stack | `bun run stack:up` / `stack:down` |
| Contract artifacts | `contracts/v0.50.0.0/{operations.json,capability.json}` |
| Slice 1 entry gate | **MET** |
