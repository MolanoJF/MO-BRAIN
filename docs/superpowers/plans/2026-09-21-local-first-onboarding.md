# Local-first onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A solo user with no domain, no DNS and no cloud account runs `bash scripts/install.sh`, answers nothing about domains, and lands on a working brain reachable over HTTPS from any device on their LAN.

**Architecture:** One new variable, `INSTALL_MODE`, decides between two paths. `local` auto-detects the LAN IP, uses it as `DOMAIN`, forces `MOBRAIN_TLS_MODE=internal` (the Caddy self-signed-CA path that already exists in `compose/Caddyfile`) and skips preflight's DNS check. `domain` is today's path, byte-for-byte. Everything downstream — secrets, `.env` layout, pull, `up` — is identical. Separately, the wizard's Space step stops asking for a name it doesn't need.

**Tech Stack:** Bash (`scripts/*.sh`, `test/unit/*.test.sh`), TypeScript + React 19 (`src/console`), Bun test (`bun test test/unit`), Docker Compose + Caddy.

**Spec:** `docs/superpowers/specs/2026-09-21-local-first-onboarding-design.md` — read it alongside this plan.

---

## Context

`scripts/install.sh:55-62` prompts for a `DOMAIN` and **exits 2** if it is blank: *"A domain is required: Caddy obtains a TLS certificate for it."* `scripts/preflight.sh`'s `check_dns` then refuses (exit 15) unless that domain publicly resolves to the host. So the only supported install today is "buy a domain, point DNS at this box, open 443 to the internet" — there is no path for a person who just wants to point a browser at their own machine.

`MOBRAIN_TLS_MODE=internal` already gives Caddy a private CA instead of public ACME, and preflight already honors it (`preflight.sh:202-205`). But it was built as a *fallback inside domain-mode*: it still requires a `DOMAIN` value. This change promotes it to a standalone mode with its own auto-detected address.

The intended outcome: `bash scripts/install.sh` → press Enter at the domain question → `https://192.168.1.x` works from the laptop, the phone, and the tablet on the same network, with one expected certificate warning that the installer explains before the user sees it.

### Two decisions locked in before writing this plan

1. **The domain prompt moves *above* the preflight call.** Preflight currently runs first (`install.sh:51-53`), so `INSTALL_MODE` would not exist yet when `check_dns` needs it. A side benefit: today, in the interactive flow, `DOMAIN` is unset when preflight runs, so `check_dns` hits its `DOMAIN is not set yet; skipping` branch (`preflight.sh:213-216`) and the advertised DNS check **never actually fires for an interactively-typed domain**. After this change it does. The invariant that matters — preflight runs before the first `gen()`, so a host that can't run the stack never holds an `ENCRYPTION_KEY` — is preserved, and its test (`install.test.sh:95-104`) still passes.
2. **Docs are in scope.** README, `docs/runbooks/install.md` and `docs/product-overview.md` all present `DOMAIN=... bash scripts/install.sh` as the only way in. Task 4 fixes that.

## Global Constraints

Copied from the spec — every task's requirements implicitly include these.

