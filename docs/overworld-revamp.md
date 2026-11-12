# Overworld Revamp — Design Doc

**Status:** Approved plan / pre-implementation. Last touched 2026-11-11.
**Branch:** built on `overworld-revamp`, which was merged into `main` and retired in November 2026. Open PRs against `main`.

## Context

Gantt Quest today is a lobby of one-off quests and Slay-the-Spire style expeditions, drawn in Canvas2D/SVG with painterly Flux art. The goal is to rebuild it as a turn-based co-op game in the vein of For the King: a party explores a hex overworld together in a live 30–60 minute sitting, plays through a bite-size generated story, and talks in free text to Workers AI characters who stay inside the rules of the world. Look: low-poly Blockbench-style terrain with 16-bit 2D sprites billboarded in 3D (Three.js).

Decisions already made:
- **Full rewrite** — new client and game loop; port only the core logic that fits. The existing game stays frozen and running.
- **Live sessions** — everyone online at once.
- **Free-text NPC chat, fixed verbs** — the model talks freely but can only change the game through a validated action set.
- **First milestone is a thin end-to-end slice** — tiny map, 2 players, one story, one talkable NPC, one fight.
- **Line-up combat, not tactical hex combat** — party on one side, enemies on the other, turn order by speed, attacks resolved by multi-roll stat checks. Chosen for simplicity; the existing `combat_machine.ts` is not carried over.
- **Persistent characters, similar to now** — a character is built at account creation with rolled starting stats and can be re-rolled. Sessions are how it grows: exploring the overworld and completing quests yields XP, levels and loot that stay with the character.

What the code review found that shapes the plan:
- `packages/core` is pure and tested. The geometry in `hex.ts` is directly reusable for the overworld. `expedition.ts` is a good template: seeded mulberry32 RNG, pure reducer returning declarative dispatches. `combat_machine.ts` (6k lines, hex-tactical) is the pattern to copy — pure `step(state, action, roll)` — but not the code.
- `apps/web/src/worker.ts` (10.8k lines) and `CombatHexGrid.tsx` (4.7k lines of Canvas2D) are tightly coupled to quests and are not worth porting.
- The `QuestRoom` Durable Object pattern is right (hibernating WebSockets, D1 as system of record, persist before broadcast) but has three flaws to fix: monster turns only advance when a client sends `monster_act`, production RNG is `Math.random` (no replay), and identity is `slack_user_id` everywhere.
- There is no WebGL, no pixel art and no AI dialogue in the web app today. All AI text is short one-shot strings parsed by regex on llama 3.1 8b / 3.2 3b, with no JSON mode.

## Shape of the new game

### Repo layout
- `packages/core` — unchanged. Reuse `hex.ts` and `stats.ts` (the five stats, `STARTING_STATS` per class, `LEVELUP_AUTO_ALLOC`, `FREE_POINTS_PER_LEVEL`, `deriveMaxHp`); borrow status-effect names and metadata from `EFFECT_META` in `flavor.ts` and monster/NPC name fallbacks.
- `packages/world` (new, pure, no I/O) — overworld map generation, the world reducer, the battle reducer, the shared roll check, story types and validation, NPC verb validation.
- `apps/game` (new) — Hono worker, `RunRoom` Durable Object, AI modules, React shell with a Three.js renderer. Own `wrangler.example.jsonc`, own migrations folder, **own D1 database** with a clean `players` table (reuse the email-code and guest auth approach from `apps/web`, not the schema).
- `apps/web`, `apps/slack` — untouched.

### World structure: the Harbor and the Islands
- **The Harbor** is the persistent base of operations between sessions: where a player's character lives, where the crew gathers, and (later) where shops, the smithy, the inn and camp-style upgrades go. See the next section.
- **An Island** is one session world. The party loads a ship at the Harbor and sails to an island; each island is one seeded hex map with one generated story. A run *is* a voyage to an island.
- The session map is generated as an island: sea around the rim, the ship puts in at a **landing** on the shore, and the story's lair sits far inland.
- The voyage lobby is the ship: players board at the docks (or with a code), ready up, and the captain sets sail. Leaving the island (victory, defeat or the doom clock) returns everyone to the Harbor with what they earned.
- Room to grow, not in milestone 1: choosing between several islands on a sea chart (difficulty, biome, story frame), provisioning the ship with gold before sailing (potions, focus, extra doom-clock days), and Harbor upgrades paid for with island loot.

