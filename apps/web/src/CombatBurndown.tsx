// Combat burndown chart — replayed from the live CombatEvent stream so we
// can show HP-over-rounds per fighter + monster alongside damage-dealt totals
// in the victory/defeat modals. Pure client-side; no DB or server changes.
//
// Granularity: the x-axis is round number from `turn_start` events. Within a
// round, multiple HP changes collapse onto one tick (we record the *end-of-
// round* HP for each actor). That's enough resolution to see momentum
// without overloading a small chart.
//
// Toggles: party members can be toggled on/off; the monster line always
// renders (it's usually the focal arc of the fight).

import { useMemo, useState } from "react";
import { MONSTER_ID } from "@gantt-quest/core";
import { Icon } from "./icons";

// Caller-facing input is "any event with a string discriminant" — CombatEvent
// from @gantt-quest/core *and* CombatPage.tsx's local re-declared union both
// satisfy this. Using `any` here so callers don't have to cast — the actual
// field reads inside buildBurndown are type-asserted per-case.
type AnyEvent = { type: string; [k: string]: any };

interface ActorMeta {
  id: string;
  name: string;
  max_hp: number;
  /** 0 for monsters + non-caster classes. Drives whether the actor shows
      up on the mana view at all. */
  max_mana: number;
  side: "party" | "monster";
  /** Final HP at end of fight — derived from the last sample. Used to dim
      lines for downed party / dead monsters. */
  final_hp?: number;
  final_mana?: number;
}

interface Sample {
  round: number;     // 0 = pre-fight starting HP, then 1, 2, …
  hp: Record<string, number>;
  mana: Record<string, number>;
  /** Cumulative damage dealt by each actor as of end of this round. Drives
      the damage-over-time line chart on the Damage tab. */
  cumDamage: Record<string, number>;
}

export interface BurndownData {
  actors: ActorMeta[];
  samples: Sample[];
  /** Total damage dealt by each actor. Healing not subtracted; this is the
      "raw output" stat players want to brag about. Heals tracked separately. */
  damageDealt: Record<string, number>;
  /** Total HP lost on each actor across the fight. Includes DoT ticks
      (effect_tick with negative hp_delta) — anything that subtracted HP. */
  damageTaken: Record<string, number>;
  healingDone: Record<string, number>;
  /** Total mana spent (sum of ability_used.mana_spent) per actor. */
  manaSpent: Record<string, number>;
}

interface InitialFighter {
  id: string;
  name: string;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
}

interface InitialMonster {
  id?: string;
  name: string;
  hp: number;
  max_hp: number;
}

/** Replay every event and produce a per-round HP series plus damage totals.
 *  Safe to call with an empty event list — returns the initial snapshot.
 *  The caller passes the *current* fighters/monster from CombatState; we
 *  rewind by replaying the events backwards from current HP to reconstruct
 *  the timeline. We treat starting HP as "max_hp" because by the time the
 *  modal renders the fight is over and current hp != starting hp. */
