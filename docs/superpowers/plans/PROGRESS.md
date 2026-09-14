# Execution Progress

**Resume here.** Single source of truth for what is done, blocked, and next. Update after every task.

**Plans:** [roadmap](./2026-09-14-brainstand-roadmap.md) · [Slice 0](./2026-09-14-slice-0-cli-lane-proof.md) · [Slice 1](./2026-09-14-slice-1-deploy-one-brain.md)
**Executing:** Slice 0 — Prove the CLI Lane
**Branch:** `main` (fresh repo, nothing to isolate from — no worktree)
**Executor:** Sonnet subagents, one task per dispatch, every result verified independently by the main session.

---

## BLOCKER — Docker is not installed

Checked 2026-09-14. All three true:

- No Docker Desktop at `C:\Program Files\Docker\Docker\`
- `docker` not on PATH in PowerShell or Git Bash
- WSL broken: `wsl --status` → `Class not registered (REGDB_E_CLASSNOTREG)`

**Slice 0's entry gate is `docker compose version`.** Until it passes, Tasks 5–10, 12 and 13 cannot run, and the Docker-dependent halves of 1, 2, 4 and 11 stay unverified.

**To unblock:** install Docker Desktop for Windows (its installer normally repairs WSL), then:

```bash
docker compose version
```

Then work the `BLOCKED` rows below in numeric order.

---

## Task status — Slice 0

`DONE` · `PARTIAL` (pure half done, Docker half pending) · `BLOCKED` · `TODO`

| # | Task | Status | Commit | What remains |
|---|---|---|---|---|
| 1 | Repo scaffold + pinned base image | PARTIAL | `f0c59c8` | Step 7 `bun run test:build` — needs Docker. **The pin gate is unverified.** |
| 2 | Slice 0 compose (postgres + ops) | PARTIAL | `84e2e42` | Steps 3–4: run `stack.contract.test.ts` — needs Docker |
| 3 | Typed exec layer (argv + redaction) | **DONE** | `d7526f4` | — 11/11 unit tests pass. Includes Task 5 Step 4's positional support, folded forward. |
| 4 | Docker host helper + pin tripwire | PARTIAL | `94185b5` | Steps 2, 6: run `version.contract.test.ts` — needs Docker |
| 5 | `init` contract (V3, V4) | BLOCKED | | **Highest-value proof in the slice.** Note its Step 4 is already done (see Task 3). |
| 6 | `config` plane contract (V11) | BLOCKED | | |
| 7 | `auth` contract (V2, V7) | BLOCKED | | |
| 8 | `mcp grant` contract (V2, V8) | BLOCKED | | |
| 9 | `doctor` + supervisor exit codes (V5, V6) | BLOCKED | | |
| 10 | Discovery contracts (V12–V14) | BLOCKED | | |
| 11 | Capability snapshot + drift diff | PARTIAL | `75a59f1` | `captureCapability()` untested — needs a running stack. 9/9 pure diff tests pass. |
| 12 | Scripted tutorial end-to-end | BLOCKED | | The headline exit gate |
| 13 | Emit `operations.json` | BLOCKED | | Needs the registry populated by Tasks 5–10. **Slice 1 cannot start without this artifact.** |
| 14 | Repo guards + CI + findings doc | PARTIAL | `127c8c7` | `test:contract` in CI unrunnable until Docker. **`docs/slice-0-findings.md` is an empty template — its 13 V-rows are filled by Tasks 5–12.** |

### Additional commits (plan defects found during execution)

| Commit | Fix |
|---|---|
| `a596c2a` | `tsconfig.json` missing `allowImportingTsExtensions` — every `.ts`-suffixed import failed `tsc --noEmit` under TS5097 |
| `8ff7aef` | `.gitattributes` forcing LF — `core.autocrlf=true` would rewrite `01-extensions.sh` to CRLF and its shebang would fail inside the Linux postgres container |
| `127c8c7` | `lint-forbidden` scanned `docs/`, so every plan file tripped every rule; added `'docs'` to `SKIP_DIRS` + a regression test. Also tightened the `shell-string-gbrain` regex, which matched any `sh -c` merely mentioning a `/srv/gbrain-home` path |

**All three are fixed in the plan files too**, so a fresh execution from scratch will not hit them.

---

## Current verification state

Runnable without Docker, all passing as of last check:

```bash
bun run lint:forbidden     # clean
bun run test:unit          # 26 tests (11 argv + 9 capability + 6 lint-forbidden)
bunx tsc --noEmit          # clean, exit 0
```

Not runnable: `bun run test:build`, `bun run test:contract`, `bun run tutorial`, `bun run stack:up`.

---

## Slice 0 exit gate

- [ ] `bun run tutorial` completes unattended, `doctorExitCode: 0`, `isolationOk: true`
- [ ] `bun run test:contract` passes at the pin and is **red** on a wrong pin
- [ ] `contracts/v0.50.0.0/operations.json` + `capability.json` committed
- [ ] `docs/slice-0-findings.md` has a status on every V-row

## Slice 1

Not started. Entry gate: Slice 0 exit gate green + `contracts/v0.50.0.0/operations.json` committed. 15 tasks.

---

## Session log

- 2026-09-14 — Plans written (roadmap + Slice 0 + Slice 1). Self-review found 3 gaps: host-side `OPS_RPC_URL`, `execOperation` misuse inside the ops container, git multi-writer contention (new Slice 1 Task 14).
- 2026-09-14 — `git init` on the project root, branch `main`.
- 2026-09-14 — Docker confirmed absent. Scoped execution to the Docker-independent subset.
- 2026-09-14 — Tasks 1, 2, 3, 4, 11, 14 executed. Three plan defects found and fixed in both repo and plan. Subagent correctly halted Task 14 at the lint finding rather than loosening the rule.
- 2026-09-14 — **Docker-independent work is COMPLETE.** 8 commits. `lint:forbidden` clean, 26/26 unit tests, `tsc --noEmit` clean. Everything further needs Docker.
