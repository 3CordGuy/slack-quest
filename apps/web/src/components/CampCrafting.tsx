// Smithy Forge + Reinforce, Apothecary Brew + Concentrate. Surfaces v1 crafting
// hooks alongside the existing SmithyCard/ApothecaryCard inside their town
// modals. Reads inventory client-side so we don't need a new fetch — the
// existing /api/inventory already returns qty + potency_stacks.

import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import type { CSSProperties } from "react";

import { RECIPE_CATALOG, RESOURCE_CATALOG, TRANSMUTE_CATALOG, findResource, smithyEffectivePower, type RecipeSpec, type ResourceSpec, type TransmuteSpec } from "@gantt-quest/core";

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
  const allOres = useMemo(() => allResources(props.inventory, "mine"), [props.inventory]);
  // Reinforce candidates: equipped weapon/armor at sharpens >= 3 and < 6.
  const reinforceCandidates = useMemo(() => props.inventory.filter((it) =>
    (it.item_type === "weapon" || it.item_type === "armor")
    && it.equipped
    && it.sharpens_count >= 3
    && it.sharpens_count < 6,
  ), [props.inventory]);

  return (
    <div style={card}>
      <StockpileMini label="Ore stockpile" resources={allOres} />
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

      <SubHeader>Transmute <span style={{ color: "var(--fg-mute)", fontWeight: 400 }}>(upgrade ore tiers)</span></SubHeader>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {TRANSMUTE_CATALOG.filter((t) => t.station === "smithy").map((t) => (
          <TransmuteRow
            key={t.id}
            spec={t}
            characterLevel={props.characterLevel}
            gold={props.gold}
            inventory={props.inventory}
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
  const allHerbs = useMemo(() => allResources(props.inventory, "forage"), [props.inventory]);
  const concentrateCandidates = useMemo(() => props.inventory.filter((it) =>
    (it.item_type === "consumable" || it.item_type === "tool")
    && (it.potency_stacks ?? 0) < 2,
  ), [props.inventory]);

  return (
    <div style={card}>
      <StockpileMini label="Herb stockpile" resources={allHerbs} />
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

      <SubHeader>Distil <span style={{ color: "var(--fg-mute)", fontWeight: 400 }}>(upgrade herb tiers)</span></SubHeader>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {TRANSMUTE_CATALOG.filter((t) => t.station === "apothecary").map((t) => (
          <TransmuteRow
            key={t.id}
            spec={t}
            characterLevel={props.characterLevel}
            gold={props.gold}
            inventory={props.inventory}
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

  const equippedInSlot = station === "smithy" && recipe.output_slot
    ? inventory.find((it) => it.equipped && it.slot === recipe.output_slot) ?? null
    : null;

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
                {inp.qty} × <span style={{ display: "inline-flex", alignItems: "center", gap: 3, verticalAlign: "middle" }}><Icon name={spec?.icon ?? "abstract-006"} size={12} color="var(--fg-mute)" /> {spec?.name ?? inp.resource_id}</span> <span style={{ opacity: 0.6 }}>({have} on hand)</span>
              </span>
            );
          })}
          <span> · {recipe.gold_cost}g</span>
          <span> · lvl {recipe.level_req}+</span>
          {station === "smithy" && recipe.output_type !== "consumable" && (() => {
            const effectivePwr = smithyEffectivePower(recipe, characterLevel);
            const delta = equippedInSlot ? effectivePwr - equippedInSlot.power : null;
            return (
              <>
                <span style={{ color: "var(--accent-gold, #f59e0b)" }}>
                  {" · pwr "}{effectivePwr}
                  {characterLevel > recipe.level_req && (
                    <span style={{ opacity: 0.6 }}> (scales ↑)</span>
                  )}
                </span>
                {equippedInSlot && delta !== null && (
                  <span style={{
                    color: delta > 0 ? "var(--accent-yes-1, #4ade80)" : delta < 0 ? "var(--accent-no-1, #f87171)" : "var(--fg-mute)",
                  }}>
                    {" · "}
                    {delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "="} vs {equippedInSlot.item_name} (pwr {equippedInSlot.power})
                  </span>
                )}
                {!equippedInSlot && recipe.output_slot && (
                  <span style={{ opacity: 0.5 }}>{" · nothing equipped in slot"}</span>
                )}
              </>
            );
          })()}
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

function TransmuteRow({
  spec, characterLevel, gold, inventory, onAfterAction,
}: {
  spec: TransmuteSpec;
  characterLevel: number;
  gold: number;
  inventory: Item[];
  onAfterAction: () => void | Promise<void>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const meetsLevel = characterLevel >= spec.level_req;
  const affordable = gold >= spec.gold_cost;
  const missingInputs = spec.inputs.filter((inp) => inventoryQty(inventory, inp.resource_id) < inp.qty);
  const hasInputs = missingInputs.length === 0;
  const canTransmute = meetsLevel && affordable && hasInputs;
  const outSpec = findResource(spec.output_resource_id);

  return (
    <>
      <div style={rowStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{spec.label}</div>
          <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>{spec.blurb}</div>
          <div style={{ fontSize: 11, color: "var(--fg-mute)", marginTop: 4 }}>
            {spec.inputs.map((inp) => {
              const s = findResource(inp.resource_id);
              const have = inventoryQty(inventory, inp.resource_id);
              const short = have < inp.qty;
              return (
                <span key={inp.resource_id} style={{ marginRight: 12, color: short ? "var(--accent-no-1, #f87171)" : "inherit" }}>
                  {inp.qty} × <span style={{ display: "inline-flex", alignItems: "center", gap: 3, verticalAlign: "middle" }}>
                    <Icon name={s?.icon ?? "abstract-006"} size={12} color="var(--fg-mute)" /> {s?.name ?? inp.resource_id}
                  </span> <span style={{ opacity: 0.6 }}>({have} on hand)</span>
                </span>
              );
            })}
            <span> · {spec.gold_cost}g</span>
            <span> · lvl {spec.level_req}+</span>
            {outSpec && (
              <span style={{ color: "var(--accent-gold, #f59e0b)" }}>
                {" → "}<Icon name={outSpec.icon} size={12} color="var(--accent-gold, #f59e0b)" style={{ verticalAlign: "middle" }} /> {outSpec.name}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={!canTransmute}
          onClick={() => setModalOpen(true)}
          style={actionBtnStyle(canTransmute)}
        >
          {!meetsLevel ? `Lvl ${spec.level_req}` : !hasInputs ? "Need inputs" : !affordable ? "Need gold" : spec.station === "smithy" ? "Transmute" : "Distil"}
        </button>
      </div>
      {modalOpen && (
        <TransmuteModal
          spec={spec}
          gold={gold}
          inventory={inventory}
          onClose={() => setModalOpen(false)}
          onAfterAction={onAfterAction}
        />
      )}
    </>
  );
}

// Multi-batch transmute UX. Shows the recipe's inputs and output as large
// SVG icons with stat-style quantity numbers, separated by a big arrow,
// and a +/- counter clamped to what the player's inventory + gold can
// actually pay for. Submits a single POST with `{count}` so the server
// scales the transaction atomically.
function TransmuteModal({
  spec, gold, inventory, onClose, onAfterAction,
}: {
  spec: TransmuteSpec;
  gold: number;
  inventory: Item[];
  onClose: () => void;
  onAfterAction: () => void | Promise<void>;
}) {
  const outSpec = findResource(spec.output_resource_id);
  const verb = spec.station === "smithy" ? "Transmute" : "Distil";
  const verbPast = spec.station === "smithy" ? "Transmuted" : "Distilled";
  // Cap = the most batches the player could afford right now. The min of
  // (gold / gold_cost) and floor(have / qty) across every input — anything
  // beyond this is disallowed before the request leaves the client.
  const inputAvailability = spec.inputs.map((inp) => {
    const have = inventoryQty(inventory, inp.resource_id);
    const maxByInput = Math.floor(have / inp.qty);
    return { input: inp, have, maxByInput, spec: findResource(inp.resource_id) };
  });
  const maxByInputs = inputAvailability.reduce((m, a) => Math.min(m, a.maxByInput), Number.POSITIVE_INFINITY);
  const maxByGold = spec.gold_cost > 0 ? Math.floor(gold / spec.gold_cost) : Number.POSITIVE_INFINITY;
  const maxCount = Math.max(1, Math.min(maxByInputs, maxByGold, 999));
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const clamped = Math.max(1, Math.min(maxCount, count));
  const totalGold = spec.gold_cost * clamped;

  async function submit() {
    setBusy(true);
    const endpoint = spec.station === "smithy"
      ? `/api/smithy/transmute/${spec.id}`
      : `/api/apothecary/transmute/${spec.id}`;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: clamped }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        toast.error(`${verb} failed: ${body.error ?? res.statusText}`);
        return;
      }
      const outName = outSpec ? `${outSpec.emoji} ${outSpec.name}` : spec.output_resource_id;
      toast.success(`${verbPast} ×${clamped} → ${outName}`);
      onClose();
      await onAfterAction();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card-1, #1a1c20)",
          border: "1px solid var(--border-base, #2a2d33)",
          borderRadius: 14,
          padding: 24,
          maxWidth: 480,
          width: "100%",
          boxShadow: "0 12px 48px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700 }}>{spec.label}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--fg-mute)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-mute)", marginBottom: 18 }}>{spec.blurb}</div>

        {/* Big From → To visual with stat numbers */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
          padding: "18px 8px",
          background: "var(--bg-card-2, rgba(255,255,255,0.03))",
          border: "1px solid var(--border-faint, rgba(255,255,255,0.06))",
          borderRadius: 12, marginBottom: 16,
        }}>
          <div style={{ display: "flex", gap: 8, flex: 1, justifyContent: "center", flexWrap: "wrap" }}>
            {inputAvailability.map((a, i) => (
              <div key={a.input.resource_id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <Icon name={a.spec?.icon ?? "abstract-006"} size={56} color="var(--fg-2, #cbd5e1)" />
                <div style={{
                  fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700,
                  fontFeatureSettings: '"tnum" 1, "lnum" 1',
                  color: "var(--fg-1)", lineHeight: 1,
                }}>
                  {a.input.qty * clamped}
                </div>
                <div style={{ fontSize: 10, color: "var(--fg-mute)", textTransform: "uppercase", letterSpacing: 1 }}>
                  of {a.have}
                </div>
                {i < inputAvailability.length - 1 && (
                  <div style={{ position: "absolute", marginTop: 28, fontSize: 18, color: "var(--fg-mute)" }}>+</div>
                )}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 24, color: "var(--fg-mute)", padding: "0 4px" }}>→</div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: 1 }}>
            <Icon name={outSpec?.icon ?? "abstract-006"} size={56} color="var(--accent-gold, #f59e0b)" />
            <div style={{
              fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700,
              fontFeatureSettings: '"tnum" 1, "lnum" 1',
              color: "var(--accent-gold, #f59e0b)", lineHeight: 1,
            }}>
              {clamped}
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-mute)", textTransform: "uppercase", letterSpacing: 1 }}>
              {outSpec?.name ?? "output"}
            </div>
          </div>
        </div>

        {/* +/- counter */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => setCount(Math.max(1, clamped - 1))}
            disabled={clamped <= 1 || busy}
            style={counterBtn(clamped > 1)}
            aria-label="Decrease"
          >
            −
          </button>
          <div style={{
            font: "700 30px/1 var(--font-display)",
            fontFeatureSettings: '"tnum" 1, "lnum" 1',
            minWidth: 70, textAlign: "center",
            color: "var(--fg-1)",
          }}>
            {clamped}
          </div>
          <button
            type="button"
            onClick={() => setCount(Math.min(maxCount, clamped + 1))}
            disabled={clamped >= maxCount || busy}
            style={counterBtn(clamped < maxCount)}
            aria-label="Increase"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setCount(maxCount)}
            disabled={clamped >= maxCount || busy}
            style={{
              marginLeft: 8, padding: "6px 12px",
              fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2,
              background: "transparent", color: "var(--fg-mute)",
              border: "1px solid var(--border-base)",
              borderRadius: 6, cursor: clamped < maxCount ? "pointer" : "not-allowed",
            }}
          >
            Max ({maxCount})
          </button>
        </div>

        {/* Cost */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "10px 12px", marginBottom: 16,
          background: "var(--bg-card-2, rgba(255,255,255,0.03))",
          border: "1px solid var(--border-faint, rgba(255,255,255,0.06))",
          borderRadius: 8, fontSize: 13,
        }}>
          <span style={{ color: "var(--fg-mute)" }}>Gold cost</span>
          <span>
            <strong style={{ color: "var(--accent-gold, #f59e0b)" }}>{totalGold}g</strong>
            <span style={{ color: "var(--fg-mute)", marginLeft: 6 }}>· {gold - totalGold}g remaining</span>
          </span>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: "10px 16px",
              background: "transparent", color: "var(--fg-2)",
              border: "1px solid var(--border-base)",
              borderRadius: 8, cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || clamped < 1}
            style={{
              padding: "10px 18px",
              background: busy ? "var(--bg-card-2)" : "var(--accent-gold, #f59e0b)",
              color: busy ? "var(--fg-mute)" : "#0b0d10",
              border: "1px solid var(--accent-gold, #f59e0b)",
              borderRadius: 8, cursor: busy ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            {busy ? "…" : `${verb} ×${clamped}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function counterBtn(enabled: boolean): CSSProperties {
  return {
    width: 44, height: 44,
    borderRadius: 22,
    background: enabled ? "var(--accent-gold, #f59e0b)" : "var(--bg-card-2, rgba(255,255,255,0.04))",
    color: enabled ? "#0b0d10" : "var(--fg-mute)",
    border: `1px solid ${enabled ? "var(--accent-gold, #f59e0b)" : "var(--border-base)"}`,
    fontSize: 22, fontWeight: 700, lineHeight: 1,
    cursor: enabled ? "pointer" : "not-allowed",
    display: "flex", alignItems: "center", justifyContent: "center",
  };
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
            {o.spec.name} ({o.qty})
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
            {h.spec.name} ({h.qty})
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

function allResources(inventory: Item[], node: "mine" | "forage" | "fish"): Array<{ spec: ResourceSpec; qty: number }> {
  return RESOURCE_CATALOG
    .filter((s) => s.node === node)
    .map((spec) => ({ spec, qty: inventoryQty(inventory, spec.id) }));
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
  // Frost the row so it stays legible when the location art shows through
  // the (now mostly-transparent) --bg-card-2 inside LocationModalWide.
  backdropFilter: "blur(10px) saturate(1.05)",
  WebkitBackdropFilter: "blur(10px) saturate(1.05)",
};

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
