# Changelog

## 2026-05-15 — Combat & Inventory UX fixes

### Solo quest heal/shield auto-target
Solo questers no longer get a one-option "pick a target" prompt when healing or shielding. Heal/shield fire on self immediately. Multi-party combat is unchanged.

### Auto-resolve checkbox engages immediately
Previously, ticking "Auto-resolve enemy turns" while the first enemy turn was already on the board did nothing — you had to manually resolve once before it kicked in. The checkbox now engages right away on whichever turn is current.

### Party dice separated from enemy dice
Combat dice rolls used to pile into a single row at the bottom of the screen, making it hard to tell who rolled what (especially solo). Rolls are now split into two labeled rows — red "Enemy" above, blue "Party" below.

### Selling items keeps inventory open
Confirming a sale used to dismiss the inventory modal underneath, so each sell forced you to reopen inventory and re-scroll to the next item. Inventory now stays mounted under the confirm dialog; after Sell or Cancel you land right back where you were.
