# Multi-Foe Encounters — Design Doc

**Status:** Draft / parked. Last touched 2026-05-11.
**Author:** josh + Claude (session continuation).

This is the design sketch for letting the party fight more than one minor
enemy at once (e.g. "a Stale PR Goblin and a Brittle Linter" instead of a
single foe per room). Written before any implementation so when we pick this
up later, we don't re-litigate the same trade-offs.

---

## Goals

- Pack encounters — 2-3 minor foes in a single combat room — as a difficulty
  knob distinct from "one beefy monster" (boss).
- Same combat verbs (`attack`/`cast`/`signature`/`ability`) work with
  minimal new syntax.
- Per-foe state for HP, status effects, telegraphs — so each foe feels like
  a real combatant, not a multi-headed HP bar.
- Doesn't break in-flight quests in production at rollout time.

## Non-goals (for v1)

- Multi-foe **bosses**. Boss phase 2 is a singular-foe concept and stays
  that way. If we want multi-phase pack bosses later, that's a separate doc.
- Multi-foe **gauntlet** waves. Gauntlet is already multi-foe across waves;
  adding "and each wave has 3 foes" is a separate balance pass.
- Foe-vs-foe interactions (one foe buffs another). Each foe is independent
  in v1 — keeps the state model flat.
- Per-foe portraits. v1 ships with a single "encounter portrait" (group
  shot). Per-foe portraits are an art-cost + block-budget problem we punt on.

---

## Current state (what's hardcoded today)

Every combat path assumes ONE monster. This is baked into the scene model:

```ts
SceneJson {
  monster_name: string;
  monster_hp: number;
  monster_max_hp: number;
  monster_effects: StatusEffect[];
  monster_telegraph?: { target_user_id };
  monster_art_url?: string;
  boss_phase?: 1 | 2;
  marked_by?: string;          // focus-fire marker
  marked_until?: number;
  ability_state?: {
    taunt?: { user_id, swings_remaining };
    vanished?: Record<string, number>;
    skip_swings?: number;       // Containerize charges
    battle_hymn?: number;
  };
  ...
}
```

