# Private member spaces (Google-Drive-style "My Space") — design

**Goal:** Inside a company-mode brain, every member gets a private write space that only they
(and no one else, including admins) can access — a "My Drive" alongside the org's "Shared
Drives." It's provisioned automatically when they're invited, and a member can also create their
own if they don't already have one. This is the mechanism that lets people put half-formed notes,
1:1 prep, and personal tracking into a company-managed brain without every teammate — or the
admin — being able to read it.

**Non-goals (explicitly out of scope for this design):**
- The fully separate "personal brain" concept (a standalone instance a user runs and owns
  entirely on their own, unrelated to any company org). That already exists as
  `organizations.brainMode = 'personal'` (`src/control/db/schema.ts:66`) and needs no schema
  change — it's a different, independent feature from what's described here.
- Multiple private spaces per member ("Q1 planning", "personal journal", etc., each its own
  gbrain source/Connection). v1 is one private space per member. Revisit if it turns out one
  notebook isn't enough — the data model doesn't foreclose it (see §5), but nothing in this
  design builds it.
- Any admin "break glass" / compliance-override path into a member's private space. Zero
  application-level admin access is the whole point of this feature; a future audited-override
  flow is a separate design, not a fallback silently baked into this one.
- Sharing a private space with a subset of other members (that's a "shared drive with limited
  membership," a different feature from a strictly-personal space).
- Anything about *content* inside a space (folders, files) — a Space is a gbrain source, and
  organizing within one is unchanged.

---

## 1. What exists today (and why this is mostly a workflow feature, not a new data model)

A "Space" already **is** a gbrain source, scoped to an org (`spaces` table,
`src/control/db/schema.ts:118` — "A Space IS a gbrain source. Hard rule (S4b)"). A "Connection"
already grants one membership exactly one write Space plus N read Spaces
(`connections` table, same file: "S4: a Connection is the unit of access. Exactly one write
Space, N read Spaces"). `spaceAccess.ts` is the single derivation both the access-overview page
and the Files routes use to decide what a membership can do with a Space — and today it has one
hard, explicitly-commented rule: **admin/owner reach every Space in the org, always**
(`src/control/spaceAccess.ts:27`, "`admin`/`owner` reach every Space in the org").

So an admin manually creating a Space and a Connection that points only one member's write at it
already produces something that behaves like a private space — nothing stops it today. What
doesn't exist is (a) automation (nobody does this by hand, and new members should get one without
an admin lifting a finger), and (b) the admin-visibility carve-out (today's admin-sees-everything
rule is deliberate and shared code; this feature is the one place it needs an exception).

## 2. Data model

Two additions, no new tables:

- `spaces.ownerMembershipId: text references memberships(id), nullable, onDelete: 'set null'`
  `NULL` = shared/company space (today's entire fleet of existing Spaces, unchanged). Non-null =
  private, owned by exactly that membership.
- Partial unique index `spaces_owner_membership_uq on (organizationId, ownerMembershipId) where
  ownerMembershipId is not null` — enforces one private space per membership, matching v1 scope.
  Trying to provision a second is rejected, not silently ignored.
- `organizations.privateSpacesEnabled: boolean not null default true` — an org-level toggle.
  Turning it off only stops *new* auto-provisioning (invite-time and self-service); it never
  touches private spaces that already exist. This is a company-brain-mode setting; on a
  `brainMode = 'personal'` org it's inert (there's only ever one member).

**Why `onDelete: 'set null'`, not `cascade` or `restrict`:** `members.ts:104` already documents
"Spaces outlive the member (S4b). v1 always orphans; never delete the gbrain source." A private
space must follow that same rule — offboarding a member must not destroy their notes. Setting
`ownerMembershipId` to `NULL` on offboard does two things at once: it satisfies "the space
outlives the member," and it's the natural point where the org reclaims the data — once nulled,
the space is no longer private (the access carve-out in §3 no longer applies to it), so it shows
up in the admin's access-overview like any other orphaned shared space, exactly the ownership
handoff you'd want when someone leaves.

## 3. Access control (`spaceAccess.ts`)

`accessFromConnections` and `spaceAccess` both gain the Space's `ownerMembershipId` as an input.
New first check, before the existing admin/owner override:

```
if (space.ownerMembershipId is not null
    and space.ownerMembershipId !== requesting membershipId):
  return null   // no access at all — not even admin/owner
```

Everything below that check is unchanged: a space with `ownerMembershipId = null` (shared) still
resolves exactly as it does today, admin/owner override included. A space owned by the requesting
membership itself still resolves through their own Connection's `writeSpaceId`/`readSpaceIds`
exactly as any other write access does today — no special-case needed for the owner's own access,
only for everyone else's.

Because this is the one shared derivation both callers already use, both inherit the carve-out
automatically:
- **`access-overview`** (`members.ts:129`): the Space listing query itself must also filter out
  other members' private spaces — not just resolve their access cell to "none." An admin should
  never see the *name* or *existence* of a space owned by someone else, only their own and every
  shared one. (Filter: `ownerMembershipId is null or ownerMembershipId = caller's membershipId`.)
- **Files routes**: inherit the access derivation change with no code change of their own, per
  the module's whole reason for existing ("a cell the page renders as `read` is exactly a read
  the Files browser will allow").

**Named trade-off, not silently accepted:** this means admins have zero visibility into private
space content through the product, by design. The underlying data still lives on company
infrastructure (the org's database, the org's gbrain deployment) — this is an application-level
access restriction, not off-boarding the data to somewhere the company doesn't control. If a
compliance-override need shows up later, it's a new, separately-designed, audited flow — not
something this design leaves a backdoor for.

## 4. Profile compilation — private spaces are always writable by their owner

`compileConnection` (`src/contracts/compile.ts:37`) derives the grant profile from the member's
**org-wide role**: `viewer → memory-reader` (read-only), `member`/`admin`/`owner` →
`memory-writer`/`coding-agent`. That mapping is correct for a member's access to *shared* company
spaces — a viewer should not be able to write to the shared brain — but it's wrong for a private
space: the whole point is a place the member can always write, regardless of what their company
role permits elsewhere.

So: when compiling the Connection for a private space specifically, the profile is always at
least `memory-writer`, independent of the owner's org role. This only affects the private-space
Connection's compilation — the same member's Connection(s) for shared spaces still compile from
their real org role exactly as today.

## 5. Provisioning

**At invite time** (`POST /members`, `src/control/routes/members.ts:49`), after the membership
row is inserted, if `org.privateSpacesEnabled`:
1. Create a `spaces` row: `ownerMembershipId = <new membershipId>`, `kind` = org's default source
   kind, `sourceId`/`name` derived deterministically from the membership id (same pattern as
   `clientName`'s `bs-<memberId8>-<spaceSlug>` in `connections.ts:1`).
2. Call the existing `provisionConnection()` (`connections.ts:101`) with `writeSpaceId` = the new
   Space, `readSpaceIds: []`, and a profile forced to writer-or-better per §4. This reuses the
   entire existing grant machinery (server client, secrets, audit log) with no changes to that
   code path itself.

**Failure handling:** if step 2 fails, the membership still exists (the invite itself succeeded)
— surface a retryable "provision private space" action on that member row rather than failing
the whole invite. This mirrors the existing pattern elsewhere in `connections.ts` of never
silently leaving a half-provisioned state.

**Self-service** (new endpoint, member-level auth, minimum role `viewer`): lets a member create
their own private space on demand — for members who joined before this feature existed, or whose
org had `privateSpacesEnabled` off and later turned it on. Same two steps as invite-time
provisioning, scoped to the caller's own membership. Rejects with a clear error if:
- `org.privateSpacesEnabled` is false (admin has disabled the feature), or
- the caller's membership already owns a private space (the partial unique index from §2 is the
  enforcement; the endpoint gives a friendly error rather than surfacing a raw constraint
  violation).

## 6. Admin UI

- Org settings: a new toggle, "Give each member a private space," default on, wired to
  `organizations.privateSpacesEnabled`.
- `access-overview`: shared spaces render exactly as today; the admin's own private space (if
  privateSpacesEnabled and they have one) renders like any other space they own; other members'
  private spaces are absent from the listing entirely, not shown-and-blocked.

## 7. Testing

- `spaceAccess.ts` unit tests: a private space returns `null` for every role except its owner's
  own membership, including `admin`/`owner` — this is the one behavior change to a function whose
  header comment already warns two callers depend on it not drifting.
- `access-overview` integration test: an admin's response never contains another member's private
  space, by id or by name.
- Provisioning: invite-time creation is atomic-enough that a `provisionConnection` failure leaves
  the membership intact and the space+connection retryable, not half-created and silently stuck.
- Profile compilation: a `viewer`-role member's private-space Connection compiles to a writer
  profile; their shared-space Connection(s), if any, still compile to `memory-reader`.
- Offboarding: removing a member sets their (former) private space's `ownerMembershipId` to
  `NULL` and it becomes visible in `access-overview` like any orphaned shared space.
