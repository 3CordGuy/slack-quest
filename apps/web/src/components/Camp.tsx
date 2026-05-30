// My Camp — the ward's bottom node. Houses the legacy Hunt launcher plus
// three new real-time gathering loops (Mine / Forage / Fish) and a Build tab
// for camp upgrades (worker tents → more parallel slots).
//
// All API calls hit /api/camp/* in the web worker. Gather yields are rolled
// server-side on first read after expires_at so a refresh and a claim agree
// on the same outcome.

import { useEffect, useMemo, useState } from "react";

import { Icon } from "../icons";
import type {
  ActiveGatheringTask, CampNode, CampStatusResponse, CampTier,
  CampUpgradeSpec, Item,
} from "../types";
import { CAMP_NODE_CONFIG, CAMP_TIERS } from "../constants";
import { muted } from "../styles";
import { SmallBadge } from "./ui";

// Static resource list keyed by node. Mirrors RESOURCE_CATALOG from
// @gantt-quest/core. Inlined here to keep Camp.tsx free of the workspace
// core import (mirrors how CAMP_NODE_CONFIG is exported from constants).
const STOCKPILE_RESOURCES: Array<{ id: string; node: CampNode; name: string; emoji: string; icon: string }> = [
  { id: "iron_ore",    node: "mine",   name: "Iron Ore",    emoji: "⛏️", icon: "coal-pile" },
  { id: "silver_ore",  node: "mine",   name: "Silver Ore",  emoji: "🪙", icon: "crystal-bars" },
  { id: "mithril_ore", node: "mine",   name: "Mithril Ore", emoji: "💠", icon: "crystal-cluster" },
  { id: "mossroot",    node: "forage", name: "Mossroot",    emoji: "🌿", icon: "herbs-bundle" },
  { id: "sunleaf",     node: "forage", name: "Sunleaf",     emoji: "🍀", icon: "chestnut-leaf" },
  { id: "nightbloom",  node: "forage", name: "Nightbloom",  emoji: "🌸", icon: "dandelion-flower" },
  { id: "river_carp",  node: "fish",   name: "River Carp",  emoji: "🐟", icon: "salmon" },
  { id: "silverfin",   node: "fish",   name: "Silverfin",   emoji: "🐠", icon: "flying-trout" },
  { id: "abyss_eel",   node: "fish",   name: "Abyss Eel",   emoji: "🐉", icon: "eel" },
];

interface CampProps {
  characterLevel: number;
  /** Active sidebar section from LocationModalWide render prop */
  section: string;
  status: CampStatusResponse | null;
  inventory: Item[];
  onStartGather: (node: CampNode, tier: CampTier, workerSlot: number) => Promise<void>;
  onClaim: (taskId: number) => Promise<void>;
  onCancel: (taskId: number) => Promise<void>;
  onBuildUpgrade: (upgradeKey: string) => Promise<void>;
}

export function Camp({
  characterLevel: _characterLevel, section, status, inventory,
  onStartGather, onClaim, onCancel, onBuildUpgrade,
}: CampProps) {
  const activeBySlot = useMemo(() => {
    const map = new Map<number, ActiveGatheringTask>();
    for (const t of status?.active ?? []) map.set(t.worker_slot, t);
    return map;
  }, [status]);

  if (section === "overview") {
    return (
      <div>
        <ActiveTaskStrip status={status} onClaim={onClaim} onCancel={onCancel} />
        <Stockpile inventory={inventory} />
      </div>
    );
  }
  if (section === "mine" || section === "forage" || section === "fish") {
    return (
      <div>
        <ActiveTaskStrip status={status} onClaim={onClaim} onCancel={onCancel} />
        <GatheringNodePanel
          node={section as CampNode}
          status={status}
          onStart={onStartGather}
          activeBySlot={activeBySlot}
        />
      </div>
    );
  }
  if (section === "build") {
    return (
      <div>
        <ActiveTaskStrip status={status} onClaim={onClaim} onCancel={onCancel} />
        <BuildPanel status={status} onBuild={onBuildUpgrade} />
      </div>
    );
  }
  return null;
}

