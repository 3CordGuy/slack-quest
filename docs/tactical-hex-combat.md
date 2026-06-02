# Tactical Hex Combat Engine

This is the original design doc for the hex-grid combat system that replaced the old front/back binary positioning model. It's preserved here so future contributors can read the architecture as it was conceived; **what actually shipped** is summarized in the [Shipped (post-plan)](#shipped-post-plan) section at the bottom.

> **Status:** All of Phases 1–7 are merged on `main`. Follow-on PRs added the canvas-fill / zoom / pan layer, mobile pinch-to-zoom, character avatars in pawn tokens, per-effect canvas visualizations with engineering-themed display labels (Containerized / Deadlocked / Firewalled / Scaled Up / Auto-Heal), rise-effect popups for soft event indicators (taunt / marked / vulnerable / foreseen / test_coverage / delivery_bonus / ill_omen), and a handful of engine fixes (move-range cap, charge cap, LOS gate for monsters, frozen-skips-every-turn bug). The [Notable merged PRs](#notable-merged-prs-in-order) list at the bottom is the most authoritative changelog.

## Context

The current combat system is purely logical — actors occupy a front/back binary position and there is no spatial reasoning, range, or line-of-sight. The user wants to make combat tactically richer with:
- A hex grid arena for positioning
- True melee/ranged/magic range enforcement
- Line-of-sight for ranged attacks
- Two-phase turns: **move** then **attack**
- Canvas-rendered particle effects on every hit

This replaces the binary `front`/`back` position concept with full 2D hex positioning. The `CombatState` persists to D1 via the existing `web_combat.ts` layer, so adding `pos` fields to actors flows naturally.

**Layout direction (decided after Phase 1+2):** The battlefield IS the combat UI. The existing dense card layout (SpotlightMonster portrait + monster cards row + PartyChips strip) is **retired**. Pawns on the hex grid are the new source of truth for who's where, who's active, and who's hurt. Floating callouts hang off each pawn for at-a-glance HP, with hover-to-expand for the full character/monster card.

---

## Architecture: Canvas Hybrid

**Canvas 2D** (not WebGL) for the hex arena + particles. WebGL is overkill for a turn-based game. PixiJS is an unnecessary dependency.

- A single `<canvas>` renders the hex grid, pawns, and particles via `requestAnimationFrame`
- React handles all surrounding UI as DOM overlays positioned absolutely over the canvas: pawn callouts, action button bar, combat log, turn strip
- Click events on the canvas are converted to hex coordinates and dispatched as WebSocket actions
- The canvas receives state as props and is purely a renderer — no game logic inside it

---

## Layout: Battlefield-First UI

The combat page becomes a single full-bleed battlefield scene. Reading top → bottom:

```
┌──────────────────────────────────────────────────────────┐
│  [exit] · turn strip · round N                  [log ▸]  │  ← top rail
├──────────────────────────────────────────────────────────┤
│                                                          │
│           ┌─Lyraxys──┐                                   │
│           │ 29/29 ♥  │                                   │
│           └──┬───────┘                                   │
│             (L)                       (S)                │
│           pawn  · · · ·              pawn ┌Creepster─┐  │
│            · · · · · · ·                  │ 18/18 ♥  │  │
│           [hex grid battlefield]          └──────────┘  │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  [Attack] [Cold Start] [Blizzard] · · · [Wait] [Flee]   │  ← action bar
└──────────────────────────────────────────────────────────┘
```

### Pawn rendering (on canvas)

Pawns are small circular tokens drawn on the canvas:
- **Fighters:** 0.55 × hex radius circle, class color ring, single-letter name
- **Monsters:** 0.60 × hex radius, red ring (gold ring + thicker for bosses)
- Yellow halo on the **current actor's** pawn
- Pulsing dim when **downed** (alpha 0.35)

Pawns intentionally carry no HP/name text on themselves — that lives in the callout above.

### Pawn callouts (DOM overlay)

Each live actor gets a floating callout positioned in screen coordinates derived from `hexToPixel(actor.pos)`. The callout has two states:

**Compact (default):**
- A small chip floating ~12px above the pawn
- Contents: `[avatar/icon] Name · HP-fraction-bar`
- Width auto-fits content (~80–120px); not interactive except for hover trigger
- Class color tints the left border for fighters; red for monsters
- A tiny tail/triangle points down at the pawn

**Expanded (full card):**
Trigger conditions, any of:
- The user is hovering the pawn or the callout
- The actor is the **current turn's actor** (auto-expanded; can collapse via X)
- Mobile: tap to expand; tap elsewhere to collapse

Contents (reuse existing components):
- For fighters: a compact version of the existing `FighterRow` / `BigHpBar` / mana bar / status pills / active mark indicator
- For monsters: a compact version of `MonsterCard` / `SpotlightMonster` content — name, tier, HP, element affinity, status pills, taunt/vulnerability/foresee badges

The expanded card balloons **above** the pawn by default. If the pawn is in the top row of the grid (no headroom), it flips below. If pawn is in the rightmost column (callout would clip), it shifts left. Positioning logic = simple bounds check.

### Smart stacking

When multiple pawns cluster in adjacent hexes, compact callouts can overlap. Strategy:
- Compact callouts use a fixed slot grid (pin direction = above pawn, with horizontal offset for left/right slot when collision detected)
- Expanded callouts always render on top with `z-index` raised; only one expanded callout per pawn at a time
- Hidden by default if the pawn is downed (a single "× Downed" badge replaces the callout)

### What gets removed

These existing components stop being rendered in the live combat scene (still imported in the code for now to avoid orphaning their internals; removed in a later cleanup):
- `SpotlightMonster` (the rotating dashed ring monster portrait)
- Monster cards row (left flank / spotlight / right flank layout)
- `PartyChips` strip across the bottom
- The "Pick a monster to target" prompt (target by clicking a pawn now)
- Position swap button (Front/Back — already gone in the engine; remove the UI button too)
- Old DOM particle system (`CombatParticles` / `triggerBurst`) — all particles now fire on canvas via `CombatHexGrid`'s API

### What stays (unchanged — important)

- **Combat log** — same right rail, same collapse behavior, same content (untouched)
- **Action button bar** — same bottom bar with Attack / abilities / Item / Mark / Wait / Flee / Resolve / Auto (untouched except the Front/Back position swap button is removed since front/back is gone)
- **Turn strip** (`InitStrip`) at the top so players see the cycle order
- **Dice rolls overlay** (left column for d20/damage rolls)
- **Victory/defeat modals** + `CombatBurndown`
- **Backdrop** (scene art) — now augmented with battlefield-specific art (see below)

---

## Hex Coordinate System

**Axial coordinates** `(q, r)` with pointy-top hexes. The third cube coord `s = -q - r` is used only for distance/LOS math.

Grid size: **13 cols × 7 rows** (q: 0–12, r: 0–6).

Pixel position of hex (q, r) on canvas:
```
x = size * (√3 * q + √3/2 * r) + offsetX
y = size * (3/2 * r) + offsetY
```
Hex size (radius) ≈ 44px → canvas footprint ~900×400px.

**Initial placement:**
- Party fighters: q ∈ {1, 2}, rows spread evenly across height
- Monsters: q ∈ {10, 11}, rows spread evenly
- Boss: q = 12, r = 3 (center-right)

---

## AI-Generated Battlefield Backgrounds

The hex arena needs scene-appropriate ground art (e.g. cracked stone floor, mossy clearing, charred ruins) under the hex overlay. We extend the existing **Flux-1-Schnell + R2** pipeline already used for monster portraits and scene views.

### Pipeline (reuses existing infra)

- **Model:** `@cf/black-forest-labs/flux-1-schnell` via `env.AI` (no new binding)
- **Storage:** `env.ART` R2 bucket under a new key prefix `art/battlefield/v1/{scene}.png`
- **Prompt:** add `BATTLEFIELD_STYLE_ANCHOR` constant in `apps/web/src/ai.ts` describing a top-down 13:7 aspect-ratio terrain tile in the existing Ghibli-watercolor style ("top-down view, no characters, no creatures, no horizon line, even diffused lighting, paint-on-paper texture")
- **Scene-keyed:** one image per scene type from `pickScene()` (6 scene types — cave, forest, ruins, castle, swamp, tower). Promoted to 8–10 if we add boss-specific variants later
- **Generation entry point:** new `generateBattlefieldArt(scene: SceneKey): Promise<string | null>` in `ai.ts`, modelled on the existing `generateMonsterArt()` + `generateAndCacheArt()` flow
- **Fail-soft:** if generation fails or `art.disabled` is set (local dev), return null → canvas falls back to a flat tinted color per scene (defined in `combatBackgrounds.tsx`)

### When generation fires

- **First combat in a given scene** triggers background gen if R2 head-check misses
- Subsequent combats in the same scene reuse the cached image instantly
- We do NOT pre-generate all 6 at once on every install (no `pregenAllBattlefieldArt` cron — first-touch is fine for 6 cheap images)

### Canvas rendering

`<CombatHexGrid>` adds a new bottom layer:
- Layer 0: battlefield art (`<img>` drawn to canvas via `drawImage()`, scaled to canvas size, ~25% alpha so hexes stay legible)
- Layers 1–4: tiles, obstacles, pawns, particles (as before)

If the image isn't loaded yet, the layer is skipped — no flash, no jank.

---

## Obstacles (LOS-blocking battlefield features)

Each battlefield gets **2–4 obstacle hexes** representing pillars, boulders, debris, or crates. They:
- **Block line of sight** (already supported by `hexLos()` — engine work is done)
- **Block movement** (occupy a hex; `hexReachable` and `hexPath` already treat them as walls because they're in the `occupied` list)
- Force tactical positioning — ranged players can't sit on the back row sniping if obstacles block their sightline

### Generation strategy

Determined at `createCombatState()` time, seeded by `questId` so the same quest always has the same obstacle layout (lets a player resume / share screenshots without drift):

```typescript
// In packages/core/src/hex.ts — new pure helper
export function generateObstacles(
  grid: HexGrid,
  partyPositions: HexPos[],
  monsterPositions: HexPos[],
  seed: number,
  count: number = 3,
): HexPos[]
```

Algorithm:
1. Candidate hexes = all in-bounds hexes EXCEPT party/monster start positions AND their direct neighbors (so no one starts boxed in)
2. Bias toward the **middle columns** (q ∈ [4, 9]) — center-of-arena obstacles create the most interesting tactical decisions
3. Avoid clustering: each new obstacle must be ≥ 2 hexes from all previously placed obstacles
4. Seeded RNG (mulberry32 or similar — pure, no Date.now()) so output is deterministic given the same seed
5. Pick `count = 2 + (seed % 3)` so quests get 2–4 obstacles

### Obstacle types (visual variety)

Each obstacle is tagged with a type for rendering:
```typescript
export interface Obstacle {
  pos: HexPos;
  kind: "boulder" | "pillar" | "crate" | "tree" | "rubble";
}
```

Type chosen by scene: cave → boulder/rubble, forest → tree/boulder, ruins → pillar/rubble, castle → crate/pillar, swamp → boulder/tree, tower → pillar/crate.

This is purely cosmetic — engine treats all obstacles identically.

### Engine changes (small)

- `CombatState.obstacles` already exists from Phase 1; change its type from `HexPos[]` to `Obstacle[]` (add the `kind`)
- `createCombatState()` calls `generateObstacles(grid, fighterPositions, monsterPositions, init.scene_seed, count)` and stores result
- `hexLos()` already takes obstacles — update signature to accept `Obstacle[]` (extract `.pos` internally) for backward compat
- `hexReachable` / `hexPath` need obstacle positions added to the `occupied` set so actors path around them
- `CombatInit` adds `scene_seed?: number` field; web app passes `questId`

### Canvas rendering

Add Layer 2 (between tiles and pawns):
- For each obstacle, draw an icon-style sprite centered on the hex
- Sprite is a simple Canvas-drawn shape (no asset files needed for MVP):
  - **boulder:** filled grey blob with a darker shadow underneath
  - **pillar:** vertical rectangle, lighter top face
  - **crate:** square outline with X braces
  - **tree:** dark green canopy + brown trunk
  - **rubble:** scatter of small grey rocks
- Obstacle hexes get a faint red/grey tile fill so they're recognizable as impassable

### Hover behavior

Hovering an obstacle hex shows tooltip "Blocked — {kind}" with `not-allowed` cursor in both move and attack phases.

### Movement implications

Because obstacles take up hexes:
- `hexReachable` now correctly skips obstacle hexes (just pass them in the `occupied` array)
- `hexPath` already routes around occupied hexes — monster auto-move handles obstacles for free
- Ranged attacks blocked when an obstacle sits on the line between attacker and target — players will need to reposition

---

## Turn Phase Model

Each actor's turn has two sub-phases tracked via `turn_phase: "move" | "attack"` on `CombatState`.

```
Start of actor's turn: turn_phase = "move"
  → Player clicks a hex:  move action → pos updates, turn_phase = "attack"
  → Player clicks Skip:   turn_phase = "attack" (stays in place)
  → Player attacks/casts/waits: turn advances (requires turn_phase = "attack")
  → Monster turn: AI handles both phases automatically in handleMonsterAct()
```

Move range per actor: `2 + floor(max(0, agi - 5) / 3)` hexes for fighters.

---

## Stat → Grid Effects

Stats feed directly into spatial capabilities, not just damage numbers:

| Stat | Grid effect |
|---|---|
| **AGI** | Move range per turn: `2 + floor(max(0, agi - 5) / 3)` hexes |
| **DEX** | Ranged weapon effective range: base 5 + `floor(max(0, dex - 5) / 4)` |
| **INT** | Focus/magic weapon effective range: base 3 + `floor(max(0, int - 5) / 4)` |
| **STR** | No range effect (MVP); reserved for knockback mechanic — shove an adjacent enemy 1 hex |
| **VIT** | No direct grid effect |

High-AGI Rogues and Wardens move farther per turn; high-INT Mages and Warlocks cast from greater distance; high-DEX characters extend ranged threat range.

## Weapon Range in Tiles

| weapon_range | base_range |
|---|---|
| `melee` | 1 (adjacent hex only, no stat modifier) |
| `focus` | 3 + INT bonus (see table above) |
| `ranged` | 5 + DEX bonus (see table above) |

Abilities inherit the actor's computed weapon range unless explicitly overridden (e.g., AoE abilities use a radius from the target instead).

---

## Line of Sight

Hex ray-march using axial lerp between two hex centers. Sample `distance` points along the line, round each sample to nearest hex. LOS is blocked by **explicit obstacle tiles** (future terrain feature) but **not by other units** (MVP — keeps play fluid).

---

## Monster Combat Design (Anti-Kite)

Distance now being meaningful creates a kiting exploit risk: players with ranged weapons could stay just outside monster melee range and attack freely. The monster spec system and AI must prevent this.

### Monster Attributes (additions to `CombatMonster`)

```typescript
weapon_range: WeaponRange;        // melee | ranged | focus (default: melee)
range_tiles: number;              // computed from weapon_range + tier bonus
move_range: number;               // hexes per turn (tier-scaled, see below)
specials: MonsterSpecial[];       // anti-kite and tactical abilities
```

### Monster Move Range by Tier

| Tier | move_range | weapon_range |
|---|---|---|
| 1–2 | 3 hexes | melee (mob strength in numbers) |
| 3–4 | 3 hexes | 50% chance ranged (range 4) |
| 5–6 | 4 hexes | melee or ranged; always has 1 special |
| 7–8 | 4 hexes | ranged (range 5) or melee w/ reach special |
| 9+ (boss) | 3 hexes (slower, heavier) | ranged + AoE; always has charge + 1 other |

### Monster Specials (anti-kite toolkit)

| Special | Effect |
|---|---|
| **charge** | Once per fight: when target is 3+ hexes away and monster can't attack, move range doubles this turn. Emit `charge` event + animation on canvas. |
| **reach** | Melee range extends to 2 hexes (for large creatures — trolls, golems). No separate movement needed. |
| **volley** | Ranged AoE: hits all hexes within radius 2 of a chosen fighter. Bypasses single-target LOS (rains down from above). |
| **entangle_on_hit** | On any melee hit, applies existing `entangled` status (−4 to-hit, can't move next turn). Forces player to stay in melee. |
| **guardian_aura** | Players in adjacent hexes cannot use the `flee` action and have move range halved while adjacent. |
| **pounce** | Melee; teleports adjacent to the farthest player then attacks immediately. Used when no target is in range after normal move. |

### Monster Spec Defaults (backward compat)

`createCombatState()` derives missing fields so existing monster specs don't break:
- No `weapon_range` → default `"melee"`, `range_tiles = 1`
- No `move_range` → default `2 + tier`
- No `specials` → `[]` (tier 5+ gets `["charge"]` injected automatically)

### Monster flavor assignments (new field in `MonsterSpec`)

Higher-tier monsters in `packages/core/src/flavor.ts` (wherever monster specs live) get `weapon_range` and `specials` added. Bosses always get at least `charge` + `volley` or `pounce` to prevent passive kiting.

## Monster AI (move + attack)

Each monster turn (auto-resolved):
1. If any fighter is in attack range + has LOS → skip move, attack
2. Else: BFS toward closest fighter, move up to `move_range` steps
3. After moving, if a fighter is now in range → attack
4. Still out of range → check `specials`:
   - Has **charge** (unused): trigger charge (double move), attempt attack again
   - Has **pounce** (unused): teleport adjacent to farthest fighter, attack
   - Else: skip attack, emit `wait` event
5. **entangle_on_hit** fires automatically on successful melee damage (via existing effect system)
6. **volley** replaces normal attack when ≥ 2 fighters are clustered within radius 2 of the highest-density fighter

---

## New Files to Create

### `packages/core/src/hex.ts` (~220 lines)
Pure hex math utilities. No dependencies.

```typescript
export type HexPos = { q: number; r: number };
export type HexGrid = { cols: number; rows: number };

hexDistance(a, b): number           // cube coord distance
hexLos(from, to, obstacles): boolean // ray-march LOS check
hexNeighbors(pos, grid): HexPos[]   // 6 adjacent within bounds
hexReachable(from, range, occupied, grid): HexPos[]  // BFS up to range
hexPath(from, to, occupied, grid): HexPos[]          // BFS shortest path
hexRing(center, radius, grid): HexPos[]              // all hexes at distance
inBounds(pos, grid): boolean
```

### `apps/web/src/CombatHexGrid.tsx` (~750 lines)
Canvas component. Receives `CombatState`, `pendingMove`, and callbacks.

```
Props:
  state: CombatState
  myActorId: ActorId | null
  onHexClick: (pos: HexPos) => void
  pendingParticles: ParticleEmit[]        // fed from parent on new events
```

**Hover interaction (mousemove → nearest hex):**

*Move phase (it's your turn, turn_phase === "move"):*
- Hovering a **reachable** hex: green tint + CSS cursor `pointer` + tooltip "Move here"
- Hovering an **occupied or out-of-range** hex: red tint + CSS cursor `not-allowed` + tooltip "Can't move here"
- Hovering own actor hex: neutral + cursor `default`

*Attack phase (it's your turn, turn_phase === "attack"):*
- Hovering a **valid target** hex (enemy in range + LOS): orange/red tint + cursor `crosshair` + tooltip "Attack [name]" (or "Cast" if ability selected)
- Hovering an **invalid target** hex (out of range or blocked LOS): grey desaturated + cursor `not-allowed` + tooltip "Out of range" or "No line of sight"
- Hovering a **friendly** hex during attack phase: neutral + cursor `default`

Hover state is tracked in a `hoveredHex: HexPos | null` ref updated from `mousemove`. The canvas cursor is set via `canvas.style.cursor`. Tooltips are a small React `<div>` absolutely positioned over the canvas (not drawn on canvas — keeps them accessible and styled consistently).

Internal rendering layers (drawn in order each rAF):
1. Hex tiles (normal / reachable highlight / attack-range overlay / LOS-blocked dim)
2. Actor tokens (circle + class color ring + name + HP fraction bar)
3. Particle layer (canvas-drawn, rAF-updated)

**Projectiles (ranged and magic attacks):**

When a ranged or magic attack fires, a projectile token travels across the canvas before the impact particles detonate:

| weapon_range / element | Projectile look | Motion |
|---|---|---|
| `ranged` (physical) | Small rotating arrow/blade, white/yellow trail | Linear arc, ~350ms |
| `fire` | Orange orb, ember particle trail | Linear, ~300ms |
| `ice` | Blue crystalline shard, frost trail | Linear, ~320ms |
| `lightning` | No travel — instant zigzag bolt drawn between attacker and target | Flash 80ms then fade |
| `poison` | Green glob, slow wobble | Arced, ~400ms |
| `focus` (generic magic) | Purple/white energy orb, sparkle trail | Linear, ~300ms |

Implementation: `activeProjectiles: Projectile[]` in the rAF loop. Each entry carries `{ fromPx, toPx, progress 0→1, type, color }`. Progress increments each frame by `dt / duration`. On `progress >= 1` the projectile is removed and the full particle burst fires at the target pixel position. **Melee attacks skip projectiles** — instead the attacker token briefly scales up (lunge: 1.0 → 1.15 → 1.0 over 150ms) and the impact particles fire immediately.

**Particle types** (all canvas-drawn, no DOM nodes):
- Physical hit: white/yellow sparks, outward burst
- Fire: orange/red rising embers
- Ice: blue/white crystalline fragments, slow settle
- Lightning: yellow/purple zigzag streaks
- Poison/Bleed: green/red drips, fall with gravity
- Heal: green/white rising motes
- Shield: blue deflection sparks at impact point
- Crit: larger version of above + canvas translate shake (±4px, decays 200ms)

---

## Files to Modify

### `packages/core/src/combat_machine.ts`

**CombatFighter additions:**
```typescript
pos: HexPos;
```

**CombatMonster additions:**
```typescript
pos: HexPos;
```

**CombatState additions:**
```typescript
grid: HexGrid;          // { cols: 13, rows: 7 }
turn_phase: "move" | "attack";
obstacles: HexPos[];    // empty for MVP, reserved for terrain
```

**New TurnAction:**
```typescript
| { kind: "move"; actor: ActorId; to: HexPos }
```

**New `step()` dispatch case:**
```typescript
case "move": return handleMove(state, action);
```

**`handleMove()` (new ~60-line handler):**
- Validate it's the actor's turn and `turn_phase === "move"`
- Validate `to` is in `hexReachable(actor.pos, moveRange, occupied, state.grid)`
- Update actor pos, set `turn_phase = "attack"`, emit `moved` event
- Do NOT advance `turn_index`

**`createCombatState()` additions:**
- Accept grid config (default `{ cols: 13, rows: 7 }`)
- Assign initial hex positions to fighters and monsters (spread evenly)
- Initialize `turn_phase: "move"`, `obstacles: []`

**`handlePlayerHit()` additions:**
- Before resolving damage, validate target hex is within weapon range_tiles
- If ranged/focus: also check `hexLos(attacker.pos, target.pos, state.obstacles)`
- Emit `out_of_range` reject event if check fails

**`handleMonsterAct()` additions:**
- Auto-move phase: BFS path toward closest fighter, update pos, emit `moved`
- Then attack if fighter now in range; else emit `wait`

**`handleAbility()` additions:**
- Validate ability range (melee = 1, others inherit weapon range)
- AoE abilities: compute all fighters/monsters within radius N of target

**After any turn-ending action** (attack, ability, wait, flee): set `turn_phase = "attack"` on the incoming state before advancing — then `advanceTurn()` will also reset it to `"move"` for the next actor. Actually cleaner: `advanceTurn()` sets `turn_phase = "move"` when returning the new state.

### `packages/core/src/combat.ts`

- Update `pickMonsterTarget()` to use `hexDistance()` rather than front/back weighting
- Remove `positionDamageMod()` (front/back damage reduction retired; hex range handles this organically)
- Add `rangeForWeapon(weapon_range: WeaponRange): number` → 1 | 3 | 5

### `apps/web/src/CombatPage.tsx`

- Import and render `<CombatHexGrid>` in the main combat layout
- Replace old position action buttons with move-phase UI:
  - During `turn_phase === "move"`: show "Skip Move" button; clicking a canvas hex fires move action
  - During `turn_phase === "attack"`: show Attack / Ability / Wait / Flee (existing)
- Remove the `position` action button (old front/back swap)
- Feed `ParticleEmit[]` to `CombatHexGrid` when events arrive (hit, heal, ability, etc.)
- Add phase label in turn strip: `[MOVE]` / `[ATTACK]`

### `apps/web/src/CombatShared.tsx`

- Remove `BigHpBar` position-based styling (front/back visual distinction)
- HP bars are now rendered on-canvas inside the hex grid tokens; the sidebar bars become secondary (or move to a compact list)

### `apps/web/src/CombatParticles.tsx`

- Retire DOM-based particle system (Web Animations API particle nodes)
- Replace with `ParticleEmit` type that gets fed into `CombatHexGrid` for canvas rendering
- Exported `particleEmitForEvent(event: CombatEvent, actorPositions): ParticleEmit | null` — maps combat events to particle descriptors

---

## Implementation Phases

**Phase 1 — Hex math + data model** *(packages/core)* ✅ DONE
1. Create `hex.ts` with all coordinate utilities + tests
2. Add `HexPos`, `HexGrid` to shared types
3. Update `CombatFighter`, `CombatMonster`, `CombatState` with new fields
4. Update `createCombatState()` with initial positioning
5. Add `handleMove()`, update `advanceTurn()` to reset phase
6. Update `handlePlayerHit()` + `handleMonsterAct()` for range/LOS
7. Write unit tests: hex math, move validation, range checks

**Phase 2 — Canvas grid renderer + side-panel wire-up** *(apps/web)* ✅ DONE
1. Create `CombatHexGrid.tsx`: hex tile rendering, actor tokens, click → hex coord
2. Add canvas particle system: emitter, update loop, projectile arcs
3. Wire `CombatHexGrid` into `CombatPage.tsx` as a collapsible HUD panel (initial integration; superseded by Phase 6)
4. Move/attack phase UI, hex hover states, "Skip Move" button
5. Monster auto-move BFS in `handleMonsterAct()`
6. Enable `hex_range_enabled: true` in `worker.ts` web combat init

**Phase 6 — Battlefield-first layout refactor** *(apps/web)* ← NEXT
Refactor `CombatPage.tsx` so the hex grid IS the combat scene, not a side panel.

1. **Hex grid takes the main area**
   - Remove the collapsible "Tactical Grid" panel wrapper
   - `<CombatHexGrid>` fills the combat scene's flex column (background art still behind it)
   - Dynamically size the canvas to fill available width up to a max (with internal scaling for narrow screens)
   - Drop or relocate the existing left flank / spotlight / right flank monster columns
   - Drop the `<PartyChips>` strip; the party lives on the grid now

2. **New `PawnCallout` component** *(apps/web/src/PawnCallout.tsx, ~250 lines)*
   - Absolutely positioned over the canvas using `hexToPixel(actor.pos)` → screen coords
   - Receives: `actor` (Fighter or Monster), `expanded` (boolean), `onExpandChange` (callback)
   - Compact state: small chip with avatar/initial + name + HP fraction bar + status pill cluster
   - Expanded state: reuses pieces of existing `MonsterCard` / `FighterRow` content (HP/mana bars, effects, ability state badges)
   - Flip direction (above ↔ below ↔ left ↔ right of pawn) based on bounds check
   - Auto-expanded when `actor.id === currentActorId`; otherwise expanded on hover/focus (desktop) or click (mobile)
   - Hides entirely when actor is downed (replace with a `× Downed` chip)

3. **Wire callouts into `CombatPage.tsx`**
   - For each fighter/monster, render a `<PawnCallout>` over the canvas
   - Pass through hover state from the hex grid so hovering a pawn expands its callout (use a new `onPawnHover(actorId)` callback from `CombatHexGrid`)
   - The current actor's callout always renders on top (z-index) and is auto-expanded
   - When the player needs to pick a monster target, clicking a monster pawn (in-range) fires the attack; if multi-monster and ambiguous, the callout shows a quick "Target" button

4. **Targeting flow refactor**
   - Remove the "Pick a monster to target it" prompt and the `setTargetMonsterId(...)` flow tied to monster cards
   - Clicking an in-range enemy pawn (or its callout) sets the target AND fires the attack in one motion
   - Multi-target abilities still use the existing `<TargetPicker>` modal flow

5. **Retire DOM particles**
   - Remove `CombatParticles` overlay + `triggerBurst` calls
   - All particles fire via `hexApiRef.current.emitParticle()` against canvas coordinates
   - Map every remaining `CombatEvent` type (currently hitting `triggerBurst`) to a canvas particle: bleed, poison, shield, heal, curse, deploy, etc.

6. **Remove orphaned UI**
   - Delete the position-swap (Front/Back) action button
   - Delete the `SpotlightMonster` + `MonsterCard` render paths from `CombatPage.tsx` (keep the components for now in case they're needed elsewhere)
   - Delete `PartyChips` render from `CombatPage.tsx`

7. **Polish**
   - Crit screen-shake via canvas transform (already implemented via `hex.shake()`)
   - Smooth pawn-move tween (200ms ease) so a `moved` event slides the pawn rather than snapping
   - Smooth callout follow when its pawn moves (CSS transition on `left`/`top`)
   - Pawn pulse animation on the current actor's hex
   - Active-actor outline color matches phase: yellow for MOVE, orange for ATTACK

**Phase 7 — Battlefield art + obstacles** *(parallelizable with Phase 6)*

*Engine work (packages/core):*
1. Add `Obstacle` type to `hex.ts`; change `CombatState.obstacles` to `Obstacle[]`
2. Implement `generateObstacles(grid, partyPos, monsterPos, seed, count)` in `hex.ts` with seeded RNG (pure, no `Date.now`)
3. Add `CombatInit.scene_seed?: number`; thread through `createCombatState()`
4. Update `hexLos()` signature to accept `Obstacle[]`
5. Update `hexReachable` / `hexPath` callers to include obstacle positions in `occupied`
6. Update `handleMonsterAct()`'s auto-move so monsters path around obstacles (just pass obstacles into `occupied`)
7. Tests: obstacle generation is deterministic given a seed; obstacles block LOS for ranged attacks; monsters path around obstacles; reachable hexes exclude obstacles

*Worker (apps/web/src/worker.ts):*
1. In `buildInitialCombatState()`, pass `scene_seed: quest.id` and `scene: pickScene(quest.id)` into `CombatInit`
2. Add new `generateBattlefieldArt(scene)` call alongside existing monster + view art generation (fire-and-forget, fail-soft)

*AI (apps/web/src/ai.ts):*
1. Add `BATTLEFIELD_STYLE_ANCHOR` constant
2. Add `BATTLEFIELD_PROMPTS: Record<SceneKey, string>` with per-scene top-down ground prompts
3. Add `generateBattlefieldArt(scene)` function modeled on `generateMonsterArt()`
4. Add `getOrScheduleBattlefieldArt(scene)` that head-checks R2 + kicks generation if missing

*Web (apps/web/src/CombatHexGrid.tsx):*
1. Accept new `backgroundUrl?: string` prop
2. Load the image once with `new Image()` + `.onload`, draw it as Layer 0 each rAF at ~25% alpha
3. Draw obstacles as Layer 2 with type-specific Canvas shapes (boulder/pillar/crate/tree/rubble)
4. Hover an obstacle → "Blocked — {kind}" tooltip + not-allowed cursor

*Web (apps/web/src/CombatPage.tsx):*
1. Fetch the battlefield art URL from the state's scene (server returns it on `bootstrap` event or as part of state)
2. Pass it to `<CombatHexGrid backgroundUrl={...} />`

*Schema (no migration needed):*
- `obstacles` already exists on persisted `CombatState`; the array element type changes from `HexPos` to `Obstacle`. Old saved states deserialize cleanly because `upgradeCombatState()` already initializes `obstacles: []` when absent
- Battlefield art URL is per-scene, cached in R2 — no D1 column needed

---

## Verification (local only — no deploy until reviewed)

Per project policy, nothing reaches prod until reviewed. All testing happens locally with the dev server.

**Step 1 — Unit tests (packages/core):**
```
pnpm test
```
- Hex math: `hexDistance`, `hexLos`, `hexReachable`, `hexPath` edge cases
- Move action: validates range, updates pos, sets `turn_phase = "attack"`
- Range enforcement: `handlePlayerHit` rejects out-of-range attacks
- Monster AI: charge fires when target is out of range; entangle applies on hit

**Step 2 — Local dev server:**
```
pnpm install && pnpm dev
```
Open `localhost:5173` (or whatever Vite port), sign in with a local user, start a quest.

**Phase 1–2 checklist** (already verified ✅)
- [x] Hex grid renders; fighters left, monsters right
- [x] Move phase: hover reachable → green + pointer cursor + "Move here"
- [x] Move phase: hover blocked → red + not-allowed + "Can't move here"
- [x] Clicking a reachable hex moves; phase switches to ATTACK
- [x] Skip Move button keeps actor in place, switches to ATTACK
- [x] Attack phase: hover valid target → "Attack" / "Out of range"
- [x] Range gating: focus weapon rejects target 8 hexes away
- [x] Monster auto-moves toward party when out of range

**Phase 6 checklist** (battlefield-first refactor)
- [ ] Hex grid fills the main combat area (no side panel, no spotlight portrait, no party strip)
- [ ] Pawn callouts float over each actor with name + HP fraction bar
- [ ] Current actor's callout is auto-expanded showing full card
- [ ] Hovering another pawn expands its callout; mouseout collapses it
- [ ] Callout flips above/below/left of pawn based on grid edge proximity
- [ ] Callouts smoothly follow their pawn when a `moved` event fires
- [ ] Clicking an in-range enemy pawn sets target AND fires attack in one motion
- [ ] Multi-monster: clicking an out-of-range pawn doesn't attack but tints invalid
- [ ] Downed actor: callout collapses to a small "× Downed" chip
- [ ] Ranged projectile visually arcs from attacker pawn → target pawn before impact particles
- [ ] Lightning attacks: instant zigzag bolt, no arc
- [ ] Every hit type fires the correct canvas particle (physical/fire/ice/lightning/poison/bleed/heal/shield/magic)
- [ ] Crit: bigger burst + canvas screen-shake
- [ ] Heal/shield/buff abilities emit particles at the targeted ally's pawn
- [ ] No DOM-particle artifacts (`CombatParticles` overlay removed)
- [ ] Victory/defeat modals + `CombatBurndown` still work
- [ ] Two browser tabs: pawn positions + callout states stay synchronized
- [ ] Mobile: pawn tap expands callout, action bar stays at bottom, grid scales sensibly
- [ ] Combat log + action button bar remain in place, unchanged behavior

**Phase 7 checklist** (background art + obstacles)
- [ ] Unit tests: `generateObstacles` is deterministic given seed; produces 2–4 obstacles; never on top of party/monster start hexes
- [ ] Unit tests: `hexLos` blocked when an obstacle sits on the ray
- [ ] Unit tests: `hexReachable` and monster auto-move route around obstacles
- [ ] First combat in a fresh scene kicks off `generateBattlefieldArt` (check worker logs)
- [ ] Once cached, subsequent combats in the same scene load the art instantly from R2
- [ ] Generation failure → canvas shows the existing CSS-tinted fallback; no errors surface to combat
- [ ] Battlefield art renders as a subtle ground layer under the hex grid; hexes stay legible
- [ ] 2–4 obstacles render per battlefield with scene-appropriate type (boulder/tree/pillar/etc.)
- [ ] Hovering an obstacle hex shows "Blocked — {kind}" tooltip + not-allowed cursor
- [ ] Ranged attacker can't hit a target when an obstacle sits between them; tooltip says "No line of sight"
- [ ] Monster auto-move paths around obstacles (no actor ever stands on an obstacle hex)
- [ ] Same questId resumed → identical obstacle layout (deterministic seed works)

**Do not run `wrangler deploy` or `db:migrate:remote` until the PR is reviewed.**

---

## Shipped (post-plan)

After Phases 1–7 landed, the work continued through a second wave of PRs. This section captures what actually exists on `main` so future sessions don't have to re-derive it from the merge log.

### Canvas + interaction layer

- **Canvas fills the area left of the combat log** via a `ResizeObserver` on the wrapper. Hex grid auto-fits inside with breathing pad, centered.
- **World→screen transform** applied per rAF frame (`ctx.translate` + `ctx.scale`). All draws — tiles, obstacles, pawns, particles, projectiles, swings — happen in world space and ride the transform.
- **Zoom + pan** for desktop:
  - Wheel/pinch-on-trackpad → zoom anchored at cursor
  - Middle / right / shift+left drag → pan
  - `+ / − / 0` keyboard
  - Floating `[+] [−] [⌖]` corner controls
  - Clamp: `0.5×` ↔ `2.5×`, pan overscroll slack so corner shots stay reachable
- **Mobile touch support** (PR #150):
  - Single touch → pan
  - Two-finger pinch → zoom anchored at the midpoint between the touches; snapshot of start distance/zoom/pan keeps the gesture stable across the whole pinch
  - Tap-that-became-pan suppresses the synthetic click so it doesn't fire a hex-move on release
  - `setPointerCapture` per touch so move deliveries stay reliable
- **Right edge of canvas wrapper** tracks `calc(min(280px, 22vw) + 20px)` so the canvas stays flush against the log on narrow viewports instead of the old hard-coded `right: 300px` dead strip.
- **Focused pawn card** overlays the canvas bottom-left (mirrors the log overlay on the right).
- **Target marker** moved off the pawn rim and onto the **hex tile** as a slow-drifting dashed orange border. Pawn stays uncluttered for status particles.
- **Pulsating yellow current-actor ring** dropped. Tile border + class-color rim already mark the active actor; the ambient effects need the visual budget.

### Pawn portraits

- Character/monster art cropped into the pawn circles (`charPortraitUrl` → fallback `classPortraitUrl` for fighters; `m.art_url` → fallback `monsterPortraitUrl(name)` for monsters using the deterministic R2 key). Letter glyph stays as the fallback when nothing loads.
- `crossOrigin` intentionally NOT set on the loaded image — `/img/...` is same-origin and `drawImage` doesn't need CORS for a tainted canvas. Setting `crossOrigin="anonymous"` silently failed every load because the worker doesn't emit CORS headers.

### AI battlefield terrain

- Full-page Ghibli backdrop **retired in hex mode**. Slack/legacy combats still render `CombatBackdropLayer` + flux scene art + atmospheric gradient.
- AI-generated battlefield terrain now draws **inside the canvas** at ~40% alpha, fills edge-to-edge.
- R2 cache version bumped to `v2` and the prompt rewritten to ask for an edge-filling tileable terrain with no border / focal point / vignette. First combat per scene re-generates.

### Status effects — visuals

Every `EffectType` has its own animated canvas visualization layered on the pawn. The map:

| Effect type | Display label | Visual |
|---|---|---|
| `burning` | Burning | Rising orange embers + warm flicker tint |
| `frozen` | Frozen | Jagged icicles hanging from the lower rim + frost halo + icy sheen |
| `shocked` | Shocked | Zigzag rim sparks + strobing yellow tint |
| `poisoned` | Poisoned | Slow rising green bubbles + sickly tint |
| `bleeding` | Bleeding | Falling crimson drips + smears (slowed cycle so it reads as a seep, not a paint shower) |
| `stunned` | **Containerized** | Translucent purple isometric shipping container wrapping the pawn, `CNTR` stencil, corner latches, periodic bang/jolt |
| `hexed` | Hexed | Counter-clockwise swirling purple curse wisps with pulsing halo |
| `entangled` | **Deadlocked** | 18-link interlocking metallic chain ring (tangential + radial alternating) with breathing scale |
| `empowered` | Empowered | Anime power-up speed lines radiating outward, upward density bias |
| `regen` | **Auto-Heal** | Floating light-green `+` signs bobbing upward |
| `barkskin` | **Firewalled** | Translucent green hex-mesh barrier with flickering panels + slow rotating scanline sweep + soft halo |
| `animal_form` | **Scaled Up** | Orange energy surge with upward streaks, concentric base rings, pulsing crown highlight |

Plus **rise-effect popups** for one-shot soft event indicators that don't sit on the persistent `effects` array (kind-specific colored icon + sparkles float up from the pawn for ~1.4s):

| Rise kind | Source event | Glyph |
|---|---|---|
| `taunt` | `ability_taunt` | Angry red exclamation |
| `marked` | `ability_mark` | Orange crosshair |
| `vulnerable` | (wired but no event yet) | Amber cracked shield |
| `foreseen` | `ability_foresee` | Cyan eye with sparkle |
| `test_coverage` | `ability_shield_of_faith` | Green checkmark |
| `delivery_bonus` | `ability_good_fortune_delayed` | Gold `$` coin |
| `ill_omen` | `ability_ill_omen_applied` | Purple hex rune |

Exposed via `CombatHexGridHandle.emitRiseEffect({ id, kind, actorId })`. Anchored to the actor's live animated position so rises stay glued mid-tween.

### Status effects — labels + tooltips

- `EFFECT_META` in `packages/core/src/flavor.ts` is the canonical source for `name`, `blurb`, `color`, `icon`, `emoji` per `EffectType`. **The `EffectType` key stays stable** (grep-friendly, used in engine code) but **`EFFECT_META.name` carries the engineering-themed display label** matching the applying ability. The comment block above the map documents this on-purpose divergence.
- Pawn-card chips render the **full** `EFFECT_META.name` (no more 4-char truncation), bumped chip font size + padding for legibility.
- Character sheet shows each effect as a card with label + remaining + blurb visible (no hover needed).
- `EFFECT_DESCRIPTIONS` in `apps/web/src/PawnCallout.tsx` derives from `EFFECT_META` for `EffectType` entries; soft event chips (taunt / marked / vulnerable / foreseen / shield_of_faith / good_fortune) are described locally since they're not in `EffectType`.

### Engine fixes

- **Player move range capped at `MAX_MOVE_RANGE = 5`.** Previously uncapped; `statSnapshot` sums equipment `stat_bonus.agi` onto base AGI, so a stack of AGI-rolled boots + pants + ring pushed `deriveMoveRange` past 10 (whole-grid jump in one move).
- **Monster `charge` capped at `MAX_CHARGE_MOVE = 8`.** Was doubling `move_range` with no ceiling; tier-9 monsters could sprint 10 hexes.
- **Monster ranged attacks now run `hexLos`.** Was missing — symmetrical with the existing player-side check in `handlePlayerHit`. Added to both `handleMonsterAct`'s in-range filter and `tryMonsterCharge`'s "already in range" early-out.
- **Frozen skips every turn it's active, not just the expiry turn.** The `wasFighterFrozen && !stillFighterFrozen` gate only fired when the effect EXPIRED on that tick — fine for engine-applied frozen with `remaining=1` but silently broken for any longer freeze. Same fix on the monster side. Plus:
  - Engine: `handleMove` rejects move attempts from frozen actors (was bypassing the tick-based skip)
  - Client: auto-fires `wait` when its turn comes up while frozen so the player isn't stranded with disabled buttons
- **State dispatch defers behind in-flight projectile/swing duration** so killing blows fade the pawn AFTER the shot lands, not before.

### Dev tooling

- `/api/dev/combat-effect` (local-only) — stamp / clear arbitrary effects on the player or first monster for visual testing. Bumps the DO cache via `refreshFromD1` after the D1 write.

### Memory + docs

- New memory note `project_canonical_effect_meta.md` pins the `EFFECT_META` source-of-truth rule and the `EffectType`-key ↔ engineering-name divergence convention. Lives in `~/.claude/projects/-Users-joshuaweaver-Work-gantt-quest/memory/` and is linked from `MEMORY.md`.
- `EFFECT_META` itself has a comment block explaining the same convention inline.

### Open / future

- `EFFECT_VISUAL` (local color/weight map in `CombatHexGrid.tsx`) could be folded into deriving from `EFFECT_META` for full source-of-truth hygiene. Currently has a stale `animal_form: "#22c55e"` (green) vs the canonical `#f97316` (orange). Doesn't surface visibly today because `animal_form` is in the ambient-particle list, not the arc-ring fallback that uses `EFFECT_VISUAL.color`.
- The `vulnerable` rise kind is wired in the canvas but no `ability_mark`/etc. event currently fires it — needs an engine event to trigger.
- Soft event chips (taunt / marked / vulnerable / foreseen / shield_of_faith / good_fortune) live in `EFFECT_DESCRIPTIONS` locally; they could move into `EFFECT_META` if/when we promote them to real `EffectType` entries.

### Notable merged PRs (in order)

- **#144** — Combat: tactical hex grid — ranges, AoE, projectile/swing animations, character sheets
- **#146** — Combat: cap movement, enforce LOS on monsters, boost reachable contrast
- **#148** — Combat: canvas fill + zoom/pan, status effects (visuals/labels/tooltips), engine fixes (this was the omnibus)
- **#150** — Combat: pinch-to-zoom + single-finger pan on mobile canvas
