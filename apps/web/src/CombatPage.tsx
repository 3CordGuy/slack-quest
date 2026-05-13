import { useEffect, useReducer, useRef, useState } from "react";

// Live web-mode combat. Connects to the QuestRoom Durable Object via WS,
// renders the current state, animates incoming events through a scrolling
// log, and lets the active player submit actions.

interface StatusEffect {
  type: "regen" | "bleeding" | "burning" | "poisoned";
  magnitude: number;
  remaining: number;
  source?: string;
}

interface Fighter {
  id: string;
  name: string;
  class: string;
  level: number;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  shield: number;
  position: "front" | "back";
  attack_mod: number;
  magic_mod: number;
  weapon_power: number;
  armor_power: number;
  initiative: number;
  effects: StatusEffect[];
}

interface Monster {
  name: string;
  hp: number;
  max_hp: number;
  tier: number;
  initiative: number;
  effects: StatusEffect[];
  is_boss: boolean;
  boss_phase: 1 | 2;
  wave?: number;
  total_waves?: number;
}

interface CombatState {
  fighters: Fighter[];
  monster: Monster;
  turn_order: string[];
  turn_index: number;
  round: number;
  status: "pending" | "active" | "victory" | "defeat" | "fled";
}

const MONSTER_ID = "__monster__";

type CombatEvent =
  | { type: "begin"; turn_order: string[]; initiatives: Record<string, number> }
  | { type: "turn_start"; actor: string; round: number }
  | { type: "roll"; actor: string; die: string; value: number; purpose: string }
  | {
      type: "hit_check";
      actor: string;
      target: string;
      roll: number;
      modifier: number;
      total: number;
      ac: number;
      hit: boolean;
    }
  | { type: "player_hit"; actor: string; target: string; damage: number; crit: boolean; formula: string }
  | {
      type: "monster_attack";
      target: string;
      raw_damage: number;
      damage_after_position: number;
      damage_after_armor: number;
      shield_absorbed: number;
      hp_damage: number;
    }
  | { type: "boss_phase_transition"; new_phase: 2 }
  | { type: "fighter_down"; target: string }
  | { type: "monster_down"; killed_by: string }
  | { type: "heal_applied"; actor: string; target: string; amount: number; rolled: number }
  | { type: "shield_applied"; actor: string; target: string; amount: number; rolled: number }
  | { type: "signature_used"; actor: string; damage: number; formula: string; mana_spent: number }
  | {
      type: "flee_check";
      actor: string;
      roll: number;
      modifier: number;
      total: number;
      dc: number;
      success: boolean;
    }
  | { type: "fled" }
  | {
      type: "position_changed";
      actor: string;
      from: "front" | "back";
      to: "front" | "back";
    }
  | {
      type: "wave_transition";
      from_monster: string;
      to_monster: string;
      to_max_hp: number;
      new_wave: number;
      total_waves: number;
    }
  | {
      type: "effect_tick";
      actor: string;
      effect: "regen" | "bleeding" | "burning" | "poisoned";
      magnitude: number;
      hp_delta: number;
      source?: string;
    }
  | { type: "victory" }
  | { type: "defeat" }
  | { type: "rejected"; reason: string }
  | ItemUsedEvent;

type TurnAction =
  | { kind: "attack"; actor: string }
  | { kind: "cast"; actor: string }
  | { kind: "heal"; actor: string; target: string }
  | { kind: "shield"; actor: string; target: string }
  | { kind: "signature"; actor: string }
  | { kind: "flee"; actor: string }
  | { kind: "position"; actor: string; to: "front" | "back" }
  | { kind: "wait"; actor: string }
  | { kind: "monster_act" }
  | { kind: "use_item"; actor: string; item_id: number; target_id?: string };

type ItemEffect =
  | { kind: "heal"; target: string; amount: number; rolled: number }
  | { kind: "mana_bump"; target: string; added: number; new_max_mana: number }
  | { kind: "revive"; target: string; hp_restored: number }
  | { kind: "monster_damage"; amount: number; capped_from?: number }
  | { kind: "self_effect"; target: string; effect: "regen"; magnitude: number; remaining: number }
  | {
      kind: "monster_effect";
      effect: "poisoned" | "bleeding" | "burning";
      magnitude: number;
      remaining: number;
    }
  | { kind: "party_mana_refill"; recipients: { user_id: string; restored: number }[] };

interface ItemUsedEvent {
  type: "item_used";
  actor: string;
  item_id: number;
  item_name: string;
  item_type: string;
  effect: ItemEffect;
}

interface InventoryItem {
  id: number;
  item_name: string;
  item_type: "weapon" | "armor" | "consumable" | "magic" | "revive" | "tool" | "scroll";
  power: number;
  rarity: "common" | "uncommon" | "rare";
  flavor: string | null;
  equipped: boolean;
}

