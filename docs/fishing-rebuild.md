# Fishing Rebuild — Design Doc

**Status:** Draft / pre-implementation. Last touched 2026-11-13.
**Author:** josh + Claude.

Fishing is the last Harbor pastime still played in a DOM panel. Today it works like this: you pick one of five cells along the shore and stop a 🐟 marker, up to four times. It pays bone and copper. This doc rebuilds it the same way the Quarry (#369) and Felling (#370/#372) were rebuilt. You play it in the Harbor itself, the camera orbits down to the water, and the game is about *feel*. The rules stay server-authoritative.

The big changes from today:

- **Where:** from the end of any of the three piers, plus the old shore spot.
- **How long:** a sitting lasts as long as you like. It costs **one stamina when it ends**, not when it starts.
- **The game:** cast, wait for the bite, then fight one fish at a time with a single button.
- **The catch:** fish are real items with a species, weight and length. You sell them, keep them, or mount them.

---

## Goals

- Play happens in the world. The camera orbits down from the map view to **first person** at the pier end, looking out to sea, with a 3D rod in the hero's hands that bends.
- **One button** (Space, click, or touch): press-and-hold or tap. Everything else is read from the scene and two meters.
- A fight about **reading the fish**. When it runs you ease off (tap) or risk the line (hold). When it rests you reel (hold). Tire it out without snapping the line.
- **Strength and Dexterity** both matter. STR sets reel speed and how fast you tire the fish. DEX sets how fast line stress builds, how long the line holds at the limit, and how wide the hook-set window is.
- A **large, data-driven catalog** of about 60 entries: about 45 creatures and 14 hauls (junk and treasure). Every creature gets a **matching 3D model and pixel sprite** from one shared shape definition.
- An economy: sell to **Old Tam** (steady, picky) or the **fishmonger** (rates move every 6 hours). Keep **specimens**, and mount them at home. A **crew-record** fish goes on the pub wall.
- **Craftable boats** (phase 6): a barrel for the coast, the rocks and the wreck, and a rowboat that reaches the **open sea**, home to the biggest fish.
- **Soft failure** throughout. A snapped line loses that fish only, never the sitting's catch (see the *soft death* principle).

## Non-goals (v1)

- Capsizing, a fish towing the boat, sails, or rowing beyond the Harbor map. Boats (phase 6) are a way to reach water, not a sailing game.
- Bait, lures or rod upgrades. The data model leaves room (`gear` on the sitting), but v1 has one rod.
- A supply/glut market, where crew sales push prices down. Rates are seeded, so no shared market state is stored.
- Watching other players fish live. They see you standing on the pier with a rod (a sprite look), not your fight.
- Time-of-day or weather tables. The catalog has a `night` flag field, but v1 ignores it until the server has a clock for day and night.

---

## What exists today (relevant pieces)

| Thing | Where | Notes |
|---|---|---|
| Fishing rules | `packages/world/src/gather.ts:226-305` | cells, school, `timingGrade` stops; pays bone 65 / copper 35 |
| Fishing UI | `apps/game/src/client/GatherPanel.tsx`, `TimingBar.tsx` | DOM `DragPanel` |
| Fishing POI | `HARBOR_GATHER.fishing = at(4,12)` (`harbor.ts:42`), model `WorldRenderer.ts:2667` | shore rim, forced to `mud` |
| Piers | `HARBOR_PIERS = [at(5,14), at(8,14), at(11,14)]` (`harbor.ts:27`) | `dock` biome, walkable; crew ships moor at them as `ship:<code>` POIs |
| In-world stage API | `WorldMinigame` (`WorldRenderer.ts:463`), `startMinigame`/`endMinigame` (`:1645`/`:1669`) | `frame()` returns eye/look/blend/fov; renderer orbits |
| Hold detection | `Quarry.tsx:147-211` + `MineStage.pressDown/pressUp` | DOM overlay with pointer capture, window Space keydown/keyup |
| Real-time replay | `mine.ts landBlows`, `felling.ts replayChops/replayStrikes` | server stamps clocks; client reports inputs; server replays |
| Stamina | `startOuting` (`server/gather.ts`) | spent **at start**, 3 per UTC day, `gathering.used` |
| Hero | 18×22 canvas sprite, **drawn facing right only** (`sprites.ts:639`) | no back view, no 3D hand attach; `Look.weapon` bakes tools into pixels |
| Held tools in stages | quarry pick (`MineStage.ts:462`), felling axe (`fellingScene.ts:343`) | first-person meshes; hero sprite hidden |
| Materials | `resources(player_id, kind, qty)` | counts only; no per-item attributes |
| Wall decor | `mounted_fish` furnishing (`hut.ts:205-213`, model `props.ts:573`) | `furnishings.meta_json` exists but `getHut` never selects it |
| Pub | per-crew DO; `PUB_BARKEEP` Old Tam only talks; fittings fixed, nothing stored | "Fish Stew" on the menu is flavour |
| Records | none in apps/game | `fish_best_ms`, `fisher_100` are in legacy apps/web only |

Today's fishing is the main source of **bone** and one of the sources of **copper**. Bone feeds galley chowder, the galley project, Stoneskin, wall-piece recipes and Gretta's errands. The haul table below keeps both flowing (see *Hauls*).

---

## The sitting

A sitting is a gathering outing (`spot: "fishing"`), so the existing rules still apply: one outing at a time, `session_json` compare-and-swap, and a claim UUID on payout. New state lives under `GatherState.sitting`.

```ts
interface Sitting {
  spot: FishSpot;               // where the last cast was made from (see "Where you fish from")
  vessel: Vessel | null;        // "barrel" | "rowboat" when afloat (phase 6)
  startedAt: number;
  lastActiveAt: number;         // server clock; drives the idle close
  creel: CaughtFish[];          // landed and kept this sitting
  creelGrams: number;
  released: number;             // thrown back (no payout, still counts for the Catch Book)
  cast: CastState | null;       // the line in the water, if any
  fight: FightScript | null;    // the hooked fish, if any (server-only parts stripped in the view)
  lostToday: number;            // snapped/thrown hooks, for flavour and XP
}
```

### Stamina, spent at the end

- **Start:** you need at least 1 stamina left, but none is spent. `startOuting` has a fishing branch that sets `session_json` without incrementing `used`. It uses the same "no outing already running" guard, plus `used < max`.
- **End:** the sitting closes, and spends 1 stamina, in one of three ways:
  1. **You choose "Done fishing."**
  2. **The creel is full.** The weight limit is **25 kg + 1 kg per point of STR**. The fish that overflows it is still kept: "That's all you can carry." So one monster can end a sitting by itself, which is the right kind of drama.
  3. **The idle close.** The line has sat untouched for more than **15 min**. This is checked **lazily** on the next status read or step, with no timers or alarms. The catch is kept and the stamina spent, as if you had chosen to stop.
- The `used` increment on close is conditional on the claim, so a close can't charge twice.
- **Edge cases:**
  - Rest and pub meals only ever *give* stamina back, and nothing else can spend stamina while a sitting holds the one outing slot. So the close never finds 0 left. It still guards with `MIN(used + 1, max)`.
  - If the UTC day rolls over mid-sitting, the close charges the new day.
- **UI copy:** the start button changes from "uses 1 stamina" to "costs 1 stamina when you're done". `StaminaBolts` shows the pending bolt as pulsing while a sitting is open.

### Catching one fish

```
idle ──hold──▶ casting ──release──▶ waiting ──bite+press──▶ fight ──D≤0──▶ landed ─▶ keep / release
                 (power)              (nibbles)     │miss            │snap/throw
                                                     ▼                ▼
                                                   idle             idle (fish lost; creel untouched)
```

1. **Cast:** hold to charge, release to throw. The distance runs 0..1, up to about 35 m. Farther water shifts the catch toward bigger fish and deeper species. It also leaves more line out, so the fight is longer and the line has less room to give before it runs out. The server stamps the cast time.
2. **Wait:** the bobber sits in the water. The seeded schedule gives 0–3 **nibbles**, which are small dips (pressing then is a miss), and then the **bite**: a hard plunge, a splash and a tug on the rod tip.
   - The hook-set window is **350 ms + up to 250 ms from DEX** (`timingEase`).
   - Miss it and the fish is gone. Recasting is free.
   - The client reports the press time. The server judges it the same way `timed()` judges a stop today: it believes the report if it falls within the round-trip slack.
3. **Fight:** see below. The fish's identity stays hidden until it's landed. You only see its behaviour, the strength meter, and a silhouette when it breaks the surface.
4. **Landed:** the fish swings up on the line to the hero, and a catch card shows species, weight, length, specimen badge, PB/record flags and today's price. **Keep** puts it in the creel. **Release** throws it back, which is useful for chasing records without filling the creel. Hauls are always kept.

---

## The fight (the core)

This is a deterministic simulation in `packages/world/src/fishfight.ts`, run on a **fixed 50 ms tick**. The client runs it live from the button. The server re-runs it from the reported inputs and its result stands.

### State per tick

| | Meaning | Shown as |
|---|---|---|
| `S` 0..1 | fish stamina | **Fish strength meter** |
| `T` 0..1.2 | line tension (1.0 = breaking point) | **Tension meter** + rod bend |
| `D` m | distance from the rod tip to the fish | line length, splash position |
| `mode` | `run` / `rest` / `jump` / `shake` | fish motion, wake, line angle |

### The fish's script

The fish is rolled at the bite, from the sitting's RNG. Its fight script is a list of segments `{mode, ms, power}` generated from its **style** and **weight**:

- **`power`** grows with weight (`basePower × kg^0.6`).
- **Runs** get shorter and weaker as `S` falls, so a tired fish runs in short, sad bursts.
- **Styles:**
  - **darter:** frequent short fast runs.
  - **diver:** few, long, heavy runs straight out.
  - **thrasher:** head-shakes, which are tension spikes.
  - **plodder:** a steady low pull with lots of stamina.
  - **leaper:** jumps, where the line goes slack and then snaps tight.
  - **dead weight:** hauls; never runs, just heavy.

### What the button does

The button's input is turned into pressure `P`:

- **Hold** = `P = 1`.
- **Tap:** a press shorter than 200 ms gives a pressure pulse of `0.5` that lasts 250 ms. Rhythmic tapping therefore averages about 0.5 ("pumping").
- **Released** = `P = 0`.

| Fish is… | P = 1 (hold) | P ≈ 0.5 (tapping) | P = 0 (nothing) |
|---|---|---|---|
| **running** | tension climbs fast; fish tires fastest; line still pays out slowly | tension climbs gently; fish tires steadily; line pays out | tension falls; fish takes line fast; fish barely tires; long slack run risks a **thrown hook** |
| **resting** | **reels in** (`D` falls at reel speed); fish tires a little; mild tension | reels in slowly | fish recovers stamina |

### Rough formulas (to tune)

```
str = statEase(STR), dex = statEase(DEX)              // 0..1 from statPct, same curve as timingEase

run:   Ttarget = pull × (0.35 + 0.65·P) × (1.15 − 0.35·dex)     where pull = power × (0.35 + 0.65·S) / LINE
       S      −= drainRun × (0.25 + P) × (0.8 + 0.5·str)  per tick
       D      += runSpeed × (1 − 0.7·P)
rest:  Ttarget = 0.15·P
       D      −= P × reelSpeed × (0.8 + 0.6·str)
       S      += P > 0 ? −drainReel : +recover
T      → Ttarget at a fixed rate (thrash/jump modes add spikes)
snap   if T > 1.0 for > (150 + 250·dex) ms
spool  if D > LINE_M (60 m): the line runs out and breaks
throw  if running with P = 0 and T < 0.08 for > 1.5 s: a seeded chance per tick the hook falls out
land   when D ≤ 1 m
cap    a fight longer than 3 min ends with the fish slipping the hook ("It wears you out")
```

What the player feels:

- **Hold all the time:** snaps the line on anything with a real run.
- **Never hold:** spools out or throws the hook.
- **Read the runs and tap through them**, then hold through the rests: lands it.
- A **strong** hero reels the rests faster and finishes the fish sooner. A **dexterous** hero can hold harder through runs without breaking, and hooks more bites.

### Determinism and replay

- **Fixed tick, integer milliseconds.** The tick uses only `+ − × /`, `min`/`max` and `Math.pow` with fixed exponents. It doesn't use `Math.sin`/`exp`, which can differ between V8 and JSC. Rendering wobble lives in the client only.
- **Report:** when the fight ends (land, snap or throw), the client posts `{ t: "fought", edges: [downMs, upMs, …] }`. That's at most 600 edges, timed from the hook-set.
- **Server checks:**
  - The fight can't have lasted longer than `now − hookAt + 100`.
  - Edges must be in order.
  - It re-runs `fight()` and its outcome stands. If the client disagrees, it resyncs, as the quarry does.
- **Known gap:** the client knows the bite schedule and the fish's script, because it needs them to animate. A bot could play perfectly, and we accept that for a low-stakes pastime. The script carries power and style, **not** species or weight, so the reveal still surprises.

---

## In-world presentation

### Where you fish from

- **New spots:** the three `HARBOR_PIERS` heads plus the old shore spot. Standing on any of them shows "Cast a line" (`TileAction`, `HarborView.tsx:294`).
- **A moored crew ship at a pier doesn't block fishing.** You cast off the side away from the hull.
- **Each pier has its own water**, which weights the catalog:

| Spot | Water | Leans toward |
|---|---|---|
| West pier `at(5,14)` | **Shallows**: weed and sand | small, common, flatfish, eels, rays |
| Middle pier `at(8,14)` | **Harbor mouth** | schooling fish, fast runners, leapers |
| East pier `at(11,14)` | **Deep and rocky**, near the lighthouse, rocks and wreck | heavy divers, bottom fish, the biggest fish |
| Shore spot `at(4,12)` | **Shallows**, short casts only | the easiest spot for beginners |

- `HARBOR_GATHER.fishing` becomes a list. For gather-spot lookups, `GATHER_SPOT_IDS` maps `fishing` to all four hexes.
- **Afloat (phase 6):** any water hex the boat can reach is a spot. Its water comes from `waterAt(hex)`, and the outer edge leads to the **open sea**. See *Boats*.

### Camera

`FishingStage implements WorldMinigame`, mounted with `world.startMinigame(g => new FishingStage(...), pierHex)`.

- `frame()` orbits from the map view down to **first person at eye height** (`EYE_HEIGHT` as felling uses) on the pier end, looking out to sea along the pier's seaward axis. That axis comes from the pier hex minus the island centre, as felling computes `seaward`. The view tilts slightly down, so the water near the pier and the horizon are both in frame.
- **FOV:** about 55°.
- **During a fight:** the look target drifts toward where the line meets the water. The camera pushes in slightly as `D` shrinks, and leans into big runs.
- **Timing:** the orbit in takes 1.6 s and out takes 1.2 s, with smootherstep easing. Under `prefers-reduced-motion` both take 0.2 s.
- **Landing:** a short follow shot of the fish lifting out of the water, then the catch card.

### The hero and the rod (first person)

*Decided: first person, like the quarry.* The hero sprite is hidden by `startMinigame` as usual.

- **Hands and rod:** the rod comes in from the lower right, with simple low-poly forearms and hands: a sleeve tinted from the hero's outfit colours, gripping the cork and the reel handle. It is built like the quarry pick: `OVERLAY_LAYER`, depthTest off, re-posed each frame from the camera basis (`posePick`, `MineStage.ts:1007`). The rod tip reaches far enough into the scene to bend visibly against the water.
- **Body motion:**
  - The hands pull back and up on a hold.
  - Each tap is a short jerk.
  - When a run drags, the rod leans toward the line.
  - On a cast, the rod sweeps back over the shoulder and forward.
- **Overworld look:** add `Look.weapon = "rod"` and show it while a sitting is open. Crewmates in the Harbor then see you on the pier with a rod. The look is sent through HarborRoom presence like any other look change.

### Rod, line and water

- **Rod:**
  - The rod is a chain of 8 tapered cylinder segments (cork grip, reel, blank, tip-top), flat-shaded like the props.
  - **Bend:** each segment rotates by `T × k × (i/n)²` toward the line direction, so most of the bend is near the tip. The rod springs back with a damped spring.
  - Taps add a small tip flick.
  - At `T > 0.85` the rod trembles and creaks.
- **Reel:** the handle spins while `D` falls. A clicking ratchet plays while line pays out, and its pitch follows the run speed.
- **Line:**
  - A `THREE.Line` along a quadratic curve from the rod tip to the entry point. Slack is drawn as sag: the control point drops by `(1 − T)`.
  - **Colour:** it brightens from white to red as tension crosses 0.85.
- **Bobber:** shown while waiting. Nibbles are small dips with a ring. The bite is a full plunge with a splash. It uses `addWaterRipple`.
- **The fish in the water:**
  - **Running:** a wake trails behind the entry point, which moves visibly away, so the run is plain to see.
  - **Resting:** a dark silhouette sits just under the surface (the shared fish model, darkened, with fog).
  - **Leaping:** the full 3D model clears the water, with a splash.
  - **Hauls:** a heavy shape with bubbles.
- **Landing:** the fish's 3D model, scaled to its real length, swings from the line beside the hero.

### HUD (DOM, over the canvas)

- **Tension meter:** a vertical bar by the rod side with three zones: green, amber from 0.7, and red from 0.95. It pulses in the red, with a crackle sound.
- **Fish strength meter:** a bar with a fish icon that drains as `S` falls. Before the fish is landed it shows **"?"** in place of the species.
- **Line out:** a small spool gauge (`D` / 60 m). It flashes when the spool is nearly empty.
- **The sitting's state** sits in a corner: the creel weight against its limit (e.g. `11.4 / 31 kg`) and catch count. "Done fishing" is a button there and also on Esc.
- **A one-line hint** that fades after the first few fights: "Tap while it runs · Hold while it rests".
- **Input:** a full-screen `.fish-hit` overlay with pointer capture, and window Space keydown/keyup, copying `Quarry.tsx:147-211`. Pointer-up and key-up are both needed, and the renderer doesn't forward them.

### Sound

New names in `audio/names.ts`: cast whoosh, plop, nibble tick, bite splash, reel click, line-out ratchet, creak, snap, splash-land, flop, record fanfare.

---

## The catalog

Data lives in `packages/world/src/fishcatalog.ts`. Each entry:

```ts
interface FishDef {
  id: string; name: string; blurb: string;
  kind: "fish" | "creature" | "haul";
  water: Water[];                    // "shallows" | "mouth" | "deep" | "sea"
  rarity: "common" | "uncommon" | "rare" | "legendary" | "mythic";
  lengthCm: [number, number];        // rolled skewed toward the low end
  weightKg: [number, number];        // derived: k·L³ × condition 0.85–1.15, clamped
  style: FightStyle;
  pricePerKg: number;                // base for the fishmonger
  kitchen?: boolean;                 // Old Tam buys it
  yields?: Resources;                // hauls: materials on landing
  shape: FishShapeId;                // drives BOTH the 3D model and the sprite
  palette: string[]; pattern?: "stripes" | "spots" | "bars" | "glow";
  night?: boolean;                   // reserved
}
```

- **Rarity weights:** common 60, uncommon 25, rare 10, legendary 1.5, mythic 0.05. Hauls make up about 12% of bites at any spot.
- **Size:** `r = u^2.2`, so most catches are small and a specimen tail exists. **Specimen** means the top 20% of a species' weight range. Every rare or better catch counts as one.
- Weights are stored as **grams** and lengths as **mm**.

### Draft list (59)

**Shallows (west pier, shore)**

| Name | Rarity | Length cm | Weight kg | Style | Notes |
|---|---|---|---|---|---|
| Harbor sprat | common | 8–15 | 0.01–0.04 | darter | kitchen |
| Mud goby | common | 6–14 | 0.01–0.05 | darter | |
| Sandbar flounder | common | 20–50 | 0.1–1.8 | plodder | kitchen |
| Green wrasse | common | 15–40 | 0.1–1.2 | darter | |
| Striped mullet | uncommon | 30–70 | 0.4–4 | leaper | kitchen |
| Glass eel | uncommon | 30–90 | 0.1–1.5 | thrasher | |
| Reed barracuda | uncommon | 50–120 | 0.8–9 | darter | |
| Lantern sole | rare | 25–60 | 0.3–3 | plodder | glows faintly |
| Spotted ray | rare | 50–140 | 3–25 | diver | bespoke shape |
| Old Whiskers (harbor wels) | legendary | 150–260 | 40–120 | diver | |

**Harbor mouth (middle pier)**

| Name | Rarity | Length cm | Weight kg | Style | Notes |
|---|---|---|---|---|---|
| Silver herring | common | 18–35 | 0.05–0.5 | darter | kitchen |
| Mackerel | common | 25–50 | 0.2–1.5 | darter | kitchen |
| Blue pollock | common | 35–80 | 0.5–6 | plodder | kitchen |
| Sea bream | common | 25–55 | 0.3–3 | darter | kitchen |
| Sea bass | uncommon | 40–90 | 0.8–10 | thrasher | kitchen |
| Bonito | uncommon | 45–80 | 1–7 | darter | |
| Garfish | uncommon | 50–90 | 0.3–1.5 | leaper | needle beak, bespoke mouth |
| Amberjack | rare | 60–150 | 4–40 | diver | |
| Silver king (tarpon) | rare | 100–200 | 10–80 | leaper | |
| Gate sturgeon | legendary | 150–280 | 30–150 | plodder | armoured plates |

**Open sea (rowboat only, phase 6)**

| Name | Rarity | Length cm | Weight kg | Style | Notes |
|---|---|---|---|---|---|
| Flying fish | common | 20–40 | 0.1–0.6 | leaper | wing fins |
| Skipjack | common | 40–80 | 1–8 | darter | kitchen |
| Albacore | common | 60–120 | 4–30 | diver | kitchen |
| Blue shark | uncommon | 150–280 | 20–120 | thrasher | |
| Drifting sunfish | uncommon | 100–250 | 50–200 | plodder | bespoke shape; huge and lazy |
| Sunfin dorado | rare | 70–180 | 4–35 | leaper | |
| Bluefin | rare | 90–200 | 12–120 | diver | |
| Broadbill swordfish | rare | 150–300 | 30–200 | leaper + diver | |
| Sailback | legendary | 180–300 | 30–90 | leaper | |
| Ribbon oarfish | legendary | 300–600 | 20–150 | plodder | bespoke long ribbon |

**Deep and rocky (east pier)**

| Name | Rarity | Length cm | Weight kg | Style | Notes |
|---|---|---|---|---|---|
| Rockling | common | 20–45 | 0.1–1.2 | plodder | kitchen |
| Red snapper | common | 30–70 | 0.5–8 | thrasher | kitchen |
| Lingcod | common | 50–120 | 1–20 | diver | kitchen |
| Scorpionfish | uncommon | 20–45 | 0.3–2.5 | thrasher | |
| Conger eel | uncommon | 80–220 | 2–40 | thrasher | |
| Inkjaw squid | uncommon | 30–90 | 0.5–8 | thrasher | creature, bespoke |
| Wreck grouper | rare | 70–160 | 6–90 | diver | |
| Moonfish | rare | 80–150 | 15–60 | plodder | |
| Grey reef shark | rare | 120–250 | 20–150 | thrasher | |
| Halibut | rare | 80–220 | 6–120 | plodder | |
| Lampjaw angler | legendary | 60–120 | 8–50 | plodder | glow, `night` later |

**Any water** (except Ironjaw)

| Name | Rarity | Length cm | Weight kg | Style | Notes |
|---|---|---|---|---|---|
| Shore crab | common | 6–15 | 0.05–0.4 | dead weight | creature, kitchen |
| Spider crab | uncommon | 20–60 | 0.5–5 | dead weight | creature |
| Blue lobster | rare (deep only) | 25–60 | 0.5–6 | thrasher | creature; bites best by the rocks |
| **Old Ironjaw** | mythic, **open sea only** | 250–380 | 150–300 | diver + thrasher | scarred shark, about 1 in 2000. Near-unlandable for weak heroes, and ends any sitting. A **bonus** Catch Book slot, not needed to finish it. |

**Hauls (dead weight; pay materials or gold)**

| Name | Rarity | Pays |
|---|---|---|
| Kelp tangle | common | nothing (a laugh) |
| Old boot | common | nothing |
| Driftwood | common | 1 wood |
| Fish skeleton | common | 1 bone |
| Whalebone bundle | uncommon | 2 bone |
| Rusted kettle | uncommon | 1 copper |
| Barnacled chain | uncommon | 1 iron |
| Message in a bottle | uncommon | a short lore note + 3–8 gold |
| Lost tackle tin | uncommon | 5–12 gold |
| Sodden crate | uncommon | 2 random materials |
| Pearl oyster | rare | 1 gem |
| Smuggler's lockbox | rare | 20–50 gold |
| Ship's bell | legendary | the **ship's bell** wall furnishing (new) |
| Mermaid's comb | legendary | sells for 120 gold, or keep it as a trophy |

Bone and copper keep flowing through **fish skeleton, whalebone, kettle and crate**, and also from enemy drops, the caverns and the quarry. The galley's chowder keeps `{bone, herbs}` in v1. A later change could let chowder take kitchen fish.

---

## Art: one shape, two renders

The catalog only has value if every entry looks distinct, and the 3D model and sprite must match. Both come from **one parametric definition** in `apps/game/src/client/fishArt.ts`:

```ts
interface FishShape {
  profile: [x, top, bottom][];     // side outline, nose→tail, ~8 stations
  girth: number;                   // width / height ratio (flat sole vs round tuna)
  tail: "fork" | "moon" | "round" | "eel" | "fan";
  fins: { dorsal: [start, end, height]; anal?: …; pectoral?: … ; sail?: … };
  mouth: "small" | "jaw" | "beak" | "whisker";
}
```

- **3D:** build a tube mesh through the stations (8 rings × 8 sides) with elliptical sections scaled by `girth`. Fins and tail are thin extruded shapes. The material is flat-shaded Lambert with vertex colours from palette and pattern (stripes, spots or bars by ring and side). Glow patterns get an emissive layer that the Fancy pass picks up.
  - The mesh is scaled to the catch's real length on landing, on the hut and pub mounts, and in the water as a silhouette.
- **Sprite:** rasterize the same profile side-on to a 24×12 (or species-scaled) pixel canvas: outline, fill, pattern pass and an eye pixel. It is used for the Catch Book, catch cards, the creel strip, inventory, the fishmonger's chalkboard and `PixelIcon`.
- **Bespoke builders** for shapes the profile can't make: the ray, squid, crab, lobster, and each haul (boot, kettle, bottle, crate, bell, chest).
- **Admin:** the existing `IconEditor` and `PaletteEditor` get a "fish" tab that previews the 3D model and sprite side by side for every catalog entry. That's how we check they match.

---

## Items, selling and storage

### Storage: new D1 tables (`fish`, `fish_bests` and `fish_records` in `0025_fish.sql`; `book_rewards` and `pub_mounts` come with phase 5)

```sql
CREATE TABLE fish (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL, species TEXT NOT NULL,
  grams INTEGER NOT NULL, mm INTEGER NOT NULL, specimen INTEGER NOT NULL,
  spot TEXT NOT NULL, caught_at INTEGER NOT NULL,
  place TEXT NOT NULL DEFAULT 'icebox',   -- icebox | trophy | hut | pub | sold
  furnishing_id TEXT                      -- when mounted in a hut
);
-- One row per player per catalog entry they have met: the Catch Book.
-- A row with caught = 0 is "seen, not landed" (it got away), which sharpens that slot's hint.
CREATE TABLE fish_bests   (player_id, species, grams, mm, fish_id, first_at, best_at,
                           caught INTEGER NOT NULL DEFAULT 0, lost INTEGER NOT NULL DEFAULT 0,
                           specimen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(player_id, species));
CREATE TABLE book_rewards (player_id, page TEXT, claimed_at, PRIMARY KEY(player_id, page));
CREATE TABLE fish_records (crew_id,   species, grams, mm, fish_id, player_id, caught_at, PRIMARY KEY(crew_id, species));
CREATE TABLE pub_mounts   (crew_id, slot INTEGER, fish_id, PRIMARY KEY(crew_id, slot));
```

- **On close:** the creel is written to `fish` (`place='icebox'`), bests and records are upserted, and haul materials and gold are paid. This happens in the same claim-guarded batch as the stamina spend.
- **Icebox:** fresh catch, capped at **60 kg**. If it's full you can still fish, but you must sell before closing, or the excess is sold to Old Tam on close at his rate.
- **Trophy chest:** specimens only, **6 slots**, kept indefinitely. Mounting a fish moves it out of the chest. When a pub mount is displaced, the fish returns to the chest.

### Old Tam (pub keeper)

- He buys **kitchen** species only, at a **steady** price: `0.8 × base × kg^0.9`, with a floor of 1 gold.
- Route: `POST /api/pub/sell-fish`, with a "Sell to Tam" option in the pub.
- His lines change once he buys: the canned stew line now has something to point at.

### The fishmonger (new stall on the quay)

- **Location:** the old fishing POI at `at(4,12)` turns into the fish stall, and it is still the shore fishing spot.
- **Rates move each 6 h slot**, seeded by `crewId + slot` the way `salesman.ts` is, so nothing is stored. Each species gets a multiplier of **0.6–1.6**. One or two **"Wanted today"** species pay **2×**, and they're chalked on a board you can read from the Harbor.
- **Price:** `base × kg^0.85 × rate`, plus +25% for specimens. The stall buys everything, trophies included.
- **Client:** shows the current board and when the next slot starts, through a `fishClock.ts` mirroring `salesmanClock.ts`.

### XP

- Each closed sitting pays `gatherXp`-style XP within the daily Harbor cap: 4, plus 1 per 2 fish kept, up to +4.
- **Outside the cap**, like `PERFECT_SPLIT_XP`:
  - +1 for each new species in your Catch Book.
  - +2 for a new crew record.

---

## The Catch Book

The Catch Book is a full set to collect. It has one page per water, so every pier, and the open sea, has a page to fill. It opens from a book icon in the fishing HUD and from the Hero sheet. Crewmates can browse it when they visit your hut, or from your public hero.

### Pages

| Page | Slots | Fished from |
|---|---|---|
| Shallows | 10 | West pier, shore |
| Harbor Mouth | 10 | Middle pier |
| Deep & Rocky | 11 | East pier, or by barrel at the rocks and the wreck |
| Open Sea | 10 | **Rowboat only** |
| Strays | 3 (shore crab, spider crab, blue lobster) | Any water |
| Flotsam | 14 hauls | Anywhere |
| **Bonus: Old Ironjaw** | 1, **outside the count** | Open sea |

- **The count:** 58 slots make a full book. A full book needs the rowboat, so the Open Sea page is the long goal. **Old Ironjaw** gets his own gilt-edged slot at the back. He is never needed to finish a page or the book, so a 1-in-2000 bite never blocks completion. Landing him earns his own reward (below).
- **Page order:** commons first, then rarer entries, legendaries last on each page. A page reads as a ladder.

### A slot

| State | Shows |
|---|---|
| **Unknown** | A dark silhouette (the shared sprite, filled flat), the rarity pip, and a hint at where it bites: "Bites off the east pier, far out." |
| **Got away** (hooked, never landed) | The silhouette with an outline, the same hint made sharper ("You lost one of these off the middle pier, on a long cast"). An Open Sea slot says "Only out past the Harbor, by boat" until you own a rowboat, and how many got away |
| **Caught** | The full-colour sprite, best weight and length, the count caught, and the date of the first catch. A **star** marks a specimen landed; a **crown** marks the crew record held. |

- **Opening a caught slot** shows its 3D model turning on a stand. It's sized to your best catch, with the blurb and today's fishmonger rate. This is the same art as the catch card (see *Art*).
- **Hauls** show a count and the first-found date, with no weight. The message in a bottle keeps every lore note you've found, in a small stack you can flip through.
- **"Got away" needs the fish rolled at the bite.** The plan already rolls it then, so a snap or a thrown hook writes a `lost` row. The species stays hidden in the fight itself. You only learn what it was afterwards, in the book: "That was a Wreck grouper."

### Rewards

| For | Reward |
|---|---|
| Each new entry | +1 XP, outside the daily Harbor cap (as in *XP*) |
| Finishing a page | A **wall piece for home**, plus +5 XP outside the cap |
| Finishing the book (58) | A **title** ("Harbormaster's Angler") and the **gilded rod**: `Look.weapon = "rod_gilded"`, shown on your sprite while fishing and on your first-person rod |
| **Landing Old Ironjaw** (bonus) | His **jaw** as a wall piece, and a line on the notice board for the whole crew. He also counts for crew records like any species. |

- **Page wall pieces** are new `FURNISHINGS` wall entries, granted on completion and never sold in a shop:
  - Shallows: a framed chart of the shallows.
  - Harbor Mouth: a brass spyglass on pegs.
  - Deep & Rocky: a lighthouse lamp lens.
  - Open Sea: a pair of crossed oars.
  - Strays: a lobster pot.
  - Flotsam: a net of glass floats.
- **Granting:** a page is checked on close, in the same batch as the catch. When a slot fills a page, a `book_rewards` row is written, and the furnishing grant plus XP are conditional on that insert, so a page can't pay twice.
- **Titles:** apps/game has no titles yet. The book needs a small `characters.title` field, shown under the name on the hero plate and the hero sheet. It is the only title source for now.

### Growing the catalog

- **New entries** join their water's page as new slots. An already-finished page shows "1 new" and is no longer complete. Rewards already claimed stay claimed, and finishing the page again pays only the new slot's +1.
- **Rarity weights:** nobody should need hundreds of sittings to finish a page. The legendary weight (1.5) is set so a legendary turns up about once every 40–60 bites at its own pier. Tune it against a seeded simulation of sittings in the phase-1 tests.

---

## Boats (phase 6)

Two craftable boats let you walk off a pier or the shore onto the water, and fish from any water hex they can reach. The rowboat also leads to the **open sea**.

### The two boats

| | Barrel | Rowboat |
|---|---|---|
| Recipe | about 6 wood + 1 iron (hoops) | about 20 wood + 4 copper + 2 fur, and **needs a blueprint** |
| Reach | **Coastal** water only: hexes next to land or a pier, which includes the rocks and the wreck | **Any** water hex, plus "Row out and cast" from the outer edge to the open sea |
| Moves | at half walking speed, wobbling | at walking speed; oars stroke, with a wake (`addWaterRipple`) |
| Creel | as on the pier | **+20 kg** (the boat carries it) |
| Look | sprite sunk to the waist in the barrel | sprite sat in the boat, oars at the sides |

- **Crafting** goes through the hut's craft flow (`craftFurnishing`, `craftProblem`). The boats are new `FURNISHINGS` entries of a new kind, `vessel`. A vessel is never placed in the hut, and is shown as "tied up at the pier". If you own both, the rowboat is used.
- **Walking off:** owning a boat lets the Harbor accept steps onto water:
  - `harborPath(map, from, to, vessel)` takes the vessel. With none, water is blocked as today. A barrel allows water hexes that border land or a dock; a rowboat allows all water.
  - The hexes behind a pier with a moored crew ship (its hull at z+1.75) stay blocked.
  - The HarborRoom `move` handler reads the player's vessel when they join, and again on `refresh` after crafting.
- **On the water:**
  - `HarborPlayer` gains `afloat?: "barrel" | "rowboat"`. The server sets it whenever a move ends on water, and clears it when you step back onto land or a dock.
  - Crewmates see the boat under you. The renderer adds a small boat or barrel mesh under the sprite, lowers the sprite, and bobs both with the water.
  - You can't lay out a bedroll afloat.
- **Fishing afloat:**
  - "Cast a line" shows on any water hex while you're afloat. The stage is the same first-person view, with the barrel rim or the rowboat's gunwale and oarlocks along the bottom of the frame. It rocks more than the pier does.
  - **Which water you're on:** `waterAt(hex)` in `harbor.ts` zones the coastal water:
    - The west and south-west coast is **shallows**.
    - South, in front of the middle pier, is the **harbor mouth**.
    - East, the lighthouse side, the rocks and the wreck, is **deep and rocky**.
    - Within 1 hex of `HARBOR_WRECK` the Wreck grouper weighs ×2, and within 1 hex of `HARBOR_ROCKS` the blue lobster weighs ×2.
  - **Open sea:** the Harbor has only two or three rings of water before the edge of the map. So from an **outer-edge** water hex, in a rowboat, the action becomes **"Row out and cast"**: a sitting with `spot: "sea"`. The camera faces the empty horizon, with the island small behind you on the orbit in. No new map is needed.
- **Moving mid-sitting:** a sitting isn't tied to one spot. You can leave the stage without ending it, row somewhere else, and cast again. Each cast records its own spot. The idle close still applies, so rowing around for 15 min without casting closes it.
- **Server checks:** the gather routes don't check where you stand today, and the piers won't either. They **do** check you own the vessel a spot needs: a barrel or rowboat for coastal water hexes, and a rowboat for `sea`. They read that from D1 at cast time.
- **Ships and boats:** a crew ship moored at a pier is just scenery to a rowboat. You row around it.

---

## Records and mounts

- **Catch Book:** see the next section.
- **Crew records:** one record per species per crew (the pub is per crew).
  - A **Record Board** on the pub wall lists each species' holder, weight and date.
  - Landing a new record pops "New crew record!" on the catch card, and posts to the Harbor notice board's voyage log as a one-liner.
- **Pub wall mounts:** **8 slots** on the pub wall.
  - Only the **current record fish** for a species may be mounted there, by its catcher.
  - When a record is beaten, the old mount comes down to its owner's trophy chest, with a plaque line in their feed. The new holder gets a nudge to mount theirs.
  - The pub fittings stay fixed. The mounts are just drawn at fixed wall anchors from `pub_mounts`.
- **Home mounts:** the existing `mounted_fish` furnishing becomes **"Mount a trophy"**.
  - Placing it asks which trophy-chest fish to use, then stores `{ fishId }` in `furnishings.meta_json`. `getHut` must start selecting `meta_json`.
  - The prop builds the fish's real model at its real length on a board sized to fit, with a brass plaque.
  - Old `mounted_fish` with no `fishId` keep drawing the current generic fish.
  - The **ship's bell** haul is its own wall piece.
- **Visiting:** crewmates visiting your hut see your mounts. `publicHero` gains a "best catch" line.

---

## Old outings and things that change

- A fishing outing in progress from before the rebuild (one with `water` and no `sitting`) can only be **landed**. It pays as before. The established pattern applies (`"The light has gone…"`).
- **Tests that pin bone/copper fishing payouts** (`gather.test.ts:206-242`, `:311-322`, `harborxp.test.ts:34-43`) get rewritten for the sitting. The generic `gatherPayout` cap stays for felling and the quarry. Fishing pays through the creel instead.
- **GatherPanel:**
  - Fishing branches to `<Fishing>` (stage + HUD) the way the quarry branches to `<Quarry>`.
  - An intro card (`FishingIntro`) covers before and after: today's board, your creel, and the stamina note.
- **Copy:** the `HarborView.tsx:155` hover text and the spot blurb are rewritten.

---

## Phases (each a PR to `main`)

1. **Rules and server.**
   - Rules in `packages/world/src/`:
     - `fishcatalog.ts`: the 59 entries.
     - `fishing.ts`: spots, rolling a catch, size, weight and price.
     - `fishfight.ts`: the fight sim.
     - `sitting.ts`: the state machine and its choices.
     - `fishbot.ts`: a test angler, not exported.
   - Server: `server/fishing.ts` closes a sitting. The stamina change (charged at close), the idle close (`settleIdle` in `server/gather.ts`), the fight replay, `0025_fish.sql`, and bests and records upserts.
   - **API:** `POST /api/gather/start` takes `{ spot: "fishing", pier }` to start a sitting. Without `pier` it's the old shore casts, so today's client is unchanged. Steps are:
     - `cast {power}`
     - `hook {at}`
     - `reel`
     - `fought {edges}`
     - `keep` / `release`
     - `bank`
   - **Built, 2026-11-13:** the icebox cap (60 kg) and the overflow sold to Tam wait for phase 4, when selling exists. Phase 1 stores every kept fish in the icebox.
   - Tests:
     - The sim is deterministic over 1000 random seeds and input traces.
     - Hold-only snaps a diver.
     - Never-press throws or spools.
     - A scripted "tap the runs, hold the rests" input lands most commons.
     - STR and DEX move land rate and fight time in the right direction.
     - Stamina is charged exactly once.
     - The idle close.
     - Old outings.
   - The live spot keeps the old flow until phase 2 flips it.
2. **The stage.**
   - `FishingStage.ts`: camera, rod bend, line, bobber, wake, silhouette, landing shot.
   - `Fishing.tsx`: input overlay, HUD meters, catch card.
   - Piers as spots, first-person hands and rod, and `Look.weapon = "rod"`.
   - Sounds.
   - Placeholder fish (one generic model).
   - This phase flips the live spot.
3. **Fish art.** `fishArt.ts`: the parametric shape to 3D mesh and pixel sprite, all 45 creature shapes, bespoke builders for the ray, squid, crabs, sunfish, oarfish and hauls, and the admin side-by-side preview. *It can run in parallel with phase 1, because it only needs the catalog's `shape` ids.*
4. **Selling.** The fishmonger stall and its seeded rates board, Old Tam buying, the icebox and trophy chest UI in the inventory screen, and sell routes.
5. **Records and mounts.** The Catch Book (pages, slot states, page and book rewards, the bonus slot, `characters.title`), the crew Record Board, pub mounts, hut "Mount a trophy" via `meta_json`, the ship's bell piece, and the record line on the notice board.

6. **Boats.**
   - The barrel and rowboat as `vessel` furnishings with recipes (the rowboat needs a blueprint).
   - `harborPath` takes a vessel, and HarborRoom presence gains `afloat`.
   - Boat meshes under the sprite, with bob and oar strokes.
   - `waterAt` zones, the wreck and rock bonuses, the edge-only "Row out and cast", and the open-sea stage framing.
   - The +20 kg rowboat creel.
   - The Open Sea page and Old Ironjaw switch on: the catalog has their entries from phase 1, but they're never rolled until this phase ships.
   - Tests: path rules for each vessel, `waterAt` zones, sea requiring a rowboat, and `afloat` set and cleared.

Per the house rules:

- Sync with `main` before each phase.
- Browser-check each phase in local dev before committing: reload, a visitor, and a phone with touch hold.
- List those checks in the PR.
- No prod tag until reviewed.

---

## Decisions (2026-11-13)

1. **Hero view:** first person, like the quarry: hands and a bending rod, with the hero hidden. Other players still see the rod on your sprite.
2. **Spoilage:** none in v1. The icebox is capped at 60 kg, and specimens go to a 6-slot trophy chest.
3. **The old shore spot:** it becomes the fishmonger's stall and rates board, and you can still fish there (shallows, short casts).
4. **Records:** personal bests in the Catch Book plus one crew record per species on the pub wall. There are no all-Harbors records.
5. **Catch Book:** 58 slots on six pages. Old Ironjaw is a bonus slot outside the count.
6. **Boats:** a craftable barrel (coastal water, rocks, wreck) and rowboat (anywhere, plus the open sea) are phase 6. The big ocean fish move to a rowboat-only **Open Sea** page, and the middle pier becomes the **Harbor Mouth**.

## Still to tune in play

- **Creel limit:** 25 kg + 1 kg per STR point. That's about 15–25 common fish, or one big one.
- Fight constants (drain, reel speed, snap grace), the cast-distance bias, and rarity weights.
  - **Phase 1 baseline:** the test angler (taps runs, eases off over 0.8 tension, holds rests) lands >95% of commons at mid stats. Rares land about 60–100% at mid stats, depending on species, and legendaries about 3–90%. Holding the button through everything only lands small fish.
  - **Old Ironjaw** is 0% for the bot even at high stats, so a better player might land him. Revisit in phase 6.
- Prices against the rest of the economy. The quarry pays a gem at 12g, so a common fish should be a few gold and a rare trophy around 40–120.
