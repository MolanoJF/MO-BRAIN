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
