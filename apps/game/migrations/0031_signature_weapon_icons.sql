-- Signature weapons get icons (and in-hand models) of their own. Until now each
-- was saved with the icon of the weapon it was drawn like (packages/world/src/gear.ts,
-- WEAPON_ICON), so a Gaff Hook showed as the Twin Gutting Knives.
UPDATE inventory SET icon = CASE ref
  WHEN 'ballast_flail' THEN 'ballast-flail'
  WHEN 'barometer_rod' THEN 'barometer-rod'
  WHEN 'gaff_hook' THEN 'gaff-hook'
  WHEN 'coral_staff' THEN 'coral-staff'
  WHEN 'ships_bell' THEN 'ships-bell'
  WHEN 'astrolabe' THEN 'astrolabe'
  WHEN 'lamp_hook' THEN 'lamp-hook'
  WHEN 'bilge_chalice' THEN 'bilge-chalice'
END
WHERE kind = 'weapon' AND ref IN ('ballast_flail', 'barometer_rod', 'gaff_hook', 'coral_staff', 'ships_bell', 'astrolabe', 'lamp_hook', 'bilge_chalice');
