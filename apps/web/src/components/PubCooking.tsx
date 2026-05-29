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

import { useState } from "react";
import toast from "react-hot-toast";
import type { CSSProperties } from "react";

import { Icon } from "../icons";
import { COOK_RECIPES, findResource, type CookRecipeSpec } from "@gantt-quest/core";
import type { Item } from "../types";
import { card, h2, muted } from "../styles";

interface PubCookingProps {
  characterLevel: number;
  gold: number;
  inventory: Item[];
  onAfterCook: () => void | Promise<void>;
}

export function PubCooking({ characterLevel, gold, inventory, onAfterCook }: PubCookingProps) {
  return (
    <div style={card}>
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
  const fishSpec = findResource(recipe.input_fish_id);
  const fishName = fishSpec ? `${fishSpec.emoji} ${fishSpec.name}` : recipe.input_fish_id;
  const onHand = inventory
    .filter((it) => it.item_type === "resource" && it.item_name === fishName)
    .reduce((sum, it) => sum + (it.qty ?? 1), 0);

  const meetsLevel = characterLevel >= recipe.level_req;
  const hasFish = onHand >= recipe.input_qty;
  const canAfford = gold >= recipe.gold_cost;
  const canCook = meetsLevel && hasFish && canAfford;
  // Abyss Stew earns the eel icon for the raw input; everything else uses
  // the generic raw-fish icon (salmon).
  const rawIcon = recipe.input_fish_id === "abyss_eel" ? "eel" : "salmon";

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
        <Icon name={rawIcon} size={22} color="var(--fg-mute)" />
        <Icon name="cycle" size={10} color="var(--fg-mute)" />
        <Icon name="fish-cooked" size={22} color="var(--fg-1)" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{recipe.output_name}</div>
        <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>{recipe.output_blurb}</div>
        <div style={{ fontSize: 11, color: "var(--fg-mute)", marginTop: 4 }}>
          <span style={{ color: hasFish ? "inherit" : "var(--accent-no-1, #f87171)" }}>
            {recipe.input_qty} × {fishSpec?.emoji ?? ""} {fishSpec?.name ?? recipe.input_fish_id}
            {" "}<span style={{ opacity: 0.6 }}>({onHand} on hand)</span>
          </span>
          <span> · {recipe.gold_cost}g</span>
          <span> · lvl {recipe.level_req}+</span>
        </div>
      </div>
      <button
        type="button"
        disabled={!canCook || busy}
        onClick={handle}
        style={actionBtn(canCook)}
      >
        {busy ? "…" : !meetsLevel ? `Lvl ${recipe.level_req}` : !hasFish ? "Need fish" : !canAfford ? "Need gold" : "Cook"}
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
