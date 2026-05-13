# Town Map + Pub — Design Doc

**Status:** Draft / parked. Last touched 2026-05-11.
**Author:** josh + Claude (session continuation).

This is the design sketch for a persistent "town" map that sits between
quests — a hub where players can spend gold on buffs, chat with NPCs, play
mini-games, and generally have a reason to log in between adventures.
Saved before any implementation so future-us doesn't re-derive the same
trade-offs.

> **Design principle: multiple-choice, not free-text.** Every interactive
> surface — NPC dialog, mini-games, location menus — uses Block Kit
> buttons. This matches the rest of the bot (dungeon NPCs, trap rooms,
> door picks, lockboxes, treasure rooms are all multi-choice today) and
> dodges three problems at once: (1) Slack's awkward free-text input UX,
> (2) unbounded AI cost per chat turn, (3) prompt-injection / abuse
> vectors. AI generates the **content of the choices** at scene refresh
> time, then players navigate pre-baked trees with zero per-interaction
> AI cost.

---

## Goals

- A hub space that's distinct from quests but **uses the same Slack thread
  patterns** — slash commands, ephemeral responses, Block Kit buttons.
- **Pub as the v1 anchor.** Drinks, bartender, mini-games. Other locations
  (shop, inn, smithy, etc.) get sketched but ship later.
- **AI-flavored NPC interactions** via pre-generated multi-choice dialog
  trees. AI generates the tree at the daily refresh; players navigate it
  with button clicks. Zero AI cost per turn.
- A **gold sink** for late-game players whose pockets are full but who
  don't need more weapons.
- A reason to log in **between quest cooldowns** (downed players, post-
  victory regroup) — keeps engagement non-binary (quest-or-nothing).

## Non-goals (for v1)

- **Town map exploration in the MMO sense.** No "walk to the inn" tile
  movement — locations are buttons on a map block.
- **NPC daily lives** (the smith goes to the pub at 6pm). NPCs are
  always-on at their location.
- **Romance, factions, reputation.** Save for v3+.
- **Player-vs-player content** (drinking contests with other party
  members? sure. PvP duels? no).
- **Procedural town generation.** The town is hand-defined per channel,
  same shape everywhere. AI generates flavor (NPC names, drink names,
  scene description), not structure.

---

## High-level shape

```
/sq town            → renders the town map (locations as buttons)
   │
   ├─ Pub          → /sq pub                (or click button)
   │     ├─ Drink menu (gold → temp buff)
   │     ├─ Talk to bartender (AI conversation, 1 reply per turn)
   │     ├─ Talk to a regular (AI conversation, rotating NPC)
   │     ├─ Mini-game: dice / drinking contest / story choice
   │     └─ Listen to rumors (free, gives a hint at next AI-generated quest)
   │
   ├─ Inn          → /sq inn                (long rest with cost discount?)
   ├─ Job board    → /sq board              (quest variant picker w/ flavor)
   ├─ Smithy       → /sq smithy             (item repair / upgrade — v2)
   ├─ Temple       → /sq temple             (revive-cost discount? — v2)
   └─ Town square  → /sq square             (leaderboard + party formation)
```

**v1 ships:** `/sq town` + `/sq pub`. Everything else gets a "coming
soon" stub button so the map looks complete.

---

## Current state (what already exists we can lean on)

- **Channel-scoped shop** (`/sq shop`) — already does per-channel state, AI
  item generation, restock cycles, gold deduction. Same pattern works for
  per-channel town state.
- **AI flavor pipeline** (`src/flavor.ts` + `src/ai.ts`) — `flavorHit`,
  `flavorSignature`, etc. all hit Workers AI with structured prompts.
  Adding `flavorNpcReply(env, character, npc, history)` is the same
  pattern.
- **Block Kit interaction routing** (`handleInteraction` in `commands.ts`)
  — `action_id` → handler dispatch. Adding `pub_drink_*`, `pub_talk_*`,
  `pub_game_*` slots in cleanly.
- **R2 art caching** (`viewArt`) — already used for shop, inventory,
  dungeon room banners. A pub interior image works the same way.