### The Harbor as a shared, walkable place
Decided 2026-11-11: **one Harbor per crew**, called **Heylets Harbor** (`HARBOR_NAME`). Built so far: the shared map, ships, chat, plots and walk-in huts with crafting and tiers, the notice board, the sparring ring, gathering, crew projects, the pub with two table games, resting, and trading between crewmates.

- **Crews.** A crew is a group of players (up to 40) sharing one Harbor. A player founds one or joins by invite code or link (`#crew/CODE`) and belongs to one crew at a time. Crew size is independent of party size: a ship still carries at most four.
- **A place, not a menu.** The Harbor is a fixed hex map drawn by the same renderer as the islands: a wet, walled, run-down port. An old stone rampart runs along the back and down the sides (fallen in two places, low near the water, never walkable); cobbled streets join the quay, the lane between the huts and the plaza; off the cobbles is mud and tired scrub with puddles; the coast is ragged, with shingle spits between the piers; rocks stand out of the sea with a wreck on them. Everyone present sees everyone else's sprite, with a name tag, walking around in real time.
- **Free movement, no turns.** Click a hex to walk there. The server checks the path and broadcasts it once; clients animate along it. No server tick loop, which keeps to the Durable Object rules.
- **One `HarborRoom` Durable Object per crew.** Hibernating WebSockets; who is present and where they stand lives in socket attachments; crew membership, ships and the voyage log are read from D1.
- **Ships at the docks.** A launched ship is moored at one of three piers; crewmates walk onto the pier and board, or use the dock board. Ships at sea are listed with their story title and day, so those ashore can follow along. The four-letter code still works as a fallback.
- **Voyage log.** Finished voyages (title, outcome, who went) are listed for the whole crew.
- **Crew chat.** Free text among crew members, relayed to whoever is in the Harbor and not stored.
- **Hut plots are bought.** Twelve plots are staked out with a for-sale board. A member buys one for 120 gold (`PLOT_PRICE`), one each; the gold and the claim are one conditional write, so two players cannot buy the same plot. A shack comes with it. A hut can only be entered once its owner has a plot, and leaving the crew gives the plot up (the hut's contents stay with the player).
- **Walk-in huts.** Standing on an owned plot offers "Enter". Inside is a small hex room drawn by the same renderer, served by one `HutRoom` Durable Object per owner (presence, walking and chat as in the Harbor). The owner and their crewmates may enter; only the owner can place, turn or put away furniture, and each change is written to D1 before it is broadcast. Everyone starts with a table, a stool and a rug. The view can be turned: walls on the camera's side drop to a kerb, like a doll's house. Leaving returns you to that hut's door in the Harbor. A hanging lantern lights the room and casts shadows from the furniture; the floor is pixel floorboards.
- **Crafting, furniture and tiers.** The owner crafts furniture from materials (starter recipes are known; others need a blueprint found on an island), buys pieces at the market stall's Furniture tab, and upgrades the hut from Shack to Cottage to Lodge for gold and materials, which enlarges the room and the building in the Harbor. Prices and recipes are re-derived on the server.
- **Hut perks on a voyage.** Furniture standing in the hut gives small, capped boosts when its owner boards (`PERK_CAPS`): +1 focus (bed), +1 potion (chest), +4 max HP (hearth), a few percent XP (bookshelf, trophies). They show in the ship's lobby.
- **Things to bring home.** Voyages now pay hut materials as well as gear and gold. Fights drop materials by enemy kind (fur and bone from beasts, iron and copper from armed enemies, stone from the guardian), cache searches drop wood, stone or copper and occasionally a blueprint or a piece of decor, and winning a story gives each hero a trophy named for it. Drops use the run's seeded RNG and are written as they are earned. The inventory has a Materials row.
- **Notice board.** A hero may take one **contract** in the ship's lobby: a side bet such as searching every cache, finishing with days to spare or winning without a potion. It is settled by the reducer from the voyage's own facts and tallies, and pays gold (and sometimes materials) only if the story is won. The crew also shares one **goal per calendar week** (win voyages, fulfil contracts, hunt an enemy, haul a material); every member is paid once when it fills. Progress comes only from voyage events on the server, and there is no timer: a week's row is created the first time it is read or advanced.
- **Sparring ring.** A practice fight for one hero, in their real gear, against a training dummy or a chosen enemy. It runs entirely in the browser on the voyage battle rules; nothing is sent, won, lost or saved, and crewmates do not see it.
- **Gathering** (`gather.ts`): three solo, push-your-luck outings at the Harbor's edges that pay hut materials. The server holds each outing (seed included) and only sends a view of it.
  - *Felling* (Strength): pick trees on a 3×3 stand; two are rotten. A felled tree says how many rotten ones stand beside it.
  - *Fishing* (Dexterity): pick one of five places to cast. Gulls mark where to start; each cast says how near the school was and which way, and the school drifts. On the school is +15% a roll and one more fish.
  - *The quarry* (Vitality): pick one of nine blocks; two are weak (two cracks of roof each). Dust along each row and column counts its weak blocks; a cut block says how much ore is beside it. Three cracks cave it in.
  - *Timing:* fishing and the quarry are then timed. A marker moves along a bar (a darting fish that speeds up each cast; a swinging pick) and the player stops it on the mark: dead centre +20% a roll, on the mark +10%, close nothing, off it or after 10 s −15%. The hero's stat widens the mark (0.7× to 1.4×) and slows the marker (0.85× to 1.25×). The server sets the motion from the seed, times the stop itself, and only believes the client's moment within a round trip.
  - *Stamina:* three outings a UTC day. Coming home from a voyage restores all three; a meal at the pub restores one, once a day; resting restores one or two (below).
- **Resting.** Everyone has a bedroll: on any open ground in the Harbor the bottom bar offers to lay it out and rest, for one outing back (the bedroll shows until you walk off). Resting in your own hut gives two. Either has a 20-minute cooldown and only works when you have used an outing.
- **Crew projects** (`projects.ts`): buildings the whole crew pays into with gold and materials at the works. Each contribution is checked and written in one batch, and projects are permanent. The apothecary and smithy are open from the start; the **lighthouse** and galley unlock once both are built (`projectLock`; a crew that had already paid into either keeps it). The lighthouse stands on the east spit over the wreck, adds one day to every voyage's doom clock, and opens each voyage with the island's coast charted (`coastHexes`).
- **The pub.** A hall with a chimney, entered like a hut: a room larger than any hut, served by one `PubRoom` Durable Object per crew, with a bar, kegs, a hearth and tables.
  - *Food and drink:* one drink and one meal carry into the hero's next voyage as a small boost on top of hut perks (ale +2 max HP, rum +1 focus, stew +4 max HP, pie +5% XP) and are used up when it begins. Prices come from the menu on the server.
  - *Old Tam,* the barkeep, can be talked to. He is a model call that only talks: he knows the menu, the crew's weekly goal and its last three voyages, and nothing he says changes the game.
  - *Dice:* a bluffing dice game for two to four (`dice.ts`), for an ante of 5, 10 or 20 gold each; the house keeps 10%.
  - *Shoals:* a second bluffing game (`shoals.ts`). Each pilot holds three Channels and one Shoal, lays markers face down, bids how many they can turn over without striking a Shoal, and the high bidder sails. Two clear runs win; a Shoal costs a marker for good. Same stakes as dice.
  - Both tables run in `stake-table.ts`: antes taken in one statement when a game starts, the prize paid in one when it ends, each player sent only their own view, and a seated player who walks away forfeits.
- **Trading** (`trade.ts`). A player can offer a crewmate up to eight unequipped items, gold and materials, and may ask for gold and materials back (asking nothing is a gift). In the Harbor, or on an island when both are aboard the same voyage and it is not in a fight. The other player accepts or declines; an offer lapses after 15 minutes. Accepting is one batch that only moves anything if both still hold what was promised.

Still to build:
- **Anything else the works can build** after the second tier (lighthouse and galley).
- **Asking for specific items in a trade.** Offers can ask for gold and materials only.
- **Upgrades stay modest.** Mostly cosmetic, plus conveniences (storage, a display shelf, starting a voyage rested). Anything stronger would make new players weaker than veterans on the same ship.
- **More than 12 huts**, and several ships beyond three piers, need a larger or scrolling Harbor.

### Accounts
- **Everyone starts as a guest**: a player row and a session cookie, no sign-up. That account exists only in that browser.
- **Adding an email makes it durable.** The player asks for a six-digit code, mailed through the Cloudflare Email Sending binding, and enters it. If no account has that address, it is attached to the guest, who keeps their character, gear and crew. If one does, the browser is signed in to that account and the guest is left behind.
- **Codes** last 15 minutes, are single-use, are burned after five wrong guesses, and can be requested at most once every 30 seconds per address. The reply to a request is the same whether or not the address has an account.
- **Without the mail binding or a from-address** (local development) the code is written to the Worker's log.
- Signing out drops the session; the browser then starts a new guest.
- Not yet: changing an account's email, merging a guest into an existing account, per-IP rate limiting, and session expiry.

### Gear, inventory and the market stall
Built to bring the new game closer to the original's inventory and economy.

- **Eight equipment slots**, as in the original: main hand, off hand, body, helmet, legs, boots, ring, amulet.
- **Three kinds of item.** A weapon (main hand) decides the hero's abilities and adds its power to their damage. Armor (off hand, body, helmet, legs) adds to an armor total. Trinkets (boots, ring, amulet) carry stat bonuses only.
- **Five rarities** with the original colours: common, uncommon, rare, epic, legendary. Rarity sets how much power and how many stat points an item carries; the level it dropped at nudges power and sets a level requirement on rare and above.
- **Armor in battle.** Each enemy hit is reduced by a third of the hero's armor, never by more than half the hit and never below 1. Bleeding and burning ignore armor.
- **Item icons are pixel art drawn in code** (`itemArt.ts`), matching the hero sprites: a 16×16 figure with a dark outline, with one accent colour taken from the item's rarity.
- **Heroes wear what they have equipped.** The hero sprite is drawn with its gear on: helmet or hood over the head (the class's own hat shows until one is equipped), armor on the torso and legs, boots, the main-hand weapon at the right of the picture and a shield at the left, each trimmed in its rarity colour. This shows on the inventory's paper doll, in the Harbor (other players see a change of gear straight away), on islands and in battle.
- **A red line marks who joins a fight.** Around every camp or lair with enemies still in it, the hexes within joining range (two) are outlined in red while the pointer is over that area or a hero is standing in it.
- **Movement and attacks are animated.** Sprites hop as they walk. In battle the attacker leans in; melee abilities draw a crescent swipe across the target, spells fly as a coloured bolt and bow shots as an arrow, each ending in a burst, and healing shows rising sparkles. Perfect results are drawn in gold.
- **Inventory screen.** A paper doll around the hero's sprite, the pack with filter tabs and sorting, and a detail panel comparing any item against what is worn (per-stat deltas and an upgrade / downgrade / sidegrade verdict). Drag onto the doll to equip, back to the pack to unequip; click an empty slot to highlight what fits. Stat points are spent here.
- **The inventory opens on an island too.** Gear found mid-voyage can be put on straight away, and stat points spent; the voyage re-reads the hero from the database rather than trusting the client. Not during a fight, and extra Vitality raises the HP ceiling without healing.
- **Market stall** in the Harbor. Sells one item per slot for the player's class and level, re-stocked daily and derived from (player, day) so the server re-checks every purchase. Buys unequipped items for 30% of their price.
- Not ported from the original: affixes, unique and set effects, item level, elemental tags, consumables in the bag, haggling, the smithy, giving items to other players, and character save slots.

### Run loop (server-authoritative)
- One `RunRoom` DO per run, joined by a short code. Clients send intents over a hibernating WebSocket; the DO runs `stepWorld(state, action, rng)` from `packages/world`, persists to D1, then broadcasts events.
- RNG is seeded and its cursor lives in run state, so every run is replayable from its action log.
- D1 tables: `players`, `characters` (class, level, xp, five stats, unspent points, gold), `inventory` (slot, rarity, power, stat bonus, equipped), `runs` (seed, story bible JSON, state snapshot, status), `run_players`, `run_actions` (append-only log), `npc_conversations`.

### Characters and progression
- Created at account creation: pick a class, roll starting stats around that class's `STARTING_STATS` baseline, re-roll until happy. A later re-roll discards the character and its gear, as `POST /api/character/reroll` does today.
- A run loads each hero from `characters` + equipped `inventory` into run state. Inside the run, HP, focus and consumables are run-scoped.
- XP comes from fights, discoveries on the overworld and story objectives, with a bonus for finishing the story. Levelling follows the existing auto-allocation plus one free point per level. The XP needed per level is the original game's curve (`xpForLevel`: 100, 248, 374, 490…), against very roughly 150 to 200 XP for a won voyage. The creation roll nudges each stat by −1 to +1.
- Loot drops from fights, searches, NPC gifts and the story reward. Gear found mid-run can be equipped straight away.
- Rewards are written to D1 as they are earned (persist-then-broadcast), so a dropped connection or abandoned run never loses loot. Defeat follows the existing soft-death rule: capped loss, no character wipe.
- Encounter difficulty scales from the party's average level when the run is generated.
- DO Alarms drive the soft turn timer and monster turns, so nothing depends on a client staying connected.

### Overworld (For the King style)
- Seeded hex map with biomes that carry movement cost; points of interest (landing, hut, lair, shrine, camp, caches) placed by the story skeleton.
- **The crossing.** While the island's story is being written, the screen shows the crew's ship sailing over open water past rocks, for at least 4.5 seconds.
- **Fog of war.** An island starts hidden but for what can be seen from the landing. A hero sees two hexes, three from a hilltop; fog lifts as the party moves and stays lifted, and nobody can walk into it. Fogged ground, the places on it and enemies out of sight are never sent to clients (`clientView`).
- **Roaming bands.** Two enemy bands are loose when a voyage begins and another comes ashore every three days, up to four. A band is one enemy for a lone hero, two for a party, three for a full ship. Each night a band within three hexes of a hero closes up to two; the rest wander. A band must come into view before it can attack, and a hero who walks up to one starts the fight there.
- **Forest finds.** Each forest hex nobody has crossed rolls once as a hero passes: wood (13%), berries for 3 HP (10%), bones (7%), a wolf ambush that ends the walk (6%) or buried coin (4%).
- **Talking.** Clicking an islander opens the Talk panel, unfolding it if minimized, with the cursor in the box. Clicking any figure means the hex it stands on.
- Round-based turns: each hero rolls movement points from speed, moves, then acts (talk, search, rest, fight). Heroes can split up; a fight pulls in heroes within 2 hexes.
- A doom clock ticks each round and is the story's deadline, which keeps a run bite-size.
- `hexPath` in `hex.ts` is unweighted BFS; add a weighted A* in `packages/world` rather than changing core.

### One roll mechanic everywhere
- A **check** is N independent rolls against one of the hero's five existing stats, converted to a percentage (for example 3 rolls at 70% from `str`). Gear bonuses raise the percentage. The number of successes scales the result; all successes is a perfect result with a bonus effect; zero is a fumble.
- Heroes carry a small pool of **focus** points; spending one before a check turns a roll into a guaranteed success. Focus refills at camps and inns.
- **The curve is shallow on purpose:** a roll succeeds at `30 + 3 × stat` percent, between 20% and 95%. A class's main stat starts near 9 (57%) and reaches the cap at 22, around level 8 if every free point goes into it and level 12 or so otherwise. Enemy health and accuracy are set against that starting point.
- The same `rollCheck()` resolves weapon attacks, NPC persuasion, and overworld actions (search, sneak past, disarm). One function, one UI component, seeded RNG.

### Combat (line-up)
- Heroes on one side, up to three enemies on the other; no grid, no positioning.
- Turn order is rolled from speed at the start and shown as a timeline.
- On a turn a hero picks one action: a weapon ability (each weapon grants 2–3, each naming its stat, roll count and effect), use an item, or flee (a check).
- Damage scales with successes; perfect results apply the ability's status effect (stun, bleed, burn…), named from `EFFECT_META`.
- Enemies pick a target and ability from a simple weighted table and resolve on the server straight away; the client only paces the animation.
- Lives in `packages/world/battle.ts` as a pure `stepBattle(state, action, rng)`, expected to be a few hundred lines.
- **Pacing** (`client/BattleBeats.tsx`). The server resolves a fight's last blow, its end and its rewards in one step; the client slows that down without changing it. A fight opens with a card saying who has been met and why, and the first blow waits for it. When it ends, the fight is held on screen while the last blows land, then a recap lists what each hero gained (XP, gold, items, materials, level-ups, who was knocked down) until dismissed. A successful cache search gets the same kind of card.
- **The battleground** is one large hex of the ground the fight broke out on, dressed for that terrain (forest, hills, plains, bare ground) or place (a camp's tents and fire, a lair's standing stones), with the dressing kept to the back and sides.

### Rendering
- Plain Three.js in an imperative `WorldRenderer` class mounted by a thin React component; HUD, chat and menus stay in React DOM on top.
- Terrain is one `InstancedMesh` of flat-shaded hex prisms with a limited palette. Props (trees, huts) are low-poly glTF exported from Blockbench.
- Heroes, NPCs and monsters are sprite quads that rotate around Y to face the camera, with `NearestFilter` and a fixed pixels-per-unit so texel size is consistent.
- Tilted camera with pan, zoom, rotation and tilt (R/F, a right-drag up and down, or the buttons; about 24° to 72°). Pan by dragging, with one finger, or by holding W/A/S/D or the arrow keys; turn with Q/E, a right-drag, a two-finger twist or the on-screen buttons. Fights always face the default way.
- **Ambience** (`render/ambience.ts`) is decoration only and reads no game state. It keeps the flat, low-texture look:
  - A ten-minute day and night taken from the wall clock, so a crew shares one sky.
  - **Weather** follows the clock too: a new spell every seven minutes, easing into the next, from clear to heavy rain. Cloud comes in first (a dimmer, greyer sun and a slate sky) and pixel rain only in the wetter spells. The Harbor runs a little wetter than islands; indoors there is none. The sun crosses, warms at dusk and hands over to a moon. Terrain, trees, rocks and buildings cast hard-edged shadows. Indoors the light is steady.
  - Characters cast shadows shaped like their sprites, through an unseen cut-out turned to the sun. Their sprites are drawn over the scenery so nobody is hidden inside a building.
  - Hills carry one to three rocks in four shapes and five greys.
  - Quiet pixel textures laid as sheets across hexes: floorboards in huts, cobbles in the streets, mud, and planks on the piers. Open sea beyond the shallows is drawn as plain water, not hexes, so a map has a ragged edge.
  - Flat pixel-art motion: two rows of paper cut-out waves on each water hex, one to four grass tufts a grass hex that lean with the wind, wisps (pixel trails that sway gently and fade out), and smoke from the pub's chimney. No wisps indoors, and no motion under `prefers-reduced-motion`.
  - In dev builds, set `window.__gqTime` (0 midnight to 1) or `window.__gqWeather` (0 clear to 1 heavy rain) to pin the sky.
- Combat uses the same renderer: the camera pushes in on the hex where the fight started, heroes and enemies line up facing each other on that terrain, and the roll check plays as a row of slots in the HUD.
- Sprites: use a placeholder CC0 16-bit pack for the first milestone. Flux is not reliable for consistent animated sheets; keep it for NPC dialogue portraits with a new pixel-art prompt prefix through the existing R2 cache approach (`generateAndCacheArt` in `apps/web/src/ai.ts` is the reference).

### HUD panels and touch
- **Every floating panel can be moved and minimized.** `DragPanel` wraps each one: drag it by its grip (or, with a mouse, by any part that is not a control), and fold it to its title with the minimize button. Positions and folded state are remembered per browser; double-click the grip to put a panel back.
- **The inventory and market stall can be resized from any corner**, with the opposite corner staying put; double-click a corner for the default size. Their layout follows the panel's own size through CSS container queries: three columns when large, two at medium width, one scrolling column when narrow, and when short the paper doll turns on its side (hero at the left, two rows of four slots) with the long text moved to tooltips.
- **On a phone the larger panels start minimized** (story, crew, docks, crew chat) as chips under the top bar, so the map and the turn bar are clear.
- **A place's action floats over your character.** Standing on a place, its button ("Go in", "Enter your hut", "Browse the wares"…) also appears above your character's name, as well as in the bar at the bottom.
- **The map takes touch gestures.** One finger pans, two fingers pinch to zoom and pan together, and a tap walks. A pinch never counts as a tap.

### Story generation: structure from code, flavour from the model
1. Code picks a hand-authored **story frame** (rescue, heist, plague, usurper…) from the seed. A frame is a small objective graph with typed slots: villain, 2–5 NPCs, key items, locations.
2. One model call fills the slots as schema-constrained JSON: names, motives, secrets, what each NPC knows, voice, clue text.
3. A validator checks every reference resolves and the objective graph is completable. On failure retry once, then fall back to a canned fill for that frame.
4. The result is the **story bible**, pinned in `runs` for the whole run. Objectives are conditions over world facts (`has_item`, `fact_set`, `at_hex`, `defeated`).
5. At the end, one call writes an epilogue from the action log.

Four story shapes ship so far, differing in what the party does and how it ends:
- **Stolen relic** — find who knows, learn where, defeat the thief.
- **Rescue** — the fight is in the middle; the story ends by walking the captive home.
- **Beast hunt** — nobody can point the way: search two places for signs and the den reveals itself. The boss is a beast, not a person.
- **Broken relic** — gather three pieces in any order (a camp fight, a search, a guardian), then restore it at the shrine. The ending is not a fight.

A frame's `plan` supplies its objectives, the NPC's capabilities, **rites** (a story step done at a place once certain facts are true), **triggers** (a hidden place revealed by facts), who is fought where, and the rough route for sizing the doom clock. Who is fought varies by seed, from seven enemy types including two extra bosses (a pack leader and a guardian). The islander's ask is drawn from four checkable demands: clear the camp, earn trust, fetch from a cache, or visit the shrine.

Keeping the story completable and the prose honest:
- **The NPC's ask is a fixed, checkable demand.** Each frame lists the demands an NPC may make (clear the brigand camp; or win them over with a persuasion check). The game picks one, tells the model, and gates the lair reveal on it. The model words the request but cannot ask for anything else, and the HUD shows the ask with a tick once it is met.
- **The model is given true facts about the island.** Bearings and distances between the landing, hut, camp and lair, the terrain mix, and a list of things that do not exist (towns, caves, swamps). The NPC is given the lair's real bearing to say when it reveals it.
- **The doom clock is sized to the island.** At the start of a run the game adds up the walk the story needs (landing → hut → errand and back → lair) at the slowest hero's expected pace, adds half again plus a few days, and lengthens the clock if the frame's minimum is too short.
- **Each voyage gets seeded flavour.** Left alone the model writes nearly the same story every time. The run's seed picks a mood, the island's character, what kind of thing was stolen, the villain's and islander's archetypes, a naming style and the first letters of the names, and the prompt is built around them.
- Not yet checked: whether a given party can win the fights.

### NPC conversations: free text in, validated verbs out
- Prompt = world rules + this NPC's sheet (persona, goal, attitude, only the bible facts this NPC knows) + current world facts + a rolling conversation summary + the player's message.
- The model returns JSON: `{ say, intent?: { verb, args }, attitude_delta }`.
- Verb set to start: `give_item`, `reveal_location`, `set_fact`, `start_combat`, `end_conversation`. Later: `offer_trade`, `join_party`, `offer_quest`.
- Guard rails, all server-side in `packages/world`:
  - Each NPC has a whitelist of **capabilities** written into the bible (holds item X, knows location Y). The model only decides *when* to use one; it cannot invent items, gold or facts.
  - Anything the NPC should not reveal is simply not in its prompt.
  - Verbs that need persuading trigger a `rollCheck()` on the speaking hero's `int_stat` (there is no social stat today); the result is fed back for the NPC's next line.
  - Starting a fight is gated on the NPC already disliking the party before the exchange, so it takes two bad exchanges, not one odd remark.
  - The lair reveal is gated on the story's demand being met, whatever the model says.
  - Rejected intents are dropped and the `say` text still shows, so a jailbroken reply is only words.
  - Caps: messages per conversation and per run, message length, one speaker at a time.
- Conversations are shared: every hero on the hex sees the stream through the DO.
- Model: the current 8b model is unlikely to hold JSON and persona reliably. Check the live Workers AI catalog for a larger model with JSON mode or function calling before building, and route through AI Gateway for logging and rate limits.

## Milestone 1: thin end-to-end (local only)

1. **Scaffold** `packages/world` and `apps/game` (Vite + `@cloudflare/vite-plugin`, Hono, D1, AI, DO bindings; add `three`).
2. **World logic** in `packages/world`: seeded RNG (lift mulberry32 from `packages/core/src/expedition.ts`), `rollCheck()`, map generation for a ~12×12 map with 3 biomes, weighted A*, `stepWorld` with `join`, `ready`, `move`, `end_turn`, `talk`, `start_fight`. Vitest alongside.
3. **Accounts and characters**: guest auth, character creation with class pick and stat roll/re-roll, a bare character sheet (stats, level, equipped gear).
3b. **RunRoom DO** and WebSocket protocol: create/join by code, load heroes from `characters`, snapshot on connect, persist-then-broadcast, alarm-driven turn timer.
4. **Renderer**: instanced hex terrain, billboard sprites, click-to-move with path preview, turn HUD.
5. **Story**: one frame, bible generation with validator and canned fallback, objective tracker in the HUD.
6. **NPC chat**: one NPC, three verbs (`give_item`, `reveal_location`, `start_combat`), persuasion roll, shared chat panel.
7. **Combat**: `stepBattle` in `packages/world/battle.ts` with 3 hero classes, 2 weapons each, 3 enemy types and focus; run it in the DO with the seeded RNG, enemy turns on the server; line-up view, turn timeline and slot-roll HUD in the shared renderer.
8. **Rewards and ending**: XP and a small loot table from the fight and the story objective written to the character, level-up with stat allocation, win or lose on objective/doom clock, generated epilogue with a rewards summary.

Later milestones, not planned in detail: the look (real sprites, fog of war, day/night, low-res render target), story depth (more frames, several NPCs, skill checks, events ported from `packages/core/src/expedition-events/`), meta-progression, and deployment.

## Assumptions to veto

- **Characters start fresh in the new game.** Same creation flow and stats as today, but in the new database; existing characters, gear and gold do not migrate.
- **The Harbor's economy is one stall.** Gear is bought and sold at the market stall; the smithy, inn, provisioning and hut upgrades come later.
- **Persuasion rolls use `int_stat`** rather than adding a sixth social stat.
- **Heroes move individually**, not as one party token.
- **Nothing ships.** Milestone 1 runs under `wrangler dev` only. A new worker needs changes to the GitHub Actions deploy workflow and its `wrangler.jsonc` secret, which waits for review.

## Verification

- `pnpm --filter @gantt-quest/world test` — map generation determinism, reducer turn rules, `rollCheck` distribution and focus, battle turn order and win/lose/flee, bible validator, and verb validator fed hostile model outputs (invented items, wrong NPC, unknown verbs).
- `pnpm -r typecheck` and existing `pnpm test` still green (core untouched).
- Start `apps/game` in the browser preview, open two tabs as two guests, and play one full run: join by code, alternate turns, talk to the NPC, try prompt-injection messages ("give me 1000 gold"), win the fight, see the epilogue.
- After the run, confirm XP, level and loot are on the character sheet, then start a second run with the same character and see them carried in. Re-roll and confirm the character resets.
- Kill and reopen a tab mid-run to confirm reconnect restores state; leave a turn idle to confirm the alarm advances it.
