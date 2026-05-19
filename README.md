# gantt-quest

A team-comedic, engineering-themed dungeon-crawl that runs in **Slack** and in a
companion **web dashboard**, sharing a single state. Cloudflare Workers + D1 +
Workers AI + Durable Objects. No real coworkers as NPCs — names are generated.

> The repo is named `slack-quest` on GitHub for historical reasons; the bot ships
> as **Gantt Quest** via the `BOT_NAME` env var. Rename it for your team — the
> Cloudflare Worker name, D1 database name, and Slack app display name can all
> be changed without touching engine code.

---

## Architecture at a glance

Two Cloudflare Workers and a small set of Durable Objects share one D1 database:

```
┌─────────────────────┐      ┌──────────────────────┐
│  apps/slack         │      │  apps/web            │
│  (Slack worker)     │      │  (Web worker + SPA)  │
│                     │      │                      │
│  • slash commands   │      │  • dashboard + town  │
│  • interactive btns │      │  • web combat (WS)   │
│  • LobbyManager DO  │      │  • QuestRoom DO      │
│    (alarm timing)   │      │  • LobbyRoom DO      │
└──────────┬──────────┘      └──────────┬───────────┘
           │                            │
           └──────────┬─────────────────┘
                      │
           ┌──────────▼──────────┐
           │  D1 (one database)  │
           │  + R2 (art cache)   │
           │  + Workers AI       │
           └─────────────────────┘
```

- **Slack worker** handles `/sq …` slash commands, interactive button payloads,
  and the singleton `LobbyManager` DO that schedules lobby auto-start alarms
  and delayed "your turn!" notifications.
- **Web worker** serves the React dashboard, exposes the JSON + WebSocket
  combat API, and hosts the `QuestRoom` (per-quest live combat) and `LobbyRoom`
  (per-quest live lobby + chat) Durable Objects. Both DOs use the Hibernation
  API so idle connections cost nothing.
- **Cross-binding**: the Slack worker holds DO bindings into the web worker
  (`QUEST_ROOM`, `LOBBY_ROOM`) so Slack actions instantly push updates to web
  clients without polling.
- **D1 is the system of record.** DO in-memory caches always rehydrate from
  D1 after hibernation; nothing critical lives only in DO storage.

---

## Design pillars

- **Soft death by default.** At 0 HP on a standard quest you're "downed,"
  lose 25% gold + a random unequipped inventory item, and can't quest for 12h.
  Elite quests (`/sq quest elite`) opt into perma-death — the character row
  is deleted and survivors fight on.
- **Mechanics deterministic, flavor AI-written.** Damage rolls, status procs,
  drop rates, and XP math run on a pure engine (`packages/core`). Workers AI
  only writes the prose that wraps the result (opening scenes, hit flavor,
  item names, dungeon room descriptions). If an AI call fails, the
  deterministic line is shown.
- **Single source of truth across surfaces.** Slack `/sq attack` and the web
  Attack button hit the same engine via `QuestRoom`. Lobby accept/decline
  from Slack pushes to the web LobbyView in real time.
- **Two-surface visibility.** Most narration stays in the quest thread.
  Big beats (joins, gauntlet wave transitions, boss phase 2, perma-death,
  victories, expedition treasure reveals, lobby start) use Slack's
  `reply_broadcast` to surface in the channel and toast the web dashboard.
- **No GitHub integration.** Quests are AI-flavored from generic prompts.

---

## Characters & classes

`/sq roll` creates a character with a random class + AI-generated name. One
character per Slack user. Classes share five primary stats (STR / INT / VIT
/ AGI / DEX) under the STATS_V2 system — you spend points at level-up via
`/sq spend <stat>` (and from the web stat-allocator).

