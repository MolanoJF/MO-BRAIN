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
| `gbrain-base` | `0.50.5.0` | `ghcr.io/molanojf/gbrain-base@sha256:9cd9ba37fe4feb78116ca70cfa91c2b8007d5a28ef934fb44261bd0858e4c7e4` |
| `control-plane` | `1.0.0` | `ghcr.io/molanojf/control-plane@sha256:67dbd8f492a5420e345e9e81879085e3c6b3a99cd811387e668068886bd8570c` |
| `agent-runner` | `2.1.274` | `ghcr.io/molanojf/agent-runner@sha256:d02d1e8452d73a2de95e39df4841e55896b123caaae5f45807acdba31ed14b6f` |

Licence: MIT (this repository and its images; gbrain is MIT, © 2026 Garry Tan, and the gbrain base image
ships his `LICENSE` at `/opt/gbrain-LICENSE`). See [`LICENSE`](LICENSE) and
[`docs/support-policy.md`](docs/support-policy.md).
