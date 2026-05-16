-- Phase 1 of the four-phase gameplay overhaul: primary stats become the source
-- of truth for combat math, replacing class-fixed attack_mod / magic_mod.
--
-- New columns default to 5 (mid-range). The backfill below first renames the
-- Data Warlock class to Data Wizard (rebrand), then sets each character's
-- starting stats by class, then applies per-level auto-allocation bonuses for
-- each level past 1, then seeds unspent_points = level - 1 so existing
-- characters get retroactive free points to spend.
--
-- Combat code reads stats via packages/core/src/stats.ts statSnapshot(); when
-- the STATS_V2 env flag is off, statSnapshot() short-circuits to legacy
-- class-fixed values regardless of these columns. Cutover is one deploy after
-- this migration runs cleanly.

ALTER TABLE characters ADD COLUMN str INTEGER NOT NULL DEFAULT 5;
ALTER TABLE characters ADD COLUMN int_stat INTEGER NOT NULL DEFAULT 5;
ALTER TABLE characters ADD COLUMN vit INTEGER NOT NULL DEFAULT 5;
ALTER TABLE characters ADD COLUMN agi INTEGER NOT NULL DEFAULT 5;
ALTER TABLE characters ADD COLUMN dex INTEGER NOT NULL DEFAULT 5;
ALTER TABLE characters ADD COLUMN unspent_points INTEGER NOT NULL DEFAULT 0;

-- Class rebrand. Done first so subsequent class-keyed UPDATEs match cleanly.
UPDATE characters SET class = 'Data Wizard' WHERE class = 'Data Warlock';

-- Starting stat allocations. Sum to 30 per class (avg 6 across 5 stats),
-- chosen to roughly match each class's existing attack_mod/magic_mod/base_hp
-- flavor so legacy combat math comes out within ±1 at L1.
UPDATE characters SET str = 4, int_stat = 9,  vit = 5,  agi = 6, dex = 6 WHERE class = 'DevOps Mage';
UPDATE characters SET str = 9, int_stat = 4,  vit = 9,  agi = 4, dex = 4 WHERE class = 'QA Paladin';
UPDATE characters SET str = 6, int_stat = 7,  vit = 6,  agi = 5, dex = 6 WHERE class = 'Backend Druid';
UPDATE characters SET str = 4, int_stat = 9,  vit = 5,  agi = 6, dex = 6 WHERE class = 'Frontend Bard';
UPDATE characters SET str = 4, int_stat = 10, vit = 6,  agi = 5, dex = 5 WHERE class = 'Staff Sage';
UPDATE characters SET str = 7, int_stat = 4,  vit = 4,  agi = 7, dex = 8 WHERE class = 'Refactor Rogue';
UPDATE characters SET str = 9, int_stat = 4,  vit = 10, agi = 4, dex = 3 WHERE class = 'SRE Warden';
UPDATE characters SET str = 4, int_stat = 10, vit = 5,  agi = 5, dex = 6 WHERE class = 'Data Wizard';

-- Per-level auto-allocation. Each class gets +1 to two stats per level past 1.
-- A character at level L receives (L - 1) × (+1 to each of two stats).
UPDATE characters SET
  str = str + CASE class
    WHEN 'QA Paladin' THEN (level - 1)
    WHEN 'Backend Druid' THEN (level - 1)
    WHEN 'SRE Warden' THEN (level - 1)
    ELSE 0
  END,
  int_stat = int_stat + CASE class
    WHEN 'DevOps Mage' THEN (level - 1)
    WHEN 'Backend Druid' THEN (level - 1)
    WHEN 'Frontend Bard' THEN (level - 1)
    WHEN 'Staff Sage' THEN (level - 1)
    WHEN 'Data Wizard' THEN (level - 1)
    ELSE 0
  END,
  vit = vit + CASE class
    WHEN 'QA Paladin' THEN (level - 1)
    WHEN 'Staff Sage' THEN (level - 1)
    WHEN 'SRE Warden' THEN (level - 1)
    WHEN 'Data Wizard' THEN (level - 1)
    ELSE 0
  END,
  agi = agi + CASE class
    WHEN 'Frontend Bard' THEN (level - 1)
    WHEN 'Refactor Rogue' THEN (level - 1)
    ELSE 0
  END,
  dex = dex + CASE class
    WHEN 'DevOps Mage' THEN (level - 1)
    WHEN 'Refactor Rogue' THEN (level - 1)
    ELSE 0
  END
WHERE level > 1;

-- One free point per level past 1 — players spend via /gq spend <stat> or the
-- web level-up modal.
UPDATE characters SET unspent_points = level - 1 WHERE level > 1;