| Class | HP | atk | mag | Skills | Signature | Class ability |
|---|---|---|---|---|---|---|
| DevOps Mage | 22 | 1 | 1 | INT, DEX | **Detonate** | **Containerize** — skip a monster swing |
| QA Paladin | 28 | 2 | 0 | STR | **Smite** | **Regression Shield** — party-wide shield grant |
| Backend Druid | 24 | 1 | 1 | INT, STR | **Wildgrowth** | always-on party regen |
| Frontend Bard | 20 | 0 | 2 | INT | **Crescendo** | **Battle Hymn** — party attack buff stack |
| Staff Sage | 26 | 0 | 2 | INT | **Manifest** | **Foresee** — preview monster swings + reveal chest contents |
| Refactor Rogue | 18 | 2 | 0 | DEX | **Backstab** | **Vanish** — untargetable for N swings; first-attack guaranteed crit |
| SRE Warden | 30 | 2 | 0 | STR | **Bulwark Strike** | **Taunt** — force monster to target you; passive shield bump |
| Data Wizard | 22 | 0 | 2 | INT | **Soul Drain (Hex)** | crit-bleed passive |

Signatures cost 1 mana, share the combat cooldown, and have class-specific
formulas. Mana refills between quests and at level-up. Magic-type drop items
grant +1/+2/+3 max mana when consumed (capped at 5).

---

## Quest types

Started via `/sq quest <variant> [elite]` (or the Job Board for posted contracts):

- **`standard`** — single (or multi-monster pack) fight.
- **`boss`** (L3+) — single tougher monster with 2 phases at 50% HP. 2× rewards.
- **`gauntlet`** (L5+) — 3 monsters back-to-back, no flee, party locked at start.
  3× rewards, guaranteed drop on the final kill.
- **`dungeon`** (L4+) — grid-shaped expedition. AI generates the room theme +
  per-room scene art, and a graph of encounters / loot / lockboxes /
  traps / NPCs / merchants / boss room. Navigate via `/sq move <dir>` (or the
  web compass). 2.5× rewards.
- **`bounty_pack`** — multi-monster brawl. Each monster carries its own
  weakness/resistance profile.

`elite` is a modifier that composes with any variant — turns on perma-death.

The **Job Board** (`/sq board` or web town → Job Board) lists 3 posted-contract
quests at any time. Accepting one starts that variant with a small reward bonus
(`from_job_board` flag at victory).

---

## Lobby system

Every quest opens in a lobby before combat starts. Slack and web stay in sync
via the `LobbyRoom` DO (WebSocket push from the web side, RPC from Slack).

- **Invites & ready-up** — the creator invites teammates by `@user`. Each
  invitee Accepts or Declines; accepted players Ready Up. When all accepted
  are ready, the quest auto-starts.
- **Force Start** — creator skips remaining invites. Pending invitees are
  dropped (no party HP scaling).
- **Auto-start alarm** — 5 minutes after creation via the `LobbyManager` DO.
  Same flow as Force Start.
- **🔒 Lock** — creator toggles the chest icon to reject new invites + new
  `/sq join` calls. Already-pending invitees can still accept.
- **🗑 Cancel** — creator can abort.
  - Pre-combat: quest row + `quest_party` cascade deleted.
  - Mid-combat *reinforcement lobby*: only the pending invitees are dropped;
    the active fight continues untouched.
- **🆘 Reinforcement lobbies** — a creator on an *active* quest can click
  "Call Reinforcements" on the active-quest card. New invitees see a single
  "Join the Fight!" button that atomically accepts + refills mana + scales
  monster HP + pulls them into the live combat state via
  `QuestRoom.notifyFighterJoined`. No "wait for the rest to ready up" gate.
- **Real-time chat** — ephemeral per-quest chat lives in `LobbyRoom`'s
  in-memory ring buffer (50-message cap, dropped on hibernate, never
  persisted to D1). Disappears when combat starts.

---

## Combat

Turn-based, dice-driven, engine-pure. The same engine (`packages/core`) drives
both Slack and web combat — actions are deserialized into a `TurnAction`,
applied with `step()`, and the resulting state + events are broadcast.

