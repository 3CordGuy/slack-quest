-- Repair: cooked/brewed items were landing in inventory with
-- `level_req = ceil(power / 3)` because addItem's legacy fallback assumed
-- gear-style power scaling. A Surf & Stream Platter (power 110) was
-- producing `level_req 37`, which made the dish the player just cooked
-- show "Req L37" in the inventory and combat picker.
--
-- Going forward addItem defaults non-equippable types to level_req=1 and
-- the cook/brew endpoints pass `level_req: character.level` explicitly.
-- This migration only repairs items whose names match the *static recipe
-- catalog* — every dish the pub cook + apothecary brew can produce. That
-- guarantees:
--   * Loot-dropped consumables (AI-named, never match these literals)
--     keep their existing level_req. If they were gated above the
--     player's level legitimately, they stay gated.
--   * Only items the player explicitly cooked / brewed get unlocked,
--     which is the smallest possible surface area to fix the bug.
UPDATE inventory
SET level_req = 1
WHERE level_req > 1
  AND item_name IN (
    -- Pub cook (fish dishes)
    '🍣 Pan-Fried Carp',
    '🐟 Silverfin Steak',
    '🍲 Abyss Stew',
    '🍱 Surf & Stream Platter',
    '🍛 Three-Fish Banquet',
    '🍤 Grand Mariner''s Feast',
    -- Apothecary brew (consumable / tool / magic outputs)
    '🧪 Greater Health Potion',
    '✨ Mana Flask',
    '🟢 Antidote',
    '⚗️ Endurance Tonic',
    '🔮 Focus Draught',
    '🧪 Vital Brew',
    '🧪 Master Health Elixir'
  );
