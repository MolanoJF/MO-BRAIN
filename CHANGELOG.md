# Changelog

Notable changes to **Mobrain**. Versions are the product's `APP_VERSION`; images publish from CI to
`ghcr.io/molanojf` (the only GHCR owner available; the product name is not a registry namespace). Full
provenance — every `U*`, `P*` and `F*` — is in [`docs/slice-5-findings.md`](docs/slice-5-findings.md).

## [1.0.0] — 2026-09-19

Mobrain 1.0.0 is the first **self-host GA** release: a team can install the product on a clean host with
`scripts/install.sh`, reach a healthy console, and operate it from the web console. gbrain is pinned and
never forked (`0.50.5.0` via the exact build `ARG`), the agent harness is pinned at `2.1.274`, and the
three images publish to GHCR at exact tags. This release closes Slice 5: the install is proven on a
runner that has never seen the repository (Gate A), the backup lane verifies its own quiesce through the
`compose exec` relay on a production-shaped stack, the Spend page states its own coverage and carries
gbrain's `notCovered` list verbatim, a new-domain restore invalidates every Connection and raises the
member-facing alerts, the nightly drift tripwire opens one issue per drifting version, and the upgrades
lane still passes Slice 3.5's rollback gate on the renamed, re-published stack. The eight verification
commands are green, e2e twice consecutively, with verbatim tails in `PROGRESS.md`. Managed cloud and
billing are deliberately **not** in this release; the substrate decision (D12: one VM per tenant,
provisioned through a cloud provider API, installed with this release's own `install.sh` over SSH) is
recorded, and managed-cloud pricing (Open Question 2) remains open.

**A release is its digests, not its tag.** The tag `v1.0.0` is a label someone can move; these three
`RepoDigest`s are the immutable artifacts, published by the `publish` job of the
[`contract` workflow](.github/workflows/contract.yml) and verified from a fresh runner by
[`release-verify.yml`](.github/workflows/release-verify.yml).

| Image | Tag | RepoDigest |
|---|---|---|
| `gbrain-base` | `0.50.5.0` | `ghcr.io/molanojf/gbrain-base@sha256:83c6e585681be27a15fa476b7307991ef0fb5334c92175686831008c60bfca0e` |
| `control-plane` | `1.0.0` | `ghcr.io/molanojf/control-plane@sha256:e6d9ecab9ce59f3762364098c12be850a12e743428db33fcdca62e0849e1a2ba` |
| `agent-runner` | `2.1.274` | `ghcr.io/molanojf/agent-runner@sha256:55372d5e8b80277c55004a14d9fe0db2ac35dc1f94ed5c83a2897b935e80e950` |

Licence: MIT (this repository and its images; gbrain is MIT, © 2026 Garry Tan, and the gbrain base image
ships his `LICENSE` at `/opt/gbrain-LICENSE`). See [`LICENSE`](LICENSE) and
[`docs/support-policy.md`](docs/support-policy.md).
