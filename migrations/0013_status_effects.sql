-- Per-character active status effects. JSON array of Effect objects:
--   { type: "regen" | "bleeding" | "burning" | ..., magnitude: int, remaining: int, source?: string }
--
-- Cleared at quest end (resolveVictory / resolveDeath / etc.). Rest does NOT clear
-- effects; they persist through short/long rest just like the underlying HP/mana state.
ALTER TABLE characters ADD COLUMN effects TEXT NOT NULL DEFAULT '[]';