// Stockpile — 3×3 stat-card grid for every gatherable resource.
// Always renders all 9 resources (zero-qty included) so the player can see
// what they're missing for crafting recipes without opening the inventory.
function Stockpile({ inventory }: { inventory: Item[] }) {
  const qtyByName = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of inventory) {
      if (it.item_type !== "resource") continue;
      map.set(it.item_name, (map.get(it.item_name) ?? 0) + (it.qty ?? 1));
    }
    return map;
  }, [inventory]);

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{
        fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, color: "var(--fg-mute)",
        marginBottom: 10, fontFamily: "var(--font-display)",
        display: "flex", alignItems: "center", gap: 6,
      }}>
        <Icon name="wooden-crate" size={13} />
        Stockpile
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
        {STOCKPILE_RESOURCES.map((r) => {
          const qty = qtyByName.get(`${r.emoji} ${r.name}`) ?? 0;
          const rarityColor = r.node === "mine"
            ? (r.id === "mithril_ore" ? "#7dd3fc" : r.id === "silver_ore" ? "#d1d5db" : "#a78bfa")
            : r.node === "forage"
            ? (r.id === "nightbloom" ? "#c084fc" : r.id === "sunleaf" ? "#fbbf24" : "#86efac")
            : (r.id === "abyss_eel" ? "#f87171" : r.id === "silverfin" ? "#7dd3fc" : "#6ee7b7");
          return (
            <div key={r.id} style={{
              padding: "10px 12px",
              borderRadius: "var(--radius-lg)",
              border: `1px solid ${qty > 0 ? rarityColor + "44" : "var(--border-base)"}`,
              background: qty > 0 ? rarityColor + "0d" : "var(--bg-card-2)",
              display: "grid",
              gridTemplateColumns: "44px 1fr auto",
              alignItems: "center",
              gap: 10,
              backdropFilter: "blur(10px) saturate(1.05)",
              WebkitBackdropFilter: "blur(10px) saturate(1.05)",
              transition: "border-color 0.2s",
              opacity: qty === 0 ? 0.55 : 1,
            }}>
              <div style={{
                width: 44, height: 44,
                display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: "var(--radius-md)",
                background: qty > 0 ? rarityColor + "1a" : "var(--bg-void)",
                border: `1px solid ${qty > 0 ? rarityColor + "55" : "var(--border-base)"}`,
                flexShrink: 0,
              }}>
                <Icon name={r.icon} size={28} color={qty > 0 ? rarityColor : "var(--fg-mute)"} />
              </div>
              <div style={{ minWidth: 0, lineHeight: 1.25 }}>
                <div style={{ fontSize: 12, color: "var(--fg-2)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                <div style={{ fontSize: 10, color: "var(--fg-mute)", textTransform: "uppercase", letterSpacing: 0.8, marginTop: 2 }}>{r.node}</div>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-display)", color: qty > 0 ? rarityColor : "var(--fg-mute)", lineHeight: 1, textAlign: "right" }}>{qty}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


function ActiveTaskStrip({
  status,
  onClaim,
  onCancel,
}: {
  status: CampStatusResponse | null;
  onClaim: (taskId: number) => Promise<void>;
  onCancel: (taskId: number) => Promise<void>;
}) {
  const active = status?.active ?? [];
  const errandSlot = status?.slots.errand_slot_used === true;
  if (active.length === 0 && !errandSlot) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16, marginBottom: 16 }}>
      {errandSlot && (
        <div style={{
          padding: "10px 14px",
          borderRadius: "var(--radius-lg)",
          border: "1px dashed var(--accent-gold-warm, #fbbf24)",
          background: "rgba(251,191,36,0.08)",
          fontSize: 12,
          color: "var(--fg-2)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <Icon name="conversation" size={16} color="var(--accent-gold, #fbbf24)" />
          <div>
            <strong style={{ color: "var(--accent-gold, #fbbf24)" }}>Main is out on a pub errand.</strong>
            {" "}Your tent slot stays occupied until you collect at the Pub.
          </div>
        </div>
      )}
      {active.map((t) => (
        <ActiveTaskRow key={t.id} task={t} now={status?.now ?? Date.now()} onClaim={onClaim} onCancel={onCancel} />
      ))}
    </div>
  );
}

function ActiveTaskRow({
  task, now, onClaim, onCancel,
}: {
  task: ActiveGatheringTask;
  now: number;
  onClaim: (taskId: number) => Promise<void>;
  onCancel: (taskId: number) => Promise<void>;
}) {
  const [ticker, setTicker] = useState(Date.now());
  useEffect(() => {
    if (task.ready) return;
    const id = setInterval(() => setTicker(Date.now()), 1000);
    return () => clearInterval(id);
  }, [task.ready]);

  const nowMs = Math.max(now, ticker);
  const remainingMs = Math.max(0, task.expires_at - nowMs);
  const totalMs = task.expires_at - task.started_at;
  const pct = totalMs > 0 ? Math.min(100, ((totalMs - remainingMs) / totalMs) * 100) : 100;
  const ready = task.ready || remainingMs <= 0;
  const nodeSpec = CAMP_NODE_CONFIG[task.node];
  const tierSpec = CAMP_TIERS[task.tier];
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // The player's own worker is slot 1 — that's the slot the quest gate
  // watches. Hired-worker rows can still be cancelled, but the affordance
  // is most important on the main slot since cancelling it unblocks
  // hunts/quests.
  const isMainSlot = task.worker_slot === 1;

  async function handleClaim() {
    setBusy(true);
    try { await onClaim(task.id); } finally { setBusy(false); }
  }

  async function handleCancel() {
    if (cancelling || busy || ready) return;
    const ok = typeof window !== "undefined"
      ? window.confirm(`Cancel ${nodeSpec.label.toLowerCase()} (Tent ${task.worker_slot})? No resources will drop.`)
      : true;
    if (!ok) return;
    setCancelling(true);
    try { await onCancel(task.id); } finally { setCancelling(false); }
  }

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      gap: 16,
      alignItems: "center",
      padding: "10px 14px",
      borderRadius: "var(--radius-lg)",
      border: ready ? "1px solid var(--accent-go-1, #4ade80)" : "1px solid var(--border-base)",
      background: "var(--bg-card-2)",
      backdropFilter: "blur(10px) saturate(1.05)",
      WebkitBackdropFilter: "blur(10px) saturate(1.05)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name={nodeSpec.icon} size={20} color={ready ? "#4ade80" : "var(--fg-mute)"} />
        <div>
          <div style={{ fontWeight: 600 }}>
            {nodeSpec.label} · {tierSpec.label}
            {isMainSlot && (
              <span style={{
                marginLeft: 8,
                font: "9px/1 var(--font-mono)",
                color: "var(--accent-gold)",
                textTransform: "uppercase",
                letterSpacing: 0.7,
                padding: "2px 6px",
                border: "1px solid var(--accent-gold-warm)",
                borderRadius: "var(--radius-sm)",
                background: "rgba(251,191,36,0.10)",
              }}>You</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>
            {isMainSlot ? "Your tent" : `Tent ${task.worker_slot}`}
            {ready ? " · Ready to collect" : ` · ${formatRemaining(remainingMs)} left`}
          </div>
        </div>
      </div>
      <div style={{
        height: 6, borderRadius: 999, background: "var(--bg-void)",
        position: "relative", overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", left: 0, top: 0, bottom: 0,
          width: `${pct}%`,
          background: ready ? "#4ade80" : "var(--accent-ink-blue-2)",
          transition: "width 1s linear",
        }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {!ready && (
          <button
            type="button"
            disabled={cancelling || busy}
            onClick={handleCancel}
            title={
              isMainSlot
                ? "Cancel and free your main character to go on a hunt or quest"
                : "Recall this worker — no resources will drop"
            }
            style={{
              background: "transparent",
              color: "var(--fg-mute)",
              border: "1px solid var(--border-base)",
              borderRadius: "var(--radius-md)",
              padding: "6px 10px",
              fontFamily: "inherit",
              fontSize: 12,
              cursor: cancelling || busy ? "default" : "pointer",
            }}
          >
            {cancelling ? "…" : "Cancel"}
          </button>
        )}
        <button
          type="button"
          disabled={!ready || busy}
          onClick={handleClaim}
          style={{
            background: ready ? "#4ade80" : "var(--bg-card)",
            color: ready ? "#0b1410" : "var(--fg-mute)",
            border: "1px solid var(--border-base)",
            borderRadius: "var(--radius-md)",
            padding: "6px 14px",
            fontFamily: "inherit",
            fontWeight: 600,
            cursor: ready && !busy ? "pointer" : "default",
          }}
        >
          {busy ? "…" : ready ? "Collect" : "Working"}
        </button>
      </div>
    </div>
  );
}

function GatheringNodePanel({
  node, status, onStart, activeBySlot,
}: {
  node: CampNode;
  status: CampStatusResponse | null;
  onStart: (node: CampNode, tier: CampTier, workerSlot: number) => Promise<void>;
  activeBySlot: Map<number, ActiveGatheringTask>;
}) {
  const spec = CAMP_NODE_CONFIG[node];
  const slotsTotal = status?.slots.total ?? 1;
  const slotsAvailable = status?.slots.available ?? 0;
  const errandSlotUsed = status?.slots.errand_slot_used === true;
  const allBusy = slotsAvailable <= 0;

  // Highest free slot wins by default — keeps "You" (slot 1) free for quests
  // unless every tent is already working.
  const freeSlots = useMemo(() => {
    const out: number[] = [];
    for (let s = 1; s <= slotsTotal; s++) {
      if (activeBySlot.has(s)) continue;
      if (s === 1 && errandSlotUsed) continue;
      out.push(s);
    }
    return out;
  }, [slotsTotal, activeBySlot, errandSlotUsed]);
  const defaultSlot = freeSlots.length > 0 ? freeSlots[freeSlots.length - 1] : null;
  const [selectedSlot, setSelectedSlot] = useState<number | null>(defaultSlot);

  // If the picker's current pick becomes busy (e.g. user started a task with
  // it), jump to the next free slot.
  useEffect(() => {
    const stillFree = selectedSlot != null && freeSlots.includes(selectedSlot);
    if (!stillFree) setSelectedSlot(defaultSlot);
  }, [defaultSlot, selectedSlot, freeSlots]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
        <Icon name={spec.icon} size={28} color="var(--fg-1)" />
        <div>
          <div style={{ font: "12px/1 var(--font-display)", textTransform: "uppercase", letterSpacing: 1.6, color: "var(--fg-mute)" }}>
            Gathering node
          </div>
          <div style={{ fontSize: 22, fontFamily: "var(--font-display)" }}>{spec.label}</div>
        </div>
      </div>
      <div style={{ ...muted, marginBottom: 14 }}>{spec.blurb}</div>

      <WorkerPicker
        slotsTotal={slotsTotal}
        activeBySlot={activeBySlot}
        errandSlotUsed={errandSlotUsed}
        selectedSlot={selectedSlot}
        onSelect={setSelectedSlot}
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 14 }}>
        {(["quick", "standard", "deep"] as CampTier[]).map((tier) => (
          <TierCard
            key={tier}
            node={node}
            tier={tier}
            disabled={allBusy || selectedSlot == null}
            workerSlot={selectedSlot}
            onStart={onStart}
          />
        ))}
      </div>

      {allBusy && (
        <div style={{ marginTop: 16, padding: "10px 14px", border: "1px dashed var(--border-base)", borderRadius: "var(--radius-md)", color: "var(--fg-mute)", fontSize: 13 }}>
          {status?.slots.errand_slot_used && (status?.slots.total ?? 1) === 1
            ? "Your main character is out on a pub errand. Collect at the Pub, or build a Worker Tent to keep gathering in parallel."
            : status?.slots.errand_slot_used
              ? `Every worker is busy — your main is out on a pub errand (${status!.slots.in_use} of ${status!.slots.total} in use).`
              : (status?.slots.total ?? 1) > 1
                ? `Every worker is busy (${status!.slots.in_use} of ${status!.slots.total} in use). Collect a finished task to free a slot.`
                : "Your tent is busy. Collect the finished task, or build a Worker Tent in the Build tab to run two tasks at once."}
        </div>
      )}
    </div>
  );
}

function workerLabel(slot: number): string {
  return slot === 1 ? "You" : `Tent ${slot - 1}`;
}

function WorkerPicker({
  slotsTotal, activeBySlot, errandSlotUsed, selectedSlot, onSelect,
}: {
  slotsTotal: number;
  activeBySlot: Map<number, ActiveGatheringTask>;
  errandSlotUsed: boolean;
  selectedSlot: number | null;
  onSelect: (slot: number) => void;
}) {
  const slots: number[] = [];
  for (let s = 1; s <= slotsTotal; s++) slots.push(s);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
      padding: "10px 12px",
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border-base)",
      background: "var(--bg-card-2)",
      backdropFilter: "blur(10px) saturate(1.05)",
      WebkitBackdropFilter: "blur(10px) saturate(1.05)",
    }}>
      <span style={{
        font: "11px/1 var(--font-display)",
        textTransform: "uppercase",
        letterSpacing: 1.4,
        color: "var(--fg-mute)",
      }}>
        Send
      </span>
      {slots.map((s) => {
        const busy = activeBySlot.get(s);
        const onErrand = s === 1 && errandSlotUsed && !busy;
        const disabled = !!busy || onErrand;
        const active = selectedSlot === s;
        const busyNote = busy
          ? `Busy: ${CAMP_NODE_CONFIG[busy.node].label} · ${CAMP_TIERS[busy.tier].label}`
          : onErrand
            ? "Out on a pub errand"
            : s === 1
              ? "You'll be tied up — can't start a quest until this finishes"
              : "Tent worker — leaves you free for quests";
        return (
          <button
            key={s}
            type="button"
            onClick={() => !disabled && onSelect(s)}
            disabled={disabled}
            title={busyNote}
            style={{
              padding: "5px 10px",
              border: active
                ? "1px solid var(--accent-ink-blue-2)"
                : "1px solid var(--border-base)",
              borderRadius: 999,
              background: active
                ? "var(--accent-ink-blue-2)"
                : disabled ? "var(--bg-card)" : "transparent",
              color: active ? "#fff" : disabled ? "var(--fg-mute)" : "var(--fg-1)",
              fontFamily: "inherit",
              fontSize: 12,
              fontWeight: 600,
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.6 : 1,
            }}
          >
            {workerLabel(s)}{busy ? " · busy" : onErrand ? " · errand" : ""}
          </button>
        );
      })}
    </div>
  );
}

