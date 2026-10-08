# Security policy

## Reporting a vulnerability

**Report privately. Do not open a public issue.**

Use GitHub's private security advisory flow on the Mo-brain repository: **Security → Report a vulnerability**. If that channel is not available to you, contact the maintainer who gave you the release, or your deployment's operator, through the same private channel you received the software from.

Please include the affected version (`/api/health` reports the gbrain pin), the deployment shape (self-hosted Compose on a host you control), and a reproduction. Do not include live secrets, API keys or `ENCRYPTION_KEY` values.

### Response window

This is a small, self-hosted project at GA; these are targets, not a contractual SLA.

| Stage | Target |
|---|---|
| We acknowledge the report | within **5 business days** |
| Initial assessment and severity | within **10 business days** |
| Fix or documented mitigation for a confirmed high-severity issue | within **30 days** |

We coordinate disclosure with the reporter and credit you if you want. We will not pursue legal action against good-faith research that stays within the scope above and does not access other users' data.

## Scope

In scope: the Mo-brain control plane, console, installer, preflight, backup/restore and upgrade lanes, the agent runner and its fences, and the Compose/Caddy deployment as shipped.

Out of scope: gbrain itself (report those to [garrytan/gbrain](https://github.com/garrytan/gbrain/security/advisories/new)), and misconfiguration of a host you control (for example, publishing a service port by hand or exposing the Docker socket to something that touches agent output).

## Trust boundaries

**Caddy is the only ingress.** In the production Compose file (`compose/docker-compose.yml`) Caddy is the only service that publishes host ports, 80 and 443. Postgres, `gbrain-serve`, `gbrain-worker`, `gbrain-ops`, the control plane and the scheduler are on private Docker networks and publish nothing. Caddy terminates TLS, adds HSTS and the standard security headers, routes gbrain's reserved paths (`/mcp`, `/authorize`, `/token`, `/.well-known/*`, `/ingest`, `/health`, `/metrics`, …) to `gbrain-serve`, and routes `/api/*` and the console SPA to the control plane. The dev override (`compose/docker-compose.dev.yml`) additionally publishes `3140` and a plain-HTTP `8443`; that file is for local development and is not part of a production deployment.

**`/admin` is never routed (S1).** gbrain ships an embedded admin SPA at `/admin` that is a second control plane with god rights over the same brain, authenticated by a bootstrap token rather than Mo-brain's RBAC, with in-process sessions and no audit trail Mo-brain owns. Caddy answers `404` for `/admin`, `/admin/*`, `/admin/api/*` and `/admin/events` on both sites, and the service is bound to the private network. The recovery path when the console is down is SSH break-glass through the ops sidecar, documented in [`docs/runbooks/break-glass.md`](docs/runbooks/break-glass.md); anything changed there deliberately bypasses Mo-brain's RBAC and audit log.

**The control plane holds no brain database credentials (S2).** The `control-plane` service is given `CONTROL_DATABASE_URL` and nothing else that reaches the brain: no `GBRAIN_DATABASE_URL`, no `DATABASE_URL`. Everything privileged crosses the `gbrain-ops` RPC boundary, and `gbrain-ops` is the only service that holds the brain DB URL and a writable `GBRAIN_HOME`. The control plane mounts `GBRAIN_HOME` read-only and is never given the Docker socket or CLI. The scheduler is strictly less privileged again: control-DB credentials and the ops bearer token only.

**Secrets are envelope-encrypted under `ENCRYPTION_KEY`.** Provider and connection secrets live in one `secrets` table in the control DB; each row is a per-secret data key wrapped by a key derived from `ENCRYPTION_KEY` (AES-256-GCM, versioned). A plaintext column would make a `pg_dump` a credential dump, so there is none. `ENCRYPTION_KEY` itself lives only in the host `.env` (mode `600`) and the control plane's environment — it is **not** in the backup archive. The archive does contain an encrypted `secrets-*.sql` dump; without `ENCRYPTION_KEY` it is useless, and without the archive the key is useless, which is exactly why the two must be stored separately. Losing `ENCRYPTION_KEY` makes every stored secret unrecoverable; a leaked key plus a leaked archive is a credential dump.

**The agent runner reaches one internal network with no default route, and its tool surface is MCP-only.** The runner joins only `runner-net`, which is declared `internal: true`: it has no gateway and no default route, so the only things the container can address are its named peers (Caddy aliased to `${DOMAIN}`, and the control plane's runner routes). The container holds no database URL, no `GBRAIN_HOME`, no ops token, no `ENCRYPTION_KEY` and no provider key; its only credentials are its `RUNNER_TOKEN` and the short-lived, per-run gbrain token and gateway token issued with each claim. It runs read-only as a non-root user with all capabilities dropped, `no-new-privileges`, pid/memory/CPU limits, a `/tmp` tmpfs and **no mounted volumes**, and the harness is started with an empty built-in tool set so only `mcp__gbrain__*` tools are available. **Bash is a job class this product does not implement**: there is no schedule field for a tool allowlist, permission mode or shell, so it cannot be requested.

**`/api/runs/*` and `/api/gateway/*` are the runner's surfaces, not the browser's.** They are designed to be reached by the runner across `runner-net` (its claim URL is `http://control-plane:3150/api/gateway`), and Caddy's `/api/*` handler also proxies them at the public host, where every route is gated by the runner's bearer token or a per-run gateway token rather than a session. Measured on the shipped stack, an unauthenticated `POST /api/runs/claim` and `POST /api/gateway/v1/messages` both answer `401`. The runner's own secrets never appear in a run record: `GET /api/runs/:id` is session-gated and projects neither token.

## Known residual risks

Stated plainly, because a boundary you are not told about is not a boundary.

- **Enabling the agent runner runs model-written code against your brain, with your organization's API key, on a schedule, with nobody watching.** That is the installer's own wording and it is the point of the feature. The network fence and the MCP-only tool surface reduce the blast radius — the agent can call only the gbrain operations its per-run grant allows, bounded by the Connection's read Spaces and one write Space, and the model gateway stops it at the budget cap — but they do not make an agent safe to run untrusted. Enable it deliberately, and read the [agent runner runbook](docs/runbooks/agent-runner.md) first.
- **The runner's public reachability is token-gated, not network-isolated.** Because Caddy's `/api/*` catch-all proxies `/api/runs/*` and `/api/gateway/*` at the public hostname, an attacker can reach those handlers; the boundary is the bearer token and the per-run grant, and the runner only ever dials its private peers. Unauthenticated requests are rejected (`401`), but this is a public attack surface and should be treated as one.
- **`ENCRYPTION_KEY` is the whole secret plane.** Anyone who can read the host `.env`, the control plane's environment, or both a backup archive and the key can recover every stored credential. Protect the host and split key from archive.
- **Break-glass bypasses the product.** `docker compose exec gbrain-ops gbrain …` reaches the brain with `gbrain-ops`'s privileges and is not audited by Mo-brain's `audit_log`. It is a deliberate recovery path for an operator with SSH, and it should be logged by hand when used.
- **A restored deployment is not a reconnected one.** Restoring to a new domain invalidates every OAuth redirect URI and issuer URL, so every Connection must be re-provisioned. The backup manifest says so on every archive.