export function buildBurndown(
  events: AnyEvent[],
  fighters: InitialFighter[],
  monsters: InitialMonster[],
): BurndownData {
  // Actor metadata. Party first, then monster(s). The monster id flips on
  // wave_transition events but the rendered name updates so the line stays
  // continuous under a single id (MONSTER_ID by convention).
  const actors: ActorMeta[] = [
    ...fighters.map<ActorMeta>((f) => ({
      id: f.id,
      name: f.name,
      max_hp: f.max_hp,
      max_mana: f.max_mana,
      side: "party",
    })),
  ];

  // Track HP + mana per id as we replay. Start everyone at full — the live
  // state's current values are the *end* state, not the start.
  const hp: Record<string, number> = {};
  const maxHp: Record<string, number> = {};
  const mana: Record<string, number> = {};
  const maxMana: Record<string, number> = {};
  for (const f of fighters) {
    hp[f.id] = f.max_hp;
    maxHp[f.id] = f.max_hp;
    mana[f.id] = f.max_mana;
    maxMana[f.id] = f.max_mana;
  }

  // Initial monster: assume the first monster from state is the one the fight
  // started against. Wave transitions later swap it in.
  const initialMonster = monsters[0];
  if (initialMonster) {
    const id = initialMonster.id ?? MONSTER_ID;
    hp[id] = initialMonster.max_hp;
    maxHp[id] = initialMonster.max_hp;
    actors.push({
      id,
      name: initialMonster.name,
      max_hp: initialMonster.max_hp,
      max_mana: 0,
      side: "monster",
    });
  }

  const damageDealt: Record<string, number> = {};
  const damageTaken: Record<string, number> = {};
  const healingDone: Record<string, number> = {};
  const manaSpent: Record<string, number> = {};

  // round 0 = pre-fight snapshot (everything full, no damage yet)
  const samples: Sample[] = [{ round: 0, hp: { ...hp }, mana: { ...mana }, cumDamage: {} }];
  let round = 0;

  const flushRound = () => {
    const snap = { ...damageDealt };  // current cumulative damage totals
    // Replace the last sample if same round, else append.
    const last = samples[samples.length - 1];
    if (last && last.round === round) {
      last.hp = { ...hp };
      last.mana = { ...mana };
      last.cumDamage = snap;
    } else {
      samples.push({ round, hp: { ...hp }, mana: { ...mana }, cumDamage: snap });
    }
  };

  // AnyEvent's index signature gives every field type `any`, so we read
  // directly with no per-branch casts — TS can't auto-narrow on a stringly
  // discriminant anyway. Variants we don't list fall through silently.
  //
  // Sampling strategy: snapshot HP/mana only when a NEW round begins (inside
  // turn_start), not after every event. Each sample at round N therefore
  // captures the state going INTO round N (after round N-1's events). This
  // prevents intra-round heals from creating "shoots up and comes back" spikes
  // in the HP chart — the heal is visible as a higher starting point in the
  // NEXT round instead of a within-round upward notch.
  for (const e of events) {
    switch (e.type) {
      case "turn_start":
        if (e.round !== round) {
          round = e.round;
          flushRound(); // snapshot HP/mana/damage at the START of this round
        }
        break;
      case "player_hit":
        hp[e.target] = Math.max(0, (hp[e.target] ?? 0) - e.damage);
        damageDealt[e.actor] = (damageDealt[e.actor] ?? 0) + e.damage;
        damageTaken[e.target] = (damageTaken[e.target] ?? 0) + e.damage;
        break;
      case "monster_attack":
        hp[e.target] = Math.max(0, (hp[e.target] ?? 0) - e.hp_damage);
        damageDealt[e.actor] = (damageDealt[e.actor] ?? 0) + e.hp_damage;
        damageTaken[e.target] = (damageTaken[e.target] ?? 0) + e.hp_damage;
        break;
      case "monster_splash": {
        const targets = e.targets as Array<{ target: string; hp_damage: number }>;
        let total = 0;
        for (const hit of targets) {
          hp[hit.target] = Math.max(0, (hp[hit.target] ?? 0) - hit.hp_damage);
          damageTaken[hit.target] = (damageTaken[hit.target] ?? 0) + hit.hp_damage;
          total += hit.hp_damage;
        }
        // No clean attacker attribution on splash; lump under the monster.
        damageDealt[MONSTER_ID] = (damageDealt[MONSTER_ID] ?? 0) + total;
        break;
      }
      case "heal_applied": {
        const cap = maxHp[e.target] ?? hp[e.target] ?? 0;
        hp[e.target] = Math.min(cap, (hp[e.target] ?? 0) + e.amount);
        healingDone[e.actor] = (healingDone[e.actor] ?? 0) + e.amount;
        break;
      }
      case "effect_tick": {
        const cap = maxHp[e.actor] ?? hp[e.actor] ?? 0;
        hp[e.actor] = Math.max(0, Math.min(cap, (hp[e.actor] ?? 0) + e.hp_delta));
        // DoTs subtract HP without a clear attacker — credit to damageTaken
        // so the row reflects "what the fight did to you."
        if (e.hp_delta < 0) {
          damageTaken[e.actor] = (damageTaken[e.actor] ?? 0) + (-e.hp_delta);
        }
        break;
      }
      case "fighter_down":
        hp[e.target] = 0;
        break;
      case "monster_down":
        // Zero out the currently-tracked main monster id. A wave_transition
        // immediately after will reset hp/max_hp to the next wave's monster.
        if (hp[MONSTER_ID] !== undefined) hp[MONSTER_ID] = 0;
        break;
      case "wave_transition": {
        // Previous monster is down; the next wave's monster takes its slot.
        // Same id (MONSTER_ID), new max_hp/name. Update actor metadata so
        // the legend reflects the current wave; previous samples keep their
        // original max so percentages are accurate per-round.
        hp[MONSTER_ID] = e.to_max_hp;
        maxHp[MONSTER_ID] = e.to_max_hp;
        const ix = actors.findIndex((a) => a.id === MONSTER_ID);
        if (ix >= 0) {
          actors[ix] = { ...actors[ix], name: e.to_monster, max_hp: e.to_max_hp };
        }
        break;
      }
      case "ability_used":
        // Ability cost paid up front. mana_spent is the actual mana drained
        // (0 for free abilities, e.g. weapon strikes routed through abilities).
        if (e.mana_spent > 0) {
          mana[e.actor] = Math.max(0, (mana[e.actor] ?? 0) - e.mana_spent);
          manaSpent[e.actor] = (manaSpent[e.actor] ?? 0) + e.mana_spent;
        }
        break;
      case "passive_mage_mana_font": {
        // DevOps Mage passive that ticks mana back. Restores up to max_mana.
        const cap = maxMana[e.actor] ?? 0;
        mana[e.actor] = Math.min(cap, (mana[e.actor] ?? 0) + e.amount);
        break;
      }
      default:
        // begin/roll/hit_check/other ability_*/flee_check/etc. don't move HP
        // or mana directly.
        break;
    }
    // Do NOT call flushRound() here — we only snapshot at round boundaries
    // (turn_start). Intra-round HP changes are tracked in the live `hp` map
    // but don't create new chart points until the next round begins.
  }
  // Capture final state after all events (end of last round).
  flushRound();

  for (const a of actors) {
    a.final_hp = hp[a.id] ?? 0;
    a.final_mana = mana[a.id] ?? 0;
  }

  return { actors, samples, damageDealt, damageTaken, healingDone, manaSpent };
}

