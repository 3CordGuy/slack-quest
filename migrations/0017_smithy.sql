-- Smithy v1 — Sharpen mechanic.
--
-- Tracks how many times a single inventory item has been sharpened at the
-- smithy. Hard-capped at 3 in the handler (smithy refuses to sharpen
-- beyond +3 over the item's original power), so original_power is
-- derivable as (current_power - sharpens_count) if we ever need it.
--
-- Default 0 backfills cleanly — pre-existing items count as "unsharpened"
-- with their current power as the baseline, which is correct for our
-- purposes (the cap rule still leaves 3 sharpens available going forward).

ALTER TABLE inventory ADD COLUMN sharpens_count INTEGER NOT NULL DEFAULT 0;
