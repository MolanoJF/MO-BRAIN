# Slice 5 findings — self-host GA

> **In progress.** Opened by Task 2 of
> `docs/superpowers/plans/2026-09-18-slice-5-self-host-ga.md`. Probes **P\***,
> upstream facts **U\*** and defects **F\*** are appended here as each task runs.

Status vocabulary: `confirmed` (the claim held as written) | `contradicted` (reality differed, and the
correction is named here) | `inference` (no artifact carries the observation; stated as such, never dressed
up as a measurement).

| # | Claim | Status |
|---|---|---|
| P1 | On a production-shaped stack (base compose file only, no published ops port) the backup verifies its quiesce through the `compose exec` relay | `confirmed` |
| P2 | Making the compose project name a variable with the legacy value as default leaves the live stack's volume names unchanged | `confirmed` |
| P3 | After the Task 4 rename the live stack's `secrets` rows still decrypt under the frozen `brainstand-kek-v1` HKDF info | `confirmed` |
| P4 | The three images can be pushed to GHCR at their exact tags with the authenticated `gh` token | `contradicted` — login succeeds, every push is denied by token scope |

---

## P1 — the backup lane verifies a quiesce on a production-shaped stack

**Task 2.** Before this change `scripts/backup.ts` set `let quiesced = true`, probed
`jobs.supervisorStatus` through `src/control/opsClient.ts` (default URL `http://gbrain-ops:3140`), and
turned the resulting connection failure into `quiesced = true` in its `catch`. On a production host no ops
port is published (S2), so the probe always threw and **every production manifest claimed a quiesce nobody
checked**. The fix makes the manifest's quiesce a three-state result (`verified` / `unverified` / `failed`)
and reaches ops through an injected caller that falls back to the `compose exec` relay when no port
answers.

The stack was brought up from the **base compose file alone** (no dev override), so `gbrain-ops` publishes
no host port — the production shape. `docker port brainstand-gbrain-ops-1` printed nothing. `OPS_RPC_URL`
was pointed at the container name so the host-side port probe could not possibly succeed.

Command:

```bash
docker compose --env-file .env -f compose/docker-compose.yml up -d --wait
OPS_RPC_URL=http://gbrain-ops:3140 bun run scripts/backup.ts /tmp/bs-backup-probe
```

Verbatim output:

```json
{
  "id": "5dde1120-5a70-43b3-b6e0-363c23fc0dc6",
  "createdAt": "2026-09-18T20:22:12.749Z",
  "gbrainVersion": "0.50.5.0",
  "components": {
    "brainDb": "brain-2026-09-18T20-21-54-109Z.sql",
    "controlDb": "control-2026-09-18T20-21-54-109Z.sql",
    "brainRepos": "brain-repos-2026-09-18T20-21-54-109Z.tar",
    "secrets": "secrets-2026-09-18T20-21-54-109Z.sql"
  },
  "sha256": {
    "brainDb": "1788c79bfd0b2cceb1aad4182ae6eb36d93ba5a03dadd715635421d640133864",
    "controlDb": "84fb1e0e270fccc9ceb706a066dcb6d091406182d53d37d7511056e4c55d4e49",
    "brainRepos": "16958f2681b953ee197d11e41789aa9b3c8c5f30a1d652bd49cbb858fcee1de6",
    "secrets": "76c37270a8ee9f2bf0140e08135aaeaa468762b7af132b4d7a5094bd9a39d880"
  },
  "quiesced": "verified",
  "quiesceLane": "relay",
  "warning": "Restoring requires the ENCRYPTION_KEY that sealed the secrets table. Store it separately from this archive — together they are a credential dump. Restoring to a NEW DOMAIN invalidates every OAuth grant; re-provision all Connections."
}
```

`"quiesced": "verified"` and `"quiesceLane": "relay"` are the point: the first honest quiesce the backup
lane has ever recorded on a production-shaped stack, proved through the one lane that works without a
published port. The manifest at `/tmp/bs-backup-probe/manifest.json` (`C:\tmp\bs-backup-probe\manifest.json`
on this host) was re-read directly and carried the same two fields.

---

## P2 — the frozen project-name default is inert on the live stack

**Task 3.** `compose/docker-compose.yml` now reads `name: ${COMPOSE_PROJECT_NAME:-brainstand}` (and
`compose/docker-compose.slice0.yml` reads `name: ${COMPOSE_PROJECT_NAME:-brainstand-slice0}`), and
`src/upgrade/snapshot.ts` derives its volume list from `projectName()` instead of the removed
`SNAPSHOT_VOLUMES` constant. The default is the legacy value, so a deployment that sets no
`COMPOSE_PROJECT_NAME` must keep the exact volume names Docker already created.

Command:

