# Operate a Mo-brain stack

Everything here runs on the stack host, from the Mo-brain checkout, as `bin/mobrain`.
`bin/mobrain` needs `docker compose` and `curl` on the host, plus the checkout's `compose/`.
Commands that talk to the API (`/api/...`) also need `~/.config/mobrain/runner.env`, which
`install` and `join` write.

## Status

```bash
bin/mobrain status            # unauthenticated: GET /api/health
bin/mobrain status --detail   # + authenticated /api/admin/health
```

`status` prints the health JSON and exits:

| Exit | Meaning | What to do |
|---|---|---|
| `0` | `ok: true`: the database answers, gbrain answers, the pin matches | nothing |
| `1` | reachable but not healthy (`503`): `db`, `gbrain` or `pin.matches` is false | `bin/mobrain ps`, then `bin/mobrain logs <svc>` (usually `gbrain` or `postgres`) |
| `2` | nothing answers at the URL (`{"ok":false,"error":"unreachable"}`) | the stack is down or the port moved: `bin/mobrain up`, then re-check |

`--detail` adds gbrain's `run_doctor` summary, `get_stats`, `autopilot --status`, and the
core-schema lock. It needs an API key, so run it from the stack host (or a joined machine)
rather than by hand.

## Logs

```bash
bin/mobrain logs gbrain        # docker compose logs; -f/--tail follow, as compose does
bin/mobrain logs mobrain
```

The four services are `postgres`, `gbrain`, `autopilot` and `mobrain`. Collector runs are
not in these logs; each run's output is in `~/.local/state/mobrain/collect/<slug>/`
(see [`collectors.md`](collectors.md)).

## Restart, stop, start

```bash
bin/mobrain up        # docker compose up -d --wait: starts, recreates changed services, waits
bin/mobrain ps        # what is running
bin/mobrain down      # stop the stack, keep the volumes
```

`up` after an edit to `compose/` or `.env` is the normal way to apply it;
`bin/mobrain up --build` also rebuilds the local `gbrain` and `mobrain` images.

**Never `bin/mobrain down -v`** (or `docker compose down -v`) outside the `mobrain-dev` and
`mobrain-selftest` projects: `-v` deletes the brain's volumes. `bin/mobrain` refuses any
project it was not told to wipe, with exit 17.

Stop the stack when it is not in use. The reference host has 2 vCPUs, and the `gbrain`,
`autopilot` and `mobrain` containers cap their memory at 3 GB between them.

## Reset the owner password

There is no `reset-password` verb on `bin/mobrain`; the admin CLI inside the `mobrain`
container owns it. Use the same compose files `bin/mobrain` would:

```bash
docker compose --env-file .env -f compose/docker-compose.yml \
  exec -T mobrain bun src/server/admin-cli.ts reset-password --email owner@example.com
```

Add `-f compose/docker-compose.dev.yml` when `COMPOSE_PROJECT_NAME=mobrain-dev`; that is
what `bin/mobrain` does for a dev project. It prints `{"email":...,"password":...}` and
deletes that person's live sessions, so they sign in again with the new password. Signing
in as the owner needs no API key and works from the UI.

## Remote access

The stack publishes one host port, on loopback only: `127.0.0.1:${MOBRAIN_PORT}` (default
8787). No other container publishes a port, and no container mounts the Docker socket —
the Docker daemon is the host CLI's, never a container's. Mo-brain serves no public TLS of
its own. To reach the UI from other devices, put the loopback port on a tailnet:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

That is tailnet-only, gives a real certificate, and needs no change to `.env`. The person
opens `https://<host>.<tailnet>.ts.net:8443`. Agents on other machines join with the line
from the UI's **Connect your agent** page (`mobrain join --url ... --key ...`; the
`mobrain-join` skill walks through it), and each one registers its own gbrain MCP client.
