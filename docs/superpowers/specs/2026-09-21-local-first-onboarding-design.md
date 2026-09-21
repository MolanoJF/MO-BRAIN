# Local-first onboarding — design

**Goal:** A solo user with no domain, no DNS, and no cloud account should be able to run
`bash scripts/install.sh` on their own machine, answer nothing about domains, and land on a
working brain reachable from any device on their LAN over HTTPS. A user who *does* have a
domain should still be able to opt into today's real-TLS path with one answer.

**Problem today:** `scripts/install.sh` unconditionally prompts for and requires a `DOMAIN`
(`scripts/install.sh:55-65`), and `preflight.sh` refuses to proceed unless that domain
publicly resolves to the host. There is no path for someone who just wants to point a browser
at their own machine. `compose/Caddyfile` already supports a self-signed local CA via
`MOBRAIN_TLS_MODE=internal` as an alternative to public Let's Encrypt, but that mode still
requires a `DOMAIN` value to be set — it was built as a fallback within domain-mode, not as a
standalone local-mode.

**Non-goals (explicitly out of scope for this design):**
- Ingesting an existing folder of files into a Space during onboarding. The wizard's
  `/wizard/space` route (`src/control/routes/wizard.ts:172-207`) creates a brand-new *empty*
  local-git Space today (`seedSpaceRepo`, `src/ops/fileplane.ts:201-228` — `git init` plus one
  README commit, no remote). This design keeps that behavior; "point me at my notes folder" is
  a separate, later feature.
- Anything about the domain-mode TLS/DNS path itself — it is unchanged.
- Multi-Space setup, remote-git Spaces (`kind: 'remote-git'`/`'github'`), or third-party
  integrations. All exist in the schema/CLI contract already but are not part of this flow.

---

## 1. Install script (`scripts/install.sh`)

The `DOMAIN` prompt changes from required to optional:

> "Domain for this brain (leave blank to just use this machine on your local network): "

- Blank input → `INSTALL_MODE=local`.
- Non-blank input → `INSTALL_MODE=domain` (today's existing path, byte-for-byte unchanged).

The `DOMAIN` and `ENABLE_RUNNER` env-var escape hatches installers already honor (for CI /
automation callers that pre-set `DOMAIN` before running the script) continue to work
unchanged; a caller can also set `INSTALL_MODE=local` directly to skip the prompt entirely.

**In local mode, before bringing the stack up, install.sh:**
1. Auto-detects the LAN IP: try `hostname -I` (take the first address), fall back to
   `ip route get 1.1.1.1` parsed for the `src` field, fall back to the literal string
   `localhost` if both fail to produce an address (e.g. an unusual network namespace).
2. Sets `DOMAIN=<detected-address>` and `MOBRAIN_TLS_MODE=internal` in the generated `.env`
   (reusing the Caddy self-signed-CA path that already exists — no `compose/Caddyfile` change
   needed).
3. Skips the public-DNS-resolution preflight check entirely (see §2).

Everything downstream of that point (secret generation, image pull, `docker compose up`) is
identical between the two modes — `INSTALL_MODE` only changes what `DOMAIN`/`MOBRAIN_TLS_MODE`
get set to and which preflight checks run.

## 2. Preflight (`scripts/preflight.sh`)

Add an `INSTALL_MODE` branch around the existing DNS-resolution check: when `local`, that
check is skipped outright (there is nothing to resolve — the "domain" is a bare IP or
`localhost`). Docker version, RAM, disk, and port-availability checks are unaffected and run
in both modes — they're just as relevant on a home machine as a VM.

## 3. Final install message

Local mode prints:

> "Stack is up. Open https://\<lan-ip\> from any device on your network and create your first
> admin. Your browser will warn about the certificate the first time — that's expected, it's a
> private local CA, not a mistake."

Domain mode's existing message (`scripts/install.sh:169-179`) is unchanged.

## 4. Wizard's Space step (`src/console/pages/Wizard.tsx` — `SpaceStep`, lines 152-180)

Today `SpaceStep` requires the user to type a `sourceId` and display name before it will
`POST /wizard/space`. Since every org's very first Space needs no meaningful naming decision
to be useful, this step changes to auto-fill and submit defaults instead of collecting them:

- `sourceId: "my-brain"`, `name: "My Brain"`.
- The isolation-notice checkbox (the "I understand folders inside a Space are not access
  boundaries" acknowledgment) stays — it's informed consent, not naming, and stays required.
- The step becomes: isolation notice → checkbox → "Continue" button → posts the two fixed
  defaults to `/wizard/space`.

No backend, route, or schema change: `POST /wizard/space` still creates exactly one
`kind: 'local-git'` Space with no remote, exactly as it does today (`wizard.ts:172-207`,
`fileplane.ts:201-228`). This applies regardless of install mode (local or domain) — it's a
general simplification to the first-run Space step, not local-mode-specific.

## 5. Connection step

Unchanged in scope from today's wizard order — search mode → schema pack → Space (now
auto-filled) → finish. The existing `/connect` page remains where a member wires up their own
agent; this design does not fold Connection creation into the wizard itself, since the wizard
doesn't touch that route today and doing so would be new scope beyond what this spec covers.

---

## Testing

- `test/unit/install.test.sh`: add cases for `INSTALL_MODE=local` (blank `DOMAIN` input →
  LAN-IP detection path taken, `MOBRAIN_TLS_MODE=internal` set, DNS-resolution preflight not
  invoked) alongside the existing domain-mode cases.
- `preflight.sh` unit tests: confirm the DNS-resolution check is skipped under
  `INSTALL_MODE=local` and still runs under `INSTALL_MODE=domain`.
- Wizard: a test asserting `SpaceStep` posts the fixed `sourceId`/`name` defaults without
  rendering input fields, and that the checkbox gate still blocks submission until checked.
