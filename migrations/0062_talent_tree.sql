-- Talent tree: per-character ability ownership + ranks + equipped loadout.
-- talent_points: pool of points earned at level-up (1 per level). Spent on
--   rank purchases via /api/character/talents/buy. Backfilled to current level
--   for existing players so they can immediately shop the tree.
-- ability_loadout: JSON { active: (string|null)[4], passive: (string|null)[1-3] }.
--   Null on insert; getCharacter() lazy-seeds it with the player's class kit so
--   the player's combat bar is unchanged on first login after rollout.
-- character_talents: which nodes the player owns and at what rank.

ALTER TABLE characters ADD COLUMN talent_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN ability_loadout TEXT;

CREATE TABLE character_talents (
  character_id TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  rank         INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
  acquired_at  INTEGER NOT NULL,
  PRIMARY KEY (character_id, node_id)
);
CREATE INDEX idx_character_talents_char ON character_talents(character_id);

-- Retroactive: every existing character gets points equal to their level.
-- Going forward, awardSpoils() grants +1 talent_point per level alongside the
-- existing +1 unspent_point grant.
UPDATE characters SET talent_points = level WHERE level > 0;
