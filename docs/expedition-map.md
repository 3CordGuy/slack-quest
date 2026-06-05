# Expedition Map — Design Doc

**Status:** Draft / pre-implementation. Last touched 2026-06-05.
**Author:** josh + Claude (run-structure spike).

Sessions today are open-ended: pick a quest from the lobby, fight, win/lose, pick another. There's no shape to a "session," no escalating risk, no choice between safe and dangerous routes. This doc proposes a Slay-the-Spire-style **expedition map** — a branching tree of nodes from start to boss, where each node is a discrete encounter the player resolves before picking the next one. Each completed boss = one "expedition" finished.

This is a *new mode* sitting next to existing quests, not a replacement.

---

## Goals

- **Structured runs** — every expedition has a clear arc: ~15 nodes from start to boss, with branching path choices at every step.
- **Risk/reward choices at every node pick** — "safe route through camp+shrine" vs "elite + treasure".
- **Composes with existing systems** — combat nodes spawn the same combat engine; camp nodes reuse existing camp mini-games; shop nodes reuse merchants.
- **Replayable** — deterministic generation from a seed, so two expeditions are visibly different.
- **Coexists with quests** — players who don't want runs can still do one-off quests as today.

## Non-goals (v1)

- **Relics / persistent run modifiers.** StS's relic system is wonderful and out of scope for v1. Adding it without good content is worse than not having it.
- **Multi-floor runs.** v1 is one map, one boss. "Act 2/3" is v2.
- **Solo runs only.** Multi-player expeditions are in scope but the *party stays the same across the whole run* — no mid-run join/leave.
- **Persistent meta-progression between runs** (unlocks, character XP carryover into next run). Each expedition is self-contained — XP/gold/items earned go to the character's permanent inventory the same way quests already do.
- **PvP / leaderboard for expeditions.** A "fastest clear" leaderboard is appealing but v2.

---

## Map shape

Conceptually a directed acyclic graph from a single START node to a single BOSS node:

```
        depth: 0    1     2     3     4     5     6     7   (...up to ~D=14)
                                                       BOSS
                                                      /
START → [n] → [n] → [n] → [n] → [n] → [n] → [n] → [n]
        \                                            \
         [n] → [n] → [n] → [n] → [n] → [n] → [n] → [n]
                                                      \
                                                       BOSS (merge)
```

Concretely for v1: **15 nodes** between start and boss, **3–4 lanes wide**, with the lanes converging at a **single boss node** at the end. Standard StS shape:
- 1 START
- ~13 intermediate nodes laid out across 3-4 lanes
- 1 BOSS

Edges: each non-boss node has 1–3 forward edges. Edges never cross (the StS rule — geometric, not graph-theoretic, but it keeps the UI clean).

## Node kinds

| Kind | Frequency | Resolution |
|---|---|---|
| `combat` | ~50% | Standard combat encounter (existing combat machine) |
| `elite` | ~10% | Tougher combat — higher monster tier, better loot |
| `event` | ~15% | Multi-choice narrative event (text + 2-3 button options with outcomes) |
| `shrine` | ~5% | One-time buff for the rest of the run (small stat boost or mana refill) |
| `camp` | ~10% | Existing camp mini-game (forage / mine / fish) for resources |
| `treasure` | ~5% | Guaranteed gear drop, no combat |
| `boss` | 1 | Final encounter, boss-tier monster |

Frequencies tunable; numbers above are starting heuristics matched roughly to StS Act 1.

## Map generation

Deterministic from `(expedition_id, party_signature)` seed so the same expedition is reproducible for debugging and replay.

Algorithm:
1. Pick lane count (3 or 4) based on party size — solo gets 3, 2+ players get 4.
2. Walk forward depth-by-depth, picking 1–3 outgoing edges per node such that no edges cross.
3. Assign kinds depth-by-depth using the frequency table above, with hard rules:
   - Depth 0 (post-START): always `combat`.
   - Depth -1 (pre-BOSS): always `camp` (free rest before boss).
   - No two `elite` adjacent on the same lane.
   - At least one `shrine` reachable per lane.

Implementation: pure function in `packages/core/src/expedition.ts`, fully unit-testable, no I/O.

## State model

Two new D1 tables:

