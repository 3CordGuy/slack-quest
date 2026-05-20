// Shared combat UI primitives — single source of truth for animations,
// HP bars, action buttons, dice, item pickers, combat log, and init strip.
// Both CombatPage (Outskirts / solo quests) and GridDungeonView (dungeon
// encounters) import from here so feature changes land in both at once.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isMonsterActor } from "@gantt-quest/core";
import { Icon } from "./icons";

export const DISPLAY_FONT = "'Metamorphous', serif";

// ─── Combat animation CSS ─────────────────────────────────────────────────────
// Call once at module init. Both consumers share the same <style> element.

export function ensureCombatAnimStyles(): void {
  if (typeof document === "undefined") return;
  const STYLE_ID = "gq-combat-anim-style";
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
@keyframes gq-shield-float {
  0%   { transform: translate(-50%, -50%) translateY(0px)   scale(1);   opacity: 0.85; }
  50%  { transform: translate(-50%, -50%) translateY(-6px)  scale(1.2); opacity: 1;    }
  100% { transform: translate(-50%, -50%) translateY(0px)   scale(1);   opacity: 0.85; }
}
@keyframes gq-shield-pulse {
  0%, 100% { box-shadow: 0 0 0 1px rgba(96,165,250,0.25), 0 0 8px rgba(96,165,250,0.12); }
  50%       { box-shadow: 0 0 0 2px rgba(96,165,250,0.55), 0 0 18px rgba(96,165,250,0.28); }
}
@keyframes gq-hit-shake {
  0%   { transform: translate(0, 0); }
  10%  { transform: translate(-5px, -2px); }
  20%  { transform: translate(5px, 2px); }
  30%  { transform: translate(-4px, 1px); }
  40%  { transform: translate(4px, -1px); }
  55%  { transform: translate(-2px, 0); }
  70%  { transform: translate(2px, 0); }
  100% { transform: translate(0, 0); }
}
@keyframes gq-hit-tint {
  0%   { box-shadow: inset 0 0 0 0 rgba(239,68,68,0); }
  20%  { box-shadow: inset 0 0 0 9999px rgba(239,68,68,0.45); }
  60%  { box-shadow: inset 0 0 0 9999px rgba(239,68,68,0.28); }
  100% { box-shadow: inset 0 0 0 0 rgba(239,68,68,0); }
}
.gq-hit-flash { animation: gq-hit-shake 550ms ease-in-out, gq-hit-tint 550ms ease-out; }
@keyframes gq-monster-lunge-card {
  0%   { transform: translateY(0); }
  35%  { transform: translateY(20px) scale(1.04); }
  60%  { transform: translateY(10px) scale(1.02); }
  100% { transform: translateY(0); }
}
.gq-monster-lunge-card { animation: gq-monster-lunge-card 520ms cubic-bezier(0.22, 1.4, 0.36, 1) both; }
@keyframes gq-slash-sweep {
  0%   { opacity: 0; transform: translate(-110%, -50%) rotate(-22deg) scaleX(0.6); }
  18%  { opacity: 1; }
  60%  { opacity: 0.9; transform: translate(110%, -50%) rotate(-22deg) scaleX(1.4); }
  100% { opacity: 0; transform: translate(130%, -50%) rotate(-22deg) scaleX(1.4); }
}
.gq-slash-streak {
  position: absolute; top: 50%; left: 0; width: 70%; height: 6px;
  background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.9) 30%, rgba(254,202,202,1) 50%, rgba(255,255,255,0.9) 70%, transparent 100%);
  filter: drop-shadow(0 0 8px rgba(252,165,165,0.9)) drop-shadow(0 0 14px rgba(239,68,68,0.55));
  pointer-events: none; transform-origin: 50% 50%;
  animation: gq-slash-sweep 420ms ease-out forwards; border-radius: 6px;
}
@keyframes gq-monster-defeated-card {
  0%   { transform: rotateX(0deg) scale(1) translateY(0); opacity: 1; filter: brightness(1) saturate(1); }
  25%  { transform: rotateX(-12deg) scale(1.03) translateY(0); opacity: 1; filter: brightness(1.35) saturate(1.4); }
  70%  { transform: rotateX(-65deg) scale(0.92) translateY(40px); opacity: 0.55; filter: brightness(0.6) saturate(0.4); }
  100% { transform: rotateX(-85deg) scale(0.78) translateY(55px); opacity: 0; filter: brightness(0.2) saturate(0); }
}
.gq-monster-defeated-card {
  animation: gq-monster-defeated-card 1100ms cubic-bezier(0.45, 0, 0.65, 1) forwards;
  transform-style: preserve-3d; perspective: 600px;
}
@keyframes gq-target-pulse {
  0%, 100% { box-shadow: 0 0 16px rgba(251,191,36,0.4), inset 0 0 0 0 rgba(251,191,36,0); }
  50%      { box-shadow: 0 0 22px rgba(251,191,36,0.55), inset 0 0 12px 0 rgba(251,191,36,0.15); }
}
.gq-monster-targeted { animation: gq-target-pulse 1800ms ease-in-out infinite; }
`;
  document.head.appendChild(s);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function useIsMobile(breakpoint = 540): boolean {
  const [v, setV] = useState(() => typeof window !== "undefined" && window.innerWidth < breakpoint);
  useEffect(() => {
    const h = () => setV(window.innerWidth < breakpoint);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, [breakpoint]);
  return v;
}

const CLASS_PORTRAIT_BASE = "/img/art/views/v6";
const CLASS_ID_BY_NAME: Record<string, string> = {
  "DevOps Mage":    "devops_mage",
  "QA Paladin":     "qa_paladin",
  "Backend Druid":  "backend_druid",
  "Frontend Bard":  "frontend_bard",
  "Staff Sage":     "staff_sage",
  "Refactor Rogue": "refactor_rogue",
  "SRE Warden":     "sre_warden",
  "Data Warlock":   "data_warlock",
};

export function slugifyName(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "unnamed";
}

const CHAR_ART_VERSION = "v3";

export function classPortraitUrl(className: string): string | null {
  const id = CLASS_ID_BY_NAME[className];
  return id ? `${CLASS_PORTRAIT_BASE}/class_${id}.png` : null;
}

export function charPortraitUrl(name: string): string {
  return `/img/art/${CHAR_ART_VERSION}/character/${slugifyName(name)}.png`;
}

export function hpColor(current: number, max: number): string {
  const pct = max > 0 ? current / max : 1;
  return pct < 0.25 ? "#ef4444" : pct < 0.5 ? "#f59e0b" : "#22c55e";
}

// ─── HitDust ─────────────────────────────────────────────────────────────────
// Tiny cartoony dust-puff burst that fires at the center of its parent
// every time `seq` changes. Mount it inside any `position: relative`
// container (typically a fighter card) and bump `seq` on the WS-side
// monster_attack handler. 12 particles fly outward + drift up, slight
// size jitter, ~750ms.
//
// Using the Web Animations API instead of CSS keyframes so we don't have
// to thread CSS-variable-in-transform interpolation quirks (which bit
// the main particle system pre-rewrite).
//
// Parent must be `position: relative` for the inset:0 overlay to sit
// inside the card.

const DUST_COUNT = 14;

export function HitDust({ seq }: { seq: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Skip seq=0 so the initial mount doesn't fire a phantom puff before
    // the first hit ever lands.
    if (seq <= 0) return;
    const root = ref.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLSpanElement>("[data-gq-dust]"));
    for (const el of els) {
      const angleDeg = Math.random() * 360;
      const distance = 22 + Math.random() * 38;
      const rad = (angleDeg * Math.PI) / 180;
      const x = Math.cos(rad) * distance;
      // Bias upward so the puff drifts like settling dust.
      const y = Math.sin(rad) * distance - 18;
      const finalScale = 1.4 + Math.random() * 0.8;
      el.animate(
        [
          { transform: "translate(-50%, -50%) scale(0)", opacity: 0 },
          { transform: "translate(-50%, -50%) scale(1)", opacity: 0.85, offset: 0.12 },
          { transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${finalScale})`, opacity: 0 },
        ],
        {
          duration: 650 + Math.random() * 250,
          delay: Math.random() * 70,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "forwards",
        },
      );
    }
  }, [seq]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "visible",
        zIndex: 3,
      }}
    >
      {Array.from({ length: DUST_COUNT }, (_, i) => {
        // Two slightly-different dust tones so the cloud looks textured
        // rather than a uniform blob. Alternating to keep it deterministic
        // across re-renders.
        const isLight = i % 2 === 0;
        const color = isLight ? "#d4c8b0" : "#b3a487";
        return (
          <span
            key={i}
            data-gq-dust
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: color,
              boxShadow: `0 0 5px ${color}aa, 0 0 10px ${color}55`,
              transform: "translate(-50%, -50%) scale(0)",
              opacity: 0,
              willChange: "transform, opacity",
            }}
          />
        );
      })}
    </div>
  );
}