```bash
docker volume ls | grep -E 'brain-repos|gbrain-home'
```

Verbatim output:

```text
local     brainstand_brain-repos
local     brainstand_gbrain-home
```

Both volumes are unchanged: with no `COMPOSE_PROJECT_NAME` in the environment, `projectName()` returns
`brainstand` and `snapshotVolumes()` returns `['brainstand_brain-repos', 'brainstand_gbrain-home']`, the
same pair the old hardcoded constant named.

---

## P3 — the rename did not break decryption: the live stack still opens its secrets

**Task 4.** `brainstand-kek-v1` is the HKDF **info** that derives the `secrets` KEK, so it is a
cryptographic domain separator and not a product name (D3). The rename moved every human-facing surface
and left all three frozen strings byte-for-byte unchanged; the point of this probe is that the proof is
operational, not textual — the live control DB's rows still open.

First, the stack was healthy after the rename:

```bash
curl -sk https://localhost:8443/api/health | grep -o '"components":[^}]*}'
```

```text
"components":{"controlDb":"ok","ops":"ok"}
```

Then both secret rows were read **by name and length only, never by value**. The plan names a helper in
`test/integration/secrets.test.ts`; **that file does not exist**, so the equivalent check was run
read-only against the running control plane: fetch `{name, salt, wrapped_dek, payload}`, call `open()`
(the production decrypt path in `src/control/secrets.ts`), and print only the name and the plaintext
length. No value is printed, and none was.

```text
anthropic_api_key decrypts, plaintext_len=108
openai_api_key decrypts, plaintext_len=164
```

Envelope lengths in the DB, from
`select name, octet_length(salt), octet_length(wrapped_dek), octet_length(payload) from secrets order by name`:

```text
anthropic_api_key|24|80|184
openai_api_key|24|80|256
```

`controlDb":"ok"` + `ops":"ok"` and both rows opening under the frozen domain separator are the whole
claim: the rename moved a name, never a key.

---

## P4 — the publish is blocked at the push: the token has no `write:packages`

**Task 5, Step 7.** The plan's publish gate needs a GHCR credential with `write:packages`. The
authenticated `gh` account is `MolanoJF`, and `gh auth status` reports its token scopes verbatim:

```text
✓ Logged in to github.com account MolanoJF (keyring)
- Token scopes: 'gist', 'read:org', 'repo'
```

There is also **no `mobrain` GitHub org** — the namespace the compose file and the publisher default
to. `docker login ghcr.io` still succeeds, because it only proves the token authenticates:

```bash
TOKEN="$(gh auth token)"
echo "$TOKEN" | docker login ghcr.io -u MolanoJF --password-stdin
```

```text
Login Succeeded
```

The first real publish, at the intended namespace:

```bash
IMAGE_NAMESPACE=mobrain GBRAIN_VERSION=0.50.5.0 HARNESS_VERSION=2.1.274 APP_VERSION=1.0.0 \
  bash scripts/publish-images.sh
```

```text
--- ghcr.io/mobrain/gbrain-base:0.50.5.0
... (the pinned build succeeds: `#14 naming to ghcr.io/mobrain/gbrain-base:0.50.5.0 done`) ...
The push refers to repository [ghcr.io/mobrain/gbrain-base]
...
error from registry: permission_denied: The token provided does not match expected scopes.
```

(`PUBLISH_EXIT=1`.) The plan's fallback namespace, `MolanoJF`, fails earlier, at the tag itself —
Docker repository names must be lowercase, and the authenticated account name is not:

```text
--- ghcr.io/MolanoJF/gbrain-base:0.50.5.0
ERROR: failed to build: invalid tag "ghcr.io/MolanoJF/gbrain-base:0.50.5.0": repository name must be lowercase
```

(`PUBLISH_EXIT=1`.)

**The blocker, named exactly:** the only available credential is an OAuth token scoped
`gist, read:org, repo`; GHCR pushes require `write:packages`, which it does not carry, and the
`mobrain` org it would push under does not exist. No digest can be produced honestly here. The dry
run and both build gates prove the artifacts build at their exact pins; only the registry push is
blocked, and it is blocked by credentials and org ownership, not by the repository. Recorded rather
than skipped: **no image was published, so there are no digests to paste.**

To unblock, on the machine that owns the release: create the `mobrain` org (or set
`IMAGE_NAMESPACE=<lowercase-owner>`), grant a token `write:packages` (a classic PAT with
`write:packages, read:packages`, or a fine-grained token with `packages: write`), then re-run:

```bash
IMAGE_NAMESPACE=mobrain GBRAIN_VERSION=0.50.5.0 HARNESS_VERSION=2.1.274 APP_VERSION=1.0.0 \
  bash scripts/publish-images.sh
```

