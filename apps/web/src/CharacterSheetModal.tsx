// Full character sheet modal — pulled up by clicking the docked pawn card.
//
// Works for both party fighters and enemy monsters. Renders a single
// scrollable card with all the detail that doesn't fit in the docked
// summary: derived stats, complete ability list (with range/cost/cooldown),
// status effects with magnitude + remaining turns, element affinities,
// monster specials, etc.
//
// Closes on backdrop click, Escape, or the × button. Portal-rendered via
// React's default flow (just absolute-positioned at root z-index).

import { useEffect } from "react";

import { activeAbilities, classByName, type ActiveAbilityDef } from "@gantt-quest/core";

import { Avatar, Icon } from "./icons";
import { charPortraitUrl, classPortraitUrl, DISPLAY_FONT } from "./CombatShared";
import { EFFECT_DESCRIPTIONS, type PawnLike } from "./PawnCallout";

export interface CharacterSheetSubject {
  pawn: PawnLike;
  side: "fighter" | "monster";
  themeColor: string;
  isSelf?: boolean;
  // For monsters: pass-through fields the sheet wants but PawnLike doesn't carry.
  monsterExtras?: {
    weapon_range?: "melee" | "ranged" | "focus";
    range_tiles?: number;
    move_range?: number;
    specials?: string[];
    element_weakness?: "fire" | "ice" | "lightning";
    element_resistance?: "fire" | "ice" | "lightning";
    attack_damage_type?: string;
    boss_phase?: 1 | 2;
  };
}

export interface CharacterSheetModalProps {
  subject: CharacterSheetSubject;
  onClose: () => void;
}