interface LootDrop {
  item_name: string;
  item_type: string;
  power: number;
  rarity: string;
  flavor: string;
}

interface FighterReward {
  user_id: string;
  damage_dealt: number;
  xp_awarded: number;
  gold_awarded: number;
  level_up: boolean;
  new_level: number;
  loot: LootDrop[];
  soft_death: { gold_lost: number; item_lost: string | null; scar: string } | null;
}

interface OutcomeSummary {
  status: "victory" | "defeat";
  rewards: FighterReward[];
  monster_name: string;
  monster_tier: number;
  total_pool_xp: number;
  total_pool_gold: number;
  elite: boolean;
  is_boss: boolean;
  dungeon_room_cleared?: boolean;
}

interface UiState {
  connection: "connecting" | "open" | "closed";
  state: CombatState | null;
  log: { id: number; text: string; tone: "info" | "good" | "bad" | "muted" }[];
  error: string | null;
  outcome: OutcomeSummary | null;
}

type UiAction =
  | { kind: "connection"; value: UiState["connection"] }
  | { kind: "state"; value: CombatState }
  | { kind: "events"; value: CombatEvent[] }
  | { kind: "error"; value: string }
  | { kind: "outcome"; value: OutcomeSummary };

let nextLogId = 1;

function reducer(s: UiState, a: UiAction): UiState {
  switch (a.kind) {
    case "connection":
      return { ...s, connection: a.value };
    case "state":
      return { ...s, state: a.value };
    case "events":
      return {
        ...s,
        log: [...s.log, ...a.value.flatMap((e) => formatEvent(e, s.state))].slice(-50),
      };
    case "error":
      return { ...s, error: a.value };
    case "outcome":
      return { ...s, outcome: a.value };
  }
}