// ─── ShieldGlow ──────────────────────────────────────────────────────────────
// 8 blue orbiting dots rendered around the perimeter of a fighter card
// whenever shield > 0. Mount inside a `position: relative` container.

const SHIELD_PARTICLES: Array<{ top: string; left: string; delay: string }> = [
  { top: "10%",  left: "-4px",  delay: "0s"   },
  { top: "50%",  left: "-4px",  delay: "0.3s" },
  { top: "90%",  left: "8%",    delay: "0.6s" },
  { top: "100%", left: "35%",   delay: "0.9s" },
  { top: "100%", left: "65%",   delay: "1.2s" },
  { top: "90%",  left: "92%",   delay: "1.5s" },
  { top: "50%",  left: "100%",  delay: "1.8s" },
  { top: "10%",  left: "88%",   delay: "2.1s" },
];

export function ShieldGlow() {
  return (
    <>
      {SHIELD_PARTICLES.map((p, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            position: "absolute",
            top: p.top,
            left: p.left,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#93c5fd",
            boxShadow: "0 0 6px 2px rgba(147,197,253,0.9), 0 0 12px rgba(96,165,250,0.6)",
            pointerEvents: "none",
            animation: `gq-shield-float 2.4s ease-in-out ${p.delay} infinite`,
            zIndex: 2,
          }}
        />
      ))}
    </>
  );
}

// ─── ShieldBurst ─────────────────────────────────────────────────────────────
// Brief blue spark burst that fires when a shield_applied event lands.
// Same WAAPI pattern as HealBurst — mount inside `position: relative`,
// bump `seq` from the shield_applied handler.

const SHIELD_BURST_COUNT = 10;
const SHIELD_BURST_COLORS = ["#93c5fd", "#bfdbfe", "#60a5fa", "#ffffff", "#dbeafe"];