export function CharacterSheetModal({ subject, onClose }: CharacterSheetModalProps) {
  // Escape closes the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { pawn, side, themeColor, isSelf, monsterExtras } = subject;
  const borderColor = side === "fighter" ? themeColor : "#dc2626";

  const avatarSrc =
    side === "fighter"
      ? charPortraitUrl(pawn.name)
      : pawn.art_url ?? null;
  const avatarFallback =
    side === "fighter" && pawn.class
      ? classPortraitUrl(pawn.class)
      : null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "rgba(15, 23, 42, 0.98)",
          border: `2px solid ${borderColor}`,
          borderRadius: 12,
          boxShadow: "0 12px 48px rgba(0,0,0,0.7)",
          color: "#e5e7eb",
          fontSize: 13,
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex",
          gap: 14,
          padding: 16,
          borderBottom: `1px solid ${borderColor}`,
          background: side === "fighter" ? "rgba(30,41,59,0.6)" : "rgba(76,5,25,0.5)",
          position: "sticky",
          top: 0,
          backdropFilter: "blur(6px)",
        }}>
          <Avatar
            src={avatarSrc}
            fallbackSrc={avatarFallback}
            alt={pawn.name}
            size={72}
            radius={8}
            fallbackIcon={side === "fighter" ? "player" : "dragon"}
            fallbackColor={side === "fighter" ? "#3a4150" : "#5a1f1f"}
            border={`1px solid ${borderColor}`}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{
                fontFamily: DISPLAY_FONT,
                fontSize: 20,
                fontWeight: 700,
                color: "#fff",
                lineHeight: 1.1,
              }}>{pawn.name}</span>
              {isSelf && <Badge bg="#1f2a3a" fg="#7dd3fc">YOU</Badge>}
              {pawn.is_boss && <Badge bg="#3a1f1f" fg="#fbbf24">BOSS</Badge>}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.6 }}>
              {side === "fighter"
                ? `${pawn.class ?? "—"} · Level ${pawn.level ?? 1}`
                : `Tier ${pawn.tier ?? 1}${monsterExtras?.boss_phase === 2 ? " · Phase 2" : ""}`}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              alignSelf: "flex-start",
              width: 32,
              height: 32,
              border: "1px solid rgba(148,163,184,0.4)",
              background: "rgba(15,23,42,0.7)",
              color: "#e5e7eb",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
            }}
            title="Close (Esc)"
          >×</button>
        </div>

        {/* Vitals */}
        <Section title="Vitals">
          <KeyValueRow keyText="HP" valueText={`${pawn.hp} / ${pawn.max_hp}`} />
          {pawn.shield !== undefined && pawn.armor_power !== undefined && pawn.armor_power > 0 && (
            <KeyValueRow keyText="Armor" valueText={`${pawn.shield} / ${Math.floor(pawn.armor_power / 2)}`} />
          )}
          {side === "fighter" && pawn.max_mana && pawn.max_mana > 0 && (
            <KeyValueRow keyText="Mana" valueText={`${pawn.mana ?? 0} / ${pawn.max_mana}`} />
          )}
        </Section>

        {/* Status effects */}
        {pawn.effects && pawn.effects.length > 0 && (
          <Section title="Status Effects">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {pawn.effects.map((e, i) => {
                const desc = EFFECT_DESCRIPTIONS[e.type];
                const color = effectColor(e.type);
                return (
                  <div
                    key={i}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      background: "rgba(30,41,59,0.55)",
                      border: `1px solid ${color}`,
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    <div style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
                      color, fontSize: 12, fontWeight: 700, letterSpacing: 0.4,
                    }}>
                      <span style={{ textTransform: "uppercase" }}>
                        {desc?.label ?? e.type} {e.magnitude > 1 && `×${e.magnitude}`}
                      </span>
                      <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600 }}>
                        {e.remaining}t left
                      </span>
                    </div>
                    {desc && (
                      <div style={{ fontSize: 11, color: "#cbd5e1", lineHeight: 1.45 }}>
                        {desc.what.replace("{mag}", String(e.magnitude))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* Fighter abilities */}
        {side === "fighter" && pawn.class && (
          <Section title="Abilities">
            <FighterAbilitiesList className={pawn.class} />
          </Section>
        )}

        {/* Monster combat profile */}
        {side === "monster" && monsterExtras && (
          <Section title="Combat Profile">
            {monsterExtras.weapon_range && (
              <KeyValueRow keyText="Weapon" valueText={`${monsterExtras.weapon_range}${monsterExtras.range_tiles ? ` · ${monsterExtras.range_tiles} hex reach` : ""}`} />
            )}
            {monsterExtras.move_range !== undefined && (
              <KeyValueRow keyText="Move range" valueText={`${monsterExtras.move_range} hex/turn`} />
            )}
            {monsterExtras.attack_damage_type && monsterExtras.attack_damage_type !== "physical" && (
              <KeyValueRow keyText="Damage type" valueText={monsterExtras.attack_damage_type} />
            )}
            {monsterExtras.specials && monsterExtras.specials.length > 0 && (
              <KeyValueRow keyText="Specials" valueText={monsterExtras.specials.join(", ")} />
            )}
            {monsterExtras.element_weakness && (
              <KeyValueRow keyText="Weakness" valueText={monsterExtras.element_weakness} valueColor={elementColor(monsterExtras.element_weakness)} />
            )}
            {monsterExtras.element_resistance && (
              <KeyValueRow keyText="Resistance" valueText={monsterExtras.element_resistance} valueColor={elementColor(monsterExtras.element_resistance)} />
            )}
          </Section>
        )}
      </div>
    </div>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "12px 16px", borderTop: "1px solid rgba(148,163,184,0.18)" }}>
      <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 8, fontWeight: 700 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function KeyValueRow({ keyText, valueText, valueColor }: { keyText: string; valueText: string; valueColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", fontSize: 12 }}>
      <span style={{ color: "#94a3b8" }}>{keyText}</span>
      <span style={{ color: valueColor ?? "#e5e7eb", fontVariantNumeric: "tabular-nums", textTransform: "capitalize" }}>{valueText}</span>
    </div>
  );
}

function Badge({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return (
    <span style={{
      padding: "2px 6px",
      borderRadius: 3,
      background: bg,
      color: fg,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.4,
      textTransform: "uppercase",
    }}>{children}</span>
  );
}

function FighterAbilitiesList({ className }: { className: string }) {
  let cls: ReturnType<typeof classByName> | null = null;
  try {
    cls = classByName(className);
  } catch {
    return <div style={{ color: "#94a3b8" }}>No abilities found for {className}.</div>;
  }
  const actives = activeAbilities(cls.abilities);
  const passives = cls.abilities.filter((a) => a.kind === "passive");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {actives.map((a) => <AbilityRow key={a.id} ability={a} />)}
      {passives.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Passives</div>
          {passives.map((p) => (
            <div key={p.id} style={{ padding: "6px 0", borderTop: "1px solid rgba(148,163,184,0.12)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Icon name={(p as { icon?: string }).icon ?? "perspective-dice-six-faces-six"} size={14} color="#c084fc" />
                <span style={{ fontWeight: 600, color: "#fff" }}>{p.name}</span>
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{p.blurb}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AbilityRow({ ability }: { ability: ActiveAbilityDef }) {
  const targetLabel: Record<string, string> = {
    "single_enemy": "single enemy",
    "single_ally": "single ally",
    "all_enemies": "all enemies",
    "all_allies": "all allies",
    "any": "any actor",
    "self": "self",
  };
  return (
    <div style={{ padding: "8px 0", borderTop: "1px solid rgba(148,163,184,0.12)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name={ability.icon} size={16} color="#d946ef" />
        <span style={{ fontWeight: 700, color: "#fff", fontSize: 13 }}>{ability.name}</span>
        <span style={{ flex: 1 }} />
        {ability.mana_cost > 0 && (
          <span style={{ fontSize: 11, color: "#a78bfa" }}>{ability.mana_cost} ✦</span>
        )}
        {ability.cooldown_turns && (
          <span style={{ fontSize: 11, color: "#fb923c" }}>{ability.cooldown_turns}t cd</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4, lineHeight: 1.5 }}>{ability.blurb}</div>
      <div style={{ display: "flex", gap: 8, marginTop: 5, flexWrap: "wrap", fontSize: 10, color: "#64748b" }}>
        <span>Target: {targetLabel[ability.target] ?? ability.target}</span>
        {typeof ability.range_tiles === "number" && (
          <span>Range: {ability.range_tiles === 1 ? "melee (1 hex)" : `${ability.range_tiles} hexes`}</span>
        )}
        {typeof ability.aoe_radius_tiles === "number" && ability.aoe_radius_tiles > 0 && (
          <span>AoE: {ability.aoe_radius_tiles}-hex blast</span>
        )}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function effectColor(type: string): string {
  const palette: Record<string, string> = {
    burning: "#fb923c",
    frozen: "#7dd3fc",
    shocked: "#fbbf24",
    poisoned: "#84cc16",
    bleeding: "#dc2626",
    hexed: "#c084fc",
    entangled: "#65a30d",
    stunned: "#94a3b8",
    empowered: "#a78bfa",
    regen: "#22c55e",
    barkskin: "#84cc16",
    animal_form: "#22c55e",
  };
  return palette[type] ?? "#94a3b8";
}

function elementColor(el: string): string {
  return el === "fire" ? "#fb923c" : el === "ice" ? "#7dd3fc" : el === "lightning" ? "#fbbf24" : "#e5e7eb";
}
