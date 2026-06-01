// Pub Cooking — bartender turns raw fish into cooked food consumables.
//
// Sits alongside PubCard and PubErrands inside the pub modal. Each recipe
// row shows raw fish (salmon icon for common/uncommon, eel for the rare
// abyss stew), gold cost, and the cooked output (fish-cooked icon). Disabled
// if the player lacks the fish or gold, or if their level is too low.
//
// Backend: POST /api/pub/cook/:recipeId consumes 1 fish + gold and grants
// a consumable food item. Food heals HP through the same path as Health
// Potions on use.

import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import type { CSSProperties } from "react";

import { Icon } from "../icons";
import { COOK_RECIPES, RESOURCE_CATALOG, findResource, type CookRecipeSpec, type ResourceSpec } from "@gantt-quest/core";
import type { Item } from "../types";
import { h2, muted } from "../styles";

interface PubCookingProps {
  characterLevel: number;
  gold: number;
  inventory: Item[];
  onAfterCook: () => void | Promise<void>;
}

export function PubCooking({ characterLevel, gold, inventory, onAfterCook }: PubCookingProps) {
  const fishStock = useMemo(() => {
    return RESOURCE_CATALOG
      .filter((s) => s.node === "fish")
      .map((spec) => {
        const fullName = `${spec.emoji} ${spec.name}`;
        const qty = inventory
          .filter((it) => it.item_type === "resource" && it.item_name === fullName)
          .reduce((sum, it) => sum + (it.qty ?? 1), 0);
        return { spec, qty };
      });
  }, [inventory]);

  return (
    <div>
      <StockpileMini label="Fish stockpile" resources={fishStock} />
      <h2 style={{ ...h2, display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <Icon name="fish-cooked" size={20} /> Cooking
      </h2>
      <p style={muted}>
        <em>"Hand over a fish, I'll hand back a plate. Coin covers the salt."</em>
      </p>
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        {COOK_RECIPES.map((recipe) => (
          <RecipeRow
            key={recipe.id}
            recipe={recipe}
            characterLevel={characterLevel}
            gold={gold}
            inventory={inventory}
            onAfterCook={onAfterCook}
          />
        ))}
      </div>
    </div>
  );
}

function RecipeRow({
  recipe, characterLevel, gold, inventory, onAfterCook,
}: {
  recipe: CookRecipeSpec;
  characterLevel: number;
  gold: number;
  inventory: Item[];
  onAfterCook: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  // Per-input availability check. Combo dishes (multi-input) show every
  // ingredient pill below the recipe name; any single missing input
  // disables the Cook button.
  const inputs = recipe.inputs.map((inp) => {
    const spec = findResource(inp.resource_id);
    const name = spec ? `${spec.emoji} ${spec.name}` : inp.resource_id;
    const onHand = inventory
      .filter((it) => it.item_type === "resource" && it.item_name === name)
      .reduce((sum, it) => sum + (it.qty ?? 1), 0);
    return { inp, spec, name, onHand, has: onHand >= inp.qty };
  });
  const meetsLevel = characterLevel >= recipe.level_req;
  const hasAllInputs = inputs.every((i) => i.has);
  const canAfford = gold >= recipe.gold_cost;
  const canCook = meetsLevel && hasAllInputs && canAfford;
  // Headline raw-fish icon: pick the highest-tier input present in the
  // recipe so combos read at a glance (eel > silverfin > carp).
  const headlineRawIcon = inputs.some((i) => i.inp.resource_id === "abyss_eel")
    ? "eel"
    : "salmon";

  async function handle() {
    setBusy(true);
    try {
      const res = await fetch(`/api/pub/cook/${recipe.id}`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        toast.error(`Couldn't cook: ${body.error ?? res.statusText}`);
        return;
      }
      toast.success(`Cooked ${recipe.output_name}`);
      await onAfterCook();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={rowStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Icon name={headlineRawIcon} size={22} color="var(--fg-mute)" />
        <Icon name="cycle" size={10} color="var(--fg-mute)" />
        <Icon name="fish-cooked" size={22} color="var(--fg-1)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{recipe.output_name}</div>
        <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>{recipe.output_blurb}</div>
        <div style={{ fontSize: 11, color: "var(--fg-mute)", marginTop: 4, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          {inputs.map((i, ix) => {
            const inputRawIcon = i.inp.resource_id === "abyss_eel" ? "eel" : "salmon";
            return (
              <span
                key={i.inp.resource_id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  color: i.has ? "inherit" : "var(--tone-bad-2, #f87171)",
                }}
              >
                {ix > 0 && <span style={{ opacity: 0.5 }}>+</span>}
                {i.inp.qty} ×
                <Icon name={inputRawIcon} size={12} color={i.has ? "var(--fg-mute)" : "var(--tone-bad-2, #f87171)"} />
                {i.spec?.name ?? i.inp.resource_id}
                <span style={{ opacity: 0.6 }}>({i.onHand})</span>
              </span>
            );
          })}
          <span>· {recipe.gold_cost}g</span>
          <span>· lvl {recipe.level_req}+</span>
        </div>
      </div>
      <button
        type="button"
        disabled={!canCook || busy}
        onClick={handle}
        style={actionBtn(canCook)}
      >
        {busy ? "…" : !meetsLevel ? `Lvl ${recipe.level_req}` : !hasAllInputs ? "Need fish" : !canAfford ? "Need gold" : "Cook"}
      </button>
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "10px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-base)",
  background: "var(--bg-card-2)",
  backdropFilter: "blur(10px) saturate(1.05)",
  WebkitBackdropFilter: "blur(10px) saturate(1.05)",
};

function actionBtn(enabled: boolean): CSSProperties {
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

function StockpileMini({ label, resources }: { label: string; resources: Array<{ spec: ResourceSpec; qty: number }> }) {
  return (
    <div style={{ marginBottom: 16, padding: "10px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--border-faint, rgba(255,255,255,0.06))", background: "var(--bg-card-2)", backdropFilter: "blur(10px) saturate(1.05)", WebkitBackdropFilter: "blur(10px) saturate(1.05)" }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2, color: "var(--fg-mute)", marginBottom: 8, fontFamily: "var(--font-display)" }}>
        <Icon name="wooden-crate" size={11} /> {label}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {resources.map((r) => (
          <div key={r.spec.id} style={{
            display: "flex", alignItems: "center", gap: 5, padding: "4px 10px",
            borderRadius: "var(--radius-sm)", border: "1px solid var(--border-base)",
            background: r.qty > 0 ? "var(--bg-card)" : "transparent",
            opacity: r.qty === 0 ? 0.45 : 1,
          }}>
            <Icon name={r.spec.icon} size={14} color="var(--fg-2)" />
            <span style={{ fontSize: 12 }}>{r.spec.name}</span>
            <span style={{ fontWeight: 700, fontSize: 13, color: r.qty > 0 ? "var(--fg-1)" : "var(--fg-mute)", marginLeft: 2 }}>{r.qty}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
