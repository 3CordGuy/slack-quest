-- Recalculate max_mana for all characters using the new INT-driven formula.
-- Formula: 2 + max(0, floor((int_stat - 4) / 2)) + floor(level / 6)
-- SQLite integer division floors automatically. COALESCE handles pre-STATS_V2 rows.
-- Full mana refill included as part of the recalculation.
UPDATE characters
SET max_mana = 2 + MAX(0, (COALESCE(int_stat, 5) - 4) / 2) + (level / 6),
    mana     = 2 + MAX(0, (COALESCE(int_stat, 5) - 4) / 2) + (level / 6);