export function ShieldBurst({ seq }: { seq: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (seq <= 0) return;
    const root = ref.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLSpanElement>("[data-gq-shield-burst]"));
    for (const el of els) {
      const angleDeg = Math.random() * 360;
      const distance = 28 + Math.random() * 36;
      const rad = (angleDeg * Math.PI) / 180;
      const x = Math.cos(rad) * distance;
      const y = Math.sin(rad) * distance - 10;
      el.animate(
        [
          { transform: "translate(-50%, -50%) scale(0)", opacity: 0 },
          { transform: "translate(-50%, -50%) scale(1.4)", opacity: 1, offset: 0.15 },
          { transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(0.4)`, opacity: 0 },
        ],
        {
          duration: 550 + Math.random() * 200,
          delay: Math.random() * 60,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "forwards",
        },
      );
    }
  }, [seq]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible", zIndex: 3 }}
    >
      {Array.from({ length: SHIELD_BURST_COUNT }, (_, i) => (
        <span
          key={i}
          data-gq-shield-burst
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: SHIELD_BURST_COLORS[i % SHIELD_BURST_COLORS.length],
            boxShadow: `0 0 5px ${SHIELD_BURST_COLORS[i % SHIELD_BURST_COLORS.length]}cc`,
            transform: "translate(-50%, -50%) scale(0)",
            opacity: 0,
            willChange: "transform, opacity",
          }}
        />
      ))}
    </div>
  );
}

// ─── HealBurst ───────────────────────────────────────────────────────────────
// Heart particles that float upward from a fighter card on heal events.
// Same WAAPI pattern as HitDust — mount inside a `position: relative`
// container and bump `seq` from the heal_applied WS event handler.

const HEAL_COUNT = 8;
// ♥ as a text particle — rendered via a span with fontSize so it scales
// the same across DPRs without needing SVG or canvas.
const HEART_COLORS = ["#f472b6", "#fb7185", "#f9a8d4", "#4ade80", "#86efac"];

export function HealBurst({ seq }: { seq: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (seq <= 0) return;
    const root = ref.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLSpanElement>("[data-gq-heal]"));
    for (const el of els) {
      // Hearts fan upward with a slight horizontal scatter.
      const xJitter = (Math.random() - 0.5) * 50;
      const yTravel = -(45 + Math.random() * 40);
      el.animate(
        [
          { transform: `translate(-50%, -50%) translate(${xJitter * 0.2}px, 0px) scale(0)`, opacity: 0 },
          { transform: `translate(-50%, -50%) translate(${xJitter * 0.6}px, ${yTravel * 0.5}px) scale(1.3)`, opacity: 1, offset: 0.25 },
          { transform: `translate(-50%, -50%) translate(${xJitter}px, ${yTravel}px) scale(0.8)`, opacity: 0 },
        ],
        {
          duration: 700 + Math.random() * 300,
          delay: Math.random() * 120,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "forwards",
        },
      );
    }
  }, [seq]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "visible",
        zIndex: 3,
      }}
    >
      {Array.from({ length: HEAL_COUNT }, (_, i) => {
        const color = HEART_COLORS[i % HEART_COLORS.length];
        return (
          <span
            key={i}
            data-gq-heal
            style={{
              position: "absolute",
              left: `${20 + (i / HEAL_COUNT) * 60}%`,
              top: "50%",
              fontSize: 13 + (i % 3) * 3,
              lineHeight: 1,
              color,
              textShadow: `0 0 6px ${color}cc`,
              transform: "translate(-50%, -50%) scale(0)",
              opacity: 0,
              willChange: "transform, opacity",
              userSelect: "none",
            }}
          >
            ♥
          </span>
        );
      })}
    </div>
  );
}

export const TONE_COLOR: Record<string, string> = {
  info:   "#e6e6e6",
  good:   "#86efac",
  bad:    "#fca5a5",
  muted:  "#9aa0a6",
  flavor: "#f5d390",
};

export const RARITY_TINT: Record<string, string> = {
  common:    "#8a8f98",
  uncommon:  "#16a34a",
  rare:      "#3b82f6",
  epic:      "#a855f7",
  legendary: "#f59e0b",
};

export const MONSTER_TARGET_TOOLS = new Set([
  "Poison Vial", "Venom Vial", "Caffeine Bomb", "Hotfix Grenade", "Production Outage",
]);

export function lootIcon(opt: {
  item_type: string;
  slot?: string | null;
  weapon_range?: string | null;
  item_subtype?: string | null;
  item_name?: string | null;
  flavor?: string | null;
}): string {
  if (opt.slot && opt.slot !== "main_hand") {
    switch (opt.slot) {
      case "off_hand": return opt.item_subtype === "gloves" ? "gloves" : "round-shield";
      case "body":     return "chest-armor";
      case "helmet":   return "heavy-helm";
      case "pants":    return "armored-pants";
      case "boots":    return "boots";
      case "ring":     return "ring";
      case "amulet":   return "gem-chain";
    }
  }
  if (opt.item_type === "weapon") {
    // "gun" anywhere in flavor → blunderbuss (per-request override).
    // Keeps loot tiles consistent with the inventory itemIcon rules.
    const f = (opt.flavor ?? "").toLowerCase();
    const n = (opt.item_name ?? "").toLowerCase();
    if (/\bgun\b/.test(f) || /\bblunderbuss\b/.test(n) || /\bblunderbuss\b/.test(f)) return "blunderbuss";
    if (opt.weapon_range === "focus")  return "crystal-wand";
    if (opt.weapon_range === "ranged") return "crossbow";
    return "sword";
  }
  if (opt.item_type === "armor")      return "chest-armor";
  if (opt.item_type === "consumable") return "bubbling-potion";
  if (opt.item_type === "magic")      return "crystal-ball";
  if (opt.item_type === "revive")     return "crowned-heart";
  if (opt.item_type === "tool")       return "anvil";
  if (opt.item_type === "scroll")     return "scroll-unfurled";
  return "anvil";
}

// ─── CBtn ─────────────────────────────────────────────────────────────────────

export function CBtn({ label, icon, color, disabled, manaCost, onClick }: {
  label: string;
  icon?: string;
  color: string;
  disabled?: boolean;
  manaCost?: number;
  onClick: () => void;
}) {
  const compact = typeof window !== "undefined" && window.innerWidth < 540;
  const sz = compact ? 60 : 78;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={manaCost ? `${label} (costs ${manaCost} mana)` : label}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: compact ? 2 : 3,
        padding: compact ? "6px 4px" : "8px 6px", width: sz, height: sz,
        background: disabled ? "#1a1c21" : color,
        border: `2px solid ${disabled ? "#2a2d33" : color}`,
        borderRadius: 8,
        color: disabled ? "#4a5568" : "#0e0f12",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        transition: "opacity 0.15s, transform 0.08s",
        flexShrink: 0, fontFamily: "inherit",
      }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = "translateY(1px)"; }}
      onMouseUp={(e)   => { e.currentTarget.style.transform = ""; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = ""; }}
    >
      {icon && <Icon name={icon} size={compact ? 20 : 26} />}
      <span style={{ fontSize: compact ? 9 : 11, fontWeight: 700, lineHeight: 1, letterSpacing: 0.3, textAlign: "center" }}>{label}</span>
      {manaCost !== undefined && <span style={{ fontSize: compact ? 8 : 9, opacity: 0.75 }}>{manaCost}✦</span>}
    </button>
  );
}

// ─── HP bars ──────────────────────────────────────────────────────────────────

function HpBarCore({ current, max, height, borderRadius, marginTop, healthColor }: {
  current: number; max: number;
  height: number; borderRadius: number; marginTop: number;
  healthColor: (pct: number) => string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const color = healthColor(pct);
  const prevPctRef = useRef(pct);
  const [damagePct, setDamagePct] = useState(0);
  const [damageVisible, setDamageVisible] = useState(false);

  useEffect(() => {
    const prev = prevPctRef.current;
    if (pct < prev - 0.001) {
      const lost = prev - pct;
      setDamagePct(lost);
      setDamageVisible(true);
      const hide  = setTimeout(() => setDamageVisible(false), 500);
      const clear = setTimeout(() => setDamagePct(0), 1100);
      prevPctRef.current = pct;
      return () => { clearTimeout(hide); clearTimeout(clear); };
    }
    prevPctRef.current = pct;
  }, [pct]);

  return (
    <div style={{ marginTop, width: "100%", height, background: "#0e0f12", borderRadius, overflow: "hidden", position: "relative" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: `${pct * 100}%`, height: "100%", background: color, transition: "width 300ms ease", zIndex: 1 }} />
      {damagePct > 0 && (
        <div style={{
          position: "absolute", left: `${pct * 100}%`, top: 0,
          width: damageVisible ? `${damagePct * 100}%` : "0%",
          height: "100%", background: "#ef4444",
          transition: damageVisible ? "none" : "width 600ms ease",
          zIndex: 2, opacity: damageVisible ? 1 : 0,
        }} />
      )}
    </div>
  );
}

const HP_COLOR_FN = (pct: number) => pct < 0.25 ? "#dc2626" : pct < 0.5 ? "#d97706" : "#16a34a";

export function BigHpBar({ current, max }: { current: number; max: number }) {
  return <HpBarCore current={current} max={max} height={14} borderRadius={7} marginTop={10} healthColor={HP_COLOR_FN} />;
}

export function HpBar({ current, max }: { current: number; max: number }) {
  return <HpBarCore current={current} max={max} height={8} borderRadius={4} marginTop={6} healthColor={HP_COLOR_FN} />;
}

// ─── Dice ─────────────────────────────────────────────────────────────────────

export interface DiceRollEntry {
  id: number; die: string; value: number; actor: string; purpose: string;
}

export const DIE_SHAPE: Record<string, { points: string; textY: number }> = {
  d4:  { points: "50,6 96,90 4,90",                              textY: 70 },
  d6:  { points: "8,8 92,8 92,92 8,92",                          textY: 56 },
  d8:  { points: "50,4 96,50 50,96 4,50",                        textY: 56 },
  d10: { points: "50,4 93,34 76,90 24,90 7,34",                  textY: 58 },
  d12: { points: "50,4 91,27 98,70 70,96 30,96 2,70 9,27",       textY: 58 },
  d20: { points: "50,4 91,28 91,72 50,96 9,72 9,28",             textY: 56 },
};
export const DEFAULT_SHAPE = DIE_SHAPE.d20;

export const D6_PIPS: Record<number, [number, number][]> = {
  1: [[1,1]],
  2: [[0,0],[2,2]],
  3: [[0,0],[1,1],[2,2]],
  4: [[0,0],[2,0],[0,2],[2,2]],
  5: [[0,0],[2,0],[1,1],[0,2],[2,2]],
  6: [[0,0],[2,0],[0,1],[2,1],[0,2],[2,2]],
};

export const PURPOSE_LABEL: Record<string, string> = {
  hit_check:      "To Hit",
  damage_attack:  "Damage",
  damage_cast:    "Spell Dmg",
  damage_monster: "Monster Dmg",
  signature:      "Signature",
  heal:           "Healing",
  shield:         "Shield",
  flee_check:     "Escape",
  initiative:     "Initiative",
};

let _diceStylesInjected = false;
export function injectDiceStyles(): void {
  if (_diceStylesInjected || typeof document === "undefined") return;
  _diceStylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    @keyframes dice-roll-in {
      0%   { transform: rotate(0deg)   scale(0)    translateY(-40px); opacity: 0; }
      55%  { transform: rotate(630deg) scale(1.14) translateY(0);     opacity: 1; }
      75%  { transform: rotate(705deg) scale(0.93); }
      88%  { transform: rotate(716deg) scale(1.06); }
      100% { transform: rotate(720deg) scale(1); }
    }
    @keyframes dice-fade-out {
      0%   { opacity: 1; transform: scale(1)   translateY(0);   }
      100% { opacity: 0; transform: scale(0.7) translateY(18px); }
    }
  `;
  document.head.appendChild(s);
}

export function D6Pips({ value, color }: { value: number; color: string }) {
  const pips = D6_PIPS[Math.min(6, Math.max(1, value))] ?? [];
  const cells: [number, number][] = [[0,0],[1,0],[2,0],[0,1],[1,1],[2,1],[0,2],[1,2],[2,2]];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 12px)", gap: 5 }}>
      {cells.map(([c, r]) => (
        <div key={`${c},${r}`} style={{
          width: 10, height: 10, borderRadius: "50%",
          background: pips.some(([pc, pr]) => pc === c && pr === r) ? color : "transparent",
          transition: "background 100ms",
        }} />
      ))}
    </div>
  );
}

export function DiceFace({ roll }: { roll: DiceRollEntry }) {
  const maxFace = parseInt(roll.die.replace("d", ""), 10) || 20;
  const shape   = DIE_SHAPE[roll.die] ?? DEFAULT_SHAPE;
  const isD6    = roll.die === "d6";

  const [display, setDisplay] = useState<number>(() => Math.ceil(Math.random() * maxFace));
  const [settled, setSettled] = useState(false);
  const [fading,  setFading]  = useState(false);

  useEffect(() => {
    let count = 0;
    const iv = setInterval(() => {
      count++;
      if (count >= 13) {
        clearInterval(iv);
        setDisplay(roll.value);
        setSettled(true);
      } else {
        setDisplay(Math.ceil(Math.random() * maxFace));
      }
    }, 50);
    const fadeTimer = setTimeout(() => setFading(true), 10000);
    return () => { clearInterval(iv); clearTimeout(fadeTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roll.id]);

  const isCrit   = roll.die === "d20" && roll.value === maxFace;
  const isFumble = roll.die === "d20" && roll.value === 1;
  const strokeColor = settled ? (isCrit ? "#22c55e" : isFumble ? "#ef4444" : "#7dd3fc") : "#4a5568";
  const fillColor   = settled ? (isCrit ? "#052e12" : isFumble ? "#2e0505" : "#0d1b2e") : "#111827";
  const numColor    = settled ? (isCrit ? "#86efac" : isFumble ? "#fca5a5" : "#f5f5f5") : "#6b7280";
  const SIZE = 92;

  return (
    <div style={{
      width: SIZE, height: SIZE, position: "relative",
      filter: settled ? `drop-shadow(0 0 8px ${strokeColor}60)` : "none",
      animationName: fading ? "dice-fade-out" : "dice-roll-in",
      animationDuration: fading ? "350ms" : "700ms",
      animationTimingFunction: fading ? "ease-in" : "cubic-bezier(0.22,1,0.36,1)",
      animationFillMode: "forwards", transition: "filter 200ms",
    }}>
      <svg width={SIZE} height={SIZE} viewBox="0 0 100 100" style={{ position: "absolute", top: 0, left: 0 }}>
        <polygon points={shape.points} fill={fillColor} stroke={strokeColor}
          strokeWidth={settled ? 3.5 : 2.5} strokeLinejoin="round"
          style={{ transition: "fill 150ms, stroke 150ms" }} />
        <text x="50" y="16" textAnchor="middle" fontSize="9" fill="#6b7280"
          fontFamily="ui-monospace, monospace" letterSpacing="1"
          style={{ textTransform: "uppercase" }}>{roll.die.toUpperCase()}</text>
      </svg>
      <div style={{ position: "absolute", top: 0, left: 0, width: SIZE, height: SIZE, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {isD6 && settled
          ? <D6Pips value={display} color={numColor} />
          : <span style={{ fontSize: roll.die === "d4" ? 22 : 28, fontWeight: 900, color: numColor, fontVariantNumeric: "tabular-nums", lineHeight: 1, transition: "color 200ms", fontFamily: "ui-monospace, monospace" }}>{display}</span>
        }
      </div>
      {settled && roll.purpose && (
        <div style={{ position: "absolute", bottom: -18, left: "50%", transform: "translateX(-50%)", fontSize: 10, color: "#9ca3af", whiteSpace: "nowrap", fontFamily: "system-ui, sans-serif", letterSpacing: 0.3, fontWeight: 500 }}>
          {PURPOSE_LABEL[roll.purpose] ?? roll.purpose}
        </div>
      )}
    </div>
  );
}

export function DiceRollDisplay({ rolls, align = "center" }: { rolls: DiceRollEntry[]; align?: "center" | "left" }) {
  useEffect(() => { injectDiceStyles(); }, []);
  if (rolls.length === 0) return null;
  const enemyRolls = rolls.filter((r) =>  isMonsterActor(r.actor));
  const partyRolls = rolls.filter((r) => !isMonsterActor(r.actor));
  const rowStyle = {
    display: "flex", gap: 14, flexWrap: "wrap" as const,
    justifyContent: align === "left" ? "flex-start" : "center",
    alignItems: "flex-start",
  };
  function pill(color: string, ring: string) {
    return {
      fontSize: 10, fontWeight: 800, color, textTransform: "uppercase" as const, letterSpacing: 2,
      fontFamily: "ui-monospace, monospace", background: "rgba(10,11,14,0.92)",
      border: `1px solid ${ring}`, padding: "3px 12px", borderRadius: 999, marginBottom: 8,
      display: "inline-block", boxShadow: "0 2px 12px rgba(0,0,0,0.6)", textShadow: "0 0 6px rgba(0,0,0,0.8)",
    };
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, pointerEvents: "none" }}>
      {enemyRolls.length > 0 && (
        <div style={{ textAlign: align }}>
          <div style={pill("#fca5a5", "#7f1d1d")}>Enemy</div>
          <div style={rowStyle}>{enemyRolls.map((r) => <DiceFace key={r.id} roll={r} />)}</div>
        </div>
      )}
      {partyRolls.length > 0 && (
        <div style={{ textAlign: align }}>
          <div style={pill("#86efac", "#166534")}>Party</div>
          <div style={rowStyle}>{partyRolls.map((r) => <DiceFace key={r.id} roll={r} />)}</div>
        </div>
      )}
    </div>
  );
}

// ─── PickerModal ──────────────────────────────────────────────────────────────
// Portal-based modal so it escapes any `backdrop-filter` containing block.

export function PickerModal({ title, onClose, children }: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16, backdropFilter: "blur(4px)",
      }}>
      <div style={{
        background: "#12141a", border: "1px solid #2a2d33", borderRadius: 12,
        width: "min(700px, 100%)", maxHeight: "85vh", display: "flex",
        flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.8)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #2a2d33", flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "1px solid #3a3d44", borderRadius: 6, color: "#9ca3af", cursor: "pointer", padding: "3px 10px", fontSize: 13 }}>✕</button>
        </div>
        <div style={{ padding: 16, overflowY: "auto", flex: 1 }}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Item pickers ─────────────────────────────────────────────────────────────

export interface CombatItem {
  id: number;
  item_name: string;
  item_type: string;
  power: number;
  rarity?: string;
  flavor?: string | null;
  equipped?: boolean;
  slot?: string | null;
  weapon_range?: string | null;
  item_subtype?: string | null;
  level_req?: number;
}

export interface CombatFighter {
  id: string;
  name: string;
  class: string;
  hp: number;
  max_hp: number;
  mana?: number;
  max_mana?: number;
  shield?: number;
  position?: "front" | "back";
}

export interface CombatMonsterRef {
  id?: string;
  name: string;
  hp: number;
  max_hp: number;
  effects?: Array<{ type: string }>;
}

export function isCombatUsable(t: string): boolean {
  return t === "consumable" || t === "magic" || t === "revive" || t === "tool" || t === "scroll";
}

export function describeCombatEffect(item: CombatItem): string {
  const p = item.power;
  switch (item.item_type) {
    case "consumable": return `Heals ${p} HP`;
    case "magic":      return `+${p} max mana`;
    case "revive":     return `Revives a downed ally at ${p}% HP`;
    case "tool":
    case "scroll": {
      switch (item.item_name) {
        case "Caffeine Bomb":
        case "Hotfix Grenade":    return `Deals ${p} damage to target (non-lethal)`;
        case "Espresso Shot":     return `Regen ${p} HP/turn for 5 turns (self)`;
        case "Poison Vial":       return `Poisons target: ${p} dmg/turn × 4 turns`;
        case "Venom Vial":        return `Poisons target: ${p} dmg/turn × 4 turns`;
        case "Production Outage": return `Instakills non-boss · 30% max HP vs boss`;
        case "Rebase Scroll":     return `Restores entire party mana to full`;
        case "Regen Draft":       return `Regen ${p} HP/turn for 3 turns (self)`;
        case "Battle Elixir":     return `+25% damage for 3 turns (self)`;
        default:                  return `Power ${p}`;
      }
    }
    default: return `Power ${p}`;
  }
}

export function UseItemTile({ item, onClick }: { item: CombatItem; onClick: () => void }) {
  const tint = RARITY_TINT[item.rarity ?? "common"] ?? "#2a2d33";
  const icon = lootIcon({
    item_type: item.item_type,
    slot: item.slot,
    weapon_range: item.weapon_range,
    item_subtype: item.item_subtype,
    item_name: item.item_name,
    flavor: item.flavor,
  });
  const effectDesc = describeCombatEffect(item);
  const levelReq = item.level_req ?? 1;
  return (
    <button onClick={onClick} style={{
      padding: "10px 12px", background: "#131519",
      border: `1px solid ${tint}55`, borderLeft: `3px solid ${tint}`,
      borderRadius: 8, color: "#d1d5db", textAlign: "left", fontSize: 12,
      cursor: "pointer", display: "flex", flexDirection: "column", gap: 5, width: "100%",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name={icon} size={18} color={tint} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: tint, fontSize: 13, lineHeight: 1.2 }}>{item.item_name}</div>
          <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {item.rarity ?? "common"}
            {levelReq > 1 && <span style={{ color: "#f59e0b", marginLeft: 6 }}>Req L{levelReq}</span>}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#93c5fd", fontWeight: 600 }}>{effectDesc}</div>
      {item.flavor && <div style={{ fontSize: 11, color: "#9aa0a6", fontStyle: "italic", lineHeight: 1.35 }}>{item.flavor}</div>}
    </button>
  );
}

const PICKER_BTN_STYLE: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "10px 16px", background: "#1a1c21", border: "1px solid #2a2d33",
  borderRadius: 8, color: "#f5f5f5", cursor: "pointer", fontSize: 13,
  transition: "border-color 0.15s", width: "100%",
};

const hoverGreen = (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.borderColor = "#166534");
const hoverRed   = (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.borderColor = "#ef4444");
const hoverOut   = (e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.borderColor = "#2a2d33");

export function ItemPicker({ items, onPickNoTarget, onPickRevive, onCancel }: {
  items: CombatItem[];
  onPickNoTarget: (id: number) => void;
  onPickRevive: (id: number) => void;
  onCancel: () => void;
}) {
  const usable = items.filter((i) => isCombatUsable(i.item_type));
  return (
    <PickerModal title={<><Icon name="ammo-bag" /> Use Item</>} onClose={onCancel}>
      {usable.length === 0
        ? <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>No usable items in your pack.</p>
        : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 }}>
            {usable.map((it) => (
              <UseItemTile
                key={it.id}
                item={it}
                onClick={() => it.item_type === "revive" ? onPickRevive(it.id) : onPickNoTarget(it.id)}
              />
            ))}
          </div>
        )
      }
    </PickerModal>
  );
}

