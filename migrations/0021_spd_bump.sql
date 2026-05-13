-- SPD match Bump support — initiator can re-surface a stale open match
-- in a chatty channel by posting a fresh announcement. Rate-limited
-- server-side via `last_bumped_at` so a bored player can't spam.
--
-- Null = never bumped (cooldown reckoned against created_at instead).
-- On bump: app code updates this conditionally — UPDATE WHERE
-- (last_bumped_at IS NULL OR last_bumped_at < cutoff). Atomic check.

ALTER TABLE spd_matches ADD COLUMN last_bumped_at INTEGER;
