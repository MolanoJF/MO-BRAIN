# Support and version policy

## The supported version

Mobrain supports exactly one gbrain version per release:

| | |
|---|---|
| **Supported gbrain version** | **`0.50.5.0`** (the pin in `.env` and the image build `ARG`) |
| **Supported harness version** (agent runner only) | **`2.1.274`** |

"Supported" has a concrete meaning here. A version is supported when Mobrain's contract suite runs green against it (pinned-current), its deterministic upgrade playbook exists, and the images at its exact tag are the ones the installer pulls. Exact semver only — never a moving tag, never a range. A version that is not the supported pin is not supported, regardless of where upstream is.

## How upgrades land

Mobrain upgrades are **deterministic and host-driven**, never automatic and never agent-driven:

```bash
bun run scripts/upgrade.ts plan --to <exact-version>   # dry run, nothing touched
bun run scripts/upgrade.ts run  --to <exact-version> --yes
bun run scripts/upgrade.ts rollback --run <runId>       # one command back
```

Each upgrade is snapshot-first (both databases plus both volumes, with zero writers), swaps images, applies migrations and post-upgrade steps, applies a hand-written playbook for the version, and gates on `doctor` parity. Rollback is a snapshot restore, because upstream ships no reverse migrations. See [`docs/runbooks/upgrade.md`](runbooks/upgrade.md).

**Our cadence commitment: we target a supported Mobrain upgrade within 30 days of an upstream gbrain release tag.** That is a target for a small maintainer team at GA, not an SLA. The work between an upstream tag and our upgrade is not the downtime — the runbook's measured quiesce-and-swap window is about a minute on the `0.50.0.0 → 0.50.5.0` delta — it is authoring the version's deterministic playbook, extending the contract suite, and passing the upgrade gate. We would rather publish a supported upgrade late than promise one the lane cannot yet meet.

Two things make the target honest:

- **Nothing auto-upgrades.** The console's banner *offers* a candidate and a human selects it. A pending `awaiting_admin_decision` checklist item keeps the banner up and blocks nothing else.
- **The drift check runs when an upstream tag lands.** Dispatch `stack.yml` with `gbrain_version` set to the new tag (`gh workflow run stack.yml -f suite=contract -f gbrain_version=<tag>`); pinned-current `0.50.5.0` is the default when the input is blank. A drift finding is news, not a broken build, and it is what starts the clock on the next supported upgrade. There is no nightly cron (see `docs/runbooks/ci.md` for why).
- **The three pinned images stay publicly, anonymously pullable.** `scripts/ci/check-public-images.sh` runs a credential-less `docker pull` of `gbrain-base`, `control-plane`, and `agent-runner`, the same thing `scripts/install.sh` does for an external user. `release.yml`'s `verify-public` job runs it right after every publish and fails that release outright if any image isn't public. Visibility is a GitHub setting outside the release pipeline and can regress on its own (a manual toggle, or a package deleted and recreated, which defaults to private), so `release-verify.yml`'s `public` job runs the same check on demand.

## What this policy does and does not promise

**Promised:**

- The supported pin is tested by the full contract suite against the pinned version on every change and nightly.
- Upgrades move through the host lane only, with a snapshot in front and a one-command rollback behind.
- Security fixes land in the supported pin line; we do not maintain older pins.
- Version drift is detected nightly and surfaced rather than discovered by an operator mid-upgrade.

**Not promised:**

- **A fixed release window.** The 30-day target is a goal, not a deadline we contract to.
- **Support for arbitrary gbrain versions.** `--to` accepts any exact four-part version, but only versions with a shipped playbook and green contract tests are supported; `plan` refuses the rest.
- **In-place or automatic upgrades**, or any upgrade driven by the agent runner. An agent runner is never a path to an upgrade.
- **Compatibility with the pinned-next candidate.** It is built to tell us where upstream is going, and it is expected to fail sometimes.

## How to check where you are

```bash
# What the running binary actually reports (declared vs observed)
curl -sk https://<your-domain>/api/health

# What upstream offers (a candidate, not a decision). Admin-gated: this needs
# an admin session cookie, or read the banner on the console's /upgrades page.
curl -sk https://<your-domain>/api/upgrades/available -H 'cookie: <admin session>'
```

`/api/health`'s `pin.matches: true` means the running binary agrees with the declared pin; `.env` alone is not evidence. `/api/upgrades/available` reports `available`, `up_to_date`, or `unknown` — and **"unknown" means the check could not run, never "up to date."**

## Reporting a problem with a supported version

See [`SECURITY.md`](../SECURITY.md) for vulnerabilities. For a correctness problem against the supported pin, include the output of `/api/health` (which carries the pin and component states) and the failing command; the contract suite's own `MEASURED` lines are the fastest way to show what disagreed.
