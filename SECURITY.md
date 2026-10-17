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

In scope: the `bin/mobrain` CLI, the console, the installer, preflight, backup/restore, and the Compose deployment as shipped (`compose/docker-compose.yml`).

Out of scope: gbrain itself (report those to [garrytan/gbrain](https://github.com/garrytan/gbrain/security/advisories/new)), and misconfiguration of a host you control (for example, publishing the loopback port to the internet by hand, putting `.env` somewhere readable, or pointing a proxy at the containers in a way that removes the boundaries below).

## Trust boundaries

The shipped stack is four containers — `postgres`, `gbrain`, `autopilot` and `mobrain` — one bash CLI and five skills. These are the boundaries the code actually enforces; a boundary you are not told about is not a boundary.

**One loopback port is the only ingress.** In `compose/docker-compose.yml`, `mobrain` is the only service that publishes a host port, and it publishes loopback only: `127.0.0.1:${MOBRAIN_PORT}` (default `8787`). `postgres`, `gbrain` and `autopilot` are on the private `internal` Docker network and publish nothing. No container mounts the Docker socket — the Docker daemon is the host CLI's, never a container's. Mo-brain serves no public TLS of its own, so the loopback port is the only way in; to reach the UI or the MCP endpoint from another device, put that loopback port on a tailnet (see [`docs/runbooks/operate.md`](docs/runbooks/operate.md)), where the TLS is Tailscale's, not Mo-brain's. `mobrain` proxies gbrain's reserved paths (`/mcp`, `/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/*`, `/health`); gbrain's own `/admin` dashboard is deliberately not routed.

**Isolation is gbrain's application-level source scoping, not database row-level security.** Every gbrain client Mo-brain issues is granted an explicit read set, and `ui` clients are `read` only; a person's agent client is a separate grant over the sources that allow agent reads. Access is enforced by re-granting or revoking gbrain clients, not by the database. It is a boundary between colleagues, not between a colleague and the operator of the host. See "What isolation is, and is not" in [`docs/runbooks/company.md`](docs/runbooks/company.md).

**The host operator can read everything on the host.** Whoever operates the host can read every source's rows in the gbrain database, every container volume, and `.env`. Say so when a company plan depends on Mo-brain being a boundary between colleagues: it is not one between a colleague and the host.

**`.env` holds the whole secret plane.** `install` writes `.env` once, mode `0600`, holding `POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` and `OPENAI_API_KEY`. Anyone who can read it — or the environment of the `mobrain` container — holds all of them. `ENCRYPTION_KEY` seals the stored `ui` and `instance` gbrain client tokens through the frozen HKDF domain separator `mobrain-kek-v1`; without that exact key a restored `mobrain` database cannot open them, and a leaked key plus a leaked database dump is a credential dump. `.env` is never in a backup; keep a copy off the host (see [`docs/runbooks/backup-restore.md`](docs/runbooks/backup-restore.md)).

## Known residual risks

Stated plainly, because a boundary you are not told about is not a boundary.

- **The host operator is inside the product's boundary.** With SSH or the Docker daemon, the operator can read the gbrain and `mobrain` databases and every volume directly, and can revoke or mint gbrain clients out of band. That work is not in Mo-brain's `audit_log`. There is no privileged-operator path to reach it through — the product simply cannot fence the person who runs the host.
- **Scoping depends on gbrain.** Isolation is only as strong as gbrain's grant enforcement. A bug that lets a client read outside its granted sources is a scoping bypass, and the fix is upstream.
- **Issued clients are live credentials.** An agent or `ui` token reads exactly the sources its grant names for as long as it is valid (agent tokens rotate on `collect --due`; `ui` and `instance` tokens are sealed in the `mobrain` database). Treat a leaked token as read access to those sources and revoke the client.
- **No TLS of Mo-brain's own.** The loopback port is plain HTTP; anything that terminates TLS in front of it (a tailnet, a reverse proxy) is part of your deployment, not the product.
