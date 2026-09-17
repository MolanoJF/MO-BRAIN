# Break-glass: operating the brain when the console is down

The console is not the only way in — but it is the only way in *through the
product*. When the console is broken and the brain itself is fine, this is the
documented recovery path.

## Why `/admin` is not simply exposed

gbrain ships an embedded admin SPA at `/admin`. It is **a second control plane
with god rights over the same brain**, authenticated by a bootstrap token
rather than our RBAC, with in-process sessions and no audit trail we own.
Every decision the permission compiler makes can be silently overridden there.

So it is bound to the private network and Caddy answers `404` for it. The
recovery path is the ops sidecar over SSH.

## Prerequisites

- SSH access to the VM running the stack.
- Membership in the `docker` group, or `sudo`.
- The repository checkout with `compose/docker-compose.yml`.

## The one command you need

```bash
docker compose -f compose/docker-compose.yml exec gbrain-ops gbrain <command>
```

`gbrain-ops` holds the brain `DATABASE_URL` and a writable `GBRAIN_HOME`, so
every control-plane command works there. The control plane holds neither.

## Common recoveries

**Is the brain healthy at all?**
```bash
docker compose -f compose/docker-compose.yml exec gbrain-ops gbrain doctor --json
```
Exit 0 does **not** mean healthy: `status: "warnings"` exits 0, and *"this binary is behind the
database schema"* is a warn. Read `checks[]` — `filter(c => c.status !== 'ok')` — and `top_issues`.
The report has no `blockers` key; the only `blockers` in gbrain's doctor belongs to the unrelated
`--locks` diagnostic.

**The console cannot reach the ops sidecar**
```bash
docker compose -f compose/docker-compose.yml logs --tail 100 gbrain-ops
docker compose -f compose/docker-compose.yml exec gbrain-ops sh -c 'curl -sf http://127.0.0.1:3140/healthz'
```

**Jobs are stuck**
```bash
docker compose -f compose/docker-compose.yml exec gbrain-ops gbrain jobs supervisor status --json
docker compose -f compose/docker-compose.yml restart gbrain-worker
```
The supervisor drains on SIGTERM and `stop` waits up to 40 seconds. Exit codes:
`0` clean shutdown, `1` max crashes exceeded, `2` another supervisor holds the
PID lock, `3` PID file unwritable.

**A member's agent cannot connect**
```bash
docker compose -f compose/docker-compose.yml exec gbrain-ops gbrain auth clients --json
docker compose -f compose/docker-compose.yml exec gbrain-ops gbrain mcp verify --client <client_id> --json
```
`mcp verify` exit `2` means *partial*: server stages passed but harness
evidence is missing. **That is not success** — do not report it as healthy.

**Reach the embedded admin SPA anyway (last resort)**

Do not open a public route. Tunnel it over SSH so it stays private:
```bash
ssh -L 3131:127.0.0.1:3131 user@your-vm
docker compose -f compose/docker-compose.yml exec gbrain-serve sh -c 'echo serving on 3131'
```
Then browse `http://127.0.0.1:3131/admin` on your own machine. **Anything you
change there bypasses our RBAC and our audit log.** Record what you did in the
incident notes; the console cannot show it to you.

## What NOT to do

- **Never run `gbrain autopilot --install`** in a container. It writes a
  crontab line, which in a container is either a silent no-op or a
  duplicate-scheduler bug depending on the base image. The product owns
  scheduling.
- **Never run `gbrain upgrade` or a self-upgrade** by hand. The product owns
  the upgrade lane: `bun run scripts/upgrade.ts` on the host, with a snapshot in
  front of it and a one-command rollback behind it — see
  [`upgrade.md`](./upgrade.md). An in-container self-upgrade desynchronizes the
  image from the running binary and leaves nothing to roll back to.
  `GBRAIN_SELF_UPGRADE_MODE=off` is set for this reason, and
  `scripts/lint-forbidden.ts` fails the build on a moving pin.
- **Never publish a host port for `gbrain-serve` or `postgres`.** `gbrain-serve`
  runs with `GBRAIN_HTTP_TRUST_PROXY=1`; making it directly reachable lets
  clients spoof `X-Forwarded-For`.
- **Never edit `~/.gbrain/config.json` by hand while the stack is up.** Writes
  serialize through `gbrain-ops` behind a Postgres advisory lock; an unlocked
  edit can lose an API key.

## After the incident

1. `gbrain doctor --json` → 0.
2. Re-run the console health page.
3. If you touched `/admin`, note it — our `audit_log` did not see it.