function TierCard({
  node, tier, disabled, workerSlot, onStart,
}: {
  node: CampNode;
  tier: CampTier;
  disabled: boolean;
  workerSlot: number | null;
  onStart: (node: CampNode, tier: CampTier, workerSlot: number) => Promise<void>;
}) {
  const tierSpec = CAMP_TIERS[tier];
  const nodeSpec = CAMP_NODE_CONFIG[node];
  const [busy, setBusy] = useState(false);
  const yieldText = describeYield(node, tier);
  const rareNote = tier === "deep" && node === "mine"
    ? "5% chance: gold-vein strike (+250 gold)"
    : tier === "deep"
      ? `Chance to roll ${prettyName(nodeSpec.rare)}`
      : tier === "standard"
        ? `Chance to roll ${prettyName(nodeSpec.uncommon)}`
        : null;

  async function handle() {
    if (workerSlot == null) return;
    setBusy(true);
    try { await onStart(node, tier, workerSlot); } finally { setBusy(false); }
  }

  return (
    <div style={{
      padding: 16,
      borderRadius: "var(--radius-lg)",
      border: "1px solid rgba(255,255,255,0.08)",
      background: "rgba(12, 14, 18, 0.72)",
      backdropFilter: "blur(10px) saturate(1.1)",
      WebkitBackdropFilter: "blur(10px) saturate(1.1)",
      display: "flex",
      flexDirection: "column",
      gap: 8,
      height: "100%",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name={nodeSpec.icon} size={16} color="var(--fg-mute)" />
          <div style={{ font: "12px/1 var(--font-display)", textTransform: "uppercase", letterSpacing: 1.4 }}>
            {tierSpec.label}
          </div>
        </div>
        <SmallBadge>{formatDuration(tierSpec.duration_ms)}</SmallBadge>
      </div>
      <div style={{ fontSize: 14 }}>{yieldText}</div>
      <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>
        +{tierSpec.base_xp} XP · +{tierSpec.base_gold} gold
      </div>
      {rareNote && (
        <div style={{ fontSize: 11, color: "var(--accent-go-1, #f59e0b)", display: "flex", alignItems: "center", gap: 4 }}>
          {node === "fish" && tier === "deep" && <Icon name="eel" size={12} color="var(--accent-go-1, #f59e0b)" />}
          {rareNote}
        </div>
      )}
      <button
        type="button"
        disabled={disabled || busy}
        onClick={handle}
        style={{
          marginTop: "auto",
          padding: "8px 12px",
          border: "1px solid var(--border-base)",
          borderRadius: "var(--radius-md)",
          background: disabled ? "var(--bg-card)" : "var(--accent-ink-blue-2)",
          color: disabled ? "var(--fg-mute)" : "#fff",
          cursor: disabled || busy ? "default" : "pointer",
          fontWeight: 600,
          fontFamily: "inherit",
        }}
      >
        {busy
          ? "Starting…"
          : workerSlot == null
            ? "All workers busy"
            : `Send ${workerLabel(workerSlot)}`}
      </button>
    </div>
  );
}

function BuildPanel({
  status,
  onBuild,
}: {
  status: CampStatusResponse | null;
  onBuild: (upgradeKey: string) => Promise<void>;
}) {
  const built = new Set(status?.upgrades_built ?? []);
  const catalog = status?.upgrades_catalog ?? [];

  // Summarize built perks (non-slot upgrades) so the player can see active
  // bonuses at a glance. Worker tents are visible via the slot counter in
  // the header so we skip them here.
  const activePerks = catalog
    .filter((u) => built.has(u.key) && u.effect.kind !== "extra_slot")
    .map((u) => {
      if (u.effect.kind === "duration_pct") return `-${u.effect.value}% gather time`;
      if (u.effect.kind === "yield_bonus") return `+${u.effect.value} primary yield`;
      if (u.effect.kind === "rare_bonus_pct") return `+${u.effect.value}% rare chance`;
      return null;
    })
    .filter((s): s is string => s !== null);

  return (
    <div>
      <div style={{ ...muted, marginBottom: 12 }}>
        Worker tents add parallel gathering slots; perks compound across every
        task you start after building them.
      </div>
      {activePerks.length > 0 && (
        <div style={{
          marginBottom: 14,
          padding: "8px 12px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--accent-go-1, #4ade80)",
          background: "var(--bg-card-2)",
          backdropFilter: "blur(10px) saturate(1.05)",
          WebkitBackdropFilter: "blur(10px) saturate(1.05)",
          fontSize: 12,
          color: "var(--accent-go-1, #4ade80)",
          display: "flex", flexWrap: "wrap", gap: 12,
        }}>
          <strong style={{ textTransform: "uppercase", letterSpacing: 1.2, fontSize: 10 }}>
            Active perks
          </strong>
          <span>{activePerks.join(" · ")}</span>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {catalog.map((u) => (
          <UpgradeRow
            key={u.key}
            upgrade={u}
            built={built.has(u.key)}
            level={status?.level ?? 1}
            gold={status?.gold ?? 0}
            onBuild={onBuild}
          />
        ))}
      </div>
    </div>
  );
}

function UpgradeRow({
  upgrade, built, level, gold, onBuild,
}: {
  upgrade: CampUpgradeSpec;
  built: boolean;
  level: number;
  gold: number;
  onBuild: (key: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const locked = upgrade.coming_soon === true;
  const affordable = gold >= upgrade.gold_cost;
  const meetsLevel = level >= upgrade.level_req;
  const canBuild = !built && !locked && affordable && meetsLevel;
  async function handle() {
    setBusy(true);
    try { await onBuild(upgrade.key); } finally { setBusy(false); }
  }
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      gap: 14,
      padding: "12px 14px",
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border-base)",
      background: locked || built ? "var(--bg-card-2)" : "var(--bg-card)",
      opacity: locked ? 0.6 : 1,
      alignItems: "center",
      backdropFilter: "blur(10px) saturate(1.05)",
      WebkitBackdropFilter: "blur(10px) saturate(1.05)",
    }}>
      <Icon name={upgrade.icon} size={22} color="var(--fg-1)" />
      <div>
        <div style={{ fontWeight: 600 }}>{upgrade.label}</div>
        <div style={{ fontSize: 13, color: "var(--fg-mute)" }}>{upgrade.blurb}</div>
        <div style={{ fontSize: 11, color: "var(--fg-mute)", marginTop: 4 }}>
          {upgrade.gold_cost} gold · level {upgrade.level_req}+
        </div>
      </div>
      <button
        type="button"
        disabled={!canBuild || busy}
        onClick={handle}
        style={{
          padding: "6px 14px",
          border: "1px solid var(--border-base)",
          borderRadius: "var(--radius-md)",
          background: built ? "transparent" : canBuild ? "var(--accent-ink-blue-2)" : "var(--bg-card-2)",
          color: built ? "var(--accent-go-1, #4ade80)" : canBuild ? "#fff" : "var(--fg-mute)",
          cursor: canBuild && !busy ? "pointer" : "default",
          fontFamily: "inherit",
          fontWeight: 600,
        }}
      >
        {built ? "Built" : locked ? "Soon" : busy ? "…" : !meetsLevel ? `Lvl ${upgrade.level_req}` : !affordable ? "Need gold" : "Build"}
      </button>
    </div>
  );
}


function formatDuration(ms: number): string {
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60000)} min`;
  const hours = Math.round(ms / (60 * 60 * 1000) * 10) / 10;
  return `${hours} hr`;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "ready";
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec.toString().padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${(min % 60).toString().padStart(2, "0")}m`;
}

function prettyName(id: string): string {
  return id.replace(/_/g, " ");
}

function describeYield(node: CampNode, tier: CampTier): string {
  const spec = CAMP_NODE_CONFIG[node];
  if (tier === "quick") return `1 ${prettyName(spec.primary)}`;
  if (tier === "standard") return `2 ${prettyName(spec.primary)} or 1 ${prettyName(spec.uncommon)}`;
  return `3 ${prettyName(spec.primary)} + chance ${prettyName(spec.rare)}`;
}
