-- Only worn gear can be hidden; what is held in the hands (weapon, shield) is
-- always shown. Clear the flag on any hand piece hidden before that rule.
UPDATE inventory SET hidden = 0 WHERE hidden = 1 AND slot IN ('main_hand', 'off_hand');
