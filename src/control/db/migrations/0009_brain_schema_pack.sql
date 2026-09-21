-- The wizard's schema-pack step accepted a pack name and threw it away: no
-- column, no gbrain call. This is the column half of closing that no-op.
-- Nullable and un-backfilled on purpose: an existing brain's real active pack
-- is whatever `gbrain schema active` resolves (gbrain init defaults new brains
-- to gbrain-base-v2), and inventing a value here would assert something we
-- have not read. The Schema page adopts the resolved pack into this column the
-- first time an admin applies one.
ALTER TABLE "brains" ADD COLUMN "schema_pack" text;
