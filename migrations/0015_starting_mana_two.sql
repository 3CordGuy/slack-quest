-- Bump starting mana from 1 to 2. Active class abilities (Containerize, Taunt,
-- Vanish, Battle Hymn, Soul Drain, Regression Shield) cost 2 mana — with the
-- old 1-mana floor, brand-new characters couldn't use their class active at
-- all until they hit level 5 and earned their first max_mana bump. Cap stays
-- at 5, so the +1 every 5 levels schedule still lands at the same ceiling
-- (just one rung shorter overall: Lv1=2 → Lv5=3 → Lv10=4 → Lv15=5).
--
-- Backfills existing Lvl 1 characters (anyone still at max_mana = 1) so they
-- aren't penalized vs. fresh rolls. Higher-level characters with max_mana = 1
-- shouldn't exist under normal play (every 5 levels grants +1), but we guard
-- by max_mana value rather than level to keep the rule simple. `mana` is
-- raised to at least 2 too so the bump is immediately usable.
--
-- SQLite doesn't support ALTER COLUMN to change the DEFAULT; new characters
-- created by `createCharacter` in src/db.ts now write max_mana = 2 / mana = 2
-- explicitly, bypassing the schema default. The DEFAULT 1 on the column is
-- effectively legacy at this point.

UPDATE characters
SET max_mana = 2,
    mana = MAX(mana, 2)
WHERE max_mana = 1;