- **Status effects framework** (`src/db.ts` `StatusEffect`) — temp buffs
  with `magnitude` + `remaining` ticks. Drinks slot in as a new
  `kind: "buff"` effect type.

What we **don't** have:
- Persistent per-character NPC memory (bartender remembering your name
  across sessions). Storing AI conversation history per `(channel, user,
  npc)` is new — would need a table or a JSON blob on `characters`.
- Multi-turn AI dialog handling. Today every AI call is one-shot. Pub
  chats need short conversation context windows.
- Town-state persistence (which NPC is at the bar today, daily specials,
  etc.) — channel-scoped, restocks on a daily cadence?

---

## Data model

```ts
// New table — per-channel town state. Refreshes on a daily cadence
// (matches shop restock for tempo consistency).
interface TownState {
  channel_id: string;
  refreshed_at: number;            // ms timestamp; ~24h cadence
  pub: {
    bartender: { name: string; vibe: string };  // AI-generated daily
    daily_special: DrinkSpec;                   // discounted drink of the day
    regulars: NpcSpec[];                        // 2-3 rotating chat NPCs
    rumors: string[];                           // 3-5 one-line teasers
  };
  // v2: inn, smithy, temple state…
}

// Drinks are catalog-defined (like Staples in the shop), not AI-rolled.
// Effects are short-lived buffs designed to feel rewarding but not
// game-breaking — comparable to magic-item +1 stat boosts but TEMPORARY.
interface DrinkSpec {
  id: string;              // "ale", "mead", "spirits", "tea", ...
  name: string;
  emoji: string;
  price: number;           // gold
  effect: DrinkEffect;
  blurb: string;           // flavor text
}

type DrinkEffect =
  | { kind: "buff_attack"; magnitude: number; duration_actions: number }
  | { kind: "buff_magic"; magnitude: number; duration_actions: number }
  | { kind: "buff_defense"; magnitude: number; duration_actions: number }
  | { kind: "restore_mana"; amount: number }
  | { kind: "restore_hp"; amount: number }
  | { kind: "buff_crit"; chance_bonus: number; duration_actions: number };

// NPCs the player can chat with. Generated per-day and memoized in
// TownState so the same NPC sticks for the session. Dialog is a static
// pre-baked tree (not live LLM chat) — see "NPC dialog trees" below.
interface NpcSpec {
  id: string;              // stable within the day, e.g. "regular_1"
  name: string;
  archetype: string;       // "weary engineer", "retired adventurer", ...
  vibe: string;            // tone hint for AI ("dry, bitter, wise")
  concern?: string;        // topic seed for the dialog tree
  dialog: DialogNode;      // pre-generated 3-level tree
}

// Recursive dialog-tree shape. Each node has an NPC line + 2-3 player
// options. Branches end when `options` is empty (or undefined) — the
// UI shows a "🚪 Walk away" button on terminal nodes. Optional payloads
// fire when the player picks that branch (rumor, gold tip, drink token).
interface DialogNode {
  npc_says: string;
  options?: DialogOption[];
}
interface DialogOption {
  player_says: string;           // short button label (~6-10 words)
  next: DialogNode;              // next node in the tree
  payload?: DialogPayload;       // optional reward for picking this branch
}
type DialogPayload =
  | { type: "rumor"; text: string }
  | { type: "gold"; amount: number }
  | { type: "drink_token"; drink_id: string }   // one free pour
  | { type: "xp"; amount: number };             // "tale tip" — small XP

// Per-player state: which payloads have been collected from which NPC
// today (so rewards don't repeat-farm). Keyed by (channel, user, npc).
interface NpcPayloadsClaimed {
  channel_id: string;
  user_id: string;
  npc_id: string;
  refresh_date: number;          // day the NPC's tree was generated
  claimed_paths: string[];       // path strings, e.g. ["0", "0_2", "1_1"]
}

// Status effects on characters get a new kind for drink buffs. Reuses
// the existing StatusEffect tick framework — duration measured in
// actions, decrements every combat action just like poison/bleed.
interface DrinkBuffEffect extends StatusEffect {
  type: "drink_buff";
  stat: "attack" | "magic" | "defense" | "crit";
  magnitude: number;
  remaining: number;       // actions left
  source: string;          // "Ale of Confidence", for the stat line
}
```