- Domain-mode behavior is **unchanged**. `INSTALL_MODE` only changes what `DOMAIN` / `MOBRAIN_TLS_MODE` get set to and which preflight checks run.
- The env-var escape hatches (`DOMAIN`, `ENABLE_RUNNER`) that CI and automation callers already rely on keep working unchanged; `INSTALL_MODE=local` is a third one that skips the domain prompt entirely.
- No `compose/Caddyfile` change. Local mode reuses the existing `tls internal` directive path.
- No backend, route or schema change. `POST /wizard/space` still creates exactly one `kind: 'local-git'` Space with no remote (`src/control/routes/wizard.ts:172-207`, `src/ops/fileplane.ts:201-228`).
- Preflight's Docker / Compose / RAM / disk / port / project-identity checks run in **both** modes. Only the DNS check branches.
- Exit codes in `preflight.sh`'s header block (10–17) are a published contract — do not renumber or add to them.
- The exact local-mode prompt copy: `Domain for this brain (leave blank to just use this machine on your local network): `
- Out of scope (spec's non-goals): ingesting an existing folder into a Space, the domain-mode TLS/DNS path itself, multi-Space setup, remote-git/github Spaces, folding Connection creation into the wizard.

## Verification (whole plan)

Windows dev host — use Git Bash explicitly for the `.sh` suites:

```bash
"C:/Program Files/Git/bin/bash.exe" test/unit/preflight.test.sh
"C:/Program Files/Git/bin/bash.exe" test/unit/install.test.sh
bun test test/unit
bun test test/integration/wizard.test.ts
```

End-to-end, on a real Linux host with Docker (the only way to prove the claim):

```bash
rm -f .env
bash scripts/install.sh      # press Enter at the domain question
# expect: "installing for this machine only, reachable at https://<lan-ip>"
grep -E '^(DOMAIN|MOBRAIN_TLS_MODE|MOBRAIN_CADDY_TLS_DIRECTIVE)=' .env
curl -sk https://<lan-ip>/api/health    # 200, components.ops "ok"
```

Then open `https://<lan-ip>` **from a second device on the same LAN**, click through the certificate warning, create the first admin, and walk the wizard to `ready` — the Space step should show the notice, a checkbox and one **Continue** button, with no text inputs.

---

## File Structure

| File | Responsibility after this change |
|---|---|
| `scripts/install.sh` | Resolves `INSTALL_MODE` (+ LAN IP detection) before preflight; two final messages. |
| `scripts/preflight.sh` | `check_dns` gains an `INSTALL_MODE=local` skip branch, beside the existing internal-TLS one. |
| `test/unit/install.test.sh` | Local-mode cases; the "refuses to run without DOMAIN" case is replaced. |
| `test/unit/preflight.test.sh` | Asserts the DNS check is skipped under `local` and still refuses under `domain`. |
| `src/console/pages/Wizard.tsx` | `SpaceStep` posts fixed defaults; exports `FIRST_SPACE`. |
| `src/control/routes/wizard.ts` | `SOURCE_ID` becomes exported (test-visible contract). No behavior change. |
| `test/unit/wizard-space-step.test.ts` | **New.** The defaults are valid and the inputs are gone. |
| `README.md`, `docs/runbooks/install.md`, `docs/product-overview.md` | Local mode documented as the default path. |

---

### Task 1: `INSTALL_MODE` in the installer, and preflight's local branch

This is one task, not two: the preflight branch is unreachable until the installer exports the variable, and the installer's local mode is broken until preflight stops refusing. A reviewer gates them together.

**Files:**
- Modify: `scripts/install.sh:46-78` (the preflight call, the DOMAIN prompt, the TLS-mode block)
- Modify: `scripts/preflight.sh:30-35` (header comment), `scripts/preflight.sh:200-205` (`check_dns`)
- Test: `test/unit/install.test.sh`, `test/unit/preflight.test.sh`

**Interfaces:**
- Produces, for Task 2 and the tests:
  - `INSTALL_MODE` — `local` | `domain`. Exported before the preflight call.
  - `DOMAIN` — in local mode, the detected LAN IPv4 or the literal `localhost`. Exported.
  - `MOBRAIN_TLS_MODE` — forced to `internal` in local mode. Exported.
  - `MOBRAIN_FAKE_LAN_IP` — **test-only** override for LAN detection, same convention as `PREFLIGHT_FAKE_*`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing installer tests**

In `test/unit/install.test.sh`, **replace** the existing `--- refuses to run without DOMAIN` case (lines 58-61) — blank `DOMAIN` is now the local-mode entry point, not an error — with the block below, and append the remaining cases after it.

```bash
echo "--- a blank DOMAIN answer installs in local mode against the detected LAN IP"
# MOBRAIN_FAKE_LAN_IP pins detection: this suite runs on hosts where neither
# `hostname -I` nor `ip route` exists (Git Bash on Windows), and the case is
# about what local mode WRITES, not about how the address was found.
printf '\n' | MOBRAIN_FAKE_LAN_IP=192.168.1.50 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
  MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.local" bash scripts/install.sh >/dev/null 2>&1
if grep -q '^DOMAIN=192\.168\.1\.50$' "$work/.env.local" && \
   grep -q '^MOBRAIN_TLS_MODE=internal$' "$work/.env.local" && \
   grep -q '^MOBRAIN_CADDY_TLS_DIRECTIVE=tls internal$' "$work/.env.local"; then
  echo "PASS: local mode wrote the LAN IP and internal TLS"
else
  echo "FAIL: local mode did not write the LAN IP / internal TLS"; fail=1
fi

echo "--- INSTALL_MODE=local skips the prompt entirely (no stdin needed)"
INSTALL_MODE=local MOBRAIN_FAKE_LAN_IP=10.0.0.7 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
  MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.local2" bash scripts/install.sh </dev/null >/dev/null 2>&1
if grep -q '^DOMAIN=10\.0\.0\.7$' "$work/.env.local2"; then
  echo "PASS: INSTALL_MODE=local needs no stdin"
else
  echo "FAIL: INSTALL_MODE=local did not skip the prompt"; fail=1
fi

echo "--- local mode never refuses on DNS, with no PREFLIGHT_SKIP_DNS and a faked NXDOMAIN"
if INSTALL_MODE=local MOBRAIN_FAKE_LAN_IP=192.168.1.51 PREFLIGHT_FAKE_DNS=nxdomain \
   PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
   MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.local3" bash scripts/install.sh </dev/null >/dev/null 2>&1; then
  echo "PASS: local mode bypassed the DNS refusal"
else
  echo "FAIL: local mode still hit the DNS refusal"; fail=1
fi

echo "--- LAN detection falls back to a usable address with no fake set"
printf '\n' | PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
  MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.local4" bash scripts/install.sh >/dev/null 2>&1
detected=$(grep '^DOMAIN=' "$work/.env.local4" | cut -d= -f2-)
# Either a real address off this host, or the documented `localhost` fallback —
# never empty, which is what would silently produce a Caddyfile with no site.
if echo "$detected" | grep -qE '^(([0-9]{1,3}\.){3}[0-9]{1,3}|localhost)$'; then
  echo "PASS: detection produced '$detected'"
else
  echo "FAIL: detection produced '${detected:-<empty>}'"; fail=1
fi

echo "--- a non-blank DOMAIN answer is still domain mode, unchanged"
printf 'brain.typed.test\n' | PREFLIGHT_SKIP_DNS=1 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
  MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.typed" bash scripts/install.sh >/dev/null 2>&1
if grep -q '^DOMAIN=brain\.typed\.test$' "$work/.env.typed" && \
   grep -q '^MOBRAIN_TLS_MODE=public$' "$work/.env.typed"; then
  echo "PASS: a typed domain still takes the public-TLS domain path"
else
  echo "FAIL: a typed domain did not take the domain path"; fail=1
fi

echo "--- refuses INSTALL_MODE=local with an explicit MOBRAIN_TLS_MODE=public"
# Let's Encrypt does not issue for a bare LAN IP. Defaulting quietly to
# internal would hide the contradiction; refusing names it.
if INSTALL_MODE=local MOBRAIN_TLS_MODE=public MOBRAIN_FAKE_LAN_IP=192.168.1.52 \
   PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
   MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.contradiction" bash scripts/install.sh </dev/null >/dev/null 2>&1; then
  echo "FAIL: accepted local mode with public TLS"; fail=1
else
  echo "PASS: refused local mode with public TLS"
fi

echo "--- rejects an unrecognized INSTALL_MODE"
if INSTALL_MODE=sideways PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
   MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.badmode" bash scripts/install.sh </dev/null >/dev/null 2>&1; then
  echo "FAIL: accepted an invalid INSTALL_MODE"; fail=1
else
  echo "PASS: rejected invalid INSTALL_MODE"
fi

echo "--- INSTALL_MODE=domain with no DOMAIN still refuses"
if INSTALL_MODE=domain PREFLIGHT_SKIP_DNS=1 PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free \
   MOBRAIN_SKIP_UP=1 MOBRAIN_ENV_PATH="$work/.env.nodomain" bash scripts/install.sh </dev/null >/dev/null 2>&1; then
  echo "FAIL: domain mode ran without a DOMAIN"; fail=1
else
  echo "PASS: domain mode still requires a DOMAIN"
fi
```

Also add, near the other parse-the-script cases at the end of the file:

```bash
echo "--- INSTALL_MODE is exported before preflight runs (parse script; no Docker)"
mode_export=$(grep -n '^export INSTALL_MODE' scripts/install.sh | head -n1 | cut -d: -f1)
if [ -n "$mode_export" ] && [ -n "$preflight_line" ] && [ "$mode_export" -lt "$preflight_line" ]; then
  echo "PASS: INSTALL_MODE exported (line $mode_export) before preflight (line $preflight_line)"
else
  echo "FAIL: INSTALL_MODE export does not precede the preflight call"; fail=1
fi
```

- [ ] **Step 2: Write the failing preflight tests**

Append to `test/unit/preflight.test.sh`, before the final `echo PASS`:

```bash
# INSTALL_MODE=local means there is no public name to resolve — the "domain" is
# a bare LAN IP or `localhost`. The DNS check is skipped outright, and says so.
expect_code 0 "INSTALL_MODE=local DOMAIN=192.168.1.50 PREFLIGHT_FAKE_DNS=nxdomain PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free bash scripts/preflight.sh"
out=$(INSTALL_MODE=local DOMAIN=192.168.1.50 PREFLIGHT_FAKE_DNS=nxdomain PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free bash scripts/preflight.sh 2>&1 || true)
echo "$out" | grep -qi "INSTALL_MODE=local" || fail "the local-mode DNS skip does not name the mode that caused it"

# And the skip is local-mode ONLY: domain mode must still refuse the same input.
expect_code 15 "INSTALL_MODE=domain DOMAIN=nx.invalid PREFLIGHT_FAKE_DNS=nxdomain PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=free bash scripts/preflight.sh"

# Every other check is mode-independent: a local install on a too-small host is
# just as doomed as a domain one.
expect_code 12 "INSTALL_MODE=local PREFLIGHT_FAKE_RAM_MB=1024 bash scripts/preflight.sh"
expect_code 14 "INSTALL_MODE=local PREFLIGHT_FAKE_PORT_80=free PREFLIGHT_FAKE_PORT_443=busy bash scripts/preflight.sh"
```

- [ ] **Step 3: Run both suites to verify they fail**

```bash
"C:/Program Files/Git/bin/bash.exe" test/unit/preflight.test.sh
"C:/Program Files/Git/bin/bash.exe" test/unit/install.test.sh
```

Expected: `preflight.test.sh` fails on the first added `expect_code 0` (gets 15, the DNS refusal). `install.test.sh` prints FAIL for the local-mode cases (the installer exits 2 on a blank domain).

- [ ] **Step 4: Add the local branch to `check_dns`**

In `scripts/preflight.sh`, insert as the **first** branch inside `check_dns` (before the existing `MOBRAIN_TLS_MODE` check at line 202):

```bash
  # INSTALL_MODE=local (scripts/install.sh): there is no public name to check.
  # DOMAIN here is this host's own LAN address, or `localhost` — resolving it
  # publicly is not merely unnecessary, it is meaningless.
  if [ "${INSTALL_MODE:-domain}" = "local" ]; then
    warn "skipping the DNS check (INSTALL_MODE=local); this brain is reachable at ${domain:-this machine} on your own network and has no public name to resolve."
    return
  fi
```

And extend the header comment (`preflight.sh:30-35`) so the skip is documented where the others are:

```bash
# PREFLIGHT_SKIP_DNS=1 skips the DNS check outright; it prints a warning
# rather than passing silently. INSTALL_MODE=local (scripts/install.sh) implies
# the same skip, and so does MOBRAIN_TLS_MODE=internal: a domain that will
# never resolve publicly — or is not a domain at all, but this host's own LAN
# address — is exactly what those modes are for, so the DNS check would refuse
# the very thing they exist to allow. The image-pull check is network-bound,
# so it is off unless explicitly enabled with PREFLIGHT_SKIP_PULL=0.
```

- [ ] **Step 5: Add LAN detection and mode resolution to the installer**

In `scripts/install.sh`, **delete** the current `DOMAIN` prompt and TLS-mode blocks (lines 55-78) and insert the following **above** the preflight call at line 51 (i.e. immediately after `export COMPOSE_PROJECT_NAME`):

```bash
# The address a local-mode brain answers on. `hostname -I` first (its first
# field is the primary address on every distro that has it), then the source
# address the kernel would pick for an outbound route, then `localhost` — an
# unusual network namespace still gets a working single-machine install rather
# than an empty DOMAIN and a Caddyfile with no site name.
# MOBRAIN_FAKE_LAN_IP is TEST-ONLY, the same convention as preflight's
# PREFLIGHT_FAKE_*: it exists so the local path can be exercised on a host
# without either command, and must never be set in production.
lan_ip() {
  local ip=""
  if [ -n "${MOBRAIN_FAKE_LAN_IP:-}" ]; then printf '%s' "$MOBRAIN_FAKE_LAN_IP"; return; fi
  ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -n1)"
  if [ -z "$ip" ]; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*[[:space:]]src[[:space:]]\{1,\}\([0-9.]\{1,\}\).*/\1/p' | head -n1)"
  fi
  printf '%s' "${ip:-localhost}"
}

# Two installs, one question. A person with a domain answers it; a person who
# just wants their own machine on their own network presses Enter and is never
# asked about DNS, certificates or a cloud account. Same escape hatch as
# ENABLE_RUNNER below: a caller that already knows (CI, an automation script)
# pre-sets DOMAIN or INSTALL_MODE and no prompt fires.
INSTALL_MODE="${INSTALL_MODE:-}"
DOMAIN="${DOMAIN:-}"
if [ -z "$INSTALL_MODE" ] && [ -z "$DOMAIN" ]; then
  read -r -p "Domain for this brain (leave blank to just use this machine on your local network): " DOMAIN || true
fi
if [ -z "$INSTALL_MODE" ]; then
  if [ -n "$DOMAIN" ]; then INSTALL_MODE=domain; else INSTALL_MODE=local; fi
fi

MOBRAIN_TLS_MODE="${MOBRAIN_TLS_MODE:-}"
case "$INSTALL_MODE" in
  domain)
    if [ -z "$DOMAIN" ]; then
      echo "INSTALL_MODE=domain needs a DOMAIN: Caddy obtains a TLS certificate for it." >&2
      echo "Leave DOMAIN unset (or set INSTALL_MODE=local) to install for this machine only." >&2
      exit 2
    fi
    MOBRAIN_TLS_MODE="${MOBRAIN_TLS_MODE:-public}"
    ;;
  local)
    # Public ACME cannot issue for a bare LAN address, so `internal` is not a
    # default here, it is the only coherent answer — and an explicit `public`
    # is a contradiction worth naming rather than silently overriding.
    if [ -n "$MOBRAIN_TLS_MODE" ] && [ "$MOBRAIN_TLS_MODE" != "internal" ]; then
      echo "INSTALL_MODE=local always uses MOBRAIN_TLS_MODE=internal; got '${MOBRAIN_TLS_MODE}'." >&2
      echo "A public certificate authority will not issue for a LAN address. Set a DOMAIN for a public cert." >&2
      exit 2
    fi
    MOBRAIN_TLS_MODE=internal
    DOMAIN="$(lan_ip)"
    echo "No domain given; installing for this machine only, reachable at https://${DOMAIN} on your network." >&2
    ;;
  *)
    echo "INSTALL_MODE must be 'local' or 'domain', got '${INSTALL_MODE}'." >&2
    exit 2
    ;;
esac

# public (default in domain mode): Caddy requests a real cert from Let's
# Encrypt, which needs $DOMAIN publicly resolvable and reachable on 80/443.
# internal: Caddy issues from its own local CA instead (compose/Caddyfile's
# `tls internal`). In domain mode it is refused rather than defaulted, because
# silently downgrading to an untrusted cert would be worse than stopping.
# See docs/runbooks/install.md for the trust tradeoff.
case "$MOBRAIN_TLS_MODE" in
  public) CADDY_TLS_DIRECTIVE="" ;;
  internal) CADDY_TLS_DIRECTIVE="tls internal" ;;
  *)
    echo "MOBRAIN_TLS_MODE must be 'public' or 'internal', got '${MOBRAIN_TLS_MODE}'." >&2
    exit 2
    ;;
esac

# Exported so preflight reasons about the install that is actually happening:
# its DNS check needs all three to decide between refusing and skipping.
export INSTALL_MODE DOMAIN MOBRAIN_TLS_MODE
```

Leave the preflight call itself (`if [ "${SKIP_PREFLIGHT:-0}" != "1" ] ...`) exactly as it is, now sitting *after* this block. Its leading comment still holds and needs no edit — preflight still runs before any `gen()`.

- [ ] **Step 6: Run both suites to verify they pass**

```bash
"C:/Program Files/Git/bin/bash.exe" test/unit/preflight.test.sh
"C:/Program Files/Git/bin/bash.exe" test/unit/install.test.sh
```

Expected: `preflight.test.sh` prints `PASS`. `install.test.sh` prints only `PASS:` lines and exits 0 — including every pre-existing domain-mode case, which must not have regressed.

- [ ] **Step 7: Commit**

```bash
git add scripts/install.sh scripts/preflight.sh test/unit/install.test.sh test/unit/preflight.test.sh
git commit -m "feat(install): add local mode — no domain, LAN IP, internal TLS

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The final install message

**Files:**
- Modify: `scripts/install.sh:167-185` (the two closing `cat` blocks)
- Test: `test/unit/install.test.sh`

**Interfaces:**
- Consumes from Task 1: `INSTALL_MODE`, `DOMAIN`, `MOBRAIN_TLS_MODE`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/install.test.sh`. Note `MOBRAIN_SKIP_UP=1` exits at line 151-154, *before* the final message — so these cases must parse the script source, the same way the `--env-file` and pull-ordering cases above them do.

```bash
echo "--- local mode's closing message explains the certificate warning (parse script; no Docker)"
# The user WILL see a browser warning; an installer that doesn't say so first
# reads as a broken install. This copy is the spec's, not a paraphrase.
if grep -q 'from any device on your network' scripts/install.sh && \
   grep -q "private local CA, not a mistake" scripts/install.sh; then
  echo "PASS: local mode's closing copy is present"
else
  echo "FAIL: local mode's closing copy is missing"; fail=1
fi

echo "--- the domain-mode internal-TLS warning is gated to domain mode (parse script; no Docker)"
# Local mode prints its own, friendlier version of the same fact; printing the
# stern domain-mode block too would say it twice, the second time alarmingly.
if grep -q 'INSTALL_MODE" = "domain" \] && \[ "\$MOBRAIN_TLS_MODE" = "internal"' scripts/install.sh; then
  echo "PASS: the internal-TLS warning is domain-mode-gated"
else
  echo "FAIL: the internal-TLS warning is not gated on INSTALL_MODE"; fail=1
fi

echo "--- the /admin note is printed in both modes (parse script; no Docker)"
# A real security fact about the stack, not a domain-mode detail.
if [ "$(grep -c 'deliberately NOT routed' scripts/install.sh)" -eq 1 ]; then
  echo "PASS: the /admin note is printed once, outside the mode branch"
else
  echo "FAIL: the /admin note is duplicated into the mode branches or missing"; fail=1
fi
```

- [ ] **Step 2: Run it to verify it fails**

Run: `"C:/Program Files/Git/bin/bash.exe" test/unit/install.test.sh`
Expected: the three new cases print FAIL; everything from Task 1 still passes.

- [ ] **Step 3: Replace the closing messages**

In `scripts/install.sh`, replace lines 167-185 (the `Stack is up…` block and the `MOBRAIN_TLS_MODE=internal` block) with:

```bash
if [ "$INSTALL_MODE" = "local" ]; then
  cat <<EOF

Stack is up. Open https://${DOMAIN} from any device on your network and create
your first admin.

Your browser will warn about the certificate the first time — that's expected,
it's a private local CA, not a mistake. See docs/runbooks/install.md.
EOF
else
  cat <<EOF

Stack is up. Open https://${DOMAIN} and create your first admin.
EOF
fi

cat <<EOF

Note: https://${DOMAIN}/admin is deliberately NOT routed — gbrain's embedded
admin SPA is a second control plane with god rights over the same brain.
See docs/runbooks/break-glass.md for the recovery path.
EOF

# Domain mode only: in local mode the friendlier line above already said this,
# and the stern version would be the second time the user hears it.
if [ "$INSTALL_MODE" = "domain" ] && [ "$MOBRAIN_TLS_MODE" = "internal" ]; then
  cat <<EOF

MOBRAIN_TLS_MODE=internal: Caddy issued a certificate from its own local CA,
not a publicly trusted one. Browsers and API clients will show an untrusted-
certificate warning until you distribute and trust that CA yourself — this is
a real security-posture difference from a public cert, not a cosmetic one.
See docs/runbooks/install.md.
EOF
fi
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `"C:/Program Files/Git/bin/bash.exe" test/unit/install.test.sh`
Expected: all `PASS:`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh test/unit/install.test.sh
git commit -m "feat(install): local mode explains the cert warning before the browser does

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The wizard's Space step stops asking

**Files:**
- Modify: `src/console/pages/Wizard.tsx:152-180` (`SpaceStep`)
- Modify: `src/control/routes/wizard.ts:36` (export `SOURCE_ID`)
- Test: `test/unit/wizard-space-step.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Tasks 1-2. This is independent of install mode and applies to both.
- Produces:
  - `export const FIRST_SPACE: { readonly sourceId: 'my-brain'; readonly name: 'My Brain' }` from `src/console/pages/Wizard.tsx`
  - `export const SOURCE_ID: RegExp` from `src/control/routes/wizard.ts` (already exists at line 36 as a module-private `const`; only the `export` keyword is added)

**Why a source-parsing test:** this repo has no DOM test harness — there is no `@testing-library/react` and nothing imports `react-dom/server`. Console tests (`test/unit/console-app.test.ts`) assert **exported pure values** (`phaseFor`, `signInError`) instead, and the shell suites assert script structure by parsing the file. This test does both, in that established style. Do not add a DOM testing dependency for this.

- [ ] **Step 1: Write the failing test**

Create `test/unit/wizard-space-step.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { FIRST_SPACE } from '../../src/console/pages/Wizard.tsx';
import { SOURCE_ID } from '../../src/control/routes/wizard.ts';
import { readFileSync } from 'node:fs';

/**
 * Every org's first Space is just "mine" — there is no naming decision in it
 * worth a form. What IS worth a gate is the isolation notice: folders inside a
 * Space are not access boundaries, and that is informed consent, not naming.
 * So the defaults get filled in and the checkbox stays.
 */
describe('the wizard\'s first Space needs no name (S4b)', () => {
  test('the defaults are exactly what the spec fixes them at', () => {
    expect(FIRST_SPACE.sourceId).toBe('my-brain');
    expect(FIRST_SPACE.name).toBe('My Brain');
  });

  test('the default sourceId satisfies the server\'s own validator', () => {
    // POST /wizard/space answers 400 for anything this regex rejects. A default
    // the server refuses would make the step impossible to complete at all.
    expect(SOURCE_ID.test(FIRST_SPACE.sourceId)).toBe(true);
  });

  const source = readFileSync(
    new URL('../../src/console/pages/Wizard.tsx', import.meta.url), 'utf8',
  );
  const spaceStep = source.slice(source.indexOf('function SpaceStep'));

  test('SpaceStep renders no text inputs', () => {
    // The regression this guards: re-adding a "source id" field, which is the
    // thing a first-run user has no basis to answer.
    expect(spaceStep).not.toMatch(/placeholder=/);
    expect(spaceStep).not.toMatch(/type="text"/);
  });

  test('the isolation checkbox survives, and still gates the button', () => {
    expect(spaceStep).toMatch(/type="checkbox"/);
    expect(spaceStep).toMatch(/disabled=\{busy \|\| !acknowledged\}/);
    // and nothing else gates it — no leftover `|| !sourceId`
    expect(spaceStep).not.toMatch(/!sourceId/);
  });

  test('the button submits the fixed defaults', () => {
    expect(spaceStep).toMatch(/FIRST_SPACE/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/wizard-space-step.test.ts`
Expected: FAIL — `SyntaxError` / `undefined` on the `FIRST_SPACE` and `SOURCE_ID` imports, since neither is exported yet.

- [ ] **Step 3: Export `SOURCE_ID`**

In `src/control/routes/wizard.ts:36`, add the keyword only — the regex, and every use of it, is unchanged:

```ts
export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
```

- [ ] **Step 4: Rewrite `SpaceStep`**

In `src/console/pages/Wizard.tsx`, replace the whole `SpaceStep` function (lines 152-180) with:

```tsx
/**
 * The first Space of a brand-new brain needs no naming decision to be useful:
 * it is the org's own corpus and nothing else exists to tell it apart from.
 * Exported so the tests can assert the exact payload without a DOM.
 */
export const FIRST_SPACE = { sourceId: 'my-brain', name: 'My Brain' } as const;

function SpaceStep(
  { busy, notice, onSubmit }: { busy: boolean; notice: string; onSubmit: (b: unknown) => void },
) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Create your first Space</h2>
      <p className="text-sm text-muted">
        Your brain starts with one Space, <span className="font-mono">{FIRST_SPACE.sourceId}</span>.
        You can add more later.
      </p>
      {/* S4b: a blocking choice, not a tooltip. Naming went away; consent did not. */}
      <div className="card border-warning">
        <p className="text-sm">{notice}</p>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={acknowledged}
                 onChange={(e) => setAcknowledged(e.target.checked)} />
          I understand folders inside a Space are not access boundaries.
        </label>
      </div>
      <button className="btn-primary" disabled={busy || !acknowledged}
              onClick={() => onSubmit({ ...FIRST_SPACE })}>
        {busy ? 'Creating…' : 'Continue'}
      </button>
    </section>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test test/unit/wizard-space-step.test.ts
bun test test/unit
bunx tsc --noEmit
```

Expected: all pass. `tsc` matters here — removing the `sourceId` / `name` state leaves two now-unused `useState` bindings if the replacement was partial.

- [ ] **Step 6: Check the backend contract still holds**

Run: `bun test test/integration/wizard.test.ts`
Expected: unchanged and green. `POST /wizard/space` was not touched; this run proves it.

- [ ] **Step 7: Commit**

```bash
git add src/console/pages/Wizard.tsx src/control/routes/wizard.ts test/unit/wizard-space-step.test.ts
git commit -m "feat(wizard): first Space uses fixed defaults, keeps the isolation gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Documentation

The shipped prose currently presents a domain as mandatory. Leaving it would mean the product's headline path contradicts its own docs.

**Files:**
- Modify: `README.md:9-17` (Install), `README.md:39-48` (the preflight table's `DOMAIN` row)
- Modify: `docs/runbooks/install.md:5-45` (Before you start, The one command, non-interactive), `docs/runbooks/install.md:149-161` (Private-network install), `docs/runbooks/install.md:163-171` (Create the first admin)
- Modify: `docs/product-overview.md:84` (the install snippet)
- Create: plan copy at `docs/superpowers/plans/2026-09-21-local-first-onboarding.md`

**Interfaces:** consumes the exact copy and variable names produced by Tasks 1-2. No code.

- [ ] **Step 1: Copy this plan into the repo**

The repo keeps its plans beside their specs. Copy this file to `docs/superpowers/plans/2026-09-21-local-first-onboarding.md` verbatim, so the spec/plan pair travels with the code the way the existing slice plans do.

- [ ] **Step 2: README — lead with the no-domain path**

Replace the Install section's opening (lines 11-17) so the zero-configuration command is first and the domain command is the second option:

```markdown
Mobrain is deployed from a checkout of this repository, on the host that will run it. From the repository root:

```bash
bash scripts/install.sh
```

It asks one question. **Leave the domain blank** and Mobrain installs for this machine only: it detects the host's LAN address, issues a certificate from Caddy's own local CA, and the brain is reachable at `https://<lan-ip>` from any device on your network. Your browser warns about that certificate once — it is a private CA, not a broken install.

**Answer with a domain** you control and you get today's public path instead: Caddy obtains a real Let's Encrypt certificate, which needs that domain's A/AAAA record already pointing at this host.

```bash
DOMAIN=brain.acme-co.com bash scripts/install.sh
```

Either way the one command runs the preflight below, asks whether to enable the optional agent runner, generates the four secrets into a `.env`, pulls the pinned images, and brings the stack up with `docker compose up -d --wait`. When it finishes, open the URL it prints and create the first admin.
```

- [ ] **Step 3: README — the preflight table's DNS row**

Replace the `DOMAIN` row (line 47) so the table is true in both modes:

```markdown
| `DOMAIN` (domain mode only) | resolves to one of this host's addresses — not checked in local mode, which has no public name |
```

- [ ] **Step 4: `docs/runbooks/install.md` — prerequisites and the one command**

Replace the `DOMAIN` bullet (line 10) with:

```markdown
- **Either** a `DOMAIN` you control whose A/AAAA record already points at this host (Caddy obtains a real TLS certificate for it), **or** nothing at all — leave the domain blank and Mobrain installs against this host's own LAN address with a private certificate. (A port already held by *this* stack is not a conflict.)
```

Replace the "The one command" snippet (lines 18-20) with both forms, local first:

````markdown
```bash
bash scripts/install.sh            # local: this machine on your own network
DOMAIN=brain.acme-co.com bash scripts/install.sh   # domain: a public certificate
```
````

And rewrite the ordered list at lines 22-29, since step order changed — the domain question is now asked **before** preflight, so preflight can check the domain you actually typed:

```markdown
1. refuses if an `.env` already exists (delete it deliberately if you mean to reinstall — regenerating `ENCRYPTION_KEY` makes every stored secret unrecoverable);
2. reads `DOMAIN` from the environment, or asks for it — *"Domain for this brain (leave blank to just use this machine on your local network):"*. A blank answer selects **local mode**: the installer detects this host's LAN address (`hostname -I`, then the outbound route's source address, then `localhost`), uses it as `DOMAIN`, and forces `MOBRAIN_TLS_MODE=internal`. A non-blank answer selects **domain mode**, unchanged from previous releases;
3. runs preflight, and exits with the failing check's code if the host cannot run the stack. In domain mode this now includes the DNS check against the domain you just gave it; in local mode the DNS check is skipped and says so;
4. asks the runner question in plain words — *"This container runs model-written code against your brain, using your organization's API key, on a schedule, with nobody watching. Enable it? [y/N]:"* — unless `ENABLE_RUNNER` is already set in the environment, in which case it skips the prompt and uses that value directly. Either way, anything but an explicit yes (`y`/`yes`, case-insensitive — including EOF on a non-interactive install with neither variable set) leaves the runner **off**;
5. generates four independent secrets and writes `.env` at mode `600`;
6. pulls the pinned images from `${IMAGE_REGISTRY:-ghcr.io}/${IMAGE_NAMESPACE:-molanojf}` and runs `docker compose up -d --wait`.