function formatEvent(e: CombatEvent, state: CombatState | null): UiState["log"] {
  const nameOf = (id: string) => {
    if (id === MONSTER_ID) return state?.monster.name ?? "monster";
    return state?.fighters.find((f) => f.id === id)?.name ?? id;
  };
  switch (e.type) {
    case "begin":
      return [{ id: nextLogId++, text: "⚔️  Combat begins. Rolling initiative…", tone: "info" }];
    case "turn_start":
      return [{ id: nextLogId++, text: `▶ ${nameOf(e.actor)}'s turn (round ${e.round})`, tone: "muted" }];
    case "roll":
      return [
        {
          id: nextLogId++,
          text: `🎲 ${nameOf(e.actor)} rolled ${e.die} → ${e.value}  ·  ${e.purpose}`,
          tone: "muted",
        },
      ];
    case "hit_check":
      return [
        {
          id: nextLogId++,
          text: e.hit
            ? `✅ HIT  ${e.roll}${signed(e.modifier)} = ${e.total} vs AC ${e.ac}`
            : `❌ MISS  ${e.roll}${signed(e.modifier)} = ${e.total} vs AC ${e.ac}`,
          tone: e.hit ? "good" : "bad",
        },
      ];
    case "player_hit":
      return [
        {
          id: nextLogId++,
          text: `💥 ${nameOf(e.actor)} → ${nameOf(e.target)}: ${e.damage}${
            e.crit ? " (CRIT)" : ""
          }  [${e.formula}]`,
          tone: "good",
        },
      ];
    case "monster_attack":
      return [
        {
          id: nextLogId++,
          text:
            `💢 monster → ${nameOf(e.target)}: ${e.hp_damage} hp` +
            (e.shield_absorbed > 0 ? ` (+${e.shield_absorbed} shield)` : "") +
            (e.damage_after_position !== e.damage_after_armor
              ? ` [pos→ -${e.damage_after_armor - e.damage_after_position} mit]`
              : ""),
          tone: "bad",
        },
      ];
    case "boss_phase_transition":
      return [{ id: nextLogId++, text: "🔥 The boss enters phase 2!", tone: "bad" }];
    case "fighter_down":
      return [{ id: nextLogId++, text: `💀 ${nameOf(e.target)} is down.`, tone: "bad" }];
    case "monster_down":
      return [
        { id: nextLogId++, text: `🏆 ${nameOf(e.killed_by)} lands the killing blow.`, tone: "good" },
      ];
    case "heal_applied":
      return [
        {
          id: nextLogId++,
          text: `💚 ${nameOf(e.actor)} → ${nameOf(e.target)}: +${e.amount} HP${
            e.rolled > e.amount ? ` (rolled ${e.rolled}, clamped)` : ""
          }`,
          tone: "good",
        },
      ];
    case "shield_applied":
      return [
        {
          id: nextLogId++,
          text: `🛡️ ${nameOf(e.actor)} → ${nameOf(e.target)}: +${e.amount} shield${
            e.rolled > e.amount ? ` (rolled ${e.rolled}, capped)` : ""
          }`,
          tone: "good",
        },
      ];
    case "signature_used":
      return [
        {
          id: nextLogId++,
          text: `✨ ${nameOf(e.actor)} signature: ${e.damage} dmg  [${e.formula}]  −${e.mana_spent} mana`,
          tone: "good",
        },
      ];
    case "flee_check":
      return [
        {
          id: nextLogId++,
          text: e.success
            ? `🏃 ${nameOf(e.actor)} escape check: ${e.roll}${signed(e.modifier)} = ${e.total} vs DC ${e.dc}: SUCCESS`
            : `🏃 ${nameOf(e.actor)} escape check: ${e.roll}${signed(e.modifier)} = ${e.total} vs DC ${e.dc}: FAIL — exposed!`,
          tone: e.success ? "good" : "bad",
        },
      ];
    case "fled":
      return [{ id: nextLogId++, text: "🏃 The party escapes.", tone: "info" }];
    case "wave_transition":
      return [
        {
          id: nextLogId++,
          text: `⚔️  Wave ${e.new_wave}/${e.total_waves}: ${e.to_monster} arrives (${e.to_max_hp} HP)`,
          tone: "info",
        },
      ];
    case "position_changed":
      return [
        {
          id: nextLogId++,
          text: `${e.to === "front" ? "🔼" : "🔽"} ${nameOf(e.actor)} moves to ${e.to} row.`,
          tone: "info",
        },
      ];
    case "effect_tick": {
      const icon =
        e.effect === "regen"
          ? "💚"
          : e.effect === "poisoned"
            ? "☠️"
            : e.effect === "burning"
              ? "🔥"
              : "🩸";
      const sign = e.hp_delta >= 0 ? `+${e.hp_delta}` : `${e.hp_delta}`;
      const src = e.source ? ` (${e.source})` : "";
      return [
        {
          id: nextLogId++,
          text: `${icon} ${nameOf(e.actor)} ${e.effect}${src}: ${sign} HP`,
          tone: e.hp_delta >= 0 ? "good" : "bad",
        },
      ];
    }
    case "item_used": {
      const eff = e.effect;
      const head = `🎒 ${nameOf(e.actor)} used ${e.item_name}`;
      if (eff.kind === "heal") {
        return [{ id: nextLogId++, text: `${head}: +${eff.amount} HP`, tone: "good" }];
      } else if (eff.kind === "mana_bump") {
        return [
          {
            id: nextLogId++,
            text: `${head}: +${eff.added} max mana (now ${eff.new_max_mana})`,
            tone: "good",
          },
        ];
      } else if (eff.kind === "revive") {
        return [
          {
            id: nextLogId++,
            text: `${head}: revives ${nameOf(eff.target)} to ${eff.hp_restored} HP`,
            tone: "good",
          },
        ];
      } else if (eff.kind === "monster_damage") {
        const note = eff.capped_from
          ? ` (capped from ${eff.capped_from})`
          : "";
        return [
          {
            id: nextLogId++,
            text: `${head}: ${eff.amount} dmg to ${state?.monster.name ?? "monster"}${note}`,
            tone: "good",
          },
        ];
      } else if (eff.kind === "self_effect") {
        return [
          {
            id: nextLogId++,
            text: `${head}: ${nameOf(eff.target)} gains 🟢 regen +${eff.magnitude} × ${eff.remaining}`,
            tone: "good",
          },
        ];
      } else if (eff.kind === "monster_effect") {
        return [
          {
            id: nextLogId++,
            text: `${head}: ${state?.monster.name ?? "monster"} ☠️ ${eff.effect} ${eff.magnitude} × ${eff.remaining}`,
            tone: "good",
          },
        ];
      } else {
        // party_mana_refill
        const summary = eff.recipients
          .map((r) => `+${r.restored} to ${nameOf(r.user_id)}`)
          .join(", ");
        return [
          {
            id: nextLogId++,
            text: `${head}: mana refilled — ${summary || "no one needed it"}`,
            tone: "good",
          },
        ];
      }
    }
    case "victory":
      return [{ id: nextLogId++, text: "VICTORY", tone: "good" }];
    case "defeat":
      return [{ id: nextLogId++, text: "DEFEAT", tone: "bad" }];
    case "rejected":
      return [{ id: nextLogId++, text: `⚠ rejected: ${e.reason}`, tone: "bad" }];
  }
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function CombatPage({
  questId,
  selfId,
  onExit,
}: {
  questId: number;
  selfId: string;
  onExit: () => void;
}) {
  const [ui, dispatch] = useReducer(reducer, {
    connection: "connecting",
    state: null,
    log: [],
    error: null,
    outcome: null,
  });
  const [picking, setPicking] = useState<"heal" | "shield" | null>(null);
  const [itemPicker, setItemPicker] = useState<"closed" | "open" | { reviveItemId: number }>("closed");
  const [items, setItems] = useState<InventoryItem[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);

  // Inventory loaded once on mount; refreshed after each item_used event so
  // the picker reflects post-use state. Authoritative source is D1 via
  // /api/inventory.
  async function loadItems() {
    const res = await fetch("/api/inventory", { credentials: "include" });
    if (res.ok) setItems(((await res.json()) as { items: InventoryItem[] }).items);
  }
  useEffect(() => {
    void loadItems();
  }, []);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/quest/${questId}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => dispatch({ kind: "connection", value: "open" });
    ws.onclose = () => dispatch({ kind: "connection", value: "closed" });
    ws.onerror = () => dispatch({ kind: "error", value: "WebSocket error" });
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as
          | { type: "state"; state: CombatState }
          | { type: "events"; events: CombatEvent[] }
          | { type: "error"; message: string }
          | { type: "outcome"; outcome: OutcomeSummary };
        if (msg.type === "state") dispatch({ kind: "state", value: msg.state });
        else if (msg.type === "events") {
          dispatch({ kind: "events", value: msg.events });
          // Item use mutates inventory in D1 — refresh the picker.
          if (msg.events.some((e) => e.type === "item_used")) void loadItems();
        }
        else if (msg.type === "error") dispatch({ kind: "error", value: msg.message });
        else if (msg.type === "outcome") dispatch({ kind: "outcome", value: msg.outcome });
      } catch {
        dispatch({ kind: "error", value: "bad message" });
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [questId]);

  // Auto-scroll log to bottom as new entries arrive.
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ui.log.length]);

  function send(action: TurnAction) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "action", action }));
  }

  async function exit() {
    try {
      await fetch(`/api/quest/${questId}/end_web_combat`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      onExit();
    }
  }

  const state = ui.state;
  const currentActorId =
    state && state.status === "active"
      ? state.turn_order[state.turn_index % state.turn_order.length]
      : null;
  const myTurn = currentActorId === selfId;
  const ended =
    state?.status === "victory" || state?.status === "defeat" || state?.status === "fled";
  const me = state?.fighters.find((f) => f.id === selfId);
  const myMana = me?.mana ?? 0;

  function fireOnTarget(targetId: string) {
    if (!picking) return;
    send({ kind: picking, actor: selfId, target: targetId } as TurnAction);
    setPicking(null);
  }

  function fireUseItem(itemId: number, targetId?: string) {
    send({ kind: "use_item", actor: selfId, item_id: itemId, target_id: targetId });
    setItemPicker("closed");
  }

  return (
    <div style={page}>
      <div style={topBar}>
        <button onClick={exit} style={exitBtn}>
          ← Back
        </button>
        <span style={{ ...muted, fontSize: 12 }}>
          {ui.connection === "open" ? "● connected" : ui.connection === "connecting" ? "○ connecting" : "× disconnected"}
        </span>
      </div>

      {!state && (
        <div style={card}>
          <p style={muted}>Loading combat…</p>
          {ui.error && <p style={{ ...muted, color: "#c0392b" }}>{ui.error}</p>}
        </div>
      )}

      {state && (
        <>
          <MonsterCard monster={state.monster} round={state.round} />
          <InitiativeTrack
            order={state.turn_order}
            currentIndex={state.turn_index % state.turn_order.length}
            fighters={state.fighters}
            monster={state.monster}
            selfId={selfId}
          />
          <PartySection fighters={state.fighters} currentActorId={currentActorId} selfId={selfId} />
          {state.status === "active" && picking && (
            <TargetPicker
              kind={picking}
              fighters={state.fighters}
              onPick={fireOnTarget}
              onCancel={() => setPicking(null)}
            />
          )}
          {state.status === "active" && itemPicker === "open" && (
            <ItemPicker
              items={items}
              onPickNoTarget={(id) => fireUseItem(id)}
              onPickRevive={(id) => setItemPicker({ reviveItemId: id })}
              onCancel={() => setItemPicker("closed")}
            />
          )}
          {state.status === "active" &&
            typeof itemPicker === "object" &&
            "reviveItemId" in itemPicker && (
              <ReviveTargetPicker
                fighters={state.fighters}
                onPick={(targetId) => fireUseItem(itemPicker.reviveItemId, targetId)}
                onCancel={() => setItemPicker("open")}
              />
            )}
          {state.status === "active" && !picking && itemPicker === "closed" && (
            <ActionBar
              disabled={!myTurn}
              mana={myMana}
              hasItems={items.some((i) => isCombatUsable(i.item_type))}
              selfPosition={me?.position ?? "front"}
              onAct={(kind) => {
                if (kind === "heal" || kind === "shield") {
                  setPicking(kind);
                } else if (kind === "use_item") {
                  setItemPicker("open");
                } else if (kind === "swap_position") {
                  const to = me?.position === "front" ? "back" : "front";
                  send({ kind: "position", actor: selfId, to });
                } else if (kind === "signature" || kind === "flee" || kind === "attack" || kind === "cast" || kind === "wait") {
                  send({ kind, actor: selfId } as TurnAction);
                }
              }}
            />
          )}
          {!myTurn && state.status === "active" && currentActorId === MONSTER_ID && (
            <button style={{ ...button, background: "#5c1f1f" }} onClick={() => send({ kind: "monster_act" })}>
              Resolve monster turn
            </button>
          )}
          <EventLog log={ui.log} scrollRef={logScrollRef} />
          {ended && (
            <EndBanner
              status={state.status as "victory" | "defeat" | "fled"}
              outcome={ui.outcome}
              selfId={selfId}
              fighters={state.fighters}
            />
          )}
        </>
      )}
    </div>
  );
}

