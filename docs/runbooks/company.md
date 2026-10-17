# Company mode

A fresh install is a **personal brain**: one owner (plus whoever they invite), one private
space per member. Company mode turns the same stack into a shared brain: company sources,
invites, roles, grants, and company collectors.

## Switching modes

```bash
bin/mobrain mode company
bin/mobrain mode personal
```

Only the **owner** may switch, and the switch is the owner's own setting, not a data
migration — nothing moves and no page is retagged. Inviting, granting, and creating a
company source are refused in personal mode with `403 {"error":"company_mode_required"}`.
Switching back to personal is allowed only while the owner is the **only user who is not
`disabled`**: an open invite counts, because an invite is a user row. With anyone else
present the command fails `409 {"error":"not_sole_member"}` — offboard them first if that
is intended. The UI's People & access page has the same switch; in personal mode it shows
the switch and nothing else.

## Invites

```bash
bin/mobrain member invite colleague@example.com --role member   # prints the claim URL
```

The invite creates a user with status `invited`, no password, and a **24-hour, single-use
link**. The link is shown to the inviter (`claimUrl` on the API response; the UI shows it on
the People & access page) and using it sets a password only on an `invited` user, marks the
invite used, and activates them. The password must be at least 10 characters. If the claim
fails halfway, the failure un-burns the invite and leaves the user `invited`, so the same
link can be retried. A used or expired link answers `410 invite_invalid`; issue a new
invite.

Only the owner may invite an `admin`, and nobody can invite an `owner`. Invites are
refused with `403` in personal mode.

## Roles

Spec §5.2. A role is what the person's gbrain clients are compiled from:

| Role | Private source | `agent` client | `ui` client |
|---|---|---|---|
| owner | yes, `p-<slug>` | profile `operator` (scopes `admin`, `skills_member_self`); writes own private; reads own private + every active company source | `read`; same read set as agent |
| admin | yes | same as owner | same |
| member | yes | scopes `read,write`; writes own private; reads own private + granted company sources where `agent_reads` | `read`; own private + all granted company sources |
| viewer | no | scopes `read`; reads granted company sources where `agent_reads` | `read`; granted company sources |

```bash
bin/mobrain member list                       # id, email, role, status (TSV)
bin/mobrain member role colleague@example.com viewer
```

There is exactly one owner. The owner cannot be demoted, offboarded, or changed by
themselves (`409 owner_is_fixed`, `409 cannot_change_self`), and only the owner may
promote someone to or demote someone from `admin`. Moving a `viewer` to a role that owns a
private source creates that source; no role ever reads another person's private source.

## Grants and `agent_reads`

Company access is an explicit `grants` row. `agent_reads` is the person's switch for
whether their *agent* — not just the UI — may read that source:

```bash
bin/mobrain grant colleague@example.com c-company              # agent reads, default
bin/mobrain grant colleague@example.com c-deals --no-agent-reads
bin/mobrain revoke colleague@example.com c-deals
```

A grant always gives the person's `ui` client read access; `agent_reads` adds the source to
their agent client's read set. The member can flip their own switch on the Sources page
(`PATCH /api/me/grants/<source>`); owners and admins read every active company source by
role and have no grant row to toggle.

Adding or removing a grant, changing a role, or flipping `agent_reads` **recompiles that
person's client specs and rescopes their existing gbrain clients before the request
returns** — it is a fresh set of grants at gbrain, not a cached decision. Every people and
access change also writes an `audit_log` row.

## Company sources

```bash
bin/mobrain source add "Deals"     # prints the id, c-<slug>; the first is c-company
bin/mobrain source list
bin/mobrain source archive c-deals
```

A company source is shared by grant; a private source (`p-<slug>`) belongs to its owner and
no other person's clients read it, including the owner's and the admins'. `source archive`
archives it in gbrain, marks it archived here, deletes its grants, and revokes its
`company_writer` clients, so nothing keeps reading a source that no longer exists.

## Company collectors

A company source's writer client belongs to an owner or admin, one per (person, source):

```bash
bin/mobrain client issue company-writer c-deals --register
```

`--register` adds an MCP server named `gbrain-company-<source>` to that person's harness and
prints the expiry. A collector that writes to a company source runs with that registration;
its prompt names `gbrain-company-<source>` as the write server, and that client can read the
source it writes. Company-level collectors run on the host of whoever owns the registration,
on the same timer as personal ones. The same person's personal collectors are unchanged.

## Offboarding

```bash
bin/mobrain member offboard colleague@example.com
```

Offboarding moves the person to `offboarding`, then, checking each step before doing it:
revokes every live client (agent, ui, company_writer), archives their private source in
gbrain, deletes their grants and sessions, revokes their API keys, and marks them
`disabled`. It is **idempotent and resumable**: a run interrupted halfway is fixed by
running it again, and each step only touches what is still left. Offboarding a `disabled`
user is a no-op. An `admin` can only be offboarded by the owner; the owner cannot be
offboarded at all.

## What isolation is, and is not

Isolation is gbrain's **application-level source scoping**: every gbrain client is granted
an explicit read set, and `ui` clients are `read` only. It is not database row-level
security. The person who operates the host can read every source's rows, every container
volume, and `.env`. Say so when a company plan depends on Mo-brain being a boundary between
colleagues and the operator — it is a boundary between colleagues, not between a colleague
and the host.
