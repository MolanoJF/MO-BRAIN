# Changelog

Notable changes to **Mobrain**. Versions are the product's `APP_VERSION`; images publish from CI to
`ghcr.io/molanojf` (the only GHCR owner available; the product name is not a registry namespace). Full
provenance — every `U*`, `P*` and `F*` — is in [`docs/slice-5-findings.md`](docs/slice-5-findings.md).

## [Unreleased]

Custom schema packs. An org admin can now define their brain's own ontology — page types, the folders
they file into, and the link verbs between them — three ways that all share one `PackDraft` shape:
design it in the console's Schema page, paste a draft into "Import draft", or have an agent draft it
with the new `mobrain-schema-designer` skill, which only ever produces JSON for a human to import. The
REST API is the only writer: it is admin-gated and audited (shape only, never a manifest body), it
writes a created pack as `pack.json` through gbrain's file plane, and it edits an existing pack only
through gbrain's atomic, lint-gated mutation batch. A pack is created but not activated; applying it
ends with a gbrain `schema active` readback rather than a claim of success. gbrain never created
directories from a pack, so Mobrain now does: on wizard finish, on apply, when a Space joins a ready
brain, and when a mutation adds a type, every Space resolving the pack gets one `README.md` per page
type — create-only, idempotent, one commit per Space, and never indexed because `README.md` is a
gbrain metafile. `schema sync` stays additive: it fills blank types and never reclassifies. Bundled
packs remain read-only; fork one to edit it. The S7 authoring probes that pinned this behaviour at
gbrain 0.50.5.0 are in [`docs/schema-pack-findings.md`](docs/schema-pack-findings.md).

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
[`release` workflow](.github/workflows/release.yml) (tag/release-triggered — an ordinary push to `main`
does not publish) and recorded in the
[v1.0.0 GitHub Release](https://github.com/MolanoJF/mobrain/releases/tag/v1.0.0), then verified from a
fresh runner by [`release-verify.yml`](.github/workflows/release-verify.yml).

| Image | Tag | RepoDigest |
|---|---|---|
| `gbrain-base` | `0.50.5.0` | `ghcr.io/molanojf/gbrain-base@sha256:3a96e62b64e1a007a07d5bf42e0d778786c7af6fb762b8bf118626db102dead1` |
| `control-plane` | `1.0.0` | `ghcr.io/molanojf/control-plane@sha256:a327595c357026322cbe7021771db99ad6be04a0589c60d554433e9043dc33e9` |
| `agent-runner` | `2.1.274` | `ghcr.io/molanojf/agent-runner@sha256:1727ee16b9f5d97f567d75a6893fa63e30d1301a8c126b2332b06837aa9b016b` |

Licence: MIT (this repository and its images; gbrain is MIT, © 2026 Garry Tan, and the gbrain base image
ships his `LICENSE` at `/opt/gbrain-LICENSE`). See [`LICENSE`](LICENSE) and
[`docs/support-policy.md`](docs/support-policy.md).
