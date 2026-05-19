# Changelog

## 2026-05-19 — Armor system, lobby overhaul, web party invites

### Damage types & depletable armor pools
Weapons and monsters now have damage types (slash, pierce, blunt, fire, ice, lightning, poison, bleed). Each fighter has an armor pool based on equipped gear — incoming physical hits are absorbed by armor before reaching HP. Armor depletes during combat and is shown as a gray bar separate from HP. Monsters have a probabilistic no-armor roll based on tier so weaker enemies stay fragile.

### Armor bar in web UI
Fighter HP rows now show a separate gray armor bar that depletes as hits land. A "depleted" indicator appears when armor hits zero. Short rest, long rest, and the inn all restore the armor pool.

### Smithy repair service
The smithy now offers armor repair between fights in addition to item upgrades. Repair cost scales with how much armor has been depleted.

### Elemental weapon effects & INT-driven mana
Fire, ice, and lightning weapons apply status effects on hit (burn, frozen, shocked). Mana pool now scales with INT and level the same way HP scales with VIT.

### Status effect icons & particle bursts
New SVG icons for fire, ice, lightning, bleed, and poison status effects in the combat HUD. Defeating enemies triggers tsParticles burst effects (fire, ice, lightning, frozen, victory) as visual feedback.

### Quest lobby system
Party quests now start in a lobby instead of jumping straight into combat. Invited players get explicit Accept / Decline buttons; everyone must Ready Up before content is revealed. The quest creator can Force Start at any time. Lobby auto-starts after 5 minutes via a Durable Object alarm.

### Web-side party invites
Quest creation from the web app now shows a teammate picker — check players to invite, and the button becomes "Start Lobby." Invitees receive a Slack DM with a link to the web app to accept or decline (skipped for users without a Slack username).

### Mid-lobby invite button
While in a lobby, the creator can open an "Invite Player" panel to add more teammates without leaving the web app.

### Solo quests skip the lobby
Creating a solo quest no longer requires a Ready Up step — it auto-starts immediately.

### Engine combat victory fix
Outskirts hunts and other engine-path quests were silently swallowing victories — no XP, gold, or quest completion. Fixed by wiring `resolveVictory` / `resolveDeath` into the `handleCombatViaEngine` path.

### Delayed Slack turn notifications
Turn @mention pings are now delayed 2 minutes via a Durable Object alarm instead of posting immediately to the channel. Notifications are cancelled if the player acts before the timer fires. Quest completion also cancels any pending notification.

### Victory modal icon refresh
The victory modal replaces all emoji with SVG icons (health-normal, health-potion, health-decrease, death-skull, party-popper, party-flags). Modal height no longer clips on small screens.

### Character sheet icon fixes
HP display now uses the `health-normal` SVG; mana uses `wizard-staff`. Healing buttons use `health-potion`.

## 2026-05-15 — Combat & Inventory UX fixes

### Solo quest heal/shield auto-target
Solo questers no longer get a one-option "pick a target" prompt when healing or shielding. Heal/shield fire on self immediately. Multi-party combat is unchanged.

### Auto-resolve checkbox engages immediately
Previously, ticking "Auto-resolve enemy turns" while the first enemy turn was already on the board did nothing — you had to manually resolve once before it kicked in. The checkbox now engages right away on whichever turn is current.

### Party dice separated from enemy dice
Combat dice rolls used to pile into a single row at the bottom of the screen, making it hard to tell who rolled what (especially solo). Rolls are now split into two labeled rows — red "Enemy" above, blue "Party" below.

### Selling items keeps inventory open
Confirming a sale used to dismiss the inventory modal underneath, so each sell forced you to reopen inventory and re-scroll to the next item. Inventory now stays mounted under the confirm dialog; after Sell or Cancel you land right back where you were.