const PALETTE = [
  "#60a5fa", // blue
  "#34d399", // green
  "#fbbf24", // amber
  "#f472b6", // pink
  "#a78bfa", // purple
  "#fb7185", // rose
  "#22d3ee", // cyan
  "#facc15", // yellow
];

const MONSTER_COLOR = "#ef4444";

export function BurndownChart({ data, selfId }: { data: BurndownData; selfId: string }) {
  // Toggle state — party members are independently toggleable; the monster
  // is always on. Default all party members on; the player's own id is
  // emphasized via a heavier stroke.
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(data.actors.map((a) => a.id)),
  );
  const [tab, setTab] = useState<"hp" | "damage" | "mana">("hp");
  // Mana tab is only meaningful when at least one party member has a mana
  // pool — non-caster fights would render an empty chart otherwise.
  const anyManaUser = data.actors.some((a) => a.side === "party" && a.max_mana > 0);

  const colorFor = useMemo(() => {
    const m = new Map<string, string>();
    let i = 0;
    for (const a of data.actors) {
      if (a.side === "monster") m.set(a.id, MONSTER_COLOR);
      else m.set(a.id, PALETTE[i++ % PALETTE.length]);
    }
    return m;
  }, [data.actors]);

  const maxRound = data.samples[data.samples.length - 1]?.round ?? 0;
  const width = 480;
  const height = 180;
  const padX = 24;
  const padY = 16;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const xOf = (round: number) =>
    padX + (maxRound === 0 ? 0 : (round / maxRound) * innerW);
  const yOf = (pct: number) => padY + innerH - pct * innerH;

  function lineFor(actor: ActorMeta): string {
    if (!enabled.has(actor.id)) return "";
    const pts = data.samples
      .map((s) => {
        const hp = s.hp[actor.id];
        if (hp === undefined) return null;
        const pct = actor.max_hp > 0 ? hp / actor.max_hp : 0;
        return `${xOf(s.round)},${yOf(pct)}`;
      })
      .filter((p): p is string => !!p);
    return pts.join(" ");
  }

  function manaLineFor(actor: ActorMeta): string {
    if (!enabled.has(actor.id) || actor.max_mana <= 0) return "";
    const pts = data.samples
      .map((s) => {
        const m = s.mana[actor.id];
        if (m === undefined) return null;
        const pct = m / actor.max_mana;
        return `${xOf(s.round)},${yOf(pct)}`;
      })
      .filter((p): p is string => !!p);
    return pts.join(" ");
  }

  // Cumulative damage normalized to the top scorer across the whole fight,
  // so every line shares a 0-100% scale and the chart stays readable when
  // damage totals span orders of magnitude (e.g. tank vs. burst caster).
  const maxCumDamage = useMemo(() => {
    let m = 0;
    for (const a of data.actors) {
      m = Math.max(m, data.damageDealt[a.id] ?? 0);
    }
    return m;
  }, [data]);

  function damageLineFor(actor: ActorMeta): string {
    if (!enabled.has(actor.id) || maxCumDamage <= 0) return "";
    const pts = data.samples.map((s) => {
      const dmg = s.cumDamage[actor.id] ?? 0;
      const pct = dmg / maxCumDamage;
      return `${xOf(s.round)},${yOf(pct)}`;
    });
    return pts.join(" ");
  }

  function toggle(id: string) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const partyActors = data.actors.filter((a) => a.side === "party");
  const monsterActors = data.actors.filter((a) => a.side === "monster");

  return (
    <div
      style={{
        background: "var(--bg-card-2)",
        border: "1px solid var(--border-faint)",
        borderRadius: "var(--radius-md)",
        padding: 12,
        marginBottom: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
        <div style={{
          font: "10px/1 var(--font-mono)",
          color: "var(--accent-gold)",
          textTransform: "uppercase",
          letterSpacing: 1.4,
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <Icon
            name={tab === "hp" ? "health-normal" : tab === "damage" ? "sword-brandish" : "crystal-ball"}
            size={12}
            color="var(--accent-gold)"
          />
          {tab === "hp" ? "HP burndown" : tab === "damage" ? "Damage dealt" : "Mana usage"}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <TabBtn icon="health-normal" label="HP" active={tab === "hp"} onClick={() => setTab("hp")} />
          <TabBtn icon="sword-brandish" label="Damage" active={tab === "damage"} onClick={() => setTab("damage")} />
          {anyManaUser && (
            <TabBtn icon="crystal-ball" label="Mana" active={tab === "mana"} onClick={() => setTab("mana")} />
          )}
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", display: "block" }}>
        {/* Grid: 25/50/75/100% horizontals */}
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <line
            key={p}
            x1={padX}
            x2={width - padX}
            y1={yOf(p)}
            y2={yOf(p)}
            stroke="var(--border-faint)"
            strokeWidth={p === 0 || p === 1 ? 1 : 0.5}
            strokeDasharray={p === 0 || p === 1 ? "" : "2 3"}
          />
        ))}
        {/* Round axis labels at 0 and max */}
        <text x={padX} y={height - 2} fill="var(--fg-mute)" fontSize={9} fontFamily="var(--font-mono)">R0</text>
        <text x={width - padX} y={height - 2} fill="var(--fg-mute)" fontSize={9} fontFamily="var(--font-mono)" textAnchor="end">R{maxRound}</text>
        {/* Scale-axis hint: HP/Mana share a "% of max" scale, Damage is "%
            of top scorer's total." Tucked into the top-left corner. */}
        <text x={padX + 2} y={padY + 8} fill="var(--fg-mute)" fontSize={9} fontFamily="var(--font-mono)">
          {tab === "damage" ? "% of top scorer" : "% of max"}
        </text>
        {/* HP view: monster first (under), party on top so player's line is
            visible. Mana view: party casters only. Damage view: every actor
            who dealt damage (party + monster). Damage uses a dashed stroke
            so it's visually distinct from the HP-down conventions. */}
        {(tab === "mana"
            ? partyActors.filter((a) => a.max_mana > 0)
            : [...monsterActors, ...partyActors]
          ).map((a) => {
            if (!enabled.has(a.id)) return null;
            const isSelf = a.id === selfId;
            const isDown = (a.final_hp ?? 0) === 0;
            const points = tab === "mana"
              ? manaLineFor(a)
              : tab === "damage"
              ? damageLineFor(a)
              : lineFor(a);
            if (!points) return null;
            return (
              <polyline
                key={a.id}
                points={points}
                fill="none"
                stroke={colorFor.get(a.id) ?? "#888"}
                strokeWidth={isSelf ? 2.5 : a.side === "monster" ? 2 : 1.5}
                strokeOpacity={isDown && tab === "hp" ? 0.55 : 1}
                strokeDasharray={tab === "damage" ? "5 3" : ""}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}
      </svg>

      {/* Legend / toggles. Monster's row is always on (no toggle); each party
          member can be turned off to declutter long fights. Mana view drops
          monster chips (monsters have no mana pool) and skips non-casters. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
        {tab !== "mana" && monsterActors.map((a) => {
          const took = data.damageTaken[a.id] ?? 0;
          return (
            <LegendChip
              key={a.id}
              color={colorFor.get(a.id) ?? "#888"}
              label={a.name}
              on={true}
              subIcon={tab === "damage" ? "sword-brandish" : "health-normal"}
              sub={tab === "damage"
                ? `${data.damageDealt[a.id] ?? 0}`
                : `${a.final_hp ?? 0}/${a.max_hp}`}
              extra={tab === "damage" && took > 0
                ? { icon: "health-decrease", text: `${took}`, tone: "bad" as const }
                : undefined}
              isMonster
            />
          );
        })}
        {partyActors
          .filter((a) => tab !== "mana" || a.max_mana > 0)
          .map((a) => {
            const isManaTab = tab === "mana";
            const isDmgTab = tab === "damage";
            const subIcon = isManaTab ? "crystal-ball" : isDmgTab ? "sword-brandish" : "health-normal";
            const sub = isManaTab
              ? `${data.manaSpent[a.id] ?? 0} spent · ${a.final_mana ?? 0}/${a.max_mana}`
              : isDmgTab
              ? `${data.damageDealt[a.id] ?? 0}`
              : `${a.final_hp ?? 0}/${a.max_hp}`;
            const took = data.damageTaken[a.id] ?? 0;
            const healed = data.healingDone[a.id] ?? 0;
            // On the Damage tab, show whichever auxiliary stat exists. Heals
            // win over taken when both are present so the "you supported the
            // party" angle pops; long fights typically have one or the other.
            const extra: { icon: string; text: string; tone?: "good" | "bad" } | undefined =
              isDmgTab
                ? healed > 0
                  ? { icon: "health-potion", text: `${healed}`, tone: "good" }
                  : took > 0
                  ? { icon: "health-decrease", text: `${took}`, tone: "bad" }
                  : undefined
                : undefined;
            return (
              <LegendChip
                key={a.id}
                color={colorFor.get(a.id) ?? "#888"}
                label={a.name + (a.id === selfId ? " (you)" : "")}
                on={enabled.has(a.id)}
                onToggle={() => toggle(a.id)}
                subIcon={subIcon}
                sub={sub}
                extra={extra}
              />
            );
          })}
      </div>
    </div>
  );
}

function TabBtn({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "var(--bg-card)" : "transparent",
        border: "1px solid var(--border-faint)",
        borderRadius: 4,
        padding: "3px 8px",
        font: "11px/1 var(--font-mono)",
        color: active ? "var(--fg-1)" : "var(--fg-mute)",
        cursor: "pointer",
        display: "inline-flex", alignItems: "center", gap: 4,
      }}
    >
      <Icon name={icon} size={11} color={active ? "var(--fg-1)" : "var(--fg-mute)"} />
      {label}
    </button>
  );
}

function LegendChip({
  color, label, sub, subIcon, extra, on, onToggle, isMonster,
}: {
  color: string;
  label: string;
  sub?: string;
  subIcon?: string;
  /** Optional second stat (e.g. healing or damage-taken alongside damage). */
  extra?: { icon: string; text: string; tone?: "good" | "bad" };
  on: boolean;
  onToggle?: () => void;
  isMonster?: boolean;
}) {
  const interactive = !!onToggle;
  return (
    <button
      onClick={onToggle}
      disabled={!interactive}
      title={interactive ? (on ? "Hide on chart" : "Show on chart") : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "var(--bg-void)",
        border: `1px solid ${on ? color : "var(--border-faint)"}`,
        borderRadius: 999,
        padding: "3px 10px",
        cursor: interactive ? "pointer" : "default",
        opacity: on ? 1 : 0.45,
        font: "11px/1 var(--font-mono)",
        color: "var(--fg-1)",
      }}
    >
      <span style={{
        display: "inline-block",
        width: 8, height: 8,
        borderRadius: 999,
        background: color,
      }} />
      {isMonster && <Icon name="death-skull" size={11} />}
      <span>{label}</span>
      {sub && (
        <span style={{ color: "var(--fg-mute)", marginLeft: 4, display: "inline-flex", alignItems: "center", gap: 3 }}>
          ·
          {subIcon && <Icon name={subIcon} size={10} color="var(--fg-mute)" />}
          {sub}
        </span>
      )}
      {extra && (() => {
        const c = extra.tone === "bad" ? "var(--tone-bad-2)" : "var(--tone-good)";
        return (
          <span style={{ color: c, marginLeft: 2, display: "inline-flex", alignItems: "center", gap: 3 }}>
            <Icon name={extra.icon} size={10} color={c} />
            {extra.text}
          </span>
        );
      })()}
    </button>
  );
}

