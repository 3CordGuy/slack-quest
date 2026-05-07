-- Battle position: 'front' takes more hits but no damage discount, 'back' is 3x less
-- likely to be targeted and takes 60% of monster damage when hit.

ALTER TABLE characters ADD COLUMN position TEXT NOT NULL DEFAULT 'front';
