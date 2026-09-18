-- F24 (Slice 5 Gate C): the pinned gbrain 0.50.5.0 accepts only
-- `conservative | balanced | tokenmax` for `search.mode`. F21 moved
-- `SEARCH_MODES` to that vocabulary, but a brain that chose a mode under the
-- old vocabulary kept it in this column, so `/api/wizard/state` still reported
-- an id the pinned binary refuses. Backfill the old ids to their nearest
-- valid mode; `balanced` is unchanged, and an unknown value is left as-is
-- rather than invented away.
UPDATE "brains"
SET "search_mode" = CASE
	WHEN "search_mode" = 'fast' THEN 'conservative'
	WHEN "search_mode" = 'thorough' THEN 'tokenmax'
	ELSE "search_mode"
END
WHERE "search_mode" IN ('fast', 'thorough');
