// My Camp — the ward's bottom node. Houses the legacy Hunt launcher plus
// three new real-time gathering loops (Mine / Forage / Fish) and a Build tab
// for camp upgrades (worker tents → more parallel slots).
//
// All API calls hit /api/camp/* in the web worker. Gather yields are rolled
// server-side on first read after expires_at so a refresh and a claim agree
// on the same outcome.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Icon } from "../icons";
import type {
  ActiveGatheringTask, CampNode, CampStatusResponse, CampTab, CampTier,
  CampUpgradeSpec, Item,
} from "../types";
import { CAMP_NODE_CONFIG, CAMP_TIERS } from "../constants";
import { card, h2, muted } from "../styles";
import { LocationHero, SmallBadge } from "./ui";

// Static resource list keyed by node. Mirrors RESOURCE_CATALOG from
// @gantt-quest/core. Inlined here to keep Camp.tsx free of the workspace
// core import (mirrors how CAMP_NODE_CONFIG is exported from constants).
const STOCKPILE_RESOURCES: Array<{ id: string; node: CampNode; name: string; emoji: string }> = [
  { id: "iron_ore",    node: "mine",   name: "Iron Ore",    emoji: "⛏️" },
  { id: "silver_ore",  node: "mine",   name: "Silver Ore",  emoji: "🪙" },
  { id: "mithril_ore", node: "mine",   name: "Mithril Ore", emoji: "💠" },
  { id: "mossroot",    node: "forage", name: "Mossroot",    emoji: "🌿" },
  { id: "sunleaf",     node: "forage", name: "Sunleaf",     emoji: "🍀" },
  { id: "nightbloom",  node: "forage", name: "Nightbloom",  emoji: "🌸" },
  { id: "river_carp",  node: "fish",   name: "River Carp",  emoji: "🐟" },
  { id: "silverfin",   node: "fish",   name: "Silverfin",   emoji: "🐠" },
  { id: "abyss_eel",   node: "fish",   name: "Abyss Eel",   emoji: "🐉" },
];

interface CampProps {
  characterLevel: number;
  overviewArt: string | null;
  navOverlay?: ReactNode;
  status: CampStatusResponse | null;
  inventory: Item[];
  onStartGather: (node: CampNode, tier: CampTier) => Promise<void>;
  onClaim: (taskId: number) => Promise<void>;
  onBuildUpgrade: (upgradeKey: string) => Promise<void>;
}

const TAB_META: Array<{ tab: CampTab; label: string; icon: string }> = [
  { tab: "mine",   label: "Mine",    icon: "ore" },
  { tab: "forage", label: "Forage",  icon: "grass-mushroom" },
  { tab: "fish",   label: "Fishing", icon: "fishing-hook" },
  { tab: "build",  label: "Build",   icon: "anvil" },
];

export function Camp({
  characterLevel, overviewArt, navOverlay, status, inventory,
  onStartGather, onClaim, onBuildUpgrade,
}: CampProps) {
  const [tab, setTab] = useState<CampTab>("mine");
  const activeBySlot = useMemo(() => {
    const map = new Map<number, ActiveGatheringTask>();
    for (const t of status?.active ?? []) map.set(t.worker_slot, t);
    return map;
  }, [status]);

  return (
    <div style={{ ...card, padding: 0 }}>
      {navOverlay && <LocationHero src={overviewArt} label="My Camp" nav={navOverlay} flush />}
      <div style={{ padding: "var(--card-pad, 32px)" }}>
        <CampHeader status={status} />
        <ActiveTaskStrip status={status} onClaim={onClaim} />
        <Stockpile inventory={inventory} />

        <div style={{ display: "flex", gap: 6, marginTop: 24, marginBottom: 20, flexWrap: "wrap" }}>
          {TAB_META.map((m) => (
            <TabButton key={m.tab} active={tab === m.tab} onClick={() => setTab(m.tab)} icon={m.icon}>
              {m.label}
            </TabButton>
          ))}
        </div>

        {(tab === "mine" || tab === "forage" || tab === "fish") && (
          <GatheringNodePanel
            node={tab}
            status={status}
            onStart={onStartGather}
            activeBySlot={activeBySlot}
          />
        )}
        {tab === "build" && (
          <BuildPanel status={status} onBuild={onBuildUpgrade} />
        )}
      </div>
    </div>
  );
}

// Stockpile — at-a-glance qty for every gatherable resource, grouped by node.
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
    <div style={{
      marginTop: 14,
      padding: "12px 14px",
      borderRadius: "var(--radius-lg)",
      border: "1px solid var(--border-base)",
      background: "var(--bg-card-2)",
    }}>
      <div style={{
        font: "11px/1 var(--font-display)",
        textTransform: "uppercase",
        letterSpacing: 1.5,
        color: "var(--fg-mute)",
        marginBottom: 10,
      }}>
        Stockpile
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
        {(["mine", "forage", "fish"] as CampNode[]).map((node) => (
          <StockpileColumn
            key={node}
            node={node}
            qtyByName={qtyByName}
          />
        ))}
      </div>
    </div>
  );
}

