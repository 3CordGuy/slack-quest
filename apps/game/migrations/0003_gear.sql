-- Full gear model: eight equipment slots, item power, level requirements,
-- icons, and the market stall's purchase record.

ALTER TABLE inventory ADD COLUMN power INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory ADD COLUMN level_req INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inventory ADD COLUMN icon TEXT NOT NULL DEFAULT '';

-- The two original slots map onto the new ones.
UPDATE inventory SET slot = 'main_hand' WHERE slot = 'weapon';
UPDATE inventory SET slot = 'amulet' WHERE slot = 'trinket';

-- Only one amulet can be worn; keep the oldest equipped one.
UPDATE inventory SET equipped = 0
WHERE slot = 'amulet' AND equipped = 1
  AND id NOT IN (SELECT MIN(id) FROM inventory WHERE slot = 'amulet' AND equipped = 1 GROUP BY player_id);

UPDATE inventory SET icon = CASE ref
  WHEN 'mace' THEN 'hammer-drop'
  WHEN 'greatsword' THEN 'broadsword'
  WHEN 'staff' THEN 'wizard-staff'
  WHEN 'tome' THEN 'scroll-unfurled'
  WHEN 'daggers' THEN 'daggers'
  WHEN 'shortbow' THEN 'crossbow'
  ELSE 'gem-chain' END
WHERE icon = '';

-- The stall's stock is derived from (player, day); only what was bought is stored.
CREATE TABLE shop_purchases (
  player_id TEXT NOT NULL REFERENCES players(id),
  day       INTEGER NOT NULL,
  idx       INTEGER NOT NULL,
  PRIMARY KEY (player_id, day, idx)
);