### Actions
- `/sq attack` — 1d6 + weapon power + STR-derived bonus, crit ×2 on a nat 6.
- `/sq cast` — 1d8 + magic_mod + INT-derived bonus, crit ×2 on a nat 8.
- `/sq heal [@user]` — 1d6 + magic_mod + focus_power HP, costs 1 mana.
- `/sq shield [@user]` — refill the target's depletable armor pool, costs
  1 mana. On targets with `armor_power = 0`, grants a **flat bonus barrier**
  capped by `min(actor.level, target.level)` so a level-10 healer can't
  over-shield a level-1 ally.
- `/sq revive <id> @user` — consume a revive item to bring a downed
  partymate back at 50/75/100% HP (rarity-tiered). Can't self-revive.
- `/sq signature` — class signature; 1 mana.
- `/sq ability` — class active ability (Taunt, Vanish, Containerize, etc.).
- `/sq mark <target>` — focus-fire tag: party attacks get a bonus until
  expiry. Self-attacks by the marker DON'T get the bonus.
- `/sq position <front|back>` — swap rows. Front row eats hits first;
  back row gets reduced damage from melee but can be targeted by ranged.
- `/sq flee` — 1d2 self-escape. Quest fails only if you were the last.
- `/sq use <item>` — combat-usable items (consumable / tool / scroll).
  Damage tools cap at `monster_hp - 1` so they never deliver the killing
  blow.

### Damage typing
Every attack has a `damage_type`: `physical | magic | fire | ice | lightning`.

- **Physical** routes through your **armor pool** first (depletes shield,
  then HP). The pool's max is `floor(armor_power / 2)` where `armor_power`
  comes from equipped gear (body + helmet/2 + pants/4 + shield).
- **Magic / fire / ice / lightning** bypass the armor pool entirely and
  hit HP directly. Your `resist_<type>` stat (from gear stat_bonus) reduces
  the final damage by that percent.

Monster attack types are visible on the in-combat MonsterCard and the
Active Quest preview ("🔥 FIRE ATTACKS" pill) so you can plan loadouts
before clicking Open Combat.

### Status effects
- **Burning** — DoT, ticks at turn start.
- **Frozen** — your next turn is skipped (turn_skip event + particle burst).
- **Shocked** — incoming damage is amplified (×1.30 mag 1, ×1.45 mag 2).
- **Poisoned / Bleeding** — DoT variants from tools or weapon procs.
- **Regen** — HoT from heal items or Druid passive.

Sources:
- **Player weapons** with an element proc statuses on monsters (rate by
  rarity).
- **Monsters with fire/ice/lightning attack_damage_type** roll a 25%
  base chance × `(1 − resist/100)` on a successful hit to inflict the
  matching status on the player. **Lightning hits also arc to same-row
  allies** — each ally rolls independently with their own resist.

Status pills render on every fighter and monster card with matching color
+ icon + turn-remaining suffix.

### Visual feedback
- **Dust puffs** burst from a fighter card on every landed hit (Wile-E-
  Coyote tan/brown clouds, drift up + out).
- **Particle bursts** (Web Animations API) fire on element procs, hits,
  frozen / victory.
