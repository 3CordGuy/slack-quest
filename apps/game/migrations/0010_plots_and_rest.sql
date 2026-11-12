-- Hut plots are bought, not handed out: `plot` is the index of the plot a
-- player owns in their crew's Harbor, or NULL while they have none.
ALTER TABLE huts ADD COLUMN plot INTEGER;

-- Resting (on a bedroll, or at home) gives back gathering stamina, with a
-- cooldown. `rested_at` is when the player last rested, in ms.
ALTER TABLE gathering ADD COLUMN rested_at INTEGER;