Preflight still runs before a single secret is generated, so a host that cannot run the stack never ends up holding an `ENCRYPTION_KEY` it cannot use.
```

In "Running it non-interactively" (line 33), add after the existing `ENABLE_RUNNER=n DOMAIN=...` example:

````markdown
For a non-interactive **local** install, set `INSTALL_MODE=local` — it skips the domain prompt without needing a `DOMAIN`:

```bash
INSTALL_MODE=local ENABLE_RUNNER=n bash scripts/install.sh
```
````

- [ ] **Step 5: `docs/runbooks/install.md` — the private-network section**

At the top of "Private-network install (no public DNS)" (line 149), add a pointer so the two internal-CA paths are not confused:

```markdown
> If you have no domain at all, you want **local mode** — leave the domain prompt blank (or set `INSTALL_MODE=local`) and the installer does all of this for you against the host's LAN address. This section is for the different case: you *have* an internal hostname (`brain.internal.acme-co.lan`) that only resolves on your own network.
```

In the same section's explanation (line 159), note the other skip trigger: `INSTALL_MODE=local` skips the DNS check for the same reason, named in terms of the mode that is active.

- [ ] **Step 6: `docs/runbooks/install.md` — "Create the first admin"**

Replace the printed-output block (lines 167-169) with both, and add the second-device instruction that is the whole point of local mode:

````markdown
In domain mode:

```text
Stack is up. Open https://<DOMAIN> and create your first admin.
```

In local mode:

```text
Stack is up. Open https://<lan-ip> from any device on your network and create
your first admin.

