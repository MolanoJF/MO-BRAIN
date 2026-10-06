# Skill catalog sync

Mobrain's member-facing skill catalog (`skills/`, mounted read-only into `gbrain-serve`/`gbrain-ops`
at `/opt/mobrain-skills`) is a small, curated subset of gbrain's built-in skills. gbrain deliberately
never serves its own bundled catalog to remote MCP callers, so nothing here updates itself — new gbrain
releases can ship skills members never see until an operator does this.

## Check for drift

On `gbrain-ops`, run the doctor check to detect new or changed skills:

```bash
docker exec <gbrain-ops-container> gbrain doctor --json
```

Look at the `skill_currency` check. A status of `"warn"` with a non-empty `details.new` list means
gbrain has built-in skills this workspace hasn't synced yet. An absent check or `status: "ok"` means
the catalog is current.

## Review and curate

1. Inspect what's new without writing anything, using gbrain's read-only skillpack commands:

   ```bash
   docker exec <gbrain-ops-container> gbrain skillpack status
   docker exec <gbrain-ops-container> gbrain skillpack list
   docker exec <gbrain-ops-container> gbrain skillpack reference <name>
   docker exec <gbrain-ops-container> gbrain skillpack sync --dry-run
   ```

   `status` reports install currency (new/drifted/current); `list` prints every skill bundled in
   gbrain's own catalog; `reference <name>` is a read-only diff of gbrain's bundled copy against a
   local copy of the same skill. `sync --dry-run` previews what a real `sync` would do.

   Do not run `gbrain skillpack sync` (without `--dry-run`) as a preview step: it actually
   scaffolds new bundled skills (it only refuses to overwrite files that already exist), so it is
   not a no-op inspection command — treat it as a write operation and only run it once you're
   ready to bring a skill in.

2. For each new or changed skill, read its `SKILL.md` and answer these questions:

   - Does it need tools or scopes beyond what member profiles (`memory-reader`, `memory-writer`,
     …) already grant? If yes, it likely needs `operator`/`coding-agent`-only exposure, not a
     member-wide add.
   - Does it match a real member workflow, or is it operator/admin tooling that doesn't belong in
     a member's `list_skills` response?
   - Does it write pages a member shouldn't be able to write unsupervised?

3. For each approved skill, copy its `SKILL.md` into `skills/<name>/SKILL.md` in this repo, then add
   a row to `skills/RESOLVER.md`'s trigger table.

## Ship it

Commit the new or changed `skills/` files as a normal PR. No redeploy-time config change is needed —
`GBRAIN_SKILLS_DIR` already points at the mounted repo folder (`compose/docker-compose.yml`,
`compose/docker-compose.slice0.yml`), so the next container start picks it up. If gbrain reads the
catalog live rather than caching it at boot (confirm this before assuming a running container needs
no restart), a running container's next `list_skills` call will see the new skills immediately.

## Cadence

Check `skill_currency` alongside each gbrain version bump. This repo already has a per-version
playbook mechanism (`src/upgrade/playbooks/`); a gbrain upgrade is a natural trigger to also check
the catalog, even though this step itself stays manual and reviewed, not automated.