export function MonsterTargetPicker({ title, monsters, onPick, onCancel }: {
  title: string;
  monsters: CombatMonsterRef[];
  onPick: (monsterId: string) => void;
  onCancel: () => void;
}) {
  return (
    <PickerModal title={title} onClose={onCancel}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {monsters.map((m) => (
          <button
            key={m.id ?? m.name}
            onClick={() => { if (m.id) onPick(m.id); }}
            style={PICKER_BTN_STYLE}
            onMouseEnter={hoverRed}
            onMouseLeave={hoverOut}
          >
            <span style={{ fontWeight: 600 }}>{m.name}</span>
            <span style={{ fontSize: 12, color: "#ef4444" }}>
              {m.hp} / {m.max_hp} HP
              {m.effects?.some((e) => e.type === "poisoned") && " ☠"}
            </span>
          </button>
        ))}
      </div>
    </PickerModal>
  );
}

export function ReviveTargetPicker({ fighters, onPick, onCancel }: {
  fighters: CombatFighter[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const downed = fighters.filter((f) => f.hp <= 0);
  return (
    <PickerModal title={<><Icon name="crowned-heart" /> Revive who?</>} onClose={onCancel}>
      {downed.length === 0
        ? <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>No downed allies.</p>
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {downed.map((f) => (
              <button key={f.id} onClick={() => onPick(f.id)}
                style={PICKER_BTN_STYLE} onMouseEnter={hoverGreen} onMouseLeave={hoverOut}>
                <span style={{ fontWeight: 600 }}>{f.name}</span>
                <span style={{ fontSize: 12, color: "#9aa0a6" }}>{f.class}</span>
              </button>
            ))}
          </div>
        )
      }
    </PickerModal>
  );
}

export function GiveItemPicker({ items, onPickItem, onCancel }: {
  items: CombatItem[];
  onPickItem: (id: number) => void;
  onCancel: () => void;
}) {
  const giveable = items.filter((i) => !i.equipped);
  return (
    <PickerModal title={<><Icon name="ammo-bag" /> Give which item?</>} onClose={onCancel}>
      {giveable.length === 0
        ? <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>No items to give.</p>
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {giveable.map((it) => (
              <button key={it.id} onClick={() => onPickItem(it.id)}
                style={PICKER_BTN_STYLE} onMouseEnter={hoverGreen} onMouseLeave={hoverOut}>
                <span style={{ fontWeight: 600 }}>{it.item_name}</span>
                <span style={{ fontSize: 12, color: "#9aa0a6" }}>pwr {it.power} · {it.rarity ?? "common"}</span>
              </button>
            ))}
          </div>
        )
      }
    </PickerModal>
  );
}

