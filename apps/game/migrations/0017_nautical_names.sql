-- Nautical names for the classes, weapons and gear (code defaults changed in
-- packages/world). Items keep the name they were made with, rarity word and
-- any smithy "+N" included, so rewrite the base name inside each stored one.
-- Matched on ref as well, so only that base's items change.
UPDATE inventory SET name = REPLACE(name, 'Audit Mace', 'Anchor Mace') WHERE ref = 'mace' AND name LIKE '%Audit Mace%';
UPDATE inventory SET name = REPLACE(name, 'Regression Greatsword', 'Breakwater Greatsword') WHERE ref = 'greatsword' AND name LIKE '%Regression Greatsword%';
UPDATE inventory SET name = REPLACE(name, 'Pipeline Staff', 'Squall Staff') WHERE ref = 'staff' AND name LIKE '%Pipeline Staff%';
UPDATE inventory SET name = REPLACE(name, 'Runbook Tome', 'Logbook of Gales') WHERE ref = 'tome' AND name LIKE '%Runbook Tome%';
UPDATE inventory SET name = REPLACE(name, 'Twin Diff Daggers', 'Twin Gutting Knives') WHERE ref = 'daggers' AND name LIKE '%Twin Diff Daggers%';
UPDATE inventory SET name = REPLACE(name, 'Hotfix Shortbow', 'Crow''s Nest Shortbow') WHERE ref = 'shortbow' AND name LIKE '%Hotfix Shortbow%';
UPDATE inventory SET name = REPLACE(name, 'Root Cause Staff', 'Driftwood Staff') WHERE ref = 'root_staff' AND name LIKE '%Root Cause Staff%';
UPDATE inventory SET name = REPLACE(name, 'Garbage Collector''s Sickle', 'Kelp Sickle') WHERE ref = 'sickle' AND name LIKE '%Garbage Collector''s Sickle%';
UPDATE inventory SET name = REPLACE(name, 'Responsive Lute', 'Dockside Lute') WHERE ref = 'lute' AND name LIKE '%Responsive Lute%';
UPDATE inventory SET name = REPLACE(name, 'Hot-Reload Flute', 'Bosun''s Pipe') WHERE ref = 'flute' AND name LIKE '%Hot-Reload Flute%';
UPDATE inventory SET name = REPLACE(name, 'Monolith Orb', 'Sextant Orb') WHERE ref = 'orb' AND name LIKE '%Monolith Orb%';
UPDATE inventory SET name = REPLACE(name, 'Legacy Scepter', 'Tidestone Scepter') WHERE ref = 'scepter' AND name LIKE '%Legacy Scepter%';
UPDATE inventory SET name = REPLACE(name, 'Pager Axe', 'Foghorn Axe') WHERE ref = 'pager_axe' AND name LIKE '%Pager Axe%';
UPDATE inventory SET name = REPLACE(name, 'Five-Nines Maul', 'Bell-Buoy Maul') WHERE ref = 'maul' AND name LIKE '%Five-Nines Maul%';
UPDATE inventory SET name = REPLACE(name, 'Query Grimoire', 'Drowned Grimoire') WHERE ref = 'grimoire' AND name LIKE '%Query Grimoire%';
UPDATE inventory SET name = REPLACE(name, 'Null Pointer Staff', 'Undertow Staff') WHERE ref = 'void_staff' AND name LIKE '%Null Pointer Staff%';
UPDATE inventory SET name = REPLACE(name, 'Rollback Buckler', 'Barrel-Lid Buckler') WHERE ref = 'buckler' AND name LIKE '%Rollback Buckler%';
UPDATE inventory SET name = REPLACE(name, 'Firewall Shield', 'Seawall Shield') WHERE ref = 'firewall' AND name LIKE '%Firewall Shield%';
UPDATE inventory SET name = REPLACE(name, 'Hauberk of Uptime', 'Hauberk of Calm Seas') WHERE ref = 'hauberk' AND name LIKE '%Hauberk of Uptime%';
UPDATE inventory SET name = REPLACE(name, 'On-call Greatcoat', 'Oilskin Greatcoat') WHERE ref = 'greatcoat' AND name LIKE '%On-call Greatcoat%';
UPDATE inventory SET name = REPLACE(name, 'Hard Hat of Review', 'Diving Helm') WHERE ref = 'hardhat' AND name LIKE '%Hard Hat of Review%';
UPDATE inventory SET name = REPLACE(name, 'Incident Hood', 'Squall Hood') WHERE ref = 'hood' AND name LIKE '%Incident Hood%';
UPDATE inventory SET name = REPLACE(name, 'Blame Visor', 'Spyglass Visor') WHERE ref = 'visor' AND name LIKE '%Blame Visor%';
UPDATE inventory SET name = REPLACE(name, 'Sprint Greaves', 'Deckhand Greaves') WHERE ref = 'greaves' AND name LIKE '%Sprint Greaves%';
UPDATE inventory SET name = REPLACE(name, 'Padded Trousers', 'Sailcloth Trousers') WHERE ref = 'trousers' AND name LIKE '%Padded Trousers%';
UPDATE inventory SET name = REPLACE(name, 'Stand-up Boots', 'Sea Boots') WHERE ref = 'boots' AND name LIKE '%Stand-up Boots%';
UPDATE inventory SET name = REPLACE(name, 'Deploy Treads', 'Gangplank Treads') WHERE ref = 'treads' AND name LIKE '%Deploy Treads%';
UPDATE inventory SET name = REPLACE(name, 'Ring of Idempotence', 'Ring of Steady Tides') WHERE ref = 'ring' AND name LIKE '%Ring of Idempotence%';
UPDATE inventory SET name = REPLACE(name, 'Linked Bands', 'Mooring Bands') WHERE ref = 'bands' AND name LIKE '%Linked Bands%';
UPDATE inventory SET name = REPLACE(name, 'Legacy Keystone', 'Lighthouse Key') WHERE ref = 'keystone' AND name LIKE '%Legacy Keystone%';
UPDATE inventory SET name = REPLACE(name, 'Blameless Badge', 'Harbormaster''s Badge') WHERE ref = 'badge' AND name LIKE '%Blameless Badge%';
