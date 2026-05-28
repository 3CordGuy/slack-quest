import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import type { Character } from "../types";
import { Icon } from "../icons";
import { smallActionBtn } from "../styles";

// DEV ONLY — shown from AccountPopover in local env (import.meta.env.DEV).
export function DevToolsModal({
  character,
  onClose,
  onRefresh,
}: {
  character: Character;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [goldAmount, setGoldAmount] = useState("1000");
  const [levelAmount, setLevelAmount] = useState(String(character.level));
  const [busy, setBusy] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [itemType, setItemType] = useState("weapon");
  const [itemName, setItemName] = useState("Dev Sword");
  const [itemPower, setItemPower] = useState("15");
  const [itemRarity, setItemRarity] = useState("rare");
  const [itemRange, setItemRange] = useState("melee");
  const [itemSlot, setItemSlot] = useState("main_hand");
  const [itemElement, setItemElement] = useState("");
  const [statBonuses, setStatBonuses] = useState({ str: "", int_stat: "", vit: "", agi: "", dex: "" });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  async function devAction(endpoint: string, body?: object) {
    setBusy(endpoint);
    setLastAction(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) {
        await onRefresh();
        setLastAction("Done!");
      } else {
        const err = await res.json().catch(() => ({})) as { error?: string };
        setLastAction(`Error: ${err.error ?? res.status}`);
      }
    } catch {
      setLastAction("Network error");
    } finally {
      setBusy(null);
    }
  }

  const isDowned = character.downed_until != null && character.downed_until > Date.now();
  const isFullHp = character.hp >= character.max_hp;
  const isFullMana = character.mana >= character.max_mana;
  const targetLevel = Math.floor(Number(levelAmount));
  const levelValid = Number.isFinite(targetLevel) && targetLevel >= 1 && targetLevel <= 99 && targetLevel !== character.level;

  const devBtn = (bg: string, fg: string, disabled = false): CSSProperties => ({
    ...smallActionBtn(disabled ? "#1a1c20" : bg, disabled ? "#4b5563" : fg),
    padding: "6px 14px",
    fontSize: 13,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "default" : "pointer",
  });
  const inputStyle: CSSProperties = {
    background: "#1a1c20", border: "1px solid #2a2d33", borderRadius: 6,
    color: "#e5e7eb", padding: "5px 10px", fontSize: 13, width: 90,
    fontFamily: "inherit",
  };
  const selectStyle: CSSProperties = {
    ...inputStyle, width: "auto", cursor: "pointer",
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#13151a",
          border: "1px solid #2a2d33",
          borderRadius: 12,
          padding: 24,
          width: "100%",
          maxWidth: 520,
          boxShadow: "0 10px 40px rgba(0,0,0,0.7)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="cog" size={16} color="#a78bfa" />
            <span style={{ fontSize: 16, fontWeight: 700, color: "#a78bfa" }}>Dev Tools</span>
          </div>
          <button onClick={onClose} style={{ ...smallActionBtn("#1a1c20", "#6b7280"), padding: "2px 8px" }}>✕</button>
        </div>

        {/* Status */}
        <div style={{ background: "#1a1c20", borderRadius: 8, padding: "10px 14px", display: "flex", gap: 20, fontSize: 13 }}>
          <span><span style={{ color: "#6b7280" }}>Lv </span><span style={{ color: "#e5e7eb", fontWeight: 600 }}>{character.level}</span></span>
          <span><span style={{ color: "#6b7280" }}>HP </span><span style={{ color: "#f87171", fontWeight: 600 }}>{character.hp}/{character.max_hp}</span></span>
          <span><span style={{ color: "#6b7280" }}>MP </span><span style={{ color: "#60a5fa", fontWeight: 600 }}>{character.mana}/{character.max_mana}</span></span>
          <span><span style={{ color: "#6b7280" }}>Gold </span><span style={{ color: "#fbbf24", fontWeight: 600 }}>{character.gold}g</span></span>
          {isDowned && <span style={{ color: "#fca5a5", fontWeight: 600 }}>DOWNED</span>}
        </div>

        {/* Restore row */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            disabled={!!busy || isFullHp}
            onClick={() => void devAction("/api/dev/heal")}
            style={devBtn("#1f3a1f", "#86efac", isFullHp)}
          >
            {busy === "/api/dev/heal" ? "…" : <><Icon name="health" size={13} /> Heal to full</>}
          </button>
          <button
            disabled={!!busy || isFullMana}
            onClick={() => void devAction("/api/dev/mana")}
            style={devBtn("#1a2a3a", "#60a5fa", isFullMana)}
          >
            {busy === "/api/dev/mana" ? "…" : <><Icon name="crystals" size={13} /> Restore mana</>}
          </button>
          <button
            disabled={!!busy || !isDowned}
            onClick={() => void devAction("/api/dev/revive")}
            style={devBtn("#2a0a0a", "#fca5a5", !isDowned)}
          >
            {busy === "/api/dev/revive" ? "…" : <><Icon name="aura" size={13} /> Revive</>}
          </button>
        </div>

        {/* Gold row */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="number"
            min={1}
            max={1000000}
            value={goldAmount}
            onChange={(e) => setGoldAmount(e.target.value)}
            style={{ ...inputStyle, color: "#fbbf24" }}
          />
          <button
            disabled={!!busy || !Number.isFinite(Number(goldAmount)) || Number(goldAmount) <= 0}
            onClick={() => void devAction("/api/dev/gold", { amount: Number(goldAmount) })}
            style={devBtn("#2a1f0a", "#fbbf24")}
          >
            {busy === "/api/dev/gold" ? "…" : <><Icon name="gold-bar" size={13} /> Give gold</>}
          </button>
        </div>

        {/* Level row */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="number"
            min={1}
            max={99}
            value={levelAmount}
            onChange={(e) => setLevelAmount(e.target.value)}
            style={inputStyle}
          />
          <button
            disabled={!!busy || !levelValid}
            onClick={() => void devAction("/api/dev/level", { level: targetLevel })}
            style={devBtn("#1a1a2e", "#a78bfa", !levelValid)}
            title={targetLevel < character.level ? "Down-leveling resets stat allocation to the class baseline and restores all free points for that level" : undefined}
          >
            {busy === "/api/dev/level" ? "…" : <><Icon name="level-three-advanced" size={13} /> Set level</>}
          </button>
        </div>

        {/* Cooldowns */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            disabled={!!busy}
            onClick={() => void devAction("/api/dev/cooldowns")}
            style={devBtn("#1a1a2a", "#c4b5fd")}
            title="Resets all time-based cooldowns in the app (e.g. shop, rests)"
          >
            {busy === "/api/dev/cooldowns" ? "…" : <><Icon name="clockwork" size={13} /> Reset cooldowns</>}
          </button>
        </div>

        {/* Give item */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Give Item</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select
              value={itemType}
              onChange={(e) => {
                const t = e.target.value;
                setItemType(t);
                setItemSlot(t === "armor" ? "body" : "main_hand");
              }}
              style={selectStyle}
            >
              <option value="weapon">Weapon</option>
              <option value="armor">Armor</option>
              <option value="consumable">Consumable</option>
              <option value="magic">Magic</option>
              <option value="revive">Revive</option>
              <option value="tool">Tool</option>
              <option value="scroll">Scroll</option>
            </select>
            <input
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              placeholder="Item name"
              style={{ ...inputStyle, width: 150 }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="number"
              min={0}
              max={999}
              value={itemPower}
              onChange={(e) => setItemPower(e.target.value)}
              style={inputStyle}
              placeholder="Power"
            />
            <select value={itemRarity} onChange={(e) => setItemRarity(e.target.value)} style={selectStyle}>
              <option value="common">Common</option>
              <option value="uncommon">Uncommon</option>
              <option value="rare">Rare</option>
              <option value="epic">Epic</option>
              <option value="legendary">Legendary</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {itemType === "weapon" && (
              <select value={itemRange} onChange={(e) => setItemRange(e.target.value)} style={selectStyle}>
                <option value="melee">Melee</option>
                <option value="ranged">Ranged</option>
                <option value="focus">Focus</option>
              </select>
            )}
            {(itemType === "weapon" || itemType === "armor") && (
              <select value={itemSlot} onChange={(e) => setItemSlot(e.target.value)} style={selectStyle}>
                {itemType === "weapon" ? (
                  <>
                    <option value="main_hand">Main hand</option>
                    <option value="off_hand">Off hand</option>
                  </>
                ) : (
                  <>
                    <option value="body">Body</option>
                    <option value="helmet">Helmet</option>
                    <option value="pants">Pants</option>
                    <option value="boots">Boots</option>
                    <option value="ring">Ring</option>
                    <option value="amulet">Amulet</option>
                    <option value="off_hand">Off hand</option>
                  </>
                )}
              </select>
            )}
            {(itemType === "weapon" || itemType === "armor") && (
              <select value={itemElement} onChange={(e) => setItemElement(e.target.value)} style={selectStyle}>
                <option value="">No element</option>
                <option value="fire">Fire</option>
                <option value="ice">Ice</option>
                <option value="lightning">Lightning</option>
              </select>
            )}
          </div>
          {itemType === "armor" && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "#6b7280", minWidth: 60 }}>Stat bonus</span>
              {(["str", "int_stat", "vit", "agi", "dex"] as const).map((stat) => (
                <label key={stat} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>{stat === "int_stat" ? "int" : stat}</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={statBonuses[stat]}
                    onChange={(e) => setStatBonuses((prev) => ({ ...prev, [stat]: e.target.value }))}
                    style={{ ...inputStyle, width: 44, padding: "4px 6px", textAlign: "center" }}
                    placeholder="0"
                  />
                </label>
              ))}
            </div>
          )}
          <div>
            <button
              disabled={!!busy || !itemName.trim() || !Number.isFinite(Number(itemPower)) || Number(itemPower) < 0}
              onClick={() => {
                const bonuses: Record<string, number> = {};
                if (itemType === "armor") {
                  for (const [k, v] of Object.entries(statBonuses)) {
                    const n = Math.floor(Number(v));
                    if (Number.isFinite(n) && n > 0) bonuses[k] = n;
                  }
                }
                void devAction("/api/dev/item", {
                  type: itemType,
                  name: itemName.trim(),
                  power: Math.floor(Number(itemPower)),
                  rarity: itemRarity,
                  weapon_range: itemType === "weapon" ? itemRange : undefined,
                  slot: (itemType === "weapon" || itemType === "armor") ? itemSlot : undefined,
                  element: itemElement || undefined,
                  stat_bonus: Object.keys(bonuses).length > 0 ? bonuses : undefined,
                });
              }}
              style={devBtn("#0f1e2e", "#7dd3fc")}
            >
              {busy === "/api/dev/item" ? "…" : <><Icon name="chest" size={13} /> Give item</>}
            </button>
          </div>
        </div>

        {lastAction && (
          <div style={{ fontSize: 12, color: lastAction.startsWith("Error") ? "#fca5a5" : "#86efac", textAlign: "center" }}>
            {lastAction}
          </div>
        )}
      </div>
    </div>
  );
}