export function GiveTargetPicker({ fighters, selfId, onPick, onCancel }: {
  fighters: CombatFighter[];
  selfId: string;
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const eligible = fighters.filter((f) => f.hp > 0 && f.id !== selfId);
  return (
    <PickerModal title={<><Icon name="player" /> Give to who?</>} onClose={onCancel}>
      {eligible.length === 0
        ? <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>No alive allies.</p>
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {eligible.map((f) => (
              <button key={f.id} onClick={() => onPick(f.id)}
                style={PICKER_BTN_STYLE} onMouseEnter={hoverGreen} onMouseLeave={hoverOut}>
                <span style={{ fontWeight: 600 }}>{f.name}</span>
                <span style={{ fontSize: 12, color: "#86efac" }}>{f.hp}/{f.max_hp} HP</span>
              </button>
            ))}
          </div>
        )
      }
      <button onClick={onCancel} style={{ marginTop: 12, padding: "4px 12px", background: "none", border: "1px solid #2a2d33", borderRadius: 6, color: "#9aa0a6", fontSize: 12, cursor: "pointer" }}>
        ← Back to items
      </button>
    </PickerModal>
  );
}

export function TargetPicker({ kind, fighters, onPick, onCancel }: {
  kind: "heal" | "shield";
  fighters: CombatFighter[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const targets = fighters.filter((f) => f.hp > 0);
  return (
    <PickerModal
      title={kind === "heal" ? <><Icon name="health-potion" /> Heal who?</> : <><Icon name="shield" /> Shield who?</>}
      onClose={onCancel}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {targets.map((f) => (
          <button key={f.id} onClick={() => onPick(f.id)}
            style={PICKER_BTN_STYLE} onMouseEnter={hoverGreen} onMouseLeave={hoverOut}>
            <span>{f.name} <span style={{ fontSize: 12, color: "#9aa0a6" }}>· {f.class}</span></span>
            <span style={{ fontSize: 12, color: "#9aa0a6", fontVariantNumeric: "tabular-nums" }}>
              {f.hp}/{f.max_hp}
            </span>
          </button>
        ))}
      </div>
    </PickerModal>
  );
}

// ─── InitStrip ────────────────────────────────────────────────────────────────

export function InitStrip({ turnOrder, turnIndex, round, selfId, fighters, monsters }: {
  turnOrder: string[];
  turnIndex: number;
  round: number;
  selfId: string;
  fighters: Array<{ id: string; name: string; hp: number }>;
  monsters: Array<{ id?: string; name: string; hp: number }>;
}) {
  const currentIdx = turnIndex % Math.max(1, turnOrder.length);
  return (
    <div style={{
      background: "rgba(10,11,14,0.55)", border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 999, backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
      boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
      padding: "6px 14px", display: "flex", gap: 8, alignItems: "center",
      maxWidth: "min(720px, 80vw)", overflowX: "auto",
    }}>
      <span style={{ fontSize: 10, color: "#9aa0a6", textTransform: "uppercase", letterSpacing: 1, marginRight: 4, whiteSpace: "nowrap" }}>Turn</span>
      {turnOrder.map((id, i) => {
        const isCurrent = i === currentIdx;
        const isMon = isMonsterActor(id);
        const fighter = fighters.find((f) => f.id === id);
        const monster = isMon ? (monsters.find((m) => m.id === id) ?? monsters[0]) : null;
        const label = isMon ? (monster?.name?.split(" ")[0] ?? "Enemy") : (fighter?.name?.split(" ")[0] ?? id);
        const isSelf = id === selfId;
        const isDead = fighter ? fighter.hp <= 0 : monster ? monster.hp <= 0 : false;
        return (
          <div key={i} style={{
            fontSize: 11, padding: "2px 8px", borderRadius: 4,
            border: isCurrent ? "1px solid #f5f5dc" : "1px solid transparent",
            background: isCurrent ? "rgba(245,245,220,0.12)" : "transparent",
            color: isDead ? "#4a5568" : isMon ? "#fca5a5" : isSelf ? "#f5f5dc" : "#d1d5db",
            fontWeight: isCurrent ? 700 : 400, whiteSpace: "nowrap",
            opacity: isDead ? 0.5 : 1, textDecoration: isDead ? "line-through" : "none",
          }}>{label}</div>
        );
      })}
      <span style={{ fontSize: 10, color: "#4a5568", marginLeft: 4, whiteSpace: "nowrap" }}>R{round}</span>
    </div>
  );
}

// ─── CombatLog ───────────────────────────────────────────────────────────────
// Dungeon-style log: colored slab turn-dividers, side-colored left rail for
// party vs enemy entries, DETAILS toggle for dice/formula sub-lines.

export interface LogEntry {
  id: number;
  content: React.ReactNode;
  tone: "good" | "bad" | "info" | "muted" | "flavor";
  side?: "party" | "enemy" | "divider" | null;
  divider_side?: "party" | "enemy";
  detail?: string;
}

export function CombatLog({ log, scrollRef }: {
  log: LogEntry[];
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, flexShrink: 0 }}>
        <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
          Combat log
        </div>
        <button
          onClick={() => setShowDetails((v) => !v)}
          title={showDetails ? "Hide dice / formulas" : "Show dice / formulas"}
          style={{
            background: "none", border: "1px solid #2a2d33",
            color: showDetails ? "#fcd34d" : "#6b7280",
            fontSize: 9, padding: "1px 6px", borderRadius: 3, cursor: "pointer",
            letterSpacing: 0.5, fontFamily: "ui-monospace, monospace",
          }}
        >
          DETAILS
        </button>
      </div>
      <div ref={scrollRef} style={{
        flex: "1 1 auto", minHeight: 0, overflowY: "auto",
        background: "#0e0f12", borderRadius: 6, padding: "8px 10px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12, lineHeight: 1.45,
        display: "flex", flexDirection: "column", gap: 3,
      }}>
        {log.length === 0 && <span style={{ color: "#4a5568" }}>Waiting for events…</span>}
        {log.slice(-40).map((e) => {
          const toneColor = TONE_COLOR[e.tone] ?? "#9aa0a6";
          if (e.side === "divider") {
            const accent = e.divider_side === "enemy" ? "#7f1d1d" : "#166534";
            const labelColor = e.divider_side === "enemy" ? "#fca5a5" : "#86efac";
            return (
              <div key={e.id} style={{
                display: "flex", alignItems: "center", gap: 6,
                margin: "2px -10px 1px", padding: "1px 10px",
                background: `linear-gradient(90deg, ${accent}33 0%, transparent 100%)`,
                borderTop: `1px solid ${accent}55`,
                borderBottom: `1px solid ${accent}22`,
                fontSize: 10, letterSpacing: 1, textTransform: "uppercase",
                color: labelColor, fontWeight: 700,
              }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.content}
                </span>
              </div>
            );
          }
          const sideAccent = e.side === "party" ? "#16a34a" : e.side === "enemy" ? "#dc2626" : "transparent";
          return (
            <div key={e.id} style={{
              color: toneColor, wordBreak: "break-word",
              paddingLeft: e.side ? 7 : 0,
              borderLeft: e.side ? `2px solid ${sideAccent}88` : "none",
              background: e.side ? `${sideAccent}11` : "transparent",
              borderRadius: 2,
            }}>
              <div>{e.content}</div>
              {showDetails && e.detail && (
                <div style={{ fontSize: 11, color: "#6b7280", paddingLeft: 10 }}>↳ {e.detail}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
