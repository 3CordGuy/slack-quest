import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import toast from "react-hot-toast";
import {
  FloatingFocusManager,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from "@floating-ui/react";

import { CLASSES, classByName, deriveAll, xpForLevel, type Achievement, type EarnedAchievement, type StatKey, type Stats as CoreStats } from "@gantt-quest/core";

import { Avatar, Icon } from "../icons";

import type {
  Character, Rarity, EquipSlot, Item, QuestVariant,
  StatusEffect, KnownCharacter,
  AchievementsResponse, MeResponse,
  SlotsListResponse,
} from "../types";
import {
  RARITY_COLOR, EFFECT_COLOR, EFFECT_ICON,
  SLOT_LABELS, SLOT_ICON, DOLL_LAYOUT,
  PRIMARY_STAT_META,
} from "../constants";
import { DISPLAY_FONT, card, h1, h2, muted, button, kbd, smallBadge, smallActionBtn } from "../styles";
import {
  adventurerCharPortrait, adventurerClassPortrait,
} from "../utils";
import {
  SmallBadge, ModalBackdrop, HoverTooltip,
} from "./ui";

export function PartyMember({ fighter, self, onInspect }: { fighter: Character; self: boolean; onInspect?: () => void }) {
  const downed =
    fighter.downed_until !== null && fighter.downed_until > Date.now();
  return (
    <div
      style={{
        padding: 12,
        background: "var(--bg-input)",
        borderRadius: "var(--radius-lg)",
        border: self ? "1px solid var(--accent-ink-blue-2)" : "1px solid var(--border-faint)",
        opacity: downed ? 0.6 : 1,
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
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{
            color: "var(--fg-1)",
            fontSize: 15,
            fontFamily: "var(--font-display)",
          }}>
            {fighter.name}
          </span>
          {fighter.slack_username && (
            <span style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--accent-ink-blue)",
            }}>@{fighter.slack_username}</span>
          )}
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--accent-arcane)",
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}>
            {fighter.class} · Lv {fighter.level}
          </span>
          {self && <SmallBadge>you</SmallBadge>}
          {downed && (
            <span className="tag" style={{ background: "rgba(239,68,68,0.15)", color: "var(--tone-bad)", border: "1px solid rgba(239,68,68,0.4)" }}>
              downed
            </span>
          )}
          <PositionBadge position={fighter.position} />
        </div>
        <div style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--fg-mute)",
          fontVariantNumeric: "tabular-nums",
        }}>
          {fighter.hp}/{fighter.max_hp}
        </div>
      </div>
      <HpBar current={fighter.hp} max={fighter.max_hp} flavor="player" />
      {(fighter.armor_power ?? 0) > 0 && (
        <div style={{ marginTop: 6 }}>
          <ArmorBar current={fighter.shield} max={Math.floor((fighter.armor_power ?? 0) / 2)} />
        </div>
      )}
      {fighter.max_mana > 0 && (
        <div style={{ marginTop: 6 }}>
          <ManaBar current={fighter.mana} max={fighter.max_mana} />
        </div>
      )}
      {!self && onInspect && (
        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={onInspect}
            className="btn btn-ghost btn-sm"
            style={{ color: "var(--accent-ink-blue)" }}
          >
            Inspect
          </button>
        </div>
      )}
    </div>
  );
}