**Storage:** `TownState` and a player→NPC-payloads-claimed table.
Migration adds:

```sql
-- 0016_town.sql (sketch)
CREATE TABLE town_state (
  channel_id TEXT PRIMARY KEY,
  refreshed_at INTEGER NOT NULL,
  state_json TEXT NOT NULL          -- includes NPCs w/ baked dialog trees
);
CREATE TABLE npc_payloads_claimed (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  npc_id TEXT NOT NULL,
  refresh_date INTEGER NOT NULL,    -- the day stamp the tree belongs to
  claimed_paths_json TEXT NOT NULL, -- ["0", "0_2", ...]
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id, npc_id)
);
```

Note: NO conversation history table. Trees are static per refresh; only
per-player **which-payload-branches-already-claimed** state persists.

---

## The pub — content design

### Drinks (catalog, not AI-rolled)

Pricing tier mirrors the shop's flat per-rarity model. Drinks are cheap
to nudge "stop by between quests for the buff" behavior.

| Drink | Effect | Duration | Price |
| --- | --- | --- | --- |
| 🍺 Tavern Ale | +1 attack | 3 actions | 8g |
| 🍷 Spiced Mead | +1 magic | 3 actions | 8g |
| 🥃 Iron Brew | +1 armor/defense | 3 actions | 8g |
| 🍵 Bitter Tea | restore 2 mana | instant | 12g |
| 🥛 Frothy Milk | restore 8 HP | instant | 10g |
| 💧 Lucky Sip | +5% crit chance | 3 actions | 15g |
| ⭐ Daily Special | rotating, discounted 30% | — | — |

Buffs are **3 actions** (~2-3 minutes mid-fight). Short enough that you
can't drink-stack indefinitely; long enough to matter for the first part
of a fight.

**No alcohol/intoxication mechanics.** Player base is engineers — keep it
fun-tavern, not Skyrim-drunk-vomit.

### NPCs

Two slots:

1. **Bartender** (permanent per day, rotating personality each refresh).
   Handles drink orders, banters when you order, has a multi-choice
   dialog tree you can step through.

2. **Regulars** — 2-3 NPCs at the bar. Each has an archetype (weary
   engineer, retired adventurer, junior dev who took a wrong turn) and
   a unique pre-generated dialog tree. May give flavor + occasionally a
   rumor / lead.

**Dialog as pre-baked trees, not live chat.** At each town refresh
(~24h), the AI generates a small dialog tree per NPC. The tree has:

- An **opening line** + 3 player **response options**.
- For each option, a **follow-up NPC line** + 2-3 next-level options.
- 2-3 levels deep before the conversation winds down ("Anyway, the next
  round is on me — go on then.").
- Branches can occasionally yield a **payload** (a rumor, a tiny gold
  tip, a free-drink token, a +XP "tale tip") — making conversations
  worth exploring.

**Single AI call per NPC per refresh** (one daily call, output ~600-800
tokens of structured JSON for the tree). Cost: fractions of a cent per
NPC per day.

**Prompt shape** (one call generates the whole tree):

```
Generate a 3-level dialog tree for {npc.name}, {npc.archetype} at the
Stale Logfile Tavern. Vibe: {npc.vibe}. Current concern: {npc.concern}.

Return JSON:
{
  opening: "<NPC's first line>",
  options: [
    {
      player_says: "<short reply text, ~6-10 words>",
      npc_reply: "<NPC's next line>",
      payload?: { type: "rumor"|"gold"|"drink_token", value: ... },
      options: [ ... 2 more levels deep ... ]
    },
    ...3 options total
  ]
}

Tone: in-character, 1-2 sentences per NPC line. No fourth-wall. End each
branch with a graceful conversation-end line.
```

Tree is cached on `npc_memory`-style row at refresh time. Player
navigation is pure tree-walk via button action_ids encoding the path
(e.g. `npc_bramfel_0_2` = bartender, first branch, second sub-option).

**Why not live-chat:** free-text NPC chat has unbounded AI cost, awkward
Slack UX (requires `plain_text_input` blocks with `dispatch_action`),
and prompt-injection risk. Pre-baked trees match how the rest of the
bot already works (dungeon NPC rooms, door picks, trap choices are all
multi-choice).

### Mini-games

Pick **one** for v1 to keep scope tight. Recommendation: **dice game**.

#### Option A: Dice game — "Liars' Roll"

- Stake gold (10g / 25g / 50g brackets).
- Both player and NPC roll a hidden pool of dice.
- 2-3 rounds of bluff calls — pure RNG with light decision-making.
- Winner takes the pot (minus a small house cut).
- **AI cost:** zero — pure mechanical mini-game.

#### Option B: Drinking contest

- Stake gold + 1 mana (the bartender pours, you commit).
- Roll opposed CON-like checks (1d6 + buff modifier).
- Winner gets pot + a temp buff; loser gets a status effect ("hungover" =
  -1 atk for 5 actions, gold returned).
- **AI cost:** zero.

#### Option C: Story / riddle

- Bartender or NPC poses a riddle / scenario.
- Player picks one of 3 responses → outcome (gold, buff, item, nothing).
- **AI cost:** one call per daily refresh to generate the scenario tree
  (same pattern as NPC dialog trees). Players navigate cached
  multiple-choice — zero AI per play.
- Risk: generic-feeling without strong prompt engineering. Probably
  needs a few hand-curated scenario templates the AI fills in (e.g.
  "guess the bug from the symptoms," "settle the deploy-vs-revert
  argument") rather than fully open-ended generation.

**Recommendation:** Liars' Roll for v1 (zero AI cost, replayable, no
content fatigue). Story/riddle is a natural Phase 4+ once we see how
much engagement the pub actually drives.

### Rumors

Free action. Reading rumors generates 3-5 single-line AI-flavored teasers
(e.g. _"Heard the Schemaless Shrieker is back near the merge gate."_ —
hints at a monster that'll show up in the next quest).

**v1 implementation:** rumors are pre-generated at TownState refresh time
(once per ~24h) and cached. No per-read AI cost.

**v1.5:** rumors can be tied to actual upcoming-monster preview — if the
channel's next quest rolls a specific monster type, a rumor in the pub
foreshadows it.

---

## UI sketch

### `/sq town` (the map)

```
🏘️ *Stale Logfile Township*
[banner image — generated AI town view]

> _Late afternoon. The watch hasn't rotated, the smith is still hammering,
>  and the tavern's already half-full._

[🍺 Pub] [🛏️ Inn] [🛒 Shop] [📋 Job Board]
[⚒️ Smithy] [⛪ Temple] [🏛️ Town Square]

_Use the buttons or type \`/sq <location>\` directly._
```

Buttons route via `handleInteraction` → location-specific renderer.
Coming-soon locations show a "🚧 Coming Soon" ephemeral on click.

### `/sq pub` (the pub interior)

```
🍺 *Stale Logfile Tavern*
[banner image — generated AI tavern interior]

> _Smoke, sawdust, a thousand failed deployments worth of regret in
>  the air. {bartender.name} polishes a mug behind the bar._

*🍷 Drink Menu*
1. 🍺 Tavern Ale — +1 attack, 3 actions — 8g
2. 🍷 Spiced Mead — +1 magic, 3 actions — 8g
3. 🥃 Iron Brew — +1 defense, 3 actions — 8g
[... 5 more ...]
⭐ *Daily Special:* 🍵 Bitter Tea — restore 2 mana — ~~12g~~ *9g*

[🍺 Order Ale] [🍷 Order Mead] [🥃 Order Brew]
[🍵 Order Tea] [🥛 Order Milk] [⭐ Special]

*👥 Folks at the Bar*
- 🍳 {bartender.name} — _the bartender_
- 🧑‍💻 {regular_1.name} — _{regular_1.archetype}_
- 🧙 {regular_2.name} — _{regular_2.archetype}_

[💬 Talk to {bartender}] [💬 Talk to {regular_1}] [💬 Talk to {regular_2}]

[🎲 Play Liars' Roll] [👂 Listen to Rumors] [🚪 Leave]
```

### NPC dialog (tree-walk UI)

Clicking "Talk to {bartender}" opens an ephemeral with the NPC's
current line + 2-3 player-choice buttons. Clicking a button replaces
the ephemeral with the NPC's reply + the next set of options. Terminal
nodes show only a "🚪 Walk away" button.

```
[💬 Talk to Bramfel]
   ↓
*🍳 Bramfel the Bartender*
"Long day in the queue, friend?"

[ "Tell me about the cellar." ]
[ "What's the special?"       ]
[ "I'm just passing through."  ]
[🔙 Back to Pub]
```

Action_id encodes the navigation path: `npc_<npc_id>_<path>` (e.g.
`npc_bramfel_root`, `npc_bramfel_0`, `npc_bramfel_0_2`). The handler
looks up the NPC tree from cached `TownState`, walks the path, and
renders the resolved node — pure deterministic lookup, no AI call.

**Payload reveals:** when a chosen branch carries a payload (rumor /
gold tip / drink token / XP), the ephemeral shows the NPC reply PLUS a
highlighted reward line ("🎁 *Bramfel slides you a free Spiced Mead
token.*"). Payloads claim once per player per refresh (tracked in
`npc_payloads_claimed`); re-walking the same branch shows the reply
without re-issuing the reward.

**Conversation reset:** each click starts a fresh ephemeral via
`response_url`'s `replace_original`, so the chat reads as one updating
panel instead of stacking. Walking away exits back to the pub view.

### Drink purchase + buff application

Clicking "Order Ale" deducts 8g, applies a `drink_buff` StatusEffect to
the character, posts an ephemeral confirmation. The buff appears in
`/sq me` under Active Effects with countdown ("🍺 Tavern Ale +1 atk, 3
actions left").

---

## Open design questions

1. **Channel-scope vs. character-scope for town state.** Going with
   channel (matches shop). But: does the bartender remember you across
   channels? Probably no — keep it channel-bound to match the rest of
   the model.

2. **Refresh cadence.** 24h matches a "daily town visit" feel. 6h (the
   shop cadence) might feel too churny for the bartender. **Recommend:**
   24h for town state, but rumors/specials can update faster.

3. **Buff stacking.** Can you drink two drinks back-to-back for stacked
   buffs? **Recommend:** no — second drink replaces the first. Keep
   buff state simple (one active drink buff at a time).

4. **Mid-quest drinks?** Probably no. Tavern is a between-quest space.
   This also keeps the buff "warm up before you go out" rather than
   "panic-chug mid-fight." Block at the slash-handler with "you can't
   buy drinks mid-quest."

5. **Dialog tree depth.** 3 levels deep is the proposed shape (opening
   + branch + sub-branch). Deeper trees feel richer but the AI gen
   token count grows fast (3 options × 3 sub-options × 3 sub-sub-
   options = 27 leaf nodes). **Recommend:** 3 levels for v1, total ~12
   distinct NPC lines per tree. Worth playtest before committing — if
   players burn through a tree in one visit, bump to 4 levels.

6. **Pub mini-game griefing.** If someone burns gold on Liars' Roll and
   loses it all, do they have recourse? **Recommend:** stake minimums
   are bounded; losing the entire pot is by design. House always slightly
   wins (5% rake) so the pub isn't a money printer.

7. **Persistent NPCs?** Should there be 1-2 "named characters" who never
   rotate (the campaign-level NPCs)? E.g. a wise old wizard who shows up
   in the town square periodically? **Recommend:** v2+ feature. Keep v1
   simple.

8. **Town-wide events?** "Festival weekend" doubles XP, "Plague week"
   blocks the temple. Save for v3.

---

## Risks / unknowns

- **AI spend.** Bounded by design. One AI call per NPC per daily refresh
  to generate a static tree, plus one call to refresh rumors. Negligible
  total daily spend regardless of how many players visit the pub.

- **Tree freshness fatigue.** If the same 3-level tree per NPC stays up
  for 24h and a player exhausts it in their first visit, they may not
  return. Mitigations: (a) only revealing payloads once-per-player makes
  re-visits flatter not zero-value (they can still read flavor); (b)
  potentially refresh trees on a faster cadence than the rest of town
  state (12h instead of 24h) at minimal AI cost; (c) make tree depth a
  tunable knob.

- **Player engagement risk** — if the pub is a one-time novelty with no
  reason to return, it's wasted dev effort. The buffs need to be
  consistently desirable (e.g. cheap-but-meaningful, +1 atk for 8g pays
  back in 1 attack), and Liars' Roll needs to be sticky enough to revisit.

- **Town state staleness.** If the bartender rotates daily but the channel
  is quiet for a week, the same NPCs hang around. Probably fine — adds
  to the "everyone knows each other" feel. Refresh-on-active-quest is
  another option.

- **Cross-feature interactions.**
  - Drink buffs need to play nice with class buffs (Bard aura stacks
    additively? probably yes — same model as the magic-item flat bonuses).
  - The job board could become the canonical quest-start UI, deprecating
    raw `/sq quest variant`. Worth thinking about before we commit to a
    "two paths to start a quest" reality.

---

## Rollout plan

### Phase 1 — Town shell + Pub MVP (1 day)

- `/sq town` route + map block with location buttons. Coming-soon stubs
  for everything except pub.
- `town_state` table + 24h refresh logic.
- `/sq pub` route + pub interior block.
- Drink catalog (8 drinks, fixed prices).
- Drink purchase flow: button → gold deduct → status effect applied
  → ephemeral confirmation.
- Status effect renderer in `/sq me` shows active drink buff.
- AI-generated town + pub banner art (one of each, cached in R2).

### Phase 2 — NPC dialog trees (half-day)

- 2-3 NPCs per pub (bartender + regulars), generated at daily town
  refresh. Each NPC carries a baked 3-level dialog tree on `TownState`.
- AI prompt produces structured JSON (opening + 3-deep options) in one
  call per NPC per refresh.
- "Talk to X" button → ephemeral with the NPC's current line + button
  options. Tree-walk via `npc_<id>_<path>` action_ids.
- `npc_payloads_claimed` table — tracks which reward branches a player
  has already claimed today so payloads don't repeat-farm.
- Payload types: rumor, gold tip, drink token, small XP.

### Phase 3 — Liars' Roll mini-game (half-day)

- Stake selection (10g/25g/50g).
- Game state machine (3 rounds of bluff calls).
- Pot resolution + house rake.
- Optional: rare "tavern champion" win streak for cosmetic flair.

### Phase 4 — Rumors + polish (quarter-day)

- 3-5 rumors generated at town refresh, cached.
- "Listen to Rumors" button shows the list.
- v1.5 hook: rumors can mention next-quest monster types (if we surface
  that signal from the quest generator).

### Phase 5 — Other locations (open-ended)

- Inn (discounted long rest, daily resting bonus).
- Job board (quest variant selector with AI-flavored quest names).
- Smithy (item repair / upgrade — needs item-condition system first).
- Temple (revive at reduced cost — 50g instead of needing a revive item).
- Town square (top-3 leaderboard display + party formation).

---

## Effort estimate (recap)

- **Phase 1 (town + pub MVP w/ drinks):** ~1 day.
- **Phase 2 (NPC chat):** ~half-day.
- **Phase 3 (Liars' Roll):** ~half-day.
- **Phase 4 (rumors):** ~quarter-day.
- **Phase 5 (everything else):** open-ended, one location at a time.

Realistic v1 ship — town shell, working pub with drinks, NPC chat, dice
game — is **2-2.5 days of focused work + playtest iteration**. Phase 1
alone (drinks-only pub) is the natural MVP and a 1-day project.
