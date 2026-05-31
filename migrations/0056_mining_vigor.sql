-- Mining mini-game vigor system.
--   vigor_full_at : Unix ms timestamp when vigor will next be full (cap 3).
--                   Null / past timestamp == full vigor.
--                   When a player spends 1 vigor, push this timestamp forward
--                   by VIGOR_REGEN_MS (1 hour). Current vigor is computed
--                   client-side as MAX(0, 3 - ceil((vigor_full_at - now) / 1hr)).
ALTER TABLE characters ADD COLUMN vigor_full_at INTEGER;