```sql
-- migrations/00XX_expeditions.sql
CREATE TABLE expeditions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    TEXT NOT NULL,            -- mirrors quests.channel_id (web:<userid> for solo)
  status        TEXT NOT NULL DEFAULT 'active',  -- active|completed|failed|abandoned
  seed          TEXT NOT NULL,
  map_json      TEXT NOT NULL,            -- full generated graph: nodes + edges
  current_node  TEXT,                     -- node id; null until player picks first
  created_by    TEXT NOT NULL REFERENCES characters(slack_user_id),
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);

CREATE TABLE expedition_party (
  expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (expedition_id, character_id)
);

CREATE TABLE expedition_node_progress (
  expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL,
  resolved_at   INTEGER NOT NULL,
  outcome_json  TEXT NOT NULL,            -- per-kind payload (combat result, event choice, etc.)
  PRIMARY KEY (expedition_id, node_id)
);
```

`map_json` is the canonical layout — generated once at expedition start, never mutated. Progress tracked in `expedition_node_progress`. This keeps the table model simple and replay-friendly.

## State machine

```
LOBBY
  ↓ POST /api/expedition/start
GENERATING          ← seed + map computed, persisted
  ↓
NODE_PICKING        ← player(s) choose from current_node's forward edges
  ↓ POST /api/expedition/pick { node_id }
NODE_RESOLVING      ← dispatched based on kind
  ↓
  ├─ combat/elite/boss → spawn standard combat (existing engine), on victory back to NODE_PICKING (or COMPLETED if boss)
  ├─ event → fetch event content, present choices, apply outcome, back to NODE_PICKING
  ├─ shrine → apply buff, back to NODE_PICKING
  ├─ camp → spawn camp mini-game UI, back to NODE_PICKING on exit
  └─ treasure → roll item, present accept/reject, back to NODE_PICKING
```

Combat-kind nodes literally create a row in the existing `quests` table with a back-pointer to the expedition (new column: `expeditions.from_expedition_id`). The combat plays out in the existing combat machine with **zero engine changes**. On combat resolve, the worker advances expedition state.

This is the key integration choice: **the expedition map orchestrates existing systems; it doesn't reinvent them.** Combat code, camp code, merchant code stay where they are.

## Routes

```
POST  /api/expedition/start         { party: [characterIds], seed? }   → { expedition_id, map }
GET   /api/expedition/:id           → { expedition, map, progress, current_node, available_picks }
POST  /api/expedition/:id/pick      { node_id }                        → { ok, next_state }
POST  /api/expedition/:id/abandon   → { ok }                            (manual quit; status='abandoned')
GET   /api/expedition/recent        → recent runs for the signed-in character
```

Combat/event/camp resolution flows through the *existing* routes — the expedition state just gates which `quest_id` / mini-game session is "current" for the run.

## UI

One new top-level screen + a few small additions:

- `apps/web/src/components/Expedition.tsx` — main expedition screen. Renders the map as an SVG tree with current position highlighted, available picks glowing, completed nodes greyed. Click a glowing node to advance.
- `apps/web/src/components/ExpeditionMapView.tsx` — pure SVG rendering of the node graph; takes `map`, `current_node`, `progress` as props. Reusable for "view a completed expedition" later.
- Lobby gets a new "Start Expedition" button next to "Start Quest", routing into the expedition flow.
- Event nodes get a new `ExpeditionEvent` component for the text + choice buttons (text generated by existing AI flavor pipeline at node-resolve time, cached on the node).

Map UI styling: borrow the visual language of the existing town WardMap ([Town.tsx](apps/web/src/components/Town.tsx)) since players already grok hex-tree layouts there.

## Coexistence with existing quests

- The lobby continues to show "Start Quest" (one-off) AND "Start Expedition" (run) side-by-side.
- A character can be in **one expedition at a time** but can also be in one-off quests outside of any expedition. Mutual exclusion check at expedition start: if any party member is mid-quest, refuse.
- Soft-death behavior unchanged inside an expedition. Down → cooldown → resume the expedition where you left off. Elite mode opt-in (existing flag on quests) applies per-node when a node spawns a combat.
- **No backwards-incompatible changes to `quests`** — the new linkage column (`from_expedition_id INTEGER`) is nullable; existing one-off quests have it NULL.

## Event pool depth

**Hard requirement: the hand-authored event pool must stand on its own without any AI flavor pass.** AI flavor is an optional cosmetic layer on top; if it's disabled (cost, outage, dev-mode), expeditions must still feel fresh.

**Target sizes for v1:**
- **60 base events** in the pool at ship.
- Each event has **2–4 choice branches**, with **2–3 outcome variants per branch** (weighted: e.g. "Pick the lock" → 60% success, 30% nothing, 10% trap), so each event yields **6–16 distinct play experiences**.
- That's ~600 distinct event-resolution moments across the pool — at ~2 events per expedition, a player would need 30+ runs to exhaust a single branch outcome, and 300+ runs to see every variant.

