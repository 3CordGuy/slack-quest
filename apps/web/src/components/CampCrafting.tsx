// Smithy Forge + Reinforce, Apothecary Brew + Concentrate. Surfaces v1 crafting
// hooks alongside the existing SmithyCard/ApothecaryCard inside their town
// modals. Reads inventory client-side so we don't need a new fetch — the
// existing /api/inventory already returns qty + potency_stacks.

import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import type { CSSProperties } from "react";

import { RECIPE_CATALOG, RESOURCE_CATALOG, findResource, type RecipeSpec, type ResourceSpec } from "@gantt-quest/core";

import { Icon } from "../icons";
import type { Item } from "../types";
import { card, h2, muted } from "../styles";

interface PanelCommon {
  characterLevel: number;
  gold: number;
  inventory: Item[];
  onAfterAction: () => void | Promise<void>;
}

// =========================================================================
// Smithy: Forge (recipes) + Reinforce (extend sharpens past 3 with ore)
// =========================================================================

export function ForgePanel(props: PanelCommon) {
  const recipes = useMemo(() => RECIPE_CATALOG.filter((r) => r.station === "smithy"), []);
  const ores = useMemo(() => filterResources(props.inventory, "mine"), [props.inventory]);
  // Reinforce candidates: equipped weapon/armor at sharpens >= 3 and < 6.
  const reinforceCandidates = useMemo(() => props.inventory.filter((it) =>
    (it.item_type === "weapon" || it.item_type === "armor")
    && it.equipped
    && it.sharpens_count >= 3
    && it.sharpens_count < 6,
  ), [props.inventory]);

  return (
    <div style={card}>
      <SectionTitle icon="anvil" title="Forge & Reinforce" />
      <p style={muted}>
        <em>"Bring me ore from the mine. I'll forge it into something worth swinging."</em>
      </p>
      <SubHeader>Forge</SubHeader>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {recipes.map((r) => (
          <RecipeRow
            key={r.id}
            recipe={r}
            characterLevel={props.characterLevel}
            gold={props.gold}
            inventory={props.inventory}
            station="smithy"
            onAfterAction={props.onAfterAction}
          />
        ))}
      </div>

      <SubHeader>Reinforce <span style={{ color: "var(--fg-mute)", fontWeight: 400 }}>(past sharpen cap, costs 1 ore)</span></SubHeader>
      {reinforceCandidates.length === 0 ? (
        <p style={muted}>Sharpen an equipped weapon or armor to its gold cap (3) first, then reinforce here with ore.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {reinforceCandidates.map((item) => (
            <ReinforceRow
              key={item.id}
              item={item}
              ores={ores}
              onAfterAction={props.onAfterAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// Apothecary: Brew (recipes) + Concentrate (boost potion potency with herbs)
// =========================================================================

export function BrewPanel(props: PanelCommon) {
  const recipes = useMemo(() => RECIPE_CATALOG.filter((r) => r.station === "apothecary"), []);
  const herbs = useMemo(() => filterResources(props.inventory, "forage"), [props.inventory]);
  const concentrateCandidates = useMemo(() => props.inventory.filter((it) =>
    (it.item_type === "consumable" || it.item_type === "tool")
    && (it.potency_stacks ?? 0) < 2,
  ), [props.inventory]);

  return (
    <div style={card}>
      <SectionTitle icon="poison-bottle" title="Brew & Concentrate" />
      <p style={muted}>
        <em>"Herbs from the camp garden. Steep, decant, refine — same as gold, slower."</em>
      </p>
      <SubHeader>Brew</SubHeader>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {recipes.map((r) => (
          <RecipeRow
            key={r.id}
            recipe={r}
            characterLevel={props.characterLevel}
            gold={props.gold}
            inventory={props.inventory}
            station="apothecary"
            onAfterAction={props.onAfterAction}
          />
        ))}
      </div>

      <SubHeader>Concentrate <span style={{ color: "var(--fg-mute)", fontWeight: 400 }}>(boost potion potency, 1 herb per stack)</span></SubHeader>
      {concentrateCandidates.length === 0 ? (
        <p style={muted}>No potions to concentrate. Brew one above, then add a herb to boost its potency.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {concentrateCandidates.map((item) => (
            <ConcentrateRow
              key={item.id}
              item={item}
              herbs={herbs}
              onAfterAction={props.onAfterAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// Row primitives
// =========================================================================

function RecipeRow({
  recipe, characterLevel, gold, inventory, station, onAfterAction,
}: {
  recipe: RecipeSpec;
  characterLevel: number;
  gold: number;
  inventory: Item[];
  station: "smithy" | "apothecary";
  onAfterAction: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const meetsLevel = characterLevel >= recipe.level_req;
  const affordable = gold >= recipe.gold_cost;
  const missingInputs = recipe.inputs.filter((inp) => {
    const have = inventoryQty(inventory, inp.resource_id);
    return have < inp.qty;
  });
  const hasInputs = missingInputs.length === 0;
  const canCraft = meetsLevel && affordable && hasInputs;

  async function handle() {
    const endpoint = station === "smithy"
      ? `/api/smithy/forge/${recipe.id}`
      : `/api/apothecary/brew/${recipe.id}`;
    setBusy(true);
    try {
      const res = await fetch(endpoint, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        toast.error(`Couldn't craft: ${body.error ?? res.statusText}`);
        return;
      }
      toast.success(`${station === "smithy" ? "Forged" : "Brewed"} ${recipe.output_name}`);
      await onAfterAction();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{recipe.output_name}</div>
        <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>{recipe.output_blurb}</div>
        <div style={{ fontSize: 11, color: "var(--fg-mute)", marginTop: 4 }}>
          {recipe.inputs.map((inp) => {
            const spec = findResource(inp.resource_id);
            const have = inventoryQty(inventory, inp.resource_id);
            const short = have < inp.qty;
            return (
              <span key={inp.resource_id} style={{ marginRight: 12, color: short ? "var(--accent-no-1, #f87171)" : "inherit" }}>
                {inp.qty} × {spec?.emoji ?? ""} {spec?.name ?? inp.resource_id} <span style={{ opacity: 0.6 }}>({have} on hand)</span>
              </span>
            );
          })}
          <span> · {recipe.gold_cost}g</span>
          <span> · lvl {recipe.level_req}+</span>
        </div>
      </div>
      <button
        type="button"
        disabled={!canCraft || busy}
        onClick={handle}
        style={actionBtnStyle(canCraft)}
      >
        {busy ? "…" : !meetsLevel ? `Lvl ${recipe.level_req}` : !hasInputs ? "Need inputs" : !affordable ? "Need gold" : station === "smithy" ? "Forge" : "Brew"}
      </button>
    </div>
  );
}

function ReinforceRow({
  item, ores, onAfterAction,
}: {
  item: Item;
  ores: Array<{ spec: ResourceSpec; qty: number }>;
  onAfterAction: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string>(ores[0]?.spec.id ?? "");
  const hasAny = ores.length > 0;

  async function handle() {
    if (!picked) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/smithy/reinforce/${item.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ resource_id: picked }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        toast.error(`Couldn't reinforce: ${body.error ?? res.statusText}`);
        return;
      }
      toast.success(`Reinforced ${item.item_name} (+1 power)`);
      await onAfterAction();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{item.item_name}</div>
        <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>
          Power {item.power} · Sharpens {item.sharpens_count}/6
        </div>
      </div>
      <select
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
        disabled={!hasAny || busy}
        style={{
          background: "var(--bg-card-2)",
          color: "var(--fg-1)",
          border: "1px solid var(--border-base)",
          borderRadius: "var(--radius-md)",
          padding: "4px 8px",
          fontFamily: "inherit",
        }}
      >
        {!hasAny && <option value="">No ore</option>}
        {ores.map((o) => (
          <option key={o.spec.id} value={o.spec.id}>
            {o.spec.emoji} {o.spec.name} ({o.qty})
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!hasAny || busy}
        onClick={handle}
        style={actionBtnStyle(hasAny)}
      >
        {busy ? "…" : "Reinforce"}
      </button>
    </div>
  );
}

function ConcentrateRow({
  item, herbs, onAfterAction,
}: {
  item: Item;
  herbs: Array<{ spec: ResourceSpec; qty: number }>;
  onAfterAction: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string>(herbs[0]?.spec.id ?? "");
  const hasAny = herbs.length > 0;
  const stacks = item.potency_stacks ?? 0;

  async function handle() {
    if (!picked) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/apothecary/concentrate/${item.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ resource_id: picked }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        toast.error(`Couldn't concentrate: ${body.error ?? res.statusText}`);
        return;
      }
      toast.success(`Concentrated ${item.item_name}`);
      await onAfterAction();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{item.item_name}</div>
        <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>
          Potency stacks {stacks}/2 · power {item.power}
        </div>
      </div>
      <select
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
        disabled={!hasAny || busy}
        style={{
          background: "var(--bg-card-2)",
          color: "var(--fg-1)",
          border: "1px solid var(--border-base)",
          borderRadius: "var(--radius-md)",
          padding: "4px 8px",
          fontFamily: "inherit",
        }}
      >
        {!hasAny && <option value="">No herbs</option>}
        {herbs.map((h) => (
          <option key={h.spec.id} value={h.spec.id}>
            {h.spec.emoji} {h.spec.name} ({h.qty})
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!hasAny || busy}
        onClick={handle}
        style={actionBtnStyle(hasAny)}
      >
        {busy ? "…" : "Concentrate"}
      </button>
    </div>
  );
}

// =========================================================================
// Helpers
// =========================================================================

function inventoryQty(inventory: Item[], resourceId: string): number {
  const spec = findResource(resourceId);
  if (!spec) return 0;
  const fullName = `${spec.emoji} ${spec.name}`;
  return inventory
    .filter((it) => it.item_type === "resource" && it.item_name === fullName)
    .reduce((sum, it) => sum + (it.qty ?? 1), 0);
}

function filterResources(inventory: Item[], node: "mine" | "forage" | "fish"): Array<{ spec: ResourceSpec; qty: number }> {
  return RESOURCE_CATALOG
    .filter((s) => s.node === node)
    .map((spec) => ({ spec, qty: inventoryQty(inventory, spec.id) }))
    .filter((entry) => entry.qty > 0);
}

function SectionTitle({ icon, title }: { icon: string; title: string }) {
  return (
    <h2 style={{ ...h2, display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <Icon name={icon} size={20} /> {title}
    </h2>
  );
}

function SubHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 18, marginBottom: 8,
      font: "11px/1 var(--font-display)",
      textTransform: "uppercase",
      letterSpacing: 1.5,
      color: "var(--fg-mute)",
    }}>
      {children}
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-base)",
  background: "var(--bg-card-2)",
};

function actionBtnStyle(enabled: boolean): CSSProperties {
  return {
    padding: "6px 14px",
    border: "1px solid var(--border-base)",
    borderRadius: "var(--radius-md)",
    background: enabled ? "var(--accent-ink-blue-2)" : "var(--bg-card)",
    color: enabled ? "#fff" : "var(--fg-mute)",
    cursor: enabled ? "pointer" : "not-allowed",
    fontFamily: "inherit",
    fontWeight: 600,
  };
}
