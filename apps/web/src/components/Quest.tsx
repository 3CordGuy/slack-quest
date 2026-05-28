import { useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../icons";
import type { ActiveQuest, Character, SceneJson } from "../types";
import { DISPLAY_FONT, card, h2, muted, button } from "../styles";
import { SmallBadge } from "./ui";
import {
  PartyMember, CharacterInspectDialog,
  HpBar, EffectChips, VariantBadge,
} from "./Character";

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

  const wrapper: CSSProperties = { padding: "32px 16px", maxWidth: 540, margin: "0 auto" };
  const pickerBtn: CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    fontSize: 15,
    borderRadius: 8,
    border: "1px solid #2a2d33",
    background: "#1a1c20",
    color: "#f5f5f5",
    cursor: "pointer",
    textAlign: "left",
  };

  if (scene.tower_awaiting_choice) {
    return (
      <div style={wrapper}>
        <div style={{ ...card, borderColor: "#854d0e" }}>
          <div style={{ fontSize: 12, color: "#fbbf24", textTransform: "uppercase", letterSpacing: 1.5, display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="tower-flag" size={14} color="#fbbf24" /> Cycle {cycle} cleared
          </div>
          <h2 style={{ ...h2, marginTop: 4 }}>You stand atop floor {floor}.</h2>
          <p style={muted}>
            The boss lies broken. Tower kills this run: <strong>{kills}</strong>. Press on into
            cycle {cycle + 1} for steeper rewards, or bank your spoils and descend.
          </p>
          {err && <div style={{ color: "#fca5a5", marginTop: 12 }}>Error: {err}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              style={{ ...button, background: "#854d0e", color: "#fef3c7", marginTop: 0, flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              disabled={busy}
              onClick={() => void call("/tower/continue")}
            >
              <Icon name="tower-flag" size={16} color="#fef3c7" /> Press on (Floor {floor + 1})
            </button>
            <button
              style={{ ...pickerBtn, fontWeight: 600, textAlign: "center", flex: 1 }}
              disabled={busy}
              onClick={() => void call("/tower/exit")}
            >
              🛌 Call it a day
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

  return (
    <div style={wrapper}>
      <div style={{ ...card, borderColor: "#854d0e" }}>
        <div style={{ fontSize: 12, color: "#fbbf24", textTransform: "uppercase", letterSpacing: 1.5 }}>
          🛌 Floor {floor} · Cycle {cycle}
        </div>
        <h2 style={{ ...h2, marginTop: 4 }}>Rest stop</h2>
        <p style={muted}>
          The party is fully healed. A hooded trader has set out three trinkets — each party member
          can take at most one. When you're ready, press on into the next floor.
        </p>
        {err && <div style={{ color: "#fca5a5", marginTop: 12 }}>Error: {err}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
          {stock.map((it, idx) => {
            const claimedBy = claims[String(idx)];
            const claimedByMe = claimedBy === selfId;
            const claimer = claimedBy ? partyById.get(claimedBy) : null;
            const canTake = !claimedBy && !iHaveClaimed;
            const isPending = pendingIdx === idx;
            return (
              <div
                key={idx}
                style={{
                  ...pickerBtn,
                  cursor: canTake ? "pointer" : "default",
                  opacity: claimedBy && !claimedByMe ? 0.55 : 1,
                  borderColor: claimedByMe ? "#fbbf24" : "#2a2d33",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{it.name}</strong>
                  <span style={{ ...muted, fontSize: 12 }}>
                    ({it.item_type}, power {it.power}, {it.rarity})
                  </span>
                  {claimedBy && (
                    <span style={{
                      marginLeft: "auto",
                      fontSize: 11,
                      fontWeight: 600,
                      color: claimedByMe ? "#fbbf24" : "#9aa0a6",
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: claimedByMe ? "#2d2410" : "#1a1c20",
                    }}>
                      {claimedByMe ? "you took this" : `taken by ${claimer?.name ?? claimedBy}`}
                    </span>
                  )}
                </div>
                {it.flavor && <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>{it.flavor}</div>}
                {canTake && (
                  <button
                    style={{
                      marginTop: 8,
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "1px solid #b89b3a",
                      background: "#2d2410",
                      color: "#fbbf24",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    disabled={isPending}
                    onClick={() => void pickItem(idx)}
                  >
                    {isPending ? "Taking…" : "Take"}
                  </button>
                )}
              </div>
            );
          })}
          <button
            style={{
              ...button,
              background: "#854d0e",
              color: "#fef3c7",
              marginTop: 12,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
            disabled={busy || pendingIdx !== null}
            onClick={() => void call("/tower/rest_advance")}
          >
            <Icon name="tower-flag" size={16} color="#fef3c7" /> Press on (Floor {floor + 1})
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
}: {
  quest: ActiveQuest;
  party: Character[];
  selfId: string;
  combatInProgress: boolean;
  onStartCombat: () => void;
  onOpenRecruitment: () => void;
}) {
  const s = quest.scene;
  const variant = s.variant ?? "standard";
  const [inspected, setInspected] = useState<Character | null>(null);
  const selfMember = party.find((p) => p.slack_user_id === selfId) ?? null;
  const otherParty = party.filter((p) => p.slack_user_id !== selfId);

  return (
    <div style={{ ...card, borderColor: "#b89b3a", borderWidth: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={h2}>Active Quest</h2>
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
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>
            {s.monster_name || "—"}
          </div>
          <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
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
          const dtypeIcon = (t: string) =>
            t === "fire" ? "🔥" : t === "ice" ? "❄️" : t === "lightning" ? "⚡" : t === "magic" ? "✨" : "⚔";
          const dtypeColor = (t: string) =>
            t === "fire" ? "#fb923c" :
            t === "ice" ? "#7dd3fc" :
            t === "lightning" ? "#fde047" :
            t === "magic" ? "#c084fc" : "#9aa0a6";
          return (
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {showAttack && (
                <span
                  title={`Attacks deal ${attackType} damage — bypasses your armor pool`}
                  style={{
                    fontSize: 10, fontWeight: 700,
                    background: dtypeColor(attackType) + "22",
                    border: `1px solid ${dtypeColor(attackType)}55`,
                    color: dtypeColor(attackType), borderRadius: 4,
                    padding: "2px 6px", textTransform: "uppercase", letterSpacing: 0.4,
                  }}
                >
                  {dtypeIcon(attackType)} {attackType} attacks
                </span>
              )}
              {elementWeak && (
                <span
                  title={`Vulnerable to ${elementWeak} element procs — fire/ice/lightning weapons stack effects faster`}
                  style={{
                    fontSize: 10, fontWeight: 700,
                    background: "#7f1d1d22", border: "1px solid #f8717144",
                    color: "#fca5a5", borderRadius: 4, padding: "2px 6px",
                    textTransform: "uppercase", letterSpacing: 0.4,
                  }}
                >
                  {dtypeIcon(elementWeak)} {elementWeak} weak
                </span>
              )}
              {elementResist && (
                <span
                  title={`Resists ${elementResist} element procs`}
                  style={{
                    fontSize: 10, fontWeight: 700,
                    background: "#1e3a5f22", border: "1px solid #60a5fa44",
                    color: "#93c5fd", borderRadius: 4, padding: "2px 6px",
                    textTransform: "uppercase", letterSpacing: 0.4,
                  }}
                >
                  {dtypeIcon(elementResist)} {elementResist} resist
                </span>
              )}
              {damageWeak && damageWeak !== elementWeak && (
                <span
                  title={`Takes extra damage from ${damageWeak} attacks`}
                  style={{
                    fontSize: 10, fontWeight: 700,
                    background: "#7f1d1d22", border: "1px solid #f8717144",
                    color: "#fca5a5", borderRadius: 4, padding: "2px 6px",
                    textTransform: "uppercase", letterSpacing: 0.4,
                  }}
                >
                  {dtypeIcon(damageWeak)} {damageWeak} vuln
                </span>
              )}
              {damageResist && damageResist !== elementResist && (
                <span
                  title={`Takes reduced damage from ${damageResist} attacks`}
                  style={{
                    fontSize: 10, fontWeight: 700,
                    background: "#1e3a5f22", border: "1px solid #60a5fa44",
                    color: "#93c5fd", borderRadius: 4, padding: "2px 6px",
                    textTransform: "uppercase", letterSpacing: 0.4,
                  }}
                >
                  {dtypeIcon(damageResist)} {damageResist} tough
                </span>
              )}
            </div>
          );
        })()}
        {s.monster_effects && s.monster_effects.length > 0 && (
          <EffectChips effects={s.monster_effects} />
        )}
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
          <div
            style={{
              ...muted,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 1.5,
              marginBottom: 8,
            }}
          >
            Party
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {selfMember && (
              <PartyMember
                fighter={selfMember}
                self={true}
              />
            )}
            {otherParty.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div
                  style={{
                    ...muted,
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 1.5,
                    marginBottom: 6,
                  }}
                >
                  Other players ({otherParty.length})
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {otherParty.map((p) => (
                    <PartyMember
                      key={p.slack_user_id}
                      fighter={p}
                      self={false}
                      onInspect={() => setInspected(p)}
                    />
                  ))}
                </div>
              </div>
            )}
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
                style={{ ...button, flex: 1, minWidth: 200, background: "#b89b3a", color: "#0e0f12" }}
              >
                <Icon name="sword" /> {combatInProgress ? "Resume Combat" : "Open Combat"}
              </button>
              {isCreator && (
                <button
                  onClick={onOpenRecruitment}
                  title="Open a reinforcement lobby. Invitees who accept will join the fight in progress."
                  style={{
                    ...button,
                    background: "#1f2937",
                    color: "#fca5a5",
                    border: "1px solid #7f1d1d",
                  }}
                >
                  🆘 Call Reinforcements
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