export function ReadOnlyDoll({ items }: { items: Item[] }) {
  const bySlot = (slot: EquipSlot) => items.find((i) => i.slot === slot);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 52px)", gap: 4, justifyContent: "center" }}>
      {DOLL_LAYOUT.map((slot, i) => {
        if (!slot) return <div key={i} />;
        const item = bySlot(slot);
        const rc = item ? RARITY_COLOR[item.rarity as Rarity] : null;
        return (
          <div
            key={slot}
            title={item ? `${item.item_name} (+${item.power})` : SLOT_LABELS[slot]}
            style={{
              width: 52, height: 52,
              border: `1px solid ${rc ? `${rc}66` : "var(--border-base)"}`,
              borderRadius: "var(--radius-lg)",
              background: item ? `${rc}11` : "var(--bg-void)",
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              gap: 2, position: "relative", overflow: "hidden",
            }}
          >
            {item ? (
              <>
                <Icon name={SLOT_ICON[slot]} size={22} color={rc ?? "var(--fg-mute-3)"} />
                <span style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  color: rc ?? "var(--fg-mute-3)",
                  fontWeight: 700,
                  lineHeight: 1,
                }}>+{item.power}</span>
                {item.sharpens_count > 0 && (
                  <div style={{
                    position: "absolute", top: 2, right: 2,
                    fontFamily: "var(--font-mono)",
                    fontSize: 8,
                    color: "var(--tone-fire)",
                    fontWeight: 700,
                  }}>
                    ×{item.sharpens_count}
                  </div>
                )}
              </>
            ) : (
              <Icon name={SLOT_ICON[slot]} size={18} color="var(--border-base)" />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function CharacterInspectDialog({
  character,
  onClose,
}: {
  character: Character;
  onClose: () => void;
}) {
  const isDowned = character.downed_until !== null && character.downed_until > Date.now();
  const cxpAtLevel = xpForLevel(character.level);
  const cxpAtNext = xpForLevel(character.level + 1);
  const cxpIntoLevel = Math.max(0, character.xp - cxpAtLevel);
  const cxpSpan = cxpAtNext - cxpAtLevel;
  const cxpPct = cxpSpan > 0 ? Math.min(1, cxpIntoLevel / cxpSpan) : 1;
  const [equippedItems, setEquippedItems] = useState<Item[]>([]);
  useEffect(() => {
    fetch(`/api/character/${encodeURIComponent(character.slack_user_id)}/equipped`, { credentials: "include" })
      .then((r) => r.json() as Promise<{ items?: Item[] }>)
      .then((d) => { if (d.items) setEquippedItems(d.items); })
      .catch(() => {});
  }, [character.slack_user_id]);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        zIndex: 999,
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        style={{
          width: "min(760px, 100%)",
          maxHeight: "calc(100vh - 40px)",
          overflowY: "auto",
          background: "#111214",
          border: "1px solid #2a2d33",
          borderRadius: 16,
          padding: 22,
          boxShadow: "0 18px 60px rgba(0,0,0,0.45)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 18,
          }}
        >
          <div>
            <h2 style={h2}>Inspect {character.name}</h2>
            <p style={{ ...muted, margin: 0 }}>
              {character.class} • Lv {character.level}
              {character.slack_username ? ` • @${character.slack_username}` : ""}
            </p>
            <div style={{ marginTop: 6, minWidth: 200 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7280", marginBottom: 3 }}>
                <span style={{ color: "#d97706", fontWeight: 600, fontFamily: DISPLAY_FONT }}>XP</span>
                <span>{cxpIntoLevel} / {cxpSpan} → Lv {character.level + 1}</span>
              </div>
              <div style={{ height: 5, background: "#1a1a1f", borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  width: `${cxpPct * 100}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #92400e, #fbbf24)",
                  borderRadius: 3,
                }} />
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              ...button,
              color: "#cbd5e1",
              padding: "10px 14px",
            }}
          >
            Close
          </button>
        </div>

        <Stats>
          <Stat
            label="HP"
            icon={<Icon name="health-normal" color="#86efac" size={36} />}
            value={`${character.hp} / ${character.max_hp}`}
          />
          <Stat
            label="Mana"
            icon={<Icon name="wizard-staff" color="#a78bfa" size={36} />}
            value={`${character.mana} / ${character.max_mana}`}
          />
          <Stat
            label="Position"
            icon={<Icon name="flag" color="#fbbf24" size={36} />}
            value={character.position}
          />
          <Stat
            label="Scars"
            icon={<Icon name="death-skull" color="#ef4444" size={36} />}
            value={
              <span title={character.scars.length > 0 ? character.scars.join(", ") : undefined}>
                {character.scars.length}
              </span>
            }
          />
          <Stat
            label="Gold"
            icon={<Icon name="cash" color="#fbbf24" size={36} />}
            value={character.gold.toString()}
          />
          <Stat
            label="Status"
            icon={<Icon name="shield" color="#7dd3fc" size={36} />}
            value={isDowned ? "Downed" : "Ready"}
          />
        </Stats>
        {equippedItems.length > 0 && (
          <div style={{ marginTop: 20, borderTop: "1px solid #1e2028", paddingTop: 16 }}>
            <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
              Equipped
            </div>
            <ReadOnlyDoll items={equippedItems} />
          </div>
        )}
      </div>
    </div>
  );
}

export function HpBar({
  current,
  max,
  flavor,
}: {
  current: number;
  max: number;
  flavor: "monster" | "player";
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  let color = "var(--tone-good-2)";
  if (pct < 0.25) color = "var(--tone-bad-2)";
  else if (pct < 0.5) color = "var(--accent-gold-warm)";
  if (flavor === "monster") {
    if (pct < 0.25) color = "var(--tone-bad)";
    else if (pct < 0.5) color = "var(--accent-gold)";
    else color = "var(--tone-bad-2)";
  }
  return (
    <div className="bar" style={{ marginTop: 6, width: "100%" }}>
      <i style={{ width: `${pct * 100}%`, right: "auto", background: color, transition: "width 200ms ease" }} />
    </div>
  );
}

export function ArmorBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const empty = current === 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        minWidth: 36,
        color: empty ? "var(--tone-bad-2)" : "var(--fg-mute-2)",
      }}>
        {current}/{max} 🛡
      </div>
      <div className="bar" style={{ flex: 1, height: 6 }}>
        <i style={{
          width: `${pct * 100}%`,
          right: "auto",
          background: empty ? "var(--fg-mute-2)" : "var(--tone-ice)",
          transition: "width 200ms ease",
        }} />
      </div>
    </div>
  );
}

export function ManaBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        minWidth: 36,
        color: "var(--accent-arcane)",
      }}>
        {current}/{max}
      </div>
      <div className="bar" style={{ flex: 1, height: 6 }}>
        <i style={{
          width: `${pct * 100}%`,
          right: "auto",
          background: "var(--accent-arcane)",
          transition: "width 200ms ease",
        }} />
      </div>
    </div>
  );
}

export function EffectChips({ effects }: { effects: StatusEffect[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
      {effects.map((eff, i) => {
        const c = EFFECT_COLOR[eff.type];
        return (
          <span
            key={i}
            className="tag"
            style={{
              background: `${c}22`,
              color: c,
              border: `1px solid ${c}55`,
            }}
          >
            <Icon name={EFFECT_ICON[eff.type]} color={c} /> {eff.type} {eff.remaining}t
          </span>
        );
      })}
    </div>
  );
}

export function VariantBadge({ variant }: { variant: QuestVariant }) {
  return <SmallBadge>{variant}</SmallBadge>;
}

export function PositionBadge({ position }: { position: "front" | "back" }) {
  const front = position === "front";
  return (
    <span
      className="tag"
      style={{
        background: front ? "var(--accent-arcane-bg)" : "var(--tone-good-bg)",
        color:      front ? "var(--accent-arcane-2)"  : "var(--tone-good)",
        border:     `1px solid ${front ? "var(--accent-arcane-3)" : "var(--tone-good-br)"}`,
      }}
    >
      {position}
    </span>
  );
}

export function AdventurersCard({ selfId }: { selfId: string }) {
  const [characters, setCharacters] = useState<KnownCharacter[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<KnownCharacter | null>(null);

  useEffect(() => {
    fetch("/api/characters", { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<{ characters: KnownCharacter[] }> : Promise.resolve({ characters: [] }))
      .then((b) => setCharacters(b.characters))
      .finally(() => setLoading(false));
  }, [selfId]);

  if (loading || characters.length === 0) return null;

  const nowMs = Date.now();

  return (
    <>
      <div style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border-faint)",
        borderRadius: "var(--radius-2xl)",
        padding: 14,
      }}>
        <div className="eyebrow" style={{ marginBottom: 10, display: "inline-flex", alignItems: "center", gap: 5 }}>
          <Icon name="player" size={11} color="var(--accent-ink-blue)" /> Adventurers
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {characters.slice(0, 8).map((ch) => {
            const msAgo = nowMs - (ch.last_active ?? 0);
            const secsAgo = Math.floor(msAgo / 1000);
            const isOnline = msAgo < 15 * 60 * 1000;
            const isRecent = msAgo < 60 * 60 * 1000;
            const ago = secsAgo < 60 ? "just now"
              : secsAgo < 3600 ? `${Math.floor(secsAgo / 60)}m ago`
              : secsAgo < 86400 ? `${Math.floor(secsAgo / 3600)}h ago`
              : `${Math.floor(secsAgo / 86400)}d ago`;
            const hpPct = ch.max_hp > 0 ? Math.max(0, Math.min(1, ch.hp / ch.max_hp)) : 0;
            // Prefer the per-character custom portrait, fall back to the
            // class default if the user hasn't generated one (or it 404s).
            const portraitSrc = adventurerCharPortrait(ch.name);
            const fallbackPortrait = adventurerClassPortrait(ch.class);

            const isDowned = ch.downed_until != null && ch.downed_until > nowMs;
            return (
              <button
                key={ch.slack_user_id}
                onClick={() => setSheet(ch)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "7px 9px",
                  borderRadius: "var(--radius-md)",
                  background: "var(--bg-card-2)",
                  border: `1px solid ${isDowned ? "rgba(127,29,29,0.4)" : "var(--border-faint)"}`,
                  cursor: "pointer", width: "100%",
                  textAlign: "left", fontFamily: "inherit",
                  transition: "border-color 0.12s",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = isDowned ? "rgba(127,29,29,0.6)" : "var(--border-strong)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = isDowned ? "rgba(127,29,29,0.4)" : "var(--border-faint)"; }}
              >
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <Avatar src={portraitSrc} fallbackSrc={fallbackPortrait} alt={ch.name} size={32} radius={4} fallbackIcon="player" fallbackColor="var(--fg-faint)" style={{ opacity: isDowned ? 0.5 : 1 }} />
                  {isDowned ? (
                    <span style={{
                      position: "absolute", bottom: -1, right: -1,
                      width: 12, height: 12, borderRadius: "50%",
                      background: "#7f1d1d", border: "1.5px solid var(--bg-card-2)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <Icon name="death-skull" size={7} color="var(--tone-bad)" />
                    </span>
                  ) : isOnline && (
                    <span style={{
                      position: "absolute", bottom: -1, right: -1,
                      width: 8, height: 8, borderRadius: "50%",
                      background: "var(--tone-good-2)",
                      border: "1.5px solid var(--bg-card-2)",
                    }} />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{
                      fontFamily: "var(--font-display)",
                      fontSize: 13,
                      color: "var(--fg-1)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>{ch.name}</span>
                    <span style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: "var(--accent-arcane)",
                      flexShrink: 0,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                    }}>Lv {ch.level}</span>
                  </div>
                  <div style={{ display: "flex", gap: 4, overflow: "hidden" }}>
                    <span style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: "var(--fg-mute)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                    }}>{ch.class}</span>
                    {ch.slack_username && <span style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: "var(--accent-ink-blue)",
                      flexShrink: 0,
                    }}>@{ch.slack_username}</span>}
                  </div>
                  <div className="bar" style={{ marginTop: 4, height: 3 }}>
                    <i style={{
                      width: `${hpPct * 100}%`,
                      right: "auto",
                      background: hpPct < 0.25 ? "var(--tone-bad-2)" : hpPct < 0.5 ? "var(--accent-gold-warm)" : "var(--tone-good-2)",
                    }} />
                  </div>
                </div>
                <span style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  flexShrink: 0,
                  color: isOnline ? "var(--tone-good-2)" : isRecent ? "var(--fg-mute-2)" : "var(--fg-faint)",
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}>{ago}</span>
              </button>
            );
          })}
        </div>
      </div>
      {sheet && (
        <AdventurerSheet
          character={sheet}
          isOwn={sheet.slack_user_id === selfId}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}

export function AchievementToast({ def, onDismiss }: { def: Achievement; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, []);
  const gradient = `linear-gradient(135deg, ${def.gradient[0]}, ${def.gradient[1]})`;
  const glowColor = def.gradient[1];
  return (
    <div
      onClick={onDismiss}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        background: "var(--bg-panel)",
        border: "1px solid var(--accent-gold)",
        borderRadius: "var(--radius-2xl)",
        padding: "12px 16px",
        boxShadow: "var(--shadow-pop), var(--glow-target)",
        cursor: "pointer", minWidth: 280, maxWidth: 320,
        animation: "achievement-in 0.3s ease",
      }}
    >
      <div style={{
        width: 44, height: 44, borderRadius: "50%",
        background: gradient,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0,
        boxShadow: `0 0 12px 3px ${glowColor}55, inset 0 0 0 2px var(--accent-gold)`,
      }}>
        <i className={`ra ra-${def.icon}`} style={{ fontSize: 20, color: "#fff" }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="eyebrow" style={{ color: "var(--accent-gold)" }}>
          Achievement Unlocked
        </div>
        <div style={{
          fontSize: 14,
          color: "var(--fg-1)",
          marginTop: 3,
          fontFamily: "var(--font-display)",
          lineHeight: 1.15,
        }}>{def.title}</div>
        <div style={{
          fontSize: 11,
          color: "var(--accent-flavor)",
          fontStyle: "italic",
          marginTop: 3,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>{def.flavor}</div>
      </div>
    </div>
  );
}

export function AchievementToastStack({ queue, onDismiss }: { queue: Achievement[]; onDismiss: (id: string) => void }) {
  if (queue.length === 0) return null;
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24,
      display: "flex", flexDirection: "column", gap: 10,
      zIndex: 9999, pointerEvents: "none",
    }}>
      {queue.map((def) => (
        <div key={def.id} style={{ pointerEvents: "auto" }}>
          <AchievementToast def={def} onDismiss={() => onDismiss(def.id)} />
        </div>
      ))}
    </div>
  );
}

export function TrophyBadge({ def, earned, isOwn }: { def: Achievement; earned: EarnedAchievement | null; isOwn: boolean }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "top",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([useDismiss(context)]);
  const isEarned = earned !== null;
  const gradient = `linear-gradient(135deg, ${def.gradient[0]}, ${def.gradient[1]})`;
  const glowColor = def.gradient[1];

  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        onClick={() => isEarned && setOpen((o) => !o)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={isEarned ? def.title : isOwn ? "???" : undefined}
        style={{
          width: 44, height: 44,
          borderRadius: "50%",
          background: gradient,
          border: "none",
          cursor: isEarned ? "pointer" : "default",
          display: "flex", alignItems: "center", justifyContent: "center",
          filter: isEarned ? undefined : "grayscale(1)",
          opacity: isEarned ? 1 : 0.2,
          boxShadow: isEarned ? `0 0 10px 2px ${glowColor}44, 0 0 4px 1px ${glowColor}88` : undefined,
          transition: "box-shadow 0.2s, opacity 0.2s",
          flexShrink: 0,
          position: "relative",
        }}
      >
        <i className={`ra ra-${def.icon}`} style={{ fontSize: 18, color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.5)" }} />
        {isEarned && hovered && (
          <div style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
            background: "var(--bg-panel)", border: "1px solid var(--border-base)",
            borderRadius: "var(--radius-md)",
            padding: "4px 8px", fontSize: 11, color: "var(--fg-1)",
            fontFamily: "var(--font-display)",
            whiteSpace: "nowrap", pointerEvents: "none", zIndex: 10,
          }}>
            {def.title}
          </div>
        )}
        {!isEarned && isOwn && hovered && (
          <div style={{
            position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
            background: "var(--bg-panel)", border: "1px solid var(--border-base)",
            borderRadius: "var(--radius-md)",
            padding: "4px 8px", fontSize: 11, color: "var(--fg-faint)", whiteSpace: "nowrap",
            pointerEvents: "none", zIndex: 10,
          }}>
            ???
          </div>
        )}
      </button>
      {isEarned && open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
            <div
              ref={refs.setFloating}
              {...getFloatingProps()}
              style={{
                ...floatingStyles,
                background: "var(--bg-panel)",
                border: "1px solid var(--accent-gold)",
                borderRadius: "var(--radius-2xl)",
                padding: 16,
                width: 240,
                zIndex: 500,
                boxShadow: "var(--shadow-pop)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <div style={{
                  width: 52, height: 52, borderRadius: "50%",
                  background: gradient,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: `0 0 14px 3px ${glowColor}55, inset 0 0 0 2px var(--accent-gold)`,
                  flexShrink: 0,
                }}>
                  <i className={`ra ra-${def.icon}`} style={{ fontSize: 22, color: "#fff" }} />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "var(--fg-1)", fontFamily: "var(--font-display)" }}>{def.title}</div>
                  <div className="eyebrow" style={{ marginTop: 3 }}>{def.category}</div>
                </div>
              </div>
              <div className="flavor-line" style={{ marginBottom: 6 }}>{def.flavor}</div>
              <div style={{ fontSize: 11, color: "var(--fg-mute)", lineHeight: 1.5, marginBottom: 8 }}>{def.description}</div>
              {earned && (
                <div style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--tone-good-2)",
                  borderTop: "1px solid var(--border-faint)",
                  paddingTop: 6,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}>
                  Earned {new Date(earned.unlocked_at).toLocaleDateString()}
                </div>
              )}
              <button
                onClick={() => setOpen(false)}
                style={{ position: "absolute", top: 8, right: 8, background: "none", border: "none", color: "var(--fg-mute)", cursor: "pointer", fontSize: 14, padding: 4 }}
              >✕</button>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

export function TrophyShelf({ earned, allDefs, isOwn }: { earned: EarnedAchievement[]; allDefs: Achievement[]; isOwn: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const earnedMap = new Map(earned.map((e) => [e.id, e]));
  const allEarnedDefs = isOwn ? allDefs : allDefs.filter((d) => earnedMap.has(d.id));
  if (allEarnedDefs.length === 0 && !isOwn) return null;

  // Collapsed: show last 5 most recently earned
  const sortedEarned = [...earned].sort((a, b) => b.unlocked_at - a.unlocked_at);
  const recent5Ids = new Set(sortedEarned.slice(0, 5).map((e) => e.id));
  const collapsedDefs = allDefs.filter((d) => recent5Ids.has(d.id));
  const visibleDefs = expanded ? allEarnedDefs : collapsedDefs;
  const count = earned.length;
  const label = isOwn ? `${count} / ${allDefs.length} earned` : `${count} earned`;
  const canExpand = allEarnedDefs.length > 5 || (isOwn && allDefs.length > 5);

  return (
    <div style={{
      padding: 12,
      background: "var(--bg-card-2)",
      borderRadius: "var(--radius-xl)",
      border: "1px solid var(--border-faint)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div className="eyebrow" style={{ color: "var(--accent-gold)", display: "inline-flex", alignItems: "center", gap: 5 }}>
          <Icon name="trophy" size={10} color="var(--accent-gold)" /> Trophies · {label}
        </div>
        {canExpand && (
          <button
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Collapse" : "Show all"}
            style={{
              background: "none", border: "none", cursor: "pointer", padding: "2px 4px",
              color: "var(--fg-mute-3)", fontFamily: "var(--font-mono)", fontSize: 10,
              textTransform: "uppercase", letterSpacing: 0.5,
              display: "flex", alignItems: "center", gap: 3,
            }}
          >
            {expanded ? "▼ Less" : "▶ All"}
          </button>
        )}
      </div>
      {count === 0 && !expanded ? (
        <p style={{ color: "var(--fg-mute)", fontSize: 12, margin: 0, fontStyle: "italic" }}>No trophies earned yet.</p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {visibleDefs.map((def) => (
            <TrophyBadge key={def.id} def={def} earned={earnedMap.get(def.id) ?? null} isOwn={isOwn} />
          ))}
        </div>
      )}
    </div>
  );
}

export function AdventurerSheet({ character, isOwn = false, onClose }: { character: KnownCharacter; isOwn?: boolean; onClose: () => void }) {
  const [sheetEarned, setSheetEarned] = useState<EarnedAchievement[]>(character.achievements ?? []);
  const [sheetDefs, setSheetDefs] = useState<Achievement[]>([]);
  const [sheetEquipped, setSheetEquipped] = useState<Item[]>([]);

  useEffect(() => {
    const url = isOwn ? "/api/achievements" : `/api/achievements/${character.slack_user_id}`;
    fetch(url, { credentials: "include" })
      .then((r) => r.ok ? r.json() as Promise<AchievementsResponse> : null)
      .then((body) => {
        if (body) {
          setSheetEarned(body.earned);
          setSheetDefs(body.definitions);
        }
      })
      .catch(() => {});
  }, [character.slack_user_id, isOwn]);

  useEffect(() => {
    fetch(`/api/character/${encodeURIComponent(character.slack_user_id)}/equipped`, { credentials: "include" })
      .then((r) => r.json() as Promise<{ items?: Item[] }>)
      .then((d) => { if (d.items) setSheetEquipped(d.items); })
      .catch(() => {});
  }, [character.slack_user_id]);

  const msAgo = Date.now() - (character.last_active ?? 0);
  const secsAgo = Math.floor(msAgo / 1000);
  const hpPct = character.max_hp > 0 ? Math.max(0, Math.min(1, character.hp / character.max_hp)) : 0;
  const xpAtLevel = xpForLevel(character.level);
  const xpAtNext = xpForLevel(character.level + 1);
  const xpIntoLevel = Math.max(0, character.xp - xpAtLevel);
  const xpSpan = xpAtNext - xpAtLevel;
  const xpPct = xpSpan > 0 ? Math.min(1, xpIntoLevel / xpSpan) : 1;
  const portraitSrc = adventurerCharPortrait(character.name);
  const fallbackPortrait = adventurerClassPortrait(character.class);
  const ago = secsAgo < 60 ? "just now"
    : secsAgo < 3600 ? `${Math.floor(secsAgo / 60)}m ago`
    : secsAgo < 86400 ? `${Math.floor(secsAgo / 3600)}h ago`
    : `${Math.floor(secsAgo / 86400)}d ago`;
  const isOnline = msAgo < 15 * 60 * 1000;

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200 }}
      />
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 300,
        background: "#13141a", borderLeft: "1px solid #2a2d33",
        zIndex: 201, overflowY: "auto", padding: "24px 20px",
        display: "flex", flexDirection: "column", gap: 16,
      }}>
        <button
          onClick={onClose}
          style={{
            position: "absolute", top: 14, right: 14,
            background: "none", border: "none", color: "#6b7280",
            cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 4,
          }}
        >✕</button>

        <Avatar src={portraitSrc} fallbackSrc={fallbackPortrait} alt={character.name} size={80} radius={8} fallbackIcon="player" fallbackColor="#4a5568" />

        <div>
          <h2 style={{ ...h2, margin: "0 0 2px" }}>{character.name}</h2>
          {character.slack_username && (
            <div style={{ fontSize: 13, color: "#7dd3fc", marginBottom: 2 }}>@{character.slack_username}</div>
          )}
          <div style={{ ...muted, fontSize: 13 }}>{character.class}</div>
          {classByName(character.class)?.blurb && (
            <div style={{ fontSize: 11, color: "#6b7280", fontStyle: "italic", marginTop: 3, lineHeight: 1.4 }}>
              {classByName(character.class)?.blurb}
            </div>
          )}
          <div style={{ ...muted, fontSize: 12, marginTop: 4, color: isOnline ? "#22c55e" : "#6b7280" }}>
            {isOnline ? "● Online" : `Last seen ${ago}`}
          </div>
        </div>

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
            <span style={{ color: "#9ca3af" }}><Icon name="player" size={10} /> Level {character.level}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9ca3af", marginBottom: 4 }}>
            <span><Icon name="health-normal" size={10} /> HP</span>
            <span style={{ color: hpPct < 0.25 ? "#fca5a5" : "#f5f5f5" }}>{character.hp} / {character.max_hp}</span>
          </div>
          <div style={{ height: 6, background: "#1d1f23", borderRadius: 3, overflow: "hidden", marginBottom: 12 }}>
            <div style={{ width: `${hpPct * 100}%`, height: "100%", background: hpPct < 0.25 ? "#dc2626" : hpPct < 0.5 ? "#d97706" : "#16a34a", transition: "width 0.3s" }} />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9ca3af", marginBottom: 4 }}>
            <span><Icon name="lightning-sword" size={10} /> XP</span>
            <span style={{ color: "#f5f5f5" }}>{xpIntoLevel} / {xpSpan}</span>
          </div>
          <div style={{ height: 6, background: "#1d1f23", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ width: `${xpPct * 100}%`, height: "100%", background: "#6366f1", transition: "width 0.3s" }} />
          </div>
        </div>

        {character.str !== undefined && (() => {
          const stats: CoreStats = {
            str: character.str ?? 5,
            int_stat: character.int_stat ?? 5,
            vit: character.vit ?? 5,
            agi: character.agi ?? 5,
            dex: character.dex ?? 5,
          };
          const derived = deriveAll(stats, character.level);
          return (
            <div style={{ padding: "10px 12px", background: "#1d1f23", borderRadius: 8, border: "1px solid #2a2d33" }}>
              <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 7, fontFamily: DISPLAY_FONT }}>Stats</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4, marginBottom: 7 }}>
                {(["str", "int_stat", "vit", "agi", "dex"] as StatKey[]).map((key) => (
                  <div key={key} style={{ textAlign: "center", background: "#13141a", borderRadius: 5, padding: "5px 3px" }}>
                    <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", fontFamily: DISPLAY_FONT }}>{key === "int_stat" ? "INT" : key.toUpperCase()}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>{stats[key]}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 9px", fontSize: 10, color: "#9ca3af" }}>
                <span>ATK {derived.attack_mod >= 0 ? `+${derived.attack_mod}` : derived.attack_mod}</span>
                <span>MAG {derived.magic_mod >= 0 ? `+${derived.magic_mod}` : derived.magic_mod}</span>
                <span>Dodge {Math.round(derived.dodge_chance * 100)}%</span>
                <span>Crit +{Math.round(derived.crit_bonus * 100)}%</span>
              </div>
            </div>
          );
        })()}

        {sheetEquipped.length > 0 && (
          <div style={{ padding: "10px 12px", background: "#1d1f23", borderRadius: 8, border: "1px solid #2a2d33" }}>
            <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, fontFamily: DISPLAY_FONT }}>Equipment</div>
            <ReadOnlyDoll items={sheetEquipped} />
          </div>
        )}

        {character.scars && character.scars.length > 0 && (
          <div style={{ padding: "10px 12px", background: "#1d1f23", borderRadius: 8, border: "1px solid #2a2d33" }}>
            <div style={{ fontSize: 11, color: "#ef4444", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
              <Icon name="death-skull" size={10} /> {character.scars.length === 1 ? "1 Scar" : `${character.scars.length} Scars`}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {character.scars.map((scar, i) => (
                <div key={i} style={{ fontSize: 12, color: "#9ca3af", fontStyle: "italic" }}>"{scar}"</div>
              ))}
            </div>
          </div>
        )}

        {(sheetDefs.length > 0 || (isOwn && sheetEarned.length >= 0)) && (
          <TrophyShelf earned={sheetEarned} allDefs={sheetDefs} isOwn={isOwn} />
        )}
      </div>
    </>
  );
}

export function PrimaryStatCard({
  statKey, value, bonus, level,
}: {
  statKey: string; value: number; bonus: number; level: number;
}) {
  const meta = PRIMARY_STAT_META[statKey];
  if (!meta) return null;
  return (
    <HoverTooltip
      placement="top"
      panelStyle={{ border: `1px solid ${meta.color}`, minWidth: 170, maxWidth: 230 }}
      content={
        <>
          <div className="eyebrow" style={{ color: meta.color, marginBottom: 4 }}>{meta.label}</div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.55, fontFamily: "var(--font-mono)" }}>{meta.tooltip(value, level)}</div>
        </>
      }
    >
      <div style={{
        textAlign: "center",
        borderRadius: "var(--radius-md)",
        padding: "7px 4px",
        background: "var(--bg-input)",
        border: "1px solid var(--border-faint)",
        cursor: "default",
        transition: "border-color 0.12s, background 0.12s",
      }}>
        <div style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          color: "var(--fg-faintest)",
          textTransform: "uppercase",
          letterSpacing: 0.8,
        }}>
          {meta.label}
        </div>
        <div style={{
          fontSize: 18,
          color: "var(--fg-1)",
          lineHeight: 1.1,
          fontFamily: "var(--font-display)",
          transition: "color 0.12s",
          marginTop: 2,
        }}>
          {value}
        </div>
        {bonus > 0 && (
          <div style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            color: "var(--tone-good-2)",
            lineHeight: 1.3,
            marginTop: 1,
          }}>+{bonus}</div>
        )}
      </div>
    </HoverTooltip>
  );
}

export function DerivedStatCard({
  icon, label, value, color, formula,
}: {
  icon: string; label: string; value: string; color: string; formula: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{
        background: "var(--bg-input)",
        borderRadius: "var(--radius-md)",
        padding: "7px 4px 6px",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
        border: `1px solid ${hovered ? color : "var(--border-faint)"}`,
        cursor: "default",
        transition: "border-color 0.12s",
      }}>
        <Icon name={icon} size={18} color={color} />
        <div style={{
          fontSize: 15,
          color,
          lineHeight: 1,
          fontFamily: "var(--font-display)",
        }}>{value}</div>
        <div style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          color: "var(--fg-faintest)",
          textTransform: "uppercase",
          letterSpacing: 0.7,
          lineHeight: 1,
        }}>{label}</div>
      </div>
      {hovered && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%",
          transform: "translateX(-50%)",
          background: "var(--bg-panel)",
          border: `1px solid ${color}`,
          borderRadius: "var(--radius-md)",
          padding: "8px 10px", zIndex: 50,
          minWidth: 160, maxWidth: 220,
          boxShadow: "var(--shadow-pop)",
          pointerEvents: "none",
          whiteSpace: "pre-line",
        }}>
          <div className="eyebrow" style={{ color, marginBottom: 4 }}>{label}</div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.55, fontFamily: "var(--font-mono)" }}>{formula}</div>
        </div>
      )}
    </div>
  );
}

export function CharacterCard({
  me,
  inventory,
  inQuest,
  onRest,
  onLogout,
  onReroll,
  onSpend,
  onSaveNotifyPref,
  onOpenDevTools,
  onRefresh,
  hideMenu,
}: {
  me: MeResponse;
  inventory: Item[];
  inQuest: boolean;
  onRest: (kind: "short" | "long") => void;
  onLogout: () => void;
  onReroll: (className?: string) => Promise<void>;
  onSpend?: (stat: StatKey) => void;
  onSaveNotifyPref?: (pref: "thread" | "dm") => Promise<void>;
  onOpenDevTools?: () => void;
  onRefresh?: () => Promise<void>;
  /** When true, the in-card gear/account popover (and its CharacterSlotsModal)
      are suppressed. Use this when the parent renders the AccountPopover
      elsewhere — e.g. in the AppTopBar. */
  hideMenu?: boolean;
}) {
  const [slotsOpen, setSlotsOpen] = useState(false);
  const [trophyDefs, setTrophyDefs] = useState<Achievement[]>([]);
  const [trophyEarned, setTrophyEarned] = useState<EarnedAchievement[]>([]);
  const [abilitiesOpen, setAbilitiesOpen] = useState(false);
  useEffect(() => {
    fetch("/api/achievements")
      .then((r) => r.ok ? r.json() as Promise<AchievementsResponse> : null)
      .then((data) => {
        if (!data) return;
        setTrophyDefs(data.definitions);
        setTrophyEarned(data.earned);
      })
      .catch(() => {});
  }, [me.character?.slack_user_id]);
  const c = me.character;
  if (!c) {
    return (
      <div style={card}>
        <h1 style={h1}>No character yet</h1>
        <p style={muted}>
          Roll one up in Slack with <code style={kbd}>/gq quest</code>, then
          reload here.
        </p>
      </div>
    );
  }
  const xpAtLevel = xpForLevel(c.level);
  const xpAtNext = xpForLevel(c.level + 1);
  const xpIntoLevel = Math.max(0, c.xp - xpAtLevel);
  const xpSpan = xpAtNext - xpAtLevel;
  const xpPct = xpSpan > 0 ? Math.min(1, xpIntoLevel / xpSpan) : 1;
  const fullyRecovered = c.hp >= c.max_hp && c.mana >= c.max_mana;
  const downed = c.downed_until !== null && c.downed_until > Date.now();
  const equippedBySlot = (slot: EquipSlot) => inventory.find((i) => i.equipped && (i.slot === slot || (i.slot === null && i.item_type === (slot === "main_hand" ? "weapon" : slot === "body" ? "armor" : ""))));
  const bodyArmor = equippedBySlot("body");
  const helmetArmor = equippedBySlot("helmet");
  const pantsArmor = equippedBySlot("pants");
  const shieldArmor = inventory.find((i) => i.equipped && i.slot === "off_hand" && i.item_subtype === "shield");
  const armorPower = (bodyArmor?.power ?? 0) + Math.floor((helmetArmor?.power ?? 0) / 2) + Math.floor((pantsArmor?.power ?? 0) / 4) + (shieldArmor?.power ?? 0);
  const restDisabled = inQuest || downed || fullyRecovered;
  const portrait = me.char_art_url ?? me.class_art_url;
  const equipBonuses: Partial<Record<StatKey, number>> = {};
  for (const item of inventory) {
    if (item.equipped && item.stat_bonus) {
      for (const [k, v] of Object.entries(item.stat_bonus)) {
        equipBonuses[k as StatKey] = (equipBonuses[k as StatKey] ?? 0) + v;
      }
    }
  }
  const baseStats: CoreStats = {
    str: c.str ?? 5,
    int_stat: c.int_stat ?? 5,
    vit: c.vit ?? 5,
    agi: c.agi ?? 5,
    dex: c.dex ?? 5,
  };
  const primaryStats: CoreStats = {
    str: baseStats.str + (equipBonuses.str ?? 0),
    int_stat: baseStats.int_stat + (equipBonuses.int_stat ?? 0),
    vit: baseStats.vit + (equipBonuses.vit ?? 0),
    agi: baseStats.agi + (equipBonuses.agi ?? 0),
    dex: baseStats.dex + (equipBonuses.dex ?? 0),
  };
  const derivedStats = deriveAll(primaryStats, c.level);
  const hasUnspentPoints = (c.unspent_points ?? 0) > 0;
  const statHasData = c.str !== undefined;
  return (
    <div style={{
      position: "relative",
      background: "var(--bg-panel)",
      border: "1px solid var(--accent-ink-blue-2)",
      borderRadius: "var(--radius-2xl)",
      padding: 16,
      boxShadow: "var(--shadow-pop)",
    }}>
      {!hideMenu && (
        <AccountPopover onLogout={onLogout} onReroll={onReroll} character={c} onSaveNotifyPref={onSaveNotifyPref} onOpenDevTools={onOpenDevTools} onOpenCharacterSlots={() => setSlotsOpen(true)} />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 4 }}>
        <div style={{
          width: 76, height: 76, flexShrink: 0,
          borderRadius: "var(--radius-lg)",
          background: "var(--bg-void)",
          border: "1px solid var(--accent-ink-blue-2)",
          display: "flex", alignItems: "center", justifyContent: "center",
          overflow: "hidden",
        }}>
          <Avatar
            src={portrait}
            alt={`${c.class} portrait`}
            size={72}
            radius={6}
            fallbackIcon="player"
            fallbackColor="var(--accent-ink-blue)"
          />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontSize: 22,
            lineHeight: 1.1,
            color: "var(--fg-1)",
          }}>{c.name}</h1>
          {c.slack_username && (
            <p style={{
              margin: "3px 0 0",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--accent-ink-blue)",
            }}>
              @{c.slack_username}
            </p>
          )}
          <p style={{
            margin: "4px 0 0",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--accent-arcane)",
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}>
            {c.class} · Lv {c.level}
          </p>
          <p className="flavor-line" style={{ margin: "5px 0 0", fontSize: 11 }}>
            {classByName(c.class)?.blurb}
          </p>
          <div style={{ marginTop: 8, minWidth: 160 }}>
            <div style={{
              display: "flex", justifyContent: "space-between",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--fg-mute-3)",
              marginBottom: 3,
              textTransform: "uppercase",
              letterSpacing: 0.6,
            }}>
              <span style={{ color: "var(--accent-gold)" }}>XP</span>
              <span>{xpIntoLevel} / {xpSpan}</span>
            </div>
            <div className="bar" style={{ height: 5 }}>
              <i style={{
                width: `${xpPct * 100}%`,
                right: "auto",
                background: "linear-gradient(90deg, var(--accent-gold-deep), var(--accent-gold))",
                transition: "width 0.4s ease",
              }} />
            </div>
          </div>
        </div>
      </div>
      <Stats>
        <Stat
          label="HP"
          icon={<Icon name="health-normal" color="#86efac" size={36} />}
          tooltip={`VIT ${primaryStats.vit}  ·  Level ${c.level}\n16 + 2×${primaryStats.vit} + 2×${c.level} = ${c.max_hp} max HP`}
          value={`${c.hp} / ${c.max_hp}`}
        />
        <Stat
          label="Mana"
          icon={<Icon name="wizard-staff" color="#a78bfa" size={36} />}
          tooltip={`INT ${primaryStats.int_stat}\n2 + floor((INT − 4) / 2) + floor(level / 6) = ${c.max_mana} max mana\nSpent to cast active abilities`}
          value={`${c.mana} / ${c.max_mana}`}
        />
        <Stat
          label="Armor"
          icon={<Icon name="shield" color="#9ca3af" size={36} />}
          tooltip={armorPower > 0
            ? `Armor pool: ${c.shield} / ${Math.floor(armorPower / 2)}\nPhysical hits deplete armor before HP\nRestored on rest or at the smithy\n\nFormula:\n  body (${bodyArmor?.power ?? 0})\n  + helmet/2 (${Math.floor((helmetArmor?.power ?? 0) / 2)})\n  + pants/4 (${Math.floor((pantsArmor?.power ?? 0) / 4)})\n  + shield (${shieldArmor?.power ?? 0})\n  = ${armorPower} armor power\n  ÷ 2 = ${Math.floor(armorPower / 2)} max pool${derivedStats.armor_bonus > 0 ? `\n\n+${derivedStats.armor_bonus} bonus from VIT ${primaryStats.vit}` : ""}`
            : `No armor equipped\nEquip body armor, helmet, pants,\nor a shield to reduce physical damage\n\nFormula:\n  body + helmet/2 + pants/4 + shield\n  = armor power ÷ 2 = max pool`}
          value={armorPower > 0
            ? <span style={{ color: c.shield === 0 ? "#ef4444" : undefined }}>{c.shield} / {Math.floor(armorPower / 2)}</span>
            : <span style={muted}>—</span>}
        />
        <Stat
          label="Gold"
          icon={<Icon name="cash" color="#fbbf24" size={36} />}
          tooltip={`Current balance: ${c.gold}g\nEarned from kills, quests, and selling\nSpend at the Shop or Apothecary`}
          value={c.gold.toString()}
        />
        <Stat
          label="Scars"
          icon={<Icon name="death-skull" color="#ef4444" size={36} />}
          tooltip={c.scars.length > 0
            ? `${c.scars.length} permanent ${c.scars.length === 1 ? "penalty" : "penalties"}\n${c.scars.join("\n")}`
            : "No scars yet\nEarned by dying in combat\n(soft death mode — capped at 3)"}
          value={c.scars.length.toString()}
        />
      </Stats>
      {/* Primary stats block — only shown after migration 0032 */}
      {(statHasData || hasUnspentPoints) && (
        <div style={{
          marginTop: 12,
          padding: "12px 12px",
          background: "var(--bg-card-2)",
          borderRadius: "var(--radius-xl)",
          border: "1px solid var(--border-faint)",
        }}>
          <div className="eyebrow" style={{ marginBottom: 8, color: "var(--fg-mute-3)" }}>Primary Stats</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 5, marginBottom: 8 }}>
            {(["str", "int_stat", "vit", "agi", "dex"] as StatKey[]).map((key) => (
              <PrimaryStatCard
                key={key}
                statKey={key}
                value={primaryStats[key]}
                bonus={equipBonuses[key] ?? 0}
                level={c.level}
              />
            ))}
          </div>
          {(() => {
            const { str, int_stat: int, vit, agi, dex } = primaryStats;
            const atkVal = derivedStats.attack_mod >= 0 ? `+${derivedStats.attack_mod}` : `${derivedStats.attack_mod}`;
            const magVal = derivedStats.magic_mod >= 0 ? `+${derivedStats.magic_mod}` : `${derivedStats.magic_mod}`;
            const dodgePct = Math.round(derivedStats.dodge_chance * 100);
            const critPct  = Math.round(derivedStats.crit_bonus * 100);
            const initVal  = derivedStats.initiative_bonus >= 0 ? `+${derivedStats.initiative_bonus}` : `${derivedStats.initiative_bonus}`;
            const stats: { icon: string; label: string; value: string; color: string; formula: string }[] = [
              {
                icon: "sword-brandish", label: "Attack", value: atkVal, color: "#f87171",
                formula: `STR ${str}\nfloor((${str} − 5) / 2) = ${atkVal}\nAdded to weapon damage rolls`,
              },
              {
                icon: "wizard-staff", label: "Magic", value: magVal, color: "#7dd3fc",
                formula: `INT ${int}\nfloor((${int} − 5) / 2) = ${magVal}\nAdded to spell & heal rolls`,
              },
              {
                icon: "dodging", label: "Dodge", value: `${dodgePct}%`, color: "#34d399",
                formula: `AGI ${agi}\nmin(15%, (${agi} − 5) × 1%) = ${dodgePct}%\nChance to fully negate a hit`,
              },
              {
                icon: "target-poster", label: "Crit", value: `+${critPct}%`, color: "#fbbf24",
                formula: `DEX ${dex}\nmax(0, (${dex} − 5) × 1%) = +${critPct}%\nBonus crit chance (cap 10%)`,
              },
              {
                icon: "coffee-cup", label: "Init", value: initVal, color: "#fb923c",
                formula: `AGI ${agi}\nfloor((${agi} − 5) / 2) = ${initVal}\nAdded to d6 initiative roll`,
              },
              ...(derivedStats.armor_bonus > 0 ? [{
                icon: "round-shield", label: "Armor", value: `+${derivedStats.armor_bonus}`, color: "#a78bfa",
                formula: `VIT ${vit}\nfloor((${vit} − 5) / 4) = +${derivedStats.armor_bonus}\nBonus armor on top of gear`,
              }] : []),
            ];
            return (
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${stats.length}, 1fr)`, gap: 5 }}>
                {stats.map((s) => <DerivedStatCard key={s.label} {...s} />)}
              </div>
            );
          })()}
          {hasUnspentPoints && onSpend && (
            <div style={{
              marginTop: 10,
              padding: "9px 10px",
              background: "var(--accent-ink-deep)",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--accent-ink-blue-2)",
            }}>
              <div style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--accent-ink-blue)",
                marginBottom: 7,
              }}>
                +{c.unspent_points} unspent {c.unspent_points === 1 ? "point" : "points"} — choose a stat:
              </div>
              <div style={{ display: "flex", gap: 5 }}>
                {(["str", "int_stat", "vit", "agi", "dex"] as StatKey[]).map((key) => (
                  <button
                    key={key}
                    onClick={() => onSpend(key)}
                    className="btn btn-ghost btn-sm"
                    style={{
                      flex: 1,
                      justifyContent: "center",
                      padding: "6px 0",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      letterSpacing: 0.5,
                      color: "var(--accent-ink-blue)",
                      borderColor: "var(--accent-ink-blue-3)",
                    }}
                  >
                    {key === "int_stat" ? "INT" : key.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {/* Abilities section */}
      {(() => {
        const abilities = classByName(c.class)?.abilities ?? [];
        if (abilities.length === 0) return null;
        return (
          <div style={{
            marginTop: 12,
            padding: "10px 12px",
            background: "var(--bg-card-2)",
            borderRadius: "var(--radius-xl)",
            border: "1px solid var(--border-faint)",
          }}>
            <button
              onClick={() => setAbilitiesOpen(o => !o)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                width: "100%", background: "none", border: "none", cursor: "pointer", padding: 0,
              }}
            >
              <span className="eyebrow">Abilities</span>
              <span style={{
                fontSize: 10,
                color: "var(--fg-faint)",
                display: "inline-block",
                transform: abilitiesOpen ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.15s ease",
              }}>▼</span>
            </button>
            {abilitiesOpen && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {abilities.map((ab) => (
                  <div key={ab.id} style={{
                    display: "flex", gap: 8,
                    padding: "8px 8px",
                    background: "var(--bg-input)",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-faint)",
                    alignItems: "flex-start",
                  }}>
                    <div style={{
                      flexShrink: 0, width: 32, height: 32,
                      background: "var(--bg-void)",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border-base)",
                      display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1,
                    }}>
                      {ab.kind === "active"
                        ? <Icon name={ab.icon} size={18} color="var(--fg-mute-2)" />
                        : <Icon name="abstract-006" size={16} color="var(--fg-faint)" />
                      }
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginBottom: 3 }}>
                        <span style={{
                          fontSize: 13, color: "var(--fg-1)",
                          fontFamily: "var(--font-display)",
                          lineHeight: 1,
                        }}>{ab.name}</span>
                        <span className="tag" style={{
                          background: ab.kind === "active" ? "var(--accent-ink-deep)" : "var(--tone-good-bg)",
                          color: ab.kind === "active" ? "var(--accent-ink-blue)" : "var(--tone-good)",
                        }}>
                          {ab.kind}
                        </span>
                        {ab.kind === "active" && ab.mana_cost > 0 && (
                          <span className="tag" style={{
                            background: "var(--accent-arcane-bg)",
                            color: "var(--accent-arcane)",
                          }}>
                            {ab.mana_cost} mana
                          </span>
                        )}
                        {ab.kind === "active" && ab.mana_cost === 0 && (
                          <span className="tag" style={{
                            background: "var(--tone-good-bg)",
                            color: "var(--tone-good)",
                          }}>
                            free
                          </span>
                        )}
                        {ab.kind === "active" && (ab.cooldown_turns ?? 0) > 0 && (
                          <span className="tag" style={{
                            background: "rgba(251,191,36,0.12)",
                            color: "var(--accent-gold)",
                          }}>
                            {ab.cooldown_turns}t CD
                          </span>
                        )}
                        {ab.kind === "passive" && (
                          <span className="tag" style={{
                            background: "rgba(129,140,248,0.12)",
                            color: "#818cf8",
                          }}>
                            {ab.trigger.replace(/_/g, " ")}
                          </span>
                        )}
                      </div>
                      <p style={{ margin: 0, fontSize: 11, color: "var(--fg-mute)", lineHeight: 1.45 }}>{ab.blurb}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
      {/* Camp section */}
      <div style={{
        marginTop: 16,
        padding: "10px 12px",
        background: "var(--bg-card-2)",
        borderRadius: "var(--radius-xl)",
        border: "1px solid var(--border-faint)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Icon name="campfire" size={11} color="var(--accent-gold-warm)" /> Camp
          </span>
          {(downed || (!downed && inQuest)) && (
            <span style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: downed ? "var(--tone-bad)" : "var(--fg-mute-3)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}>
              {downed ? "Downed" : "In quest"}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => onRest("short")}
            disabled={restDisabled}
            className="btn btn-ghost btn-sm"
            style={{
              flex: 1,
              justifyContent: "center",
              color: restDisabled ? "var(--fg-mute-3)" : "var(--tone-good)",
              borderColor: restDisabled ? "var(--border-faint)" : "var(--tone-good-br)",
            }}
          >
            <Icon name="campfire" /> Short rest
          </button>
          <button
            onClick={() => onRest("long")}
            disabled={restDisabled}
            className="btn btn-ghost btn-sm"
            style={{
              flex: 1,
              justifyContent: "center",
              color: restDisabled ? "var(--fg-mute-3)" : "var(--accent-ink-blue)",
              borderColor: restDisabled ? "var(--border-faint)" : "var(--accent-ink-blue-3)",
            }}
          >
            <Icon name="moon-sun" /> Long rest
          </button>
        </div>
      </div>
      {trophyDefs.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <TrophyShelf earned={trophyEarned} allDefs={trophyDefs} isOwn={true} />
        </div>
      )}
      {!hideMenu && slotsOpen && (
        <CharacterSlotsModal
          activeCharacter={c}
          inQuest={inQuest}
          onClose={() => setSlotsOpen(false)}
          onChanged={async () => { if (onRefresh) await onRefresh(); }}
        />
      )}
    </div>
  );
}

export function CharacterSlotsModal({
  activeCharacter,
  inQuest,
  onClose,
  onChanged,
}: {
  activeCharacter: { name: string; class: string; level: number; active_slot?: number };
  inQuest: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<SlotsListResponse | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [pickClassFor, setPickClassFor] = useState<number | null>(null);
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  async function reload() {
    const res = await fetch("/api/character-slots", { credentials: "include" });
    if (!res.ok) return;
    setView(await res.json() as SlotsListResponse);
  }
  useEffect(() => { void reload(); }, []);

  async function activate(slot: number) {
    setBusy(slot);
    const res = await fetch(`/api/character-slots/${slot}/activate`, { method: "POST", credentials: "include" });
    setBusy(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (body.error === "mid_quest") toast.error("Finish your quest before switching.");
      else toast.error("Switch failed.");
      return;
    }
    toast.success("Character switched.");
    await onChanged();
    onClose();
  }

  async function createInSlot(slot: number, cls: string | null) {
    setBusy(slot);
    const res = await fetch("/api/character-slots/new", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cls ? { slot, class: cls } : { slot }),
    });
    setBusy(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (body.error === "mid_quest") toast.error("Finish your quest before creating a new character.");
      else toast.error("Create failed.");
      return;
    }
    toast.success("New hero rolled!");
    await onChanged();
    onClose();
  }

  async function deleteSlot(slot: number) {
    setBusy(slot);
    const res = await fetch(`/api/character-slots/${slot}`, { method: "DELETE", credentials: "include" });
    setBusy(null);
    setConfirmDelete(null);
    if (!res.ok) { toast.error("Delete failed."); return; }
    toast.success("Slot cleared.");
    await reload();
  }

  // Render 3 slots in order 1..3. For each: active / saved / empty.
  const activeSlot = view?.active_slot ?? activeCharacter.active_slot ?? 1;
  const savedBySlot = new Map<number, SlotsListResponse["saved"][number]>();
  for (const s of view?.saved ?? []) savedBySlot.set(s.slot, s);

  return (
    <ModalBackdrop onCancel={onClose}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#f5f5f5", marginBottom: 4 }}>Character slots</div>
      <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 16 }}>
        Keep up to three builds. Switching snapshots your active character into its slot.
      </div>
      {inQuest && (
        <div style={{ fontSize: 12, color: "#fca5a5", marginBottom: 12, padding: "6px 10px", background: "#2a1010", borderRadius: 6, border: "1px solid #4a2020" }}>
          You're in a quest — finish or abandon it before switching or creating a character.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[1, 2, 3].map((slot) => {
          const isActive = slot === activeSlot;
          const saved = savedBySlot.get(slot);
          const slotBusy = busy === slot;
          return (
            <div
              key={slot}
              style={{
                padding: "10px 12px",
                background: isActive ? "#1a2a1a" : "#16181c",
                borderRadius: 8,
                border: `1px solid ${isActive ? "#3a5a3a" : "#2a2d33"}`,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div style={{ fontSize: 11, color: "#6b7280", width: 38, fontWeight: 600 }}>Slot {slot}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {isActive ? (
                  <>
                    <div style={{ fontSize: 13, color: "#f5f5f5", fontWeight: 600 }}>{activeCharacter.name}</div>
                    <div style={{ fontSize: 11, color: "#86efac" }}>Active • {activeCharacter.class} • Lv {activeCharacter.level}</div>
                  </>
                ) : saved ? (
                  <>
                    <div style={{ fontSize: 13, color: "#f5f5f5", fontWeight: 600 }}>{saved.name}</div>
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>{saved.class} • Lv {saved.level}</div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic" }}>Empty</div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {isActive ? (
                  <span style={{ fontSize: 11, color: "#86efac", padding: "4px 8px" }}>Active</span>
                ) : saved ? (
                  <>
                    <button
                      onClick={() => activate(slot)}
                      disabled={inQuest || slotBusy}
                      style={smallActionBtn(inQuest ? "#222428" : "#1a2a1a", inQuest ? "#6b7280" : "#86efac")}
                    >
                      {slotBusy ? "…" : "Activate"}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(slot)}
                      disabled={slotBusy}
                      style={smallActionBtn("#2a0f0f", "#fca5a5")}
                    >
                      Delete
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => { setPickClassFor(slot); setSelectedClass(null); }}
                    disabled={inQuest || slotBusy}
                    style={smallActionBtn(inQuest ? "#222428" : "#1a1c2a", inQuest ? "#6b7280" : "#93c5fd")}
                  >
                    {slotBusy ? "Rolling…" : "Create"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
        <button onClick={onClose} style={smallActionBtn("#222428", "#9ca3af")}>Close</button>
      </div>
      {pickClassFor !== null && (
        <ModalBackdrop onCancel={() => setPickClassFor(null)}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#f5f5f5", marginBottom: 4 }}>Pick a class for slot {pickClassFor}</div>
          <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>Leave unselected to roll a random class.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
            {CLASSES.map((cls) => {
              const on = selectedClass === cls.name;
              return (
                <button
                  key={cls.id}
                  onClick={() => setSelectedClass(on ? null : cls.name)}
                  title={cls.blurb}
                  style={{
                    ...smallActionBtn(on ? "#2a2410" : "#1a1c20", on ? "#fde68a" : "#9ca3af"),
                    fontSize: 11, padding: "5px 8px", textAlign: "left",
                    outline: on ? "1px solid #fde68a44" : "none",
                  }}
                >
                  {cls.name}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={() => setPickClassFor(null)} style={smallActionBtn("#222428", "#9ca3af")}>Cancel</button>
            <button
              onClick={() => { const slot = pickClassFor; setPickClassFor(null); void createInSlot(slot, selectedClass); }}
              style={smallActionBtn("#1a2a1a", "#86efac")}
            >
              Roll
            </button>
          </div>
        </ModalBackdrop>
      )}
      {confirmDelete !== null && (
        <ModalBackdrop onCancel={() => setConfirmDelete(null)}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#f5f5f5", marginBottom: 4 }}>Delete slot {confirmDelete}?</div>
          <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>
            The saved build will be lost permanently. This doesn't touch your active character.
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirmDelete(null)} style={smallActionBtn("#222428", "#9ca3af")}>Cancel</button>
            <button onClick={() => deleteSlot(confirmDelete)} style={smallActionBtn("#2a0f0f", "#fca5a5")}>Delete</button>
          </div>
        </ModalBackdrop>
      )}
    </ModalBackdrop>
  );
}

function SignOutRow({ onLogout }: { onLogout: () => void }) {
  return (
    <button onClick={onLogout} style={{ ...button, background: "#33363d" }}>
      Sign out
    </button>
  );
}

export function AccountPopover({
  onLogout,
  onReroll,
  character,
  onSaveNotifyPref,
  onOpenDevTools,
  onOpenCharacterSlots,
  placement = "top-start",
  buttonStyle,
}: {
  onLogout: () => void;
  onReroll: (className?: string) => Promise<void>;
  character: { name: string; notification_pref?: "thread" | "dm" } | null;
  onSaveNotifyPref?: (pref: "thread" | "dm") => Promise<void>;
  onOpenDevTools?: () => void;
  onOpenCharacterSlots?: () => void;
  /** Floating UI placement; defaults to top-start which suits the in-sheet
      position. The header instance overrides to bottom-end. */
  placement?: "top-start" | "bottom-end" | "bottom-start" | "top-end";
  /** Inline overrides for the trigger button — header usage drops absolute
      positioning and reskins the button. */
  buttonStyle?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [rerollStep, setRerollStep] = useState<"idle" | "pick-class" | "confirm">("idle");
  const [selectedClasses, setSelectedClasses] = useState<Set<string>>(new Set());
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [rerolling, setRerolling] = useState(false);
  const [showNotifyModal, setShowNotifyModal] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (v) => { setOpen(v); if (!v) { setRerollStep("idle"); setSelectedClasses(new Set()); setSelectedClass(null); } },
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    placement,
    whileElementsMounted: autoUpdate,
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  function rollFromSelection() {
    const pool = Array.from(selectedClasses);
    const picked = pool[Math.floor(Math.random() * pool.length)];
    setSelectedClass(picked);
    setRerollStep("confirm");
  }

  async function confirmReroll() {
    setRerolling(true);
    await onReroll(selectedClass ?? undefined);
    setRerolling(false);
    setOpen(false);
    setRerollStep("idle");
    setSelectedClasses(new Set());
    setSelectedClass(null);
  }

  return (
    <>
      <button
        ref={refs.setReference}
        onClick={() => { setOpen((v) => !v); setRerollStep("idle"); setSelectedClasses(new Set()); setSelectedClass(null); }}
        title="Account"
        style={buttonStyle ?? {
          position: "absolute", top: 8, right: 8,
          background: "none", border: "1px solid #3a3d44", borderRadius: 5,
          color: "#9ca3af", cursor: "pointer", padding: "3px 7px",
          lineHeight: 1, fontFamily: "inherit", display: "flex", alignItems: "center",
        }}
      >
        <Icon name="gears" size={14} />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, zIndex: 300 }}
            {...getFloatingProps()}
          >
            <div style={{ padding: 12, background: "#1d1f23", borderRadius: 8, border: "1px solid #2a2d33", boxShadow: "0 8px 24px rgba(0,0,0,0.6)", minWidth: 220, display: "flex", flexDirection: "column", gap: 6 }}>
              {/* Sign Out */}
              <button
                onClick={() => { setOpen(false); onLogout(); }}
                style={{ ...smallActionBtn("#1a1c20", "#f87171"), textAlign: "left" }}
              >
                <Icon name="player" size={13} /> Sign out
              </button>

              {/* Notifications */}
              {onSaveNotifyPref && (
                <button
                  onClick={() => { setOpen(false); setShowNotifyModal(true); }}
                  style={{ ...smallActionBtn("#1a1c20", "#93c5fd"), textAlign: "left" }}
                >
                  <Icon name="bell" size={13} /> Notifications
                </button>
              )}

              {/* Character slots */}
              {onOpenCharacterSlots && (
                <button
                  onClick={() => { setOpen(false); onOpenCharacterSlots(); }}
                  style={{ ...smallActionBtn("#1a1c20", "#a7f3d0"), textAlign: "left" }}
                >
                  <Icon name="player" size={13} /> Characters
                </button>
              )}

              {/* Dev tools — local env only */}
              {import.meta.env.DEV && onOpenDevTools && (
                <button
                  onClick={() => { setOpen(false); onOpenDevTools(); }}
                  style={{ ...smallActionBtn("#1a1c20", "#a78bfa"), textAlign: "left" }}
                >
                  <Icon name="cog" size={13} /> Dev tools
                </button>
              )}

              {/* Reroll */}
              <div style={{ borderTop: "1px solid #2a2d33", paddingTop: 8, marginTop: 2 }}>
                {rerollStep === "idle" ? (
                  <button
                    onClick={() => setRerollStep("pick-class")}
                    style={{ ...smallActionBtn("#1a1c20", "#fde68a"), width: "100%", textAlign: "left" }}
                  >
                    <Icon name="dice-six-faces-random" size={13} /> Reroll character
                  </button>
                ) : rerollStep === "pick-class" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ fontSize: 12, color: "#f5f5f5", fontWeight: 600 }}>Pick classes to roll from</div>
                      <button
                        onClick={() => setSelectedClasses(selectedClasses.size === CLASSES.length ? new Set() : new Set(CLASSES.map((c) => c.name)))}
                        style={{ ...smallActionBtn("#1a1c20", "#a78bfa"), fontSize: 10, padding: "2px 6px" }}
                      >
                        {selectedClasses.size === CLASSES.length ? "None" : "All"}
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                      {CLASSES.map((cls) => {
                        const on = selectedClasses.has(cls.name);
                        return (
                          <button
                            key={cls.id}
                            onClick={() => {
                              const next = new Set(selectedClasses);
                              on ? next.delete(cls.name) : next.add(cls.name);
                              setSelectedClasses(next);
                            }}
                            title={cls.blurb}
                            style={{
                              ...smallActionBtn(on ? "#2a2410" : "#1a1c20", on ? "#fde68a" : "#6b7280"),
                              fontSize: 11, padding: "4px 6px", textAlign: "left",
                              outline: on ? "1px solid #fde68a44" : "none",
                            }}
                          >
                            {cls.name}
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                      <button
                        onClick={rollFromSelection}
                        disabled={selectedClasses.size === 0}
                        style={{ ...smallActionBtn("#1a2a10", "#86efac"), flex: 1 }}
                      >
                        <Icon name="dice-six-faces-random" size={13} /> Roll{selectedClasses.size > 1 ? ` (${selectedClasses.size})` : ""}
                      </button>
                      <button onClick={() => setRerollStep("idle")} style={smallActionBtn("#222428", "#6b7280")}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 12, color: "#f5f5f5", fontWeight: 600 }}>Reroll as {selectedClass}?</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.4 }}>
                      All gear, gold, and levels will be lost. Free to do — the forfeit is the cost.
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={confirmReroll}
                        disabled={rerolling}
                        style={{ ...smallActionBtn("#2a0f0f", "#fca5a5"), flex: 1 }}
                      >
                        {rerolling ? "Rolling…" : "Confirm reroll"}
                      </button>
                      <button onClick={() => { setSelectedClass(null); setRerollStep("pick-class"); }} style={smallActionBtn("#222428", "#6b7280")}>
                        Back
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </FloatingPortal>
      )}
      {showNotifyModal && onSaveNotifyPref && (
        <NotifyPrefModal
          current={character?.notification_pref ?? "thread"}
          onSave={async (pref) => { await onSaveNotifyPref(pref); setShowNotifyModal(false); }}
          onClose={() => setShowNotifyModal(false)}
        />
      )}
    </>
  );
}

function NotifyPrefModal({
  current,
  onSave,
  onClose,
}: {
  current: "thread" | "dm";
  onSave: (pref: "thread" | "dm") => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<"thread" | "dm">(current);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await onSave(selected);
    setSaving(false);
  }

  const opts: { value: "thread" | "dm"; label: string; desc: string }[] = [
    { value: "thread", label: "Channel broadcast", desc: "Posts your turn in the quest thread and @mentions you in the channel." },
    { value: "dm",     label: "Direct message",    desc: "Sends you a private DM when it's your turn." },
  ];

  return (
    <ModalBackdrop onCancel={onClose}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#f5f5f5", marginBottom: 4 }}>Turn notifications</div>
      <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 20 }}>How would you like to be pinged when it's your turn in combat?</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {opts.map((opt) => {
          const active = selected === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSelected(opt.value)}
              style={{
                background: active ? "#1f2d3d" : "#1a1c20",
                border: `1px solid ${active ? "#3b82f6" : "#2a2d33"}`,
                borderRadius: 8,
                padding: "12px 14px",
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{
                  width: 14, height: 14, borderRadius: "50%",
                  border: `2px solid ${active ? "#3b82f6" : "#4a5060"}`,
                  background: active ? "#3b82f6" : "transparent",
                  flexShrink: 0,
                }} />
                <span style={{ fontWeight: 600, fontSize: 13, color: active ? "#93c5fd" : "#e6e6e6" }}>{opt.label}</span>
              </div>
              <div style={{ fontSize: 12, color: "#6b7280", paddingLeft: 22, lineHeight: 1.4 }}>{opt.desc}</div>
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
        <button type="button" onClick={onClose} style={{ ...button, background: "#33363d" }}>Cancel</button>
        <button type="button" onClick={handleSave} disabled={saving} style={button}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalBackdrop>
  );
}

export function Stats({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
        marginTop: 16,
      }}
    >
      {children}
    </div>
  );
}

export function Stat({ label, value, icon, tooltip }: { label: string; value: ReactNode; icon?: ReactNode; tooltip?: string }) {
  const tile = (
    <div
      style={{
        padding: 12,
        background: "var(--bg-input)",
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--border-faint)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        cursor: tooltip ? "default" : undefined,
      }}
    >
      {icon && (
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36 }}>
          {icon}
        </div>
      )}
      <div style={{ minWidth: 0 }}>
        <div className="eyebrow">{label}</div>
        <div style={{
          fontSize: 18,
          color: "var(--fg-1)",
          marginTop: 3,
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
        }}>
          {value}
        </div>
      </div>
    </div>
  );
  if (!tooltip) return tile;
  return (
    <HoverTooltip
      placement="top-start"
      panelStyle={{ minWidth: 180, maxWidth: 260 }}
      content={
        <>
          <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.55, fontFamily: "var(--font-mono)" }}>{tooltip}</div>
        </>
      }
    >
      {tile}
    </HoverTooltip>
  );
}

export function Stack({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        width: "100%",
        maxWidth: 560,
      }}
    >
      {children}
    </div>
  );
}
