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
import { isMonsterActor, MONSTER_ID } from "@gantt-quest/core";
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
  side: "party" | "monster";
  /** Final HP at end of fight — derived from the last sample. Used to dim
      lines for downed party / dead monsters. */
  final_hp?: number;
}

interface Sample {
  round: number;     // 0 = pre-fight starting HP, then 1, 2, …
  hp: Record<string, number>;
}

export interface BurndownData {
  actors: ActorMeta[];
  samples: Sample[];
  /** Total damage dealt by each actor. Healing not subtracted; this is the
      "raw output" stat players want to brag about. Heals tracked separately. */
  damageDealt: Record<string, number>;
  healingDone: Record<string, number>;
}

interface InitialFighter {
  id: string;
  name: string;
  hp: number;
  max_hp: number;
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
      side: "party",
    })),
  ];

  // Track HP per id as we replay. Start everyone at full — the live state's
  // current HP is the *end* state, not the start.
  const hp: Record<string, number> = {};
  const maxHp: Record<string, number> = {};
  for (const f of fighters) {
    hp[f.id] = f.max_hp;
    maxHp[f.id] = f.max_hp;
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
      side: "monster",
    });
  }

  const damageDealt: Record<string, number> = {};
  const healingDone: Record<string, number> = {};

  // round 0 = pre-fight HP snapshot
  const samples: Sample[] = [{ round: 0, hp: { ...hp } }];
  let round = 0;

  const flushRound = () => {
    // Replace the last sample if same round, else append.
    const last = samples[samples.length - 1];
    if (last && last.round === round) {
      last.hp = { ...hp };
    } else {
      samples.push({ round, hp: { ...hp } });
    }
  };

  // AnyEvent's index signature gives every field type `any`, so we read
  // directly with no per-branch casts — TS can't auto-narrow on a stringly
  // discriminant anyway. Variants we don't list fall through silently.
  for (const e of events) {
    switch (e.type) {
      case "turn_start":
        if (e.round !== round) {
          round = e.round;
          flushRound();
        }
        break;
      case "player_hit":
        hp[e.target] = Math.max(0, (hp[e.target] ?? 0) - e.damage);
        damageDealt[e.actor] = (damageDealt[e.actor] ?? 0) + e.damage;
        break;
      case "monster_attack":
        hp[e.target] = Math.max(0, (hp[e.target] ?? 0) - e.hp_damage);
        damageDealt[e.actor] = (damageDealt[e.actor] ?? 0) + e.hp_damage;
        break;
      case "monster_splash": {
        const targets = e.targets as Array<{ target: string; hp_damage: number }>;
        let total = 0;
        for (const hit of targets) {
          hp[hit.target] = Math.max(0, (hp[hit.target] ?? 0) - hit.hp_damage);
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
      default:
        // begin/roll/hit_check/ability_*/flee_check/etc. don't move HP.
        break;
    }
    flushRound();
  }

  for (const a of actors) {
    a.final_hp = hp[a.id] ?? 0;
  }

  return { actors, samples, damageDealt, healingDone };
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
  const [tab, setTab] = useState<"hp" | "damage">("hp");

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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{
          font: "10px/1 var(--font-mono)",
          color: "var(--accent-gold)",
          textTransform: "uppercase",
          letterSpacing: 1.4,
        }}>
          {tab === "hp" ? "HP burndown" : "Damage dealt"}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <TabBtn label="HP" active={tab === "hp"} onClick={() => setTab("hp")} />
          <TabBtn label="Damage" active={tab === "damage"} onClick={() => setTab("damage")} />
        </div>
      </div>

      {tab === "hp" ? (
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
          {/* Lines: monster first (under), party on top so player's line is visible */}
          {[...monsterActors, ...partyActors].map((a) => {
            if (!enabled.has(a.id)) return null;
            const isSelf = a.id === selfId;
            const isDown = (a.final_hp ?? 0) === 0;
            return (
              <polyline
                key={a.id}
                points={lineFor(a)}
                fill="none"
                stroke={colorFor.get(a.id) ?? "#888"}
                strokeWidth={isSelf ? 2.5 : a.side === "monster" ? 2 : 1.5}
                strokeOpacity={isDown ? 0.55 : 1}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}
        </svg>
      ) : (
        <DamageBars data={data} colorFor={colorFor} selfId={selfId} />
      )}

      {/* Legend / toggles. Monster's row is always on (no toggle); each party
          member can be turned off to declutter long fights. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
        {monsterActors.map((a) => (
          <LegendChip
            key={a.id}
            color={colorFor.get(a.id) ?? "#888"}
            label={a.name}
            on={true}
            sub={tab === "damage"
              ? `${data.damageDealt[a.id] ?? 0} dmg`
              : `${a.final_hp ?? 0}/${a.max_hp}`}
            isMonster
          />
        ))}
        {partyActors.map((a) => (
          <LegendChip
            key={a.id}
            color={colorFor.get(a.id) ?? "#888"}
            label={a.name + (a.id === selfId ? " (you)" : "")}
            on={enabled.has(a.id)}
            onToggle={() => toggle(a.id)}
            sub={tab === "damage"
              ? `${data.damageDealt[a.id] ?? 0} dmg${data.healingDone[a.id] ? ` · +${data.healingDone[a.id]} heal` : ""}`
              : `${a.final_hp ?? 0}/${a.max_hp}`}
          />
        ))}
      </div>
    </div>
  );
}

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
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
      }}
    >
      {label}
    </button>
  );
}

function LegendChip({
  color, label, sub, on, onToggle, isMonster,
}: {
  color: string;
  label: string;
  sub?: string;
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
      <span>{isMonster ? <><Icon name="death-skull" size={11} /> {label}</> : label}</span>
      {sub && (
        <span style={{ color: "var(--fg-mute)", marginLeft: 4 }}>· {sub}</span>
      )}
    </button>
  );
}

function DamageBars({
  data, colorFor, selfId,
}: {
  data: BurndownData;
  colorFor: Map<string, string>;
  selfId: string;
}) {
  const rows = data.actors
    .map((a) => ({
      actor: a,
      dmg: data.damageDealt[a.id] ?? 0,
      heal: data.healingDone[a.id] ?? 0,
    }))
    .sort((x, y) => y.dmg - x.dmg);

  const max = Math.max(1, ...rows.map((r) => r.dmg));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {rows.map(({ actor, dmg, heal }) => {
        const pct = (dmg / max) * 100;
        const isMonster = isMonsterActor(actor.id);
        return (
          <div key={actor.id} style={{ display: "flex", alignItems: "center", gap: 8, font: "11px/1 var(--font-mono)" }}>
            <div style={{ flex: "0 0 110px", color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {isMonster && <Icon name="death-skull" size={10} />} {actor.name}
              {actor.id === selfId && <span style={{ color: "var(--fg-mute)" }}> (you)</span>}
            </div>
            <div style={{ flex: 1, height: 12, background: "var(--bg-void)", borderRadius: 3, position: "relative", overflow: "hidden" }}>
              <div style={{
                width: `${pct}%`,
                height: "100%",
                background: colorFor.get(actor.id) ?? "#888",
                transition: "width 0.3s ease",
              }} />
            </div>
            <div style={{ flex: "0 0 90px", textAlign: "right", color: "var(--fg-mute)" }}>
              {dmg}{heal > 0 ? ` · +${heal}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}
