-- Replace the three per-node Vigor pools with per-node Stock pools.
-- Each node (Mine, Herb Garden, Fishing Hole) tracks a harvestable stock
-- that depletes by the number of resources the player actually pulls and
-- replenishes 1 unit per hour up to cap (10). Stored as the timestamp
-- when stock will next be full, same shape as vigor_full_at — null/past
-- means full.
--
-- Players can still PLAY the mini-game when stock is empty (skill is its
-- own reward) — they just get scant XP and zero resources. The mini-game
-- stays a leaderboard-eligible score-attack mode regardless of stock.
--
-- The old vigor columns (vigor_full_at, forage_vigor_full_at,
-- fish_vigor_full_at) are left in place but no longer read by the app.
ALTER TABLE characters ADD COLUMN mine_stock_full_at    INTEGER;
ALTER TABLE characters ADD COLUMN forage_stock_full_at  INTEGER;
ALTER TABLE characters ADD COLUMN fish_stock_full_at    INTEGER;
