-- The starting clothes get pictures of their own: a knitted cap, a navy naval tunic and plain deck boots,
-- not the hood, the chest armor and the sea boots they were saved with (packages/world/src/gear.ts, GARB).
UPDATE inventory SET icon = CASE ref
  WHEN 'garb_hat' THEN 'knit-cap'
  WHEN 'garb_tunic' THEN 'naval-tunic'
  WHEN 'garb_shoes' THEN 'deck-boots'
END
WHERE ref IN ('garb_hat', 'garb_tunic', 'garb_shoes');

UPDATE town_gear SET icon = CASE ref
  WHEN 'garb_hat' THEN 'knit-cap'
  WHEN 'garb_tunic' THEN 'naval-tunic'
  WHEN 'garb_shoes' THEN 'deck-boots'
END
WHERE ref IN ('garb_hat', 'garb_tunic', 'garb_shoes');