**No-repeat rules:**
- An event never repeats within a single expedition.
- Last 10 events seen by a character are excluded from the pool when sampling the next one — soft cooldown across recent runs, not just within a run.
- Weight-bias against any event the character has resolved 3+ times in their last 50 events — keeps the long tail breathing.

**Authoring tags for variety:**
Each event gets tags: `tone` (grim / wry / hopeful / weird), `setup` (encounter / discovery / dilemma / NPC), `risk` (safe / mixed / dangerous), `theme` (greed / mercy / curiosity / fear). When sampling, the picker biases *against* tags that match the previous 2-3 events on the same expedition — back-to-back grim-dilemma events feel monotonous; the variety system breaks that up automatically.

**Authoring distribution for the 60-event pool:**
| Setup | Count | Examples |
|---|---|---|
| Encounter (a person/creature) | ~20 | wandering merchant, lost engineer, drunken bard, suspicious crow |
| Discovery (an object/place) | ~15 | broken vending machine, ancient terminal, weeping shrine |
| Dilemma (choose between bad options) | ~15 | trolley problem with a deploy bot, save the data or save the dev |
| NPC quest-bite (short transaction) | ~10 | "deliver this to X", "I'll trade Y for Z" |

**AI flavor pass (optional layer):**
When enabled, AI rewrites the *prose* of the chosen event/branch/outcome for the current expedition's theme — never changes the mechanical outcome or the choice options. Cached per event-resolution in case the player retreats and re-enters. Disabling it shows the hand-authored text verbatim; both modes are first-class.

**Implementation note:**
Events live as TypeScript modules in `packages/core/src/expedition-events/` — one file per setup category, ~15 per file. Strongly typed via a shared `ExpeditionEvent` type. This puts content in version control, lets us measure pool coverage in tests, and avoids a CMS-shaped problem we don't need.

## Test plan

Unit (`packages/core/src/expedition.test.ts`):
- Map generation is deterministic for a given seed.
- Generated maps obey all hard rules (no adjacent elites, every lane has a shrine, single boss at end, no crossing edges).
- Frequency distribution across many seeds approximates target ratios.
- State transitions for each node kind (pure-function reducer style).

Integration:
- End-to-end test: start expedition, complete 3 nodes including one combat, verify state persists across worker reload.
- Abandon-mid-run cleans up gracefully.

Manual:
- Full clear of a generated map start→boss, mixing every node kind at least once.

## Migration / back-compat

- Three new tables + one nullable column on `quests`. All additive — no existing data touched.
- No DO schema change (combat DOs are spawned per-node via existing path).
- Feature is opt-in from the lobby; doesn't affect users who only do one-off quests.

## Open questions

1. **Party HP/mana between nodes** — does HP carry over from combat node to combat node, or fully heal between encounters? Recommend **carry over** (StS-faithful, makes camp nodes meaningful), but worth confirming.
2. **Death policy** — if the whole party is downed in a mid-run combat, does the expedition fail (abandon all progress) or pause for the cooldown like a single quest? Recommend **pause and resume** for v1 (consistent with current soft-death) — sets up "perma-death expedition mode" as a future elite-flag.
3. **Map width vs depth** — 15 nodes is a starting number. May want to tune to actual playthrough time once we can measure.
4. **Event content sourcing** — hand-authored pool is the floor; AI flavor is optional polish. See "Event pool depth" below for sizing.

## Implementation outline

1. Migration: 3 new tables + `from_expedition_id` on `quests`.
2. `packages/core/src/expedition.ts` — pure map generation + state machine.
3. Worker routes (`/api/expedition/*`) — orchestration and persistence.
4. UI: `Expedition.tsx`, `ExpeditionMapView.tsx`, `ExpeditionEvent.tsx`; lobby integration.
5. Combat/camp/merchant integration — minimal changes; mostly back-pointers and post-resolve callbacks.
6. Hand-author the 60-event pool (4 files in `expedition-events/`, ~15 each); wire optional AI flavor pass; implement no-repeat sampler with tag-based anti-monotony bias.
7. Tests, then PR.

Estimated effort: ~3-4 days for core + tests + routes, ~2-3 days for UI, ~3-4 days for event content (60 events × ~3 branches × ~2-3 outcomes is real writing time) + AI wiring. This is the larger of the two parallel tracks; event authoring is likely the critical path.
