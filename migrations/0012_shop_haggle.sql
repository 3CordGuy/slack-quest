-- Per-shop-item haggle state. Communal: any player can haggle once per item;
-- the outcome locks for everyone for the rest of the cycle.
--
-- Values:
--   NULL      → not yet attempted (haggle button visible)
--   "failed"  → haggle was rolled and failed (button hidden, original price)
--   "15"      → succeeded at 15% off (button hidden, price already discounted)
--   "25"      → succeeded at 25% off
--   "30"      → succeeded at 30% off (rare crit)
ALTER TABLE shop_stock ADD COLUMN haggled TEXT;