function StockpileColumn({
  node,
  qtyByName,
}: {
  node: CampNode;
  qtyByName: Map<string, number>;
}) {
  const spec = CAMP_NODE_CONFIG[node];
  const entries = STOCKPILE_RESOURCES.filter((r) => r.node === node);
  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontSize: 11, color: "var(--fg-mute)", textTransform: "uppercase", letterSpacing: 1.2,
        marginBottom: 6,
      }}>
        <Icon name={spec.icon} size={11} />
        <span>{node === "mine" ? "Ore" : node === "forage" ? "Herbs" : "Fish"}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {entries.map((r) => {
          const full = `${r.emoji} ${r.name}`;
          const qty = qtyByName.get(full) ?? 0;
          return (
            <div key={r.id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              fontSize: 12,
              color: qty > 0 ? "var(--fg-1)" : "var(--fg-mute)",
            }}>
              <span><span style={{ marginRight: 4 }}>{r.emoji}</span>{r.name}</span>
              <span style={{
                fontVariantNumeric: "tabular-nums",
                fontWeight: 600,
                color: qty > 0 ? "var(--accent-go-1, #4ade80)" : "var(--fg-mute)",
              }}>{qty}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CampHeader({ status }: { status: CampStatusResponse | null }) {
  const slotsTotal = status?.slots.total ?? 1;
  const slotsUsed  = status?.slots.in_use ?? 0;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 4 }}>
      <h2 style={h2}>My Camp</h2>
      <span style={muted}>
        {slotsUsed} of {slotsTotal} {slotsTotal === 1 ? "tent" : "tents"} in use
      </span>
    </div>
  );
}

function ActiveTaskStrip({
  status,
  onClaim,
}: {
  status: CampStatusResponse | null;
  onClaim: (taskId: number) => Promise<void>;
}) {
  const active = status?.active ?? [];
  if (active.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
      {active.map((t) => (
        <ActiveTaskRow key={t.id} task={t} now={status?.now ?? Date.now()} onClaim={onClaim} />
      ))}
    </div>
  );
}

function ActiveTaskRow({
  task, now, onClaim,
}: {
  task: ActiveGatheringTask;
  now: number;
  onClaim: (taskId: number) => Promise<void>;
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

  async function handleClaim() {
    setBusy(true);
    try { await onClaim(task.id); } finally { setBusy(false); }
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
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name={nodeSpec.icon} size={20} color={ready ? "#4ade80" : "var(--fg-mute)"} />
        <div>
          <div style={{ fontWeight: 600 }}>{nodeSpec.label} · {tierSpec.label}</div>
          <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>
            Tent {task.worker_slot}
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
  );
}

function GatheringNodePanel({
  node, status, onStart, activeBySlot,
}: {
  node: CampNode;
  status: CampStatusResponse | null;
  onStart: (node: CampNode, tier: CampTier) => Promise<void>;
  activeBySlot: Map<number, ActiveGatheringTask>;
}) {
  const spec = CAMP_NODE_CONFIG[node];
  const slotsAvailable = status?.slots.available ?? 0;
  const allBusy = slotsAvailable <= 0;
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
      <div style={{ ...muted, marginBottom: 18 }}>{spec.blurb}</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {(["quick", "standard", "deep"] as CampTier[]).map((tier) => (
          <TierCard
            key={tier}
            node={node}
            tier={tier}
            disabled={allBusy}
            onStart={onStart}
          />
        ))}
      </div>

      {allBusy && (
        <div style={{ marginTop: 16, padding: "10px 14px", border: "1px dashed var(--border-base)", borderRadius: "var(--radius-md)", color: "var(--fg-mute)", fontSize: 13 }}>
          All tents busy. Collect a completed task or pitch another worker tent in Build.
        </div>
      )}
    </div>
  );
}

function TierCard({
  node, tier, disabled, onStart,
}: {
  node: CampNode;
  tier: CampTier;
  disabled: boolean;
  onStart: (node: CampNode, tier: CampTier) => Promise<void>;
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
    setBusy(true);
    try { await onStart(node, tier); } finally { setBusy(false); }
  }

  return (
    <div style={{
      padding: 16,
      borderRadius: "var(--radius-lg)",
      border: "1px solid var(--border-base)",
      background: "var(--bg-card-2)",
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
        <div style={{ fontSize: 11, color: "var(--accent-go-1, #f59e0b)" }}>{rareNote}</div>
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
        {busy ? "Starting…" : disabled ? "All tents busy" : "Start gathering"}
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

function TabButton({
  active, onClick, children, icon,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  icon: string;
}) {
  const style: CSSProperties = {
    padding: "6px 12px",
    border: "1px solid var(--border-base)",
    borderRadius: "var(--radius-md)",
    background: active ? "var(--accent-ink-blue-2)" : "transparent",
    color: active ? "#fff" : "var(--fg-mute)",
    cursor: "pointer",
    fontFamily: "inherit",
    display: "flex",
    alignItems: "center",
    gap: 6,
  };
  return (
    <button type="button" onClick={onClick} style={style}>
      <Icon name={icon} size={14} />
      <span>{children}</span>
    </button>
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