function MonsterCard({ monster, round }: { monster: Monster; round: number }) {
  return (
    <div style={{ ...card, borderColor: "#7c2020" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#f5f5f5" }}>{monster.name}</div>
          <div style={{ ...muted, fontSize: 12 }}>
            Tier {monster.tier}
            {monster.is_boss && ` · Boss (phase ${monster.boss_phase})`}
            {monster.wave && monster.total_waves && ` · Wave ${monster.wave}/${monster.total_waves}`}
            {` · Round ${round}`}
          </div>
        </div>
        <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
          {monster.hp} / {monster.max_hp}
        </div>
      </div>
      <BigHpBar current={monster.hp} max={monster.max_hp} />
    </div>
  );
}

function InitiativeTrack({
  order,
  currentIndex,
  fighters,
  monster,
  selfId,
}: {
  order: string[];
  currentIndex: number;
  fighters: Fighter[];
  monster: Monster;
  selfId: string;
}) {
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
        Initiative
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {order.map((id, i) => {
          const name = id === MONSTER_ID ? monster.name : fighters.find((f) => f.id === id)?.name ?? id;
          const init = id === MONSTER_ID ? monster.initiative : fighters.find((f) => f.id === id)?.initiative ?? 0;
          const isCurrent = i === currentIndex;
          const isSelf = id === selfId;
          return (
            <div
              key={id}
              style={{
                padding: "8px 12px",
                borderRadius: 20,
                background: isCurrent ? "#b89b3a" : "#1d1f23",
                color: isCurrent ? "#0e0f12" : "#e6e6e6",
                fontSize: 13,
                fontWeight: 600,
                border: isSelf && !isCurrent ? "1px solid #3a7bd5" : "1px solid transparent",
              }}
            >
              {name} · {init}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PartySection({
  fighters,
  currentActorId,
  selfId,
}: {
  fighters: Fighter[];
  currentActorId: string | null;
  selfId: string;
}) {
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
        Party
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {fighters.map((f) => (
          <FighterRow
            key={f.id}
            fighter={f}
            self={f.id === selfId}
            current={f.id === currentActorId}
          />
        ))}
      </div>
    </div>
  );
}

function FighterRow({ fighter, self, current }: { fighter: Fighter; self: boolean; current: boolean }) {
  const down = fighter.hp <= 0;
  return (
    <div
      style={{
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
        border: current ? "1px solid #b89b3a" : self ? "1px solid #3a7bd5" : "1px solid transparent",
        opacity: down ? 0.5 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 14 }}>{fighter.name}</span>
          <span style={{ ...muted, fontSize: 12 }}>
            {fighter.class} · Lv {fighter.level} · {fighter.position}
          </span>
          {self && (
            <span style={badge("#1f2a3a", "#7dd3fc", "#2a3a5a")}>you</span>
          )}
          {down && (
            <span style={badge("#3a1f1f", "#ff7676", "#5a2a2a")}>downed</span>
          )}
        </div>
        <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
          {fighter.hp}/{fighter.max_hp}
          {fighter.shield > 0 && (
            <span style={{ color: "#7c83ff", marginLeft: 6 }}>+{fighter.shield}</span>
          )}
        </div>
      </div>
      <HpBar current={fighter.hp} max={fighter.max_hp} />
      {fighter.max_mana > 0 && (
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ ...muted, fontSize: 11, minWidth: 36 }}>
            {fighter.mana}/{fighter.max_mana}
          </div>
          <div
            style={{
              flex: 1,
              height: 4,
              background: "#0e0f12",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${(fighter.mana / Math.max(1, fighter.max_mana)) * 100}%`,
                height: "100%",
                background: "#6366f1",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

type ActionKind =
  | "attack"
  | "cast"
  | "heal"
  | "shield"
  | "signature"
  | "flee"
  | "wait"
  | "use_item"
  | "swap_position";

// Items the worker has dispatch for in handleUseItem. Tools / scrolls are
// catalog-dispatched, so even though we filter by type here, the worker
// can still reject named items it doesn't yet support (e.g. Crowbar,
// Production Outage) — UI surfaces the error message inline.
function isCombatUsable(t: string): boolean {
  return (
    t === "consumable" ||
    t === "magic" ||
    t === "revive" ||
    t === "tool" ||
    t === "scroll"
  );
}

function ActionBar({
  disabled,
  mana,
  hasItems,
  selfPosition,
  onAct,
}: {
  disabled: boolean;
  mana: number;
  hasItems: boolean;
  selfPosition: "front" | "back";
  onAct: (kind: ActionKind) => void;
}) {
  const otherRow = selfPosition === "front" ? "back" : "front";
  return (
    <div style={{ ...card, display: "flex", gap: 8, flexWrap: "wrap" }}>
      <ActionBtn label="⚔ Attack" hint="d20+atk vs AC · 1d6 dmg" disabled={disabled} onClick={() => onAct("attack")} />
      <ActionBtn label="🔮 Cast" hint="d20+mag vs AC · 1d8 dmg" disabled={disabled} onClick={() => onAct("cast")} />
      <ActionBtn
        label="✨ Sig"
        hint={mana > 0 ? "Class signature · 1 mana" : "No mana"}
        disabled={disabled || mana < 1}
        onClick={() => onAct("signature")}
      />
      <ActionBtn label="💚 Heal" hint="1d6+mag · pick target" disabled={disabled} onClick={() => onAct("heal")} />
      <ActionBtn label="🛡 Shield" hint="1d6+mag · pick target" disabled={disabled} onClick={() => onAct("shield")} />
      <ActionBtn
        label="🎒 Item"
        hint={hasItems ? "Consumable / magic / revive / tool / scroll" : "Nothing usable"}
        disabled={disabled || !hasItems}
        onClick={() => onAct("use_item")}
      />
      <ActionBtn
        label={otherRow === "front" ? "🔼 To front" : "🔽 To back"}
        hint={otherRow === "front" ? "Soak hits · full damage" : "Less hit risk · 60% dmg taken"}
        disabled={disabled}
        onClick={() => onAct("swap_position")}
      />
      <ActionBtn label="🏃 Flee" hint="d20+mod vs DC 10+tier" disabled={disabled} onClick={() => onAct("flee")} />
      <ActionBtn label="⏸ Wait" hint="Skip your turn" disabled={disabled} onClick={() => onAct("wait")} />
    </div>
  );
}

function ItemPicker({
  items,
  onPickNoTarget,
  onPickRevive,
  onCancel,
}: {
  items: InventoryItem[];
  onPickNoTarget: (id: number) => void;       // consumable / magic / tool / scroll
  onPickRevive: (id: number) => void;          // needs a target picker step
  onCancel: () => void;
}) {
  const usable = items.filter((i) => isCombatUsable(i.item_type));
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>🎒 Use which?</div>
      {usable.length === 0 && (
        <p style={{ ...muted, fontSize: 13 }}>Nothing usable in combat.</p>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {usable.map((it) => (
          <button
            key={it.id}
            onClick={() => {
              if (it.item_type === "revive") onPickRevive(it.id);
              else onPickNoTarget(it.id);
            }}
            style={{
              ...button,
              marginTop: 0,
              padding: "10px 14px",
              background: "#1d1f23",
              border: "1px solid #2a2d33",
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 2,
            }}
          >
            <span style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
              <span style={{ fontWeight: 600 }}>{it.item_name}</span>
              <span style={{ ...muted, fontSize: 12 }}>
                {it.item_type} · {it.rarity} · +{it.power}
              </span>
            </span>
            {it.flavor && (
              <span style={{ ...muted, fontSize: 11, fontStyle: "italic" }}>
                {it.flavor}
              </span>
            )}
          </button>
        ))}
      </div>
      <button
        onClick={onCancel}
        style={{ ...button, marginTop: 8, background: "transparent", border: "1px solid #2a2d33", color: "#9aa0a6" }}
      >
        Cancel
      </button>
    </div>
  );
}

function ReviveTargetPicker({
  fighters,
  onPick,
  onCancel,
}: {
  fighters: Fighter[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const downed = fighters.filter((f) => f.hp <= 0);
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>💖 Revive who?</div>
      {downed.length === 0 && (
        <p style={{ ...muted, fontSize: 13 }}>No downed allies.</p>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {downed.map((f) => (
          <button
            key={f.id}
            onClick={() => onPick(f.id)}
            style={{
              ...button,
              marginTop: 0,
              padding: "10px 14px",
              background: "#1d1f23",
              border: "1px solid #2a2d33",
              textAlign: "left",
            }}
          >
            {f.name} <span style={{ ...muted, fontSize: 12 }}>· {f.class}</span>
          </button>
        ))}
      </div>
      <button
        onClick={onCancel}
        style={{ ...button, marginTop: 8, background: "transparent", border: "1px solid #2a2d33", color: "#9aa0a6" }}
      >
        Back
      </button>
    </div>
  );
}

function TargetPicker({
  kind,
  fighters,
  onPick,
  onCancel,
}: {
  kind: "heal" | "shield";
  fighters: Fighter[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  // Only valid for living fighters (heal/shield can't target a downed
  // character — revive will handle that when it lands).
  const targets = fighters.filter((f) => f.hp > 0);
  const label = kind === "heal" ? "💚 Heal who?" : "🛡 Shield who?";
  return (
    <div style={{ ...card }}>
      <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>{label}</div>
      <div style={{ display: "grid", gap: 8 }}>
        {targets.map((f) => (
          <button
            key={f.id}
            onClick={() => onPick(f.id)}
            style={{
              ...button,
              marginTop: 0,
              padding: "10px 14px",
              background: "#1d1f23",
              border: "1px solid #2a2d33",
              textAlign: "left",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>
              {f.name}{" "}
              <span style={{ ...muted, fontSize: 12 }}>
                · {f.class}
              </span>
            </span>
            <span style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
              {f.hp}/{f.max_hp}
              {f.shield > 0 && <span style={{ color: "#7c83ff" }}> +{f.shield}</span>}
            </span>
          </button>
        ))}
      </div>
      <button
        onClick={onCancel}
        style={{ ...button, marginTop: 8, background: "transparent", border: "1px solid #2a2d33", color: "#9aa0a6" }}
      >
        Cancel
      </button>
    </div>
  );
}

function ActionBtn({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...button,
        flex: "1 1 140px",
        marginTop: 0,
        background: disabled ? "#2a2d33" : "#3a7bd5",
        color: disabled ? "#6a7080" : "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.8 }}>{hint}</span>
    </button>
  );
}

function EventLog({
  log,
  scrollRef,
}: {
  log: UiState["log"];
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  return (
    <div style={card}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
        Combat log
      </div>
      <div
        ref={scrollRef}
        style={{
          maxHeight: 280,
          overflowY: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          background: "#0e0f12",
          borderRadius: 8,
          padding: 12,
          display: "grid",
          gap: 4,
        }}
      >
        {log.length === 0 && <span style={muted}>Waiting for events…</span>}
        {log.map((line) => (
          <div key={line.id} style={{ color: TONE_COLOR[line.tone] }}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function EndBanner({
  status,
  outcome,
  selfId,
  fighters,
}: {
  status: "victory" | "defeat" | "fled";
  outcome: OutcomeSummary | null;
  selfId: string;
  fighters: Fighter[];
}) {
  const win = status === "victory";
  const fled = status === "fled";
  const dungeonRoom = win && outcome?.dungeon_room_cleared;
  const labelText = dungeonRoom ? "ROOM CLEARED" : win ? "VICTORY" : fled ? "ESCAPED" : "DEFEAT";
  const borderColor = win ? "#16a34a" : fled ? "#b89b3a" : "#7c2020";
  const bg = win ? "#0f2818" : fled ? "#241e0d" : "#28100f";
  const fg = win ? "#86efac" : fled ? "#facc15" : "#fca5a5";
  return (
    <div
      style={{
        ...card,
        borderColor,
        background: bg,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 32, fontWeight: 800, color: fg }}>{labelText}</div>
      {!outcome && <p style={muted}>Resolving outcome…</p>}
      {outcome && (
        <div style={{ marginTop: 12, textAlign: "left" }}>
          {win && (outcome.is_boss || outcome.elite) && (
            <div style={{ ...muted, fontSize: 12, textAlign: "center", marginBottom: 8 }}>
              {outcome.is_boss && "Boss "} {outcome.elite && "Elite "} pool: {outcome.total_pool_xp} XP · {outcome.total_pool_gold}g (split by contribution)
            </div>
          )}
          <div style={{ display: "grid", gap: 8 }}>
            {outcome.rewards.map((r) => (
              <RewardRow
                key={r.user_id}
                reward={r}
                fighterName={fighters.find((x) => x.id === r.user_id)?.name ?? r.user_id}
                isSelf={r.user_id === selfId}
                won={win}
              />
            ))}
          </div>
          <p style={{ ...muted, marginTop: 12, textAlign: "center" }}>
            {outcome?.dungeon_room_cleared
              ? "Room cleared. Use Slack /sq choose to pick the next door (and resolve any trap/lockbox/npc rooms there)."
              : <>Click <strong>← Back</strong> to return.</>}
          </p>
        </div>
      )}
    </div>
  );
}

function RewardRow({
  reward,
  fighterName,
  isSelf,
  won,
}: {
  reward: FighterReward;
  fighterName: string;
  isSelf: boolean;
  won: boolean;
}) {
  return (
    <div
      style={{
        padding: 12,
        background: "#0e0f12",
        borderRadius: 8,
        border: isSelf ? "1px solid #3a7bd5" : "1px solid transparent",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontWeight: 700, color: "#f5f5f5" }}>{fighterName}</span>
          {isSelf && <span style={{ ...muted, fontSize: 12 }}>(you)</span>}
          <span style={{ ...muted, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
            · {reward.damage_dealt} dmg
          </span>
        </div>
        <div style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", color: "#e6e6e6" }}>
          {won
            ? `+${reward.xp_awarded} XP · +${reward.gold_awarded}g`
            : reward.soft_death
              ? "downed"
              : "—"}
        </div>
      </div>
      {reward.level_up && (
        <div style={{ marginTop: 6, fontSize: 13, color: "#facc15", fontWeight: 600 }}>
          ⭐ Level {reward.new_level}!
        </div>
      )}
      {reward.loot.length > 0 && (
        <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
          {reward.loot.map((it, i) => (
            <div key={i} style={{ fontSize: 12, color: "#86efac" }}>
              🎁 {it.item_name} · {it.rarity} {it.item_type} +{it.power}
            </div>
          ))}
        </div>
      )}
      {reward.soft_death && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#fca5a5" }}>
          💀 −{reward.soft_death.gold_lost}g
          {reward.soft_death.item_lost && ` · lost ${reward.soft_death.item_lost}`}
          {reward.soft_death.scar && ` · scar: "${reward.soft_death.scar}"`}
        </div>
      )}
    </div>
  );
}

// ─── styles + helpers ──────────────────────────────────────────────────────

function BigHpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const color = pct < 0.25 ? "#fca5a5" : pct < 0.5 ? "#fbbf24" : "#ef4444";
  return (
    <div
      style={{
        marginTop: 10,
        width: "100%",
        height: 14,
        background: "#0e0f12",
        borderRadius: 7,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct * 100}%`,
          height: "100%",
          background: color,
          transition: "width 200ms ease",
        }}
      />
    </div>
  );
}

function HpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const color = pct < 0.25 ? "#dc2626" : pct < 0.5 ? "#d97706" : "#16a34a";
  return (
    <div
      style={{
        marginTop: 6,
        width: "100%",
        height: 8,
        background: "#0e0f12",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct * 100}%`,
          height: "100%",
          background: color,
          transition: "width 200ms ease",
        }}
      />
    </div>
  );
}

function badge(bg: string, fg: string, border: string): React.CSSProperties {
  return {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    padding: "2px 6px",
    borderRadius: 4,
    border: `1px solid ${border}`,
    fontWeight: 600,
    background: bg,
    color: fg,
  };
}

const TONE_COLOR: Record<string, string> = {
  info: "#e6e6e6",
  good: "#86efac",
  bad: "#fca5a5",
  muted: "#9aa0a6",
};

const page: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  width: "100%",
  maxWidth: 720,
  margin: "0 auto",
  padding: 24,
};
const topBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};
const card: React.CSSProperties = {
  background: "#15171b",
  padding: 24,
  borderRadius: 12,
  width: "100%",
  border: "1px solid #2a2d33",
  boxSizing: "border-box",
};
const muted: React.CSSProperties = { color: "#9aa0a6", fontSize: 14, margin: 0 };
const button: React.CSSProperties = {
  marginTop: 12,
  width: "100%",
  padding: "12px 14px",
  fontSize: 16,
  fontWeight: 600,
  borderRadius: 8,
  border: "none",
  background: "#3a7bd5",
  color: "#fff",
  cursor: "pointer",
};
const exitBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #2a2d33",
  color: "#e6e6e6",
  padding: "6px 12px",
  borderRadius: 8,
  fontSize: 13,
  cursor: "pointer",
};