Your browser will warn about the certificate the first time — that's expected,
it's a private local CA, not a mistake. See docs/runbooks/install.md.
```

In local mode that address works from the host itself and from any phone, tablet or laptop on the same network. The certificate warning appears once per device and per browser; clicking through is expected. To remove it, distribute Caddy's local CA root and trust it on each device — the same tradeoff described under [Private-network install](#private-network-install-no-public-dns).
````

The `curl -sk` verification below it already uses `-k` and needs no change.

- [ ] **Step 7: `docs/product-overview.md`**

At line 84, replace the single `DOMAIN=brain.acme-co.com bash scripts/install.sh` snippet with `bash scripts/install.sh` plus one sentence: the command asks for a domain, a blank answer installs against the machine's own LAN address, and a domain answer takes the public-certificate path. Leave line 281 (fleet provisioning over SSH) alone — that path legitimately uses domain mode.

- [ ] **Step 8: Verify the docs describe the software that exists**

Every command in the changed prose must actually run. From a Linux host with Docker:

```bash
grep -rn "install.sh" README.md docs/runbooks/install.md docs/product-overview.md
"C:/Program Files/Git/bin/bash.exe" test/unit/install.test.sh
```

Confirm no remaining sentence claims a domain is required, and that the copy quoted in the runbook matches `scripts/install.sh` verbatim (the Task 2 test asserts the installer's side; this is the docs' side).

- [ ] **Step 9: Commit**

```bash
git add README.md docs/runbooks/install.md docs/product-overview.md docs/superpowers/plans/2026-09-21-local-first-onboarding.md
git commit -m "docs: local-first install is the default path

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Notes for the executor

- **`hostname -I` does not exist on macOS or Git Bash for Windows.** That is expected and handled: detection falls through to `ip route get`, then to `localhost`. A Windows dev host running the suite will exercise the `localhost` fallback, which is why the fake exists for the cases that are about what gets *written*.
- **`printf '\n' | bash scripts/install.sh` is how a blank answer is delivered** in tests. `</dev/null` gives `read` an EOF, not an empty line — both land in local mode here (`DOMAIN` stays empty either way), but keep the two distinct so the cases keep meaning what they say.
- **A fixed `sourceId` makes the wizard's 409-duplicate path reachable only on a re-run.** It is not a regression: `wizard.ts:192-202` seeds the repo and calls `sources.add` *before* the DB insert, so a failed create leaves no row and a retry succeeds; a *successful* create advances the lifecycle past `sources-added`, so the step is not shown again. The 409 error still surfaces in the wizard's error banner if it ever fires. No new handling is needed — do not add any.
- **Do not renumber preflight's exit codes.** The 15 (DNS) case is skipped in local mode, not repurposed.
