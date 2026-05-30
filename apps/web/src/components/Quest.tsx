import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Avatar, Icon } from "../icons";
import type { ActiveQuest, Character, SceneJson } from "../types";
import { muted } from "../styles";
import { SmallBadge } from "./ui";
import { charPortraitUrl, classPortraitUrl } from "../CombatShared";
import {
  CharacterInspectDialog,
  HpBar, EffectChips, VariantBadge, PositionBadge,
} from "./Character";

// Detect phone widths so the tower interlude can drop into a single column.
// Used in TowerInterlude — kept module-local so other Quest.tsx exports don't
// each have to wire their own media subscriber.
function useIsMobile(query = "(max-width: 640px)"): boolean {
  const [match, setMatch] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatch(e.matches);
    setMatch(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return match;
}

// Full-screen interlude for non-combat tower floors (rest stop + post-boss
// choice). Renders the merchant picker or the press-on/bank prompt; on
// resolution it calls onAdvance which triggers an App-level refresh and
// drops the user back into the next floor's combat flow.
export function TowerInterlude({
  questId,
  scene,
  party,
  selfId,
  onAdvance,
}: {
  questId: number;
  scene: SceneJson;
  party: Character[];
  selfId: string;
  onAdvance: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const floor = scene.tower_floor ?? 0;
  const cycle = scene.tower_cycle ?? 1;
  const kills = scene.tower_kills_run ?? 0;

  // Generic post helper that triggers App-level refresh on success.
  // Used for /tower/continue, /tower/exit, and /tower/rest_advance — each
  // of those mutates scene_json and the next render shows the new state.
  async function call(path: string, body?: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/quest/${questId}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "request_failed");
      onAdvance();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Pick-an-item helper. Refreshes activeQuest after each successful
  // claim so the claim badge appears immediately. Uses a separate
  // pendingIdx so we can show a per-button spinner without disabling the
  // whole card.
  const [pendingIdx, setPendingIdx] = useState<number | null>(null);
  async function pickItem(idx: number) {
    if (pendingIdx !== null || busy) return;
    setPendingIdx(idx);
    setErr(null);
    try {
      const res = await fetch(`/api/quest/${questId}/tower/rest_pick`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: idx }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "request_failed");
      // Refresh activeQuest so the new claim is reflected in scene.tower_rest_claims.
      onAdvance();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPendingIdx(null);
    }
  }

  const isMobile = useIsMobile();

  // Full-screen page shell — sits over var(--bg-void) and centers the modal.
  // The interlude is a takeover state, not a card embedded in the dashboard,
  // so we lean on the design system's modal kit (.modal-head/body/foot) for
  // a familiar shape.
  const pageShell: CSSProperties = {
    minHeight: "100vh",
    background: "var(--bg-void)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: isMobile ? 12 : 32,
    boxSizing: "border-box",
  };
  const modalShell: CSSProperties = {
    width: "100%",
    maxWidth: 640,
    background: "var(--bg-panel)",
    border: "1px solid var(--border-base)",
    borderRadius: "var(--radius-2xl)",
    boxShadow: "var(--shadow-modal)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  };

  // Big floor numeral — the visual anchor of either interlude variant.
  function FloorHero({ label }: { label: string }) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: isMobile ? "16px 16px 0" : "22px 24px 0",
        }}
      >
        <div
          style={{
            width: isMobile ? 60 : 72,
            height: isMobile ? 60 : 72,
            flexShrink: 0,
            borderRadius: "var(--radius-lg)",
            background: "var(--bg-void)",
            border: "1px solid var(--border-strong)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--accent-gold)",
          }}
        >
          <Icon name="tower-flag" size={isMobile ? 32 : 38} color="var(--accent-gold)" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              font: "10px/1.3 var(--font-mono)",
              color: "var(--fg-mute)",
              textTransform: "uppercase",
              letterSpacing: 0.7,
            }}
          >
            {label}
          </div>
          <div
            style={{
              font: `${isMobile ? 28 : 36}px/1 var(--font-display)`,
              color: "var(--accent-gold)",
              marginTop: 6,
            }}
          >
            Floor {floor}
          </div>
          <div
            style={{
              font: "11px/1.3 var(--font-mono)",
              color: "var(--fg-mute)",
              textTransform: "uppercase",
              letterSpacing: 0.7,
              marginTop: 6,
            }}
          >
            Cycle {cycle} · Kills {kills}
          </div>
        </div>
      </div>
    );
  }

  if (scene.tower_awaiting_choice) {
    return (
      <div style={pageShell}>
        <div style={modalShell}>
          <FloorHero label={`Cycle ${cycle} cleared`} />
          <div
            className="modal-body"
            style={{ padding: isMobile ? 16 : "20px 24px" }}
          >
            <p style={{ ...muted, margin: 0, lineHeight: 1.55 }}>
              The boss lies broken atop floor {floor}. Press on into cycle {cycle + 1} for
              steeper rewards, or bank your spoils and descend.
            </p>
            {err && (
              <div style={{ color: "var(--tone-bad)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                Error: {err}
              </div>
            )}
          </div>
          <div
            className="modal-foot"
            style={{
              padding: isMobile ? 14 : "16px 24px",
              borderTop: "1px solid var(--border-faint)",
              background: "var(--bg-deep)",
              display: "flex",
              flexDirection: isMobile ? "column" : "row",
              gap: 10,
              alignItems: "stretch",
            }}
          >
            <button
              className="btn btn-gold"
              style={{
                flex: 1,
                justifyContent: "center",
                width: isMobile ? "100%" : undefined,
              }}
              disabled={busy}
              onClick={() => void call("/tower/continue")}
            >
              <Icon name="tower-flag" size={14} color="#1a1300" />
              Advance · Floor {floor + 1}
            </button>
            <button
              className="btn btn-ghost"
              style={{
                flex: 1,
                justifyContent: "center",
                width: isMobile ? "100%" : undefined,
              }}
              disabled={busy}
              onClick={() => void call("/tower/exit")}
            >
              Rest · Call it a day
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Rest stop floor — claim up to one item each, then "Press on" together.
  const stock = scene.tower_rest_stock ?? [];
  const claims = scene.tower_rest_claims ?? {};
  const partyById = new Map(party.map((p) => [p.slack_user_id, p]));
  const myClaimedIdx = Object.entries(claims).find(([, uid]) => uid === selfId)?.[0];
  const iHaveClaimed = myClaimedIdx !== undefined;

  // Single-line offer row, lightly inspired by the design system's .offer
  // pattern but using inline styles since we have variable claim states
  // (own, taken, available) that need per-row treatment.
  const offerRow = (claimed: boolean, mine: boolean): CSSProperties => ({
    background: "var(--bg-card)",
    border: `1px solid ${mine ? "var(--accent-gold)" : "var(--border-faint)"}`,
    borderRadius: "var(--radius-lg)",
    padding: "12px 14px",
    opacity: claimed && !mine ? 0.55 : 1,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  });

  return (
    <div style={pageShell}>
      <div style={modalShell}>
        <FloorHero label="Rest stop" />
        <div
          className="modal-body"
          style={{
            padding: isMobile ? 16 : "20px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <p style={{ ...muted, margin: 0, lineHeight: 1.55 }}>
            The party is fully healed. A hooded trader has set out three trinkets — each party
            member can take at most one. When you're ready, press on into the next floor.
          </p>

          {/* Party glance — surfaces who's at the rest stop and their class
              in the design system's arcane purple, matching the briefing
              language elsewhere. */}
          {party.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fit, minmax(160px, 1fr))",
                gap: 8,
              }}
            >
              {party.map((p) => (
                <div
                  key={p.slack_user_id}
                  style={{
                    background: "var(--bg-card-2)",
                    border: "1px solid var(--border-faint)",
                    borderRadius: "var(--radius-md)",
                    padding: "8px 10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <div
                    style={{
                      font: "13px/1.2 var(--font-display)",
                      color: "var(--fg-1)",
                    }}
                  >
                    {p.name}
                  </div>
                  <div
                    style={{
                      font: "10px/1 var(--font-mono)",
                      color: "var(--accent-arcane-2)",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    {p.class} · L{p.level}
                  </div>
                </div>
              ))}
            </div>
          )}

          {err && (
            <div style={{ color: "var(--tone-bad)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              Error: {err}
            </div>
          )}

          <div className="group-label">Trader's wares</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {stock.map((it, idx) => {
              const claimedBy = claims[String(idx)];
              const claimedByMe = claimedBy === selfId;
              const claimer = claimedBy ? partyById.get(claimedBy) : null;
              const canTake = !claimedBy && !iHaveClaimed;
              const isPending = pendingIdx === idx;
              return (
                <div key={idx} style={offerRow(!!claimedBy, claimedByMe)}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong
                      style={{
                        font: "700 14px/1.2 var(--font-body)",
                        color: "var(--fg-1)",
                      }}
                    >
                      {it.name}
                    </strong>
                    <span
                      style={{
                        font: "10px/1.2 var(--font-mono)",
                        color: "var(--fg-mute-3)",
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      {it.item_type} · pwr {it.power} · {it.rarity}
                    </span>
                    {claimedBy && (
                      <span
                        style={{
                          marginLeft: "auto",
                          font: "700 10px/1 var(--font-mono)",
                          color: claimedByMe ? "var(--accent-gold)" : "var(--fg-mute)",
                          padding: "3px 8px",
                          borderRadius: "var(--radius-sm)",
                          background: claimedByMe ? "rgba(251,191,36,0.12)" : "var(--bg-input)",
                          border: `1px solid ${claimedByMe ? "var(--accent-gold)" : "var(--border-base)"}`,
                          textTransform: "uppercase",
                          letterSpacing: 0.5,
                        }}
                      >
                        {claimedByMe ? "you took this" : `taken by ${claimer?.name ?? claimedBy}`}
                      </span>
                    )}
                  </div>
                  {it.flavor && (
                    <div className="flavor-line">{it.flavor}</div>
                  )}
                  {canTake && (
                    <div>
                      <button
                        className="btn btn-gold btn-sm"
                        disabled={isPending}
                        onClick={() => void pickItem(idx)}
                      >
                        {isPending ? "Taking…" : "Take"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div
          className="modal-foot"
          style={{
            padding: isMobile ? 14 : "16px 24px",
            borderTop: "1px solid var(--border-faint)",
            background: "var(--bg-deep)",
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            gap: 10,
            alignItems: "stretch",
            justifyContent: "flex-end",
          }}
        >
          <button
            className="btn btn-gold"
            style={{
              justifyContent: "center",
              width: isMobile ? "100%" : undefined,
            }}
            disabled={busy || pendingIdx !== null}
            onClick={() => void call("/tower/rest_advance")}
          >
            <Icon name="tower-flag" size={14} color="#1a1300" />
            Advance · Floor {floor + 1}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ActiveQuestCard({
  quest,
  party,
  selfId,
  combatInProgress,
  onStartCombat,
  onOpenRecruitment,
  onOpenInventory,
}: {
  quest: ActiveQuest;
  party: Character[];
  selfId: string;
  combatInProgress: boolean;
  onStartCombat: () => void;
  onOpenRecruitment: () => void;
  onOpenInventory?: () => void;
}) {
  const s = quest.scene;
  const variant = s.variant ?? "standard";
  const [inspected, setInspected] = useState<Character | null>(null);
  const selfMember = party.find((p) => p.slack_user_id === selfId) ?? null;
  const otherParty = party.filter((p) => p.slack_user_id !== selfId);

  return (
    <div
      style={{
        // Quest banner: dark panel with the red quest-accent border, matching
        // the WardMap quest banner so the dashboard pre-combat state and the
        // map state read as the same surface.
        background: "var(--bg-panel)",
        border: "1px solid var(--tone-bad-3)",
        borderRadius: "var(--radius-2xl)",
        padding: 20,
        boxSizing: "border-box",
        boxShadow: "var(--shadow-pop)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Icon name="death-skull" size={18} color="var(--tone-bad-2)" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              font: "10px/1 var(--font-mono)",
              color: "var(--fg-mute)",
              textTransform: "uppercase",
              letterSpacing: 0.7,
              marginBottom: 4,
            }}
          >
            Active Quest · {variant}
          </div>
          <div
            style={{
              font: "20px/1.1 var(--font-display)",
              color: "var(--fg-1)",
            }}
          >
            {s.monster_name || "Unknown threat"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <VariantBadge variant={variant} />
          {quest.elite && <SmallBadge>elite</SmallBadge>}
          {variant === "boss" && s.boss_phase === 2 && (
            <SmallBadge>phase 2</SmallBadge>
          )}
          {variant === "gauntlet" && s.wave && s.total_waves && (
            <SmallBadge>
              wave {s.wave}/{s.total_waves}
            </SmallBadge>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {s.monster_art_url && (
          <ClickablePortrait
            src={s.monster_art_url}
            alt={s.monster_name}
            width="100%"
            height="auto"
            borderRadius={8}
            style={{ maxHeight: 280, objectFit: "cover", marginBottom: 12 }}
          />
        )}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <div
            style={{
              ...muted,
              fontVariantNumeric: "tabular-nums",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            {s.monster_hp} / {s.monster_max_hp} HP
          </div>
        </div>
        <HpBar current={s.monster_hp} max={s.monster_max_hp} flavor="monster" />
        {/* Threat profile pills — same color/icon language as the in-combat
            MonsterCard. Shown pre-Engage so players can plan loadouts /
            resist gear / approach order before clicking "Open Combat".
            Reads from the primary monster (pack[0]) or the top-level scene
            fields for solo quests. */}
        {(() => {
          const m0 = s.monsters?.[0];
          const attackType: "physical" | "magic" | "fire" | "ice" | "lightning" =
            (m0?.attack_damage_type ?? s.monster_attack_type ?? "physical") as
              "physical" | "magic" | "fire" | "ice" | "lightning";
          const elementWeak = m0?.element_weakness;
          const elementResist = m0?.element_resistance;
          const damageWeak = m0?.damage_weakness ?? s.monster_damage_weakness;
          const damageResist = m0?.damage_resistance ?? s.monster_damage_resistance;
          const showAttack = attackType !== "physical";
          if (!showAttack && !elementWeak && !elementResist && !damageWeak && !damageResist) {
            return null;
          }
          const dtypeIconName = (t: string) =>
            t === "fire" ? "fire" : t === "ice" ? "ice-bolt" : t === "lightning" ? "electric" : t === "magic" ? "crystal-ball" : "sword";
          const dtypeColor = (t: string) =>
            t === "fire" ? "#fb923c" :
            t === "ice" ? "#7dd3fc" :
            t === "lightning" ? "#fde047" :
            t === "magic" ? "#c084fc" : "#9aa0a6";
          const pill = (label: string, title: string, bg: string, border: string, color: string, iconType: string) => (
            <span
              title={title}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 10, fontWeight: 700,
                background: bg, border, color, borderRadius: 4,
                padding: "2px 6px", textTransform: "uppercase", letterSpacing: 0.4,
              }}
            >
              <Icon name={dtypeIconName(iconType)} size={10} color={color} />
              {label}
            </span>
          );
          return (
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {showAttack && pill(`${attackType} attacks`, `Attacks deal ${attackType} damage — bypasses your armor pool`, dtypeColor(attackType) + "22", `1px solid ${dtypeColor(attackType)}55`, dtypeColor(attackType), attackType)}
              {elementWeak && pill(`${elementWeak} weak`, `Vulnerable to ${elementWeak} element procs`, "#7f1d1d22", "1px solid #f8717144", "#fca5a5", elementWeak)}
              {elementResist && pill(`${elementResist} resist`, `Resists ${elementResist} element procs`, "#1e3a5f22", "1px solid #60a5fa44", "#93c5fd", elementResist)}
              {damageWeak && damageWeak !== elementWeak && pill(`${damageWeak} vuln`, `Takes extra damage from ${damageWeak} attacks`, "#7f1d1d22", "1px solid #f8717144", "#fca5a5", damageWeak)}
              {damageResist && damageResist !== elementResist && pill(`${damageResist} tough`, `Takes reduced damage from ${damageResist} attacks`, "#1e3a5f22", "1px solid #60a5fa44", "#93c5fd", damageResist)}
            </div>
          );
        })()}
        {s.monster_effects && s.monster_effects.length > 0 && (
          <EffectChips effects={s.monster_effects} />
        )}
        {/* Tier + estimated rewards row */}
        {(() => {
          const tier = s.tier ?? 1;
          const isBoss = variant === "boss";
          const xpMult = (isBoss ? 2 : 1) * (quest.elite ? 1.5 : 1);
          const goldMult = (isBoss ? 2 : 1) * (quest.elite ? 1.5 : 1);
          const estXp   = Math.round(15 * Math.pow(tier, 1.2) * xpMult);
          const estGold = Math.round(8  * Math.pow(tier, 1.2) * goldMult);
          return (
            <div style={{ display: "flex", gap: 12, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ font: "10px/1 var(--font-mono)", color: "var(--fg-mute)", textTransform: "uppercase", letterSpacing: 0.8, background: "var(--bg-card-2)", border: "1px solid var(--border-faint)", borderRadius: 4, padding: "3px 7px" }}>
                Tier {tier}
              </span>
              <span style={{ font: "10px/1 var(--font-mono)", color: "var(--accent-gold)", display: "flex", alignItems: "center", gap: 4 }}>
                <Icon name="perspective-dice-six" size={11} color="var(--accent-gold)" />
                ~{estXp} XP
              </span>
              <span style={{ font: "10px/1 var(--font-mono)", color: "#a78059", display: "flex", alignItems: "center", gap: 4 }}>
                <Icon name="gold-bar" size={11} color="#a78059" />
                ~{estGold} gold
              </span>
              {party.length > 1 && (
                <span style={{ font: "10px/1 var(--font-mono)", color: "var(--tone-good-2)", display: "flex", alignItems: "center", gap: 4 }}>
                  <Icon name="linked-rings" size={11} color="var(--tone-good-2)" />
                  +{party.length >= 4 ? 25 : party.length === 3 ? 20 : 10}% XP party bonus
                </span>
              )}
            </div>
          );
        })()}
      </div>

      {s.scene && (
        <div
          style={{
            ...muted,
            marginTop: 12,
            fontStyle: "italic",
            lineHeight: 1.5,
          }}
        >
          {s.scene}
        </div>
      )}

      {party.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
            Party · {party.length}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[...(selfMember ? [selfMember] : []), ...otherParty].map((p) => {
              const isSelf = p.slack_user_id === selfId;
              const downed = p.downed_until !== null && p.downed_until > Date.now();
              const hpPct  = p.max_hp > 0 ? Math.max(0, p.hp / p.max_hp) : 0;
              const hpCol  = hpPct < 0.25 ? "#dc2626" : hpPct < 0.5 ? "#d97706" : "#16a34a";
              const armorMax = Math.floor((p.armor_power ?? 0) / 2);
              return (
                <div
                  key={p.slack_user_id}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 10px",
                    background: "var(--bg-input)",
                    borderRadius: "var(--radius-lg)",
                    border: isSelf ? "1px solid var(--accent-ink-blue-2)" : "1px solid var(--border-faint)",
                    opacity: downed ? 0.55 : 1,
                  }}
                >
                  <Avatar
                    src={charPortraitUrl(p.name)}
                    fallbackSrc={classPortraitUrl(p.class)}
                    alt={p.name}
                    size={40}
                    radius={20}
                    style={{ flexShrink: 0 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                      <span style={{ font: "13px/1 var(--font-display)", color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{p.name}</span>
                      {p.slack_username && <span style={{ font: "10px/1 var(--font-mono)", color: "var(--accent-ink-blue)" }}>@{p.slack_username}</span>}
                      <span style={{ font: "10px/1 var(--font-mono)", color: "var(--accent-arcane)", textTransform: "uppercase", letterSpacing: 0.4 }}>{p.class} · L{p.level}</span>
                      {isSelf && <SmallBadge>you</SmallBadge>}
                      {downed && <SmallBadge>downed</SmallBadge>}
                      <PositionBadge position={p.position} />
                    </div>
                    {/* HP + optional shield on shared track */}
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div className="bar" style={{ flex: 1 }}>
                        <i style={{ width: `${(p.hp / (p.max_hp + armorMax || 1)) * 100}%`, background: hpCol }} />
                        {armorMax > 0 && p.shield > 0 && (
                          <i style={{ left: `${(p.max_hp / (p.max_hp + armorMax)) * 100}%`, width: `${(p.shield / (p.max_hp + armorMax)) * 100}%`, background: "repeating-linear-gradient(45deg,#93c5fd,#93c5fd 4px,#60a5fa 4px,#60a5fa 8px)" }} />
                        )}
                      </div>
                      <span style={{ font: "10px/1 var(--font-mono)", color: "var(--fg-mute)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{p.hp}/{p.max_hp}</span>
                    </div>
                    {p.max_mana > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                        <div className="bar" style={{ flex: 1, height: 4 }}>
                          <i style={{ width: `${(p.mana / p.max_mana) * 100}%`, background: "var(--accent-arcane)" }} />
                        </div>
                        <span style={{ font: "10px/1 var(--font-mono)", color: "var(--fg-mute)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{p.mana}/{p.max_mana}</span>
                      </div>
                    )}
                  </div>
                  {!isSelf && (
                    <button onClick={() => setInspected(p)} className="btn btn-ghost btn-sm" style={{ flexShrink: 0, color: "var(--accent-ink-blue)" }}>
                      <Icon name="scroll-quill" size={12} color="var(--accent-ink-blue)" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {inspected && (
        <CharacterInspectDialog
          character={inspected}
          onClose={() => setInspected(null)}
        />
      )}
      {(() => {
        const combatAvailable =
          variant === "standard" ||
          variant === "boss" ||
          variant === "gauntlet" ||
          // Tower combat + boss floors. Rest floors and the post-boss
          // awaiting-choice state route to TowerInterlude up-stack and
          // never reach the dashboard, but be defensive about both.
          (variant === "tower" &&
            (s.tower_floor_kind === "combat" || s.tower_floor_kind === "boss") &&
            !s.tower_awaiting_choice);
        if (combatAvailable) {
          const isCreator = quest.created_by === selfId;
          return (
            <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
              <button
                onClick={onStartCombat}
                className="btn btn-primary"
                style={{ flex: 1, minWidth: 200, justifyContent: "center" }}
              >
                <Icon name="sword" size={14} color="#fff" />
                {combatInProgress ? "Resume Combat" : "Start Combat"}
              </button>
              {onOpenInventory && (
                <button
                  onClick={onOpenInventory}
                  title="Check or swap your gear before entering combat"
                  className="btn btn-ghost"
                  style={{ justifyContent: "center" }}
                >
                  <Icon name="knapsack" size={14} color="var(--fg-3)" />
                  Gear up
                </button>
              )}
              {isCreator && (
                <button
                  onClick={onOpenRecruitment}
                  title="Open a reinforcement lobby. Invitees who accept will join the fight in progress."
                  className="btn btn-ghost"
                  style={{ justifyContent: "center" }}
                >
                  <Icon name="death-skull" size={14} color="var(--tone-bad-2)" />
                  Open recruitment
                </button>
              )}
            </div>
          );
        }
        return null;
      })()}
    </div>
  );
}

// Wide scene/banner image — click to expand full-screen. Used for landscape
// art (monster scene, quest banners). For square portraits use <Avatar>.
export function ClickablePortrait({
  src,
  alt,
  width = "100%",
  height = "auto",
  borderRadius = 8,
  style: extraStyle,
}: {
  src: string;
  alt: string;
  width?: number | string;
  height?: number | string;
  borderRadius?: number;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
        style={{
          width,
          height,
          borderRadius,
          objectFit: "cover",
          display: "block",
          cursor: "zoom-in",
          ...extraStyle,
        }}
        onError={(e) => { e.currentTarget.style.display = "none"; }}
      />
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            cursor: "zoom-out",
          }}
        >
          <img
            src={src}
            alt={alt}
            style={{
              maxWidth: "min(90vw, 800px)",
              maxHeight: "85vh",
              borderRadius: 12,
              objectFit: "contain",
              boxShadow: "0 16px 48px rgba(0,0,0,0.8)",
            }}
          />
        </div>
      )}
    </>
  );
}