Direct readers of these singular fields (grep target if/when we implement):
- `performMonsterTurn` (single swing, single target pick)
- `handleCombat` (writes new `monster_hp` via `tryUpdateScene`)
- `persistNextTelegraph` (writes one telegraph)
- `pickMonsterTarget` (picks ONE player victim; doesn't pick a foe)
- `tryUpdateScene` (atomic conditional on `monster_hp`)
- `useSoulDrain` / `useContainerize` / `useTaunt` (target "the" monster)
- `useMark` / `marked_by` (singular focus marker)
- `buildCombatBlocks` (renders one foe stat line + one portrait)
- Damage tools: Caffeine Bomb, Hotfix Grenade, Production Outage, Poison Vial
- Dungeon combat rooms: `ExpeditionNode.monster_name/monster_max_hp/monster_art_url`
- AI flavor: `flavorHit`, `flavorSignature`, `flavorBossPhase` all take a
  single monster name string.

---

## Proposed data model

Singular fields become an array. Each foe carries its own state:

```ts
interface Foe {
  id: string;                       // stable per-encounter (e.g. "foe_1")
  name: string;
  hp: number;
  max_hp: number;
  effects: StatusEffect[];          // poison, bleed, etc. — per-foe
  telegraph?: { target_user_id };   // each foe telegraphs independently
  art_url?: string;                 // optional — see "Art" below
  // Reserved for v2:
  // boss_phase?: 1 | 2;            // pack-boss multi-phase
  // role?: "minion" | "elite";     // for asymmetric pack encounters
}

SceneJson {
  // NEW canonical field.
  foes?: Foe[];

  // LEGACY — kept for read-time normalization of in-flight quests during
  // rollout. After 2 weeks post-deploy, sunset via a migration that splats
  // legacy fields into foes[0] and drops the columns from new writes.
  monster_name?: string;
  monster_hp?: number;
  monster_max_hp?: number;
  monster_effects?: StatusEffect[];
  monster_telegraph?: { target_user_id };
  monster_art_url?: string;

  // Per-foe marks. mark_id keys map to foe.id.
  marks?: Record<string, { marked_by: string; marked_until: number }>;

  // ability_state.taunt becomes per-foe: which foe is locked to which player.
  ability_state?: {
    taunt?: Record<string, { user_id: string; swings_remaining: number }>;
    //                ^foe.id
    vanished?: Record<string, number>;           // unchanged — per-player
    skip_swings?: Record<string, number>;        // per-foe Containerize
    battle_hymn?: number;                        // unchanged — party-wide
  };

  // boss_phase stays singular — only meaningful for boss quests, which
  // remain 1-foe per scope.
  boss_phase?: 1 | 2;
}
```

**Read-time normalization** (in `db.ts`'s scene loader): if `foes` is
absent and `monster_name` is present, synthesize `foes: [{id:"foe_1",
name:monster_name, hp:monster_hp, ...}]`. This is the same pattern as the
existing `expedition→dungeon` rename — old rows keep working without a
hard migration.

**`tryUpdateScene` atomicity:** the current guard (`WHERE monster_hp = ?`)
is what prevents racing attacks from clobbering each other's damage.
Per-foe guards mean we'd need a CHECK against `json_extract(scene_json,
'$.foes[N].hp')` matching the pre-read value. Doable but more SQL. v1
proposal: **accept rare races for damage** (each player's damage lands
non-atomically). The damage loss in a true race is ~1 player's swing per
encounter, which is small and self-balancing (low-HP foes die fast anyway).
The current model's atomicity was already best-effort.

---

## Combat loop changes

### Target selection — `/sq attack`, `/sq cast`, `/sq signature`

Three options, pick one:

| Option | UX | Implementation cost |
| --- | --- | --- |
| **A. Auto-target** (lowest HP, ties broken by index) | "I just want to swing." | Trivial. |
| **B. Slash arg** — `/sq attack 2` | Power users get explicit control. | Easy — parse `args[0]`. |
| **C. Buttons in combat block** | Click-to-target on each foe row. | Medium — per-foe action_ids. |

**Recommendation:** ship A as the default, allow B for power users, defer
C to a polish pass. The combat block can show foe indices (`1.`, `2.`) so
players know what to type for B.

### Monster turn

**Open question:** do all alive foes swing per round, or just one?

- **All swing:** higher difficulty pressure (the whole point of pack
  encounters). Each foe's telegraph commits, then on the next round all
  alive foes resolve their swings in order.
- **One swings:** softer cadence — pack feels weaker than 1 beefy foe.
  Probably not what we want.

**Recommendation:** all alive foes swing. This is the difficulty knob.
HP scaling needs to drop accordingly (see "Tuning" below).

### Victory condition

`willKill` becomes "the last alive foe just dropped." Check `foes.every(f
=> f.hp <= 0)` after any damage write. Until then, the room stays in
combat.

---

## Active ability impacts

| Ability | Change |
| --- | --- |
| 🛡 Taunt | Per-foe state. `/sq ability` prompts target foe (auto-pick highest-HP foe? or button-pick?). |
| 🧙 Containerize | Per-foe skip. `/sq ability` targets a foe to freeze. |
| 💀 Soul Drain | Targets a single foe. Use same target-pick UX as `/sq attack`. |
| 🗡 Vanish | Unchanged — you hide from all foes simultaneously. |
| ✨ Regression Shield | Unchanged — party-wide shield buff. |
| 🎵 Battle Hymn | Unchanged — aura applies regardless of which foe is hit. |
| 📜 Foresee | Now shows N telegraphs (one per alive foe). More valuable in pack encounters. |
| 🌿 Migrate | Unchanged — repositioning is foe-agnostic. |

Mark (`/sq mark`) becomes per-foe. Focus-fire bonus only applies when
attacking the marked foe.

---

## UI — combat block

Block budget: Slack caps at 50 blocks. Current combat block is ~8 blocks
(header, narration, divider, player events, divider, monster event,
divider, foe stats). With N foes:

- Single encounter portrait (one image block) — group shot, not per-foe.
- One section block per foe: `2. **Brittle Linter** — HP 12/18 🎯 next:
  @kaix` (combines stat line + telegraph).
- Player events / monster events sections share structure.

3 foes fits comfortably under 50 blocks. Past 3, we'd need to collapse
stat lines into one block.

**Foe index display:** prefix each foe with `1.`, `2.`, `3.` so slash-arg
targeting (`/sq attack 2`) is discoverable.

---

## AI / art

### Naming

`buildQuestScene` generates one monster name today. For multi-foe:

- **v1:** generate N names independently with an extra prompt instruction
  ("these are a pack — names should feel thematically related but
  distinct"). N AI calls per scene generation.
- **v2:** single prompt asking for "an encounter description with N
  foes" so the AI returns thematically-linked names in one call.

Cheaper option v2, but v1 ships easier.

### Encounter art

Per-foe portraits would: (a) blow the block budget, (b) double or triple
art cost, (c) look weird in a thread post.

**Recommendation:** one **encounter portrait** per scene. Prompt the
image gen with "a group of N enemies: a Stale PR Goblin and a Brittle
Linter, fantasy concept art, Elmore/Easley style" — the existing single-
image rendering still works.

### Scene narration

`buildQuestScene` already produces a `scene` string. For multi-foe, the
prompt becomes "a room with [foe 1] and [foe 2]" — natural language
handles N-foe descriptions fine.

---

## Tuning

Multi-foe is HARDER than 1 foe of equivalent HP because the party takes
multiple swings per round. Rough mental model:

```
solo party (1 fighter) vs. 1 foe (HP=20):
  3 rounds to kill, 3 monster swings taken.

solo party vs. 2 foes (HP=12 each, total HP=24):
  4-6 rounds to kill (depending on focus-fire), 8-12 monster swings.
  (Each round: 2 swings from 2 foes until one dies, then 1.)
```

So 2 foes at 60% HP each (total 1.2×) feels harder than 1 foe at 1.2×.

**Heuristic for v1:** pack encounter total HP = `1.0 × solo HP`, split
across N foes evenly. Tune from playtest.

**Difficulty curve:** pack encounters in dungeons should be **rare** in
low-tier rooms (1 of 4 combat rooms is a pack), more common in higher
tiers. Standard quests stay 1-foe by default; introduce a `/sq quest
pack` variant for opt-in 2-foe play.

---

## Rollout plan

### Phase 1 — Prototype (half-day)

Goal: prove the combat loop. Cut every corner.

- New `Foe` interface + scene-level `foes` array.
- Read-time normalization in `db.ts` for legacy single-monster scenes.
- Hardcoded 2-foe `/sq quest pack` variant. Standard / boss / gauntlet /
  dungeon untouched.
- Auto-target lowest HP. No slash arg, no buttons.
- All alive foes swing per round.
- Single encounter portrait (reuse single-monster art prompt with the
  pack name list shoved in).
- Mark + active abilities still target "the first alive foe" (auto). UI
  doesn't show targeting yet.
- Combat block: list each foe's stat line; one portrait at top.

### Phase 2 — Targeting + abilities (half-day)

- Slash arg targeting: `/sq attack 2`, `/sq cast 1`, etc.
- Buttons in the combat block for click-targeting.
- Per-foe Mark + Taunt + Soul Drain + Containerize.
- Per-foe Foresee output.

### Phase 3 — Dungeon integration + tuning (half-day)

- Dungeon combat rooms roll a foe count (1 / 2 / 3) weighted by tier.
- Monster pool re-tuning: HP per foe in pack rooms.
- Optional: rare 3-foe "swarm" rooms in late dungeons.

### Phase 4 — Polish (open-ended)

- AI prompts: thematically-linked pack names in one call.
- Per-foe portraits if we ever solve the block-budget problem.
- Pack bosses (multi-foe + phase transitions).
- Foe-vs-foe interactions (synergy buffs, e.g. "the Healer Slime restores
  HP to other foes per turn").

---

## Open design questions

1. **Targeting UX** — auto-target good enough for v1, or do we want
   buttons day one? Probably auto-target is fine.

2. **Telegraph density** — N foes × N players means each combat block
   shows multiple "X is winding up on @Y" lines. Risk: visual noise. Mit:
   collapse identical-target telegraphs ("Foe 1 + Foe 2 both targeting
   @kaix").

3. **AOE abilities** — none today. If we add a Bard "Inspiring Shout"
   that hits all foes, the pack model makes it relevant. Worth designing
   one ability around pack mechanics during Phase 2.

4. **Boss vs. pack composition** — could a boss be flanked by 2 minions?
   That's a v3+ thing, but worth keeping the data model open enough to
   support (already does: a Foe with `role: "elite"` and another with
   `role: "minion"`).

5. **Soft-death single foe vs. pack** — if you go down in a pack fight
   vs. a solo fight, is the death cooldown different? Probably not — keep
   it simple, same 12h soft-death rule.

---

## Risks / unknowns

- **Atomic write semantics** — accepting races for per-foe damage is a
  design call. If playtest shows visible damage loss, we revisit with
  per-foe conditional writes.

- **Block budget** — 3+ foes may push close to Slack's 50-block cap when
  combined with active-effect lines, passive triggers, and player events.
  Mitigation: collapse multi-foe lines into single sections.

- **AI call cost** — N foe names = N extra AI calls (or one bigger one).
  Negligible at current usage, but worth monitoring.

- **Difficulty tuning** — pack encounters might feel either trivial (HP
  too low, party blasts through) or brutal (too many monster swings per
  round). Phase 3 tuning pass is mandatory before defaulting any dungeon
  room to pack mode.

- **Existing in-flight quests** — read-time normalization handles legacy
  single-monster scenes. But the rollout window matters: if we ship the
  new code with bugs and someone's mid-dungeon, we'd want a quick rollback
  path. Keep singular-monster code paths working for at least 2 weeks
  post-deploy before sunsetting.

---

## Effort estimate (recap)

- **Phase 1 (prototype):** ~4-6 hours focused.
- **Phase 2 (targeting + abilities):** ~4-6 hours focused.
- **Phase 3 (dungeons + tuning):** ~4-8 hours including playtest.
- **Phase 4 (polish):** open-ended.

Realistic total to "ship multi-foe everywhere we want it": **2-3 days of
focused work + playtest iteration.** Half-day if we ship just Phase 1
behind a `/sq quest pack` variant.
