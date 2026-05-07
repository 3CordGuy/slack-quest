-- Damage-absorbing shield. Persists across actions until depleted by incoming hits.
-- Granted by /sq shield (party-targetable, mana-gated). Consumed before HP on damage.

ALTER TABLE characters ADD COLUMN shield INTEGER NOT NULL DEFAULT 0;