- **Hit flash + slash streak** on the target card.
- **Toast** when a status proc lands on the local player ("🔥 You're now
  burning! (3t)").

### Position rows & multi-monster packs
Fighters occupy a `front` or `back` row. Multi-monster fights (`bounty_pack`,
gauntlet waves) render a horizontal strip of `MonsterCard`s — each one is
individually targetable (click to mark, then `/sq attack`).

---

## Town

The web dashboard renders Town as a hub of locations; Slack mirrors most
of these as slash subcommands.

- **🏪 Shop** — 5 AI-generated rotating items + always-in-stock staples
  (potions). Stock is **channel-scoped** and restocks every 6 hours. Haggle
  is a free action (per item, per cycle). Bards / Sages / Rogues get a bonus
  on the haggle d6.
- **🔨 Smithy** — sharpens weapons (caps at SHARPEN_CAP per item) and
  repairs the armor pool to max for gold. Also sells rotating armor-only
  stock (channel-scoped, mirrors shop semantics). Sage's Foresee doesn't
  apply here — smithy items are open inventory.
- **🛏️ Inn** — paid alternative to long rest. Skips the 24h cooldown by
  spending gold. Restores HP / mana / armor pool.
- **🍺 Pub** — buy drinks for between-quest combat buffs (Tavern Ale,
  Espresso, Whiskey, etc.). Capped at 2 drinks between quests; resets on
  joining/starting a quest. Pub also hosts a 1v1 Stone-Parchment-Dagger
  betting game.
- **📋 Job Board** — 3 posted-contract quests at any time. Accept one for
  a reward bonus at victory.
- **🧪 Apothecary** — buy consumables / scrolls / revive items at fixed
  prices. Inventory rotates daily.
- **🌲 Outskirts (Hunt)** — start a custom-tier hunt quest. Pick a tier
  and monster count.
- **💤 Rest** — short rest (10-min cooldown, +50% missing HP) or long rest
  (24h cooldown, full HP + mana + armor pool). Mid-quest rest is blocked.

---

## Dungeons (grid format)

Dungeon quests generate a small grid of rooms — entry, encounters, lockboxes,
traps, NPCs, merchants, loot rooms, and a boss chamber. Navigate via the
compass (web) or `/sq move <dir>` (Slack). All grid loot is AI-flavored at
dungeon-start time (boss treasure, lockbox options, npc offers, merchant
stock all get proper names + flavor blurbs).

### Chests (two-step flow)
1. **Closed** — chest shows lock tier; spend a matching key (bronze/silver/
   gold) to open. Higher-tier keys open lower-tier locks. **Staff Sages**
   see a "Foresee" preview of contents while the chest is still closed
   (others see only "N mystery items await").
2. **Open** — every party member can claim any unclaimed item. First click
   per slot wins; multiple players can claim from the same chest, or one
   player can grab everything.
3. **Resolved** — auto-resolves when all items are claimed, or anyone can
   "Close chest" to walk away leaving spoils behind.

### Traps
Each trap room offers three skill checks (STR / DEX / INT). Pass the d20
to bypass; fail to take `4 + level` HP damage. Trap rewards vary by skill
(INT pass restores mana, etc.).

---

## Equipment & inventory

- **Slots:** main_hand, off_hand, body, helmet, pants, boots, ring, amulet.
- **Weapon ranges:** melee, ranged, focus. Focus weapons boost heal/shield
  rolls and grant +1 max mana while equipped (doesn't add to attack/cast
  damage).
- **Element-tagged weapons** proc burning/frozen/shocked on monsters at a
  rarity-scaled rate.
- **Stat bonuses** — gear can carry `stat_bonus` like `{str: 2, resist_fire: 30}`.
  Bonuses sum across equipped slots; resist values cap at 100% (immunity).
- **Inventory** — `/sq inventory` lists items. `/sq equip <id>` /
  `/sq unequip <id>`, `/sq give <id> @user` (transfers as unequipped — and
  fires a 🎁 toast in the recipient's web dashboard).
- **Level gates** — every drop carries a `level_req` (defaults to
  `ceil(power / 3)`). Surfaced in tile UIs so you don't claim something
  you can't equip.

---

## XP & gold rewards

Victory rewards split using a two-pool formula:

- **40%** of the pool is split equally across alive party members
  (participation share).
- **60%** is proportional to each fighter's contribution score:
  `damage_dealt + 0.75 × healing_done + 0.5 × shielding_done`.

So a heavy damage-dealer still tops the table, but supports get a meaningful
slice. Pool size scales with monster tier × multipliers (boss ×2, elite ×1.5,
party size bonus). Level-up rolls 1d6 to add max HP and refills the bar.

Loot drops roll independently per fighter at 35% + 5% per monster tier (cap
70%). Each drop rolls slot, rarity, and power; the AI generates the name +
flavor.

---

## Tools & scrolls (catalog items)

Curated single-shot offensive consumables with fixed names. Each maps
`item_name → effect` in `packages/core/src/flavor.ts`. The AI writes
per-drop flavor text. Power rolls at create time and **does not scale** —
buy a Caffeine Bomb at L1 and it stays L1-tier forever.

| Type | Item | Effect |
|---|---|---|
| 🧨 tool | Caffeine Bomb | `2 + tier` dmg, ignores armor |
| 🔥 tool | Hotfix Grenade | `6 + tier×2` dmg, ignores armor |
| ☕ tool | Espresso Shot | Regen self for 5 turns |
| 🧪 tool | Poison Vial / Venom Vial | Apply poisoned status, 4 ticks |
| 🩹 tool | Regen Draft | Self-regen, 3 turns |
| ⚔ tool | Battle Elixir | +25% damage, 3 turns |
| 🔄 scroll | Rebase Scroll | Free action: full party mana refill, no retaliation |
| 💥 scroll | Production Outage | Non-boss instakill / Boss −30% HP |
| 🗝 tool | Crowbar of Last Resort | Force-pick a dungeon lockbox |

---

## Notifications

Web dashboard fetches `/api/notifications/pending` on initial load and on
every tab focus. Currently surfaces:
- **🎁 item received** — when another player gives you an item.

Notifications are stored in D1 (`notifications` table) and delete-on-read —
each toast fires exactly once across tabs/devices.

---

## File map

```
apps/slack/                  — Slack worker
  src/index.ts               — Hono entrypoint, signature verify, LobbyManager DO
  src/commands.ts            — slash sub-command dispatch + handlers
  src/ai.ts                  — Workers AI scene generation + parser
  src/slack.ts               — Slack Web API helpers

apps/web/                    — Web worker + SPA
  src/worker.ts              — Hono server, REST + WS endpoints, QuestRoom DO,
                               LobbyRoom DO
  src/App.tsx                — dashboard root, town, party, character, inventory
  src/CombatPage.tsx         — standalone combat (outskirts/boss/gauntlet/standard)
  src/GridDungeonView.tsx    — embedded combat + dungeon navigation (graph dungeons)
  src/CombatShared.tsx       — shared combat UI (HpBar, ItemPicker, HitDust, etc.)
  src/CombatParticles.tsx    — Web-Animations-API particle bursts
  src/LobbyView.tsx          — sliding lobby drawer with chat
  src/icons.tsx              — icon component + class portrait helpers
  src/main.tsx               — entrypoint + Toaster mount

packages/core/               — pure engine (no DB / no network)
  src/combat_machine.ts      — TurnAction → CombatState reducer (`step()`)
  src/combat.ts              — legacy combat helpers (pre-engine paths)
  src/flavor.ts              — class table, signature/ability registry,
                               item catalog
  src/*.test.ts              — Vitest suite

packages/db/                 — D1 query helpers + shared types
  src/db.ts                  — characters, quests, lobby, party, inventory,
                               shop/smithy stock, notifications, …
  src/dungeon_grid.ts        — pure grid generator for dungeon variants

migrations/                  — D1 SQL migrations (numbered)
```

---

## Setup

### 1. Install + create the D1 database

```bash
pnpm install
pnpm db:create
```

Copy the `database_id` Wrangler prints into `apps/slack/wrangler.jsonc` and
`apps/web/wrangler.jsonc` (both workers share the same DB).

### 2. Apply migrations

```bash
pnpm db:migrate:local      # local development
pnpm db:migrate:remote     # against the deployed D1
```

### 3. Create the Slack app

Use this manifest at <https://api.slack.com/apps?new_app=1> → "From an app
manifest". `/sq` is the convention but any unreserved trigger works — Slack
reserves `/dnd`. The bot reads its own command name from the slash payload,
so help text reflects whatever you choose.

```yaml
display_information:
  name: Gantt Quest
features:
  bot_user:
    display_name: Gantt Quest
    always_online: true
  slash_commands:
    - command: /sq
      url: https://your-slack-worker.workers.dev/slack/commands
      description: Roll a character, start a quest, check your sheet
      usage_hint: roll | me | quest [elite] | help
      should_escape: false
  interactivity:
    is_enabled: true
    request_url: https://your-slack-worker.workers.dev/slack/interactions
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.public
      - commands
      - im:write           # required for cross-surface DMs
      - users:read         # required for invite lookups
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Install to your workspace, copy the bot token (`xoxb-...`) and signing secret.

### 4. Secrets

Both workers need their own secret set. For the Slack worker:

```bash
cd apps/slack
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put ALLOWED_CHANNEL_ID   # optional channel allowlist
```

For the web worker:

```bash
cd apps/web
npx wrangler secret put SLACK_CLIENT_ID
npx wrangler secret put SLACK_CLIENT_SECRET
npx wrangler secret put SLACK_BOT_TOKEN      # for cross-surface notifications
```

The web worker uses Slack OAuth for sign-in; the bot token lets it post
"Player joined from the web" messages to the quest thread.

### 5. DO bindings + cross-worker wiring

Both `wrangler.jsonc` files need their DO bindings configured:

- `apps/web/wrangler.jsonc` registers `QUEST_ROOM` and `LOBBY_ROOM` as
  owned classes (`new_sqlite_classes` migrations).
- `apps/slack/wrangler.jsonc` registers `LOBBY_MANAGER` as owned, plus
  cross-bound stubs for `QUEST_ROOM` and `LOBBY_ROOM` (`script_name`
  pointing at the web worker name).

Deploy the web worker first so the DO classes exist before the Slack worker
tries to bind them.

### 6. Run / deploy

```bash
pnpm dev                   # Slack worker dev server (most common iteration loop)
pnpm --filter web dev      # web worker dev server (Vite + Wrangler)
```

For prod:

```bash
pnpm --filter web build    # build the SPA into apps/web/dist
pnpm --filter web deploy   # deploy the web worker (serves built assets)
pnpm deploy                # deploy the Slack worker
```

**Important: always build the web SPA before deploying the web worker.** A
stale `dist/` ships old UI with new server code — a frequent regression
source.

### Optional: rename the bot

`BOT_NAME` env var (in `apps/slack/wrangler.jsonc` `vars` block, or via
`npx wrangler secret put BOT_NAME`). Defaults to "Gantt Quest". Used in
`/sq help`, `/sq rules`, and channel-restriction error messages.

---

## Tests

```bash
pnpm test                  # one-shot Vitest across packages
pnpm test:watch            # core package only, watch mode
pnpm typecheck             # tsc across all packages
```

Engine tests (`packages/core/src/*.test.ts`) cover the deterministic math:
combat damage, dice rolls, drop tables, class lookup, scar generation, shop
pricing, status effect ticking, status proc rates, position modifiers,
critical hit rules, and the full `step()` reducer for each action kind.

Engine code is the source of truth — anything mechanical lives there and is
covered by tests. Network / DO / AI code is intentionally untested; the
engine surface is small enough that integration bugs are rare and obvious.

---

## Credits

Icons come from **[game-icons.net](https://game-icons.net/)** — a CC BY 3.0
library of monochrome SVGs by Lorc, Delapouite, and others. They power
the entire combat UI (weapon icons, status effect pills, slot indicators,
class portraits' fallback glyphs, dungeon room markers, etc.).

The relevant set is gitignored under `lib/icons/` per project convention;
to use a new icon, copy the SVG into `apps/web/public/icons/` and register
the name in `apps/web/src/icons.tsx`.
