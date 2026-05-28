import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Icon } from "../icons";
import { postJson, drinkBuffLabel, formatRelative } from "../utils";
import { LIARS_TRUST_MULT_DISPLAY, LIARS_CHALLENGE_MULT_DISPLAY, GAME_LABELS, ERROR_LABELS } from "../constants";
import { card, h2, muted, DISPLAY_FONT, smallActionBtn } from "../styles";
import { LocationHero, Banner, RefreshButton } from "./ui";
import type {
  PubResponse, PubNpc, PubTalkResponse, DrinkBuff, SpdData, SpdResult, SpdThrow,
  PubLeaderboardEntry, LiarsRoundPending, LiarsRoundResult,
} from "../types";

function NpcSection({ npcs }: { npcs: { bartender: PubNpc | null; regulars: PubNpc[] } }) {
  const [active, setActive] = useState<PubNpc | null>(null);
  const all = [npcs.bartender, ...npcs.regulars].filter((n): n is PubNpc => n !== null);

  return (
    <div style={{ marginTop: 24, borderTop: "1px solid #2a2d33", paddingTop: 16 }}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>
        <Icon name="player" size={11} /> At the Bar
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: active ? 16 : 0 }}>
        {all.map((npc) => (
          <button
            key={npc.id}
            onClick={() => setActive(active?.id === npc.id ? null : npc)}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              border: `1px solid ${active?.id === npc.id ? "#6366f1" : "#2a2d33"}`,
              background: active?.id === npc.id ? "#1e1e3a" : "#16181c",
              color: active?.id === npc.id ? "#a5b4fc" : "#d1d5db",
              cursor: "pointer", fontSize: 12, fontFamily: "inherit",
            }}
          >
            <Icon name="conversation" size={10} /> {npc.name}
            {npc.role === "bartender" && <span style={{ ...muted, fontSize: 10, marginLeft: 4 }}>(bartender)</span>}
          </button>
        ))}
      </div>
      {active && <NpcConversation key={active.id} npc={active} onClose={() => setActive(null)} />}
    </div>
  );
}

function NpcConversation({ npc, onClose }: { npc: PubNpc; onClose: () => void }) {
  const [path, setPath] = useState("");
  const [dialog, setDialog] = useState<PubTalkResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function talk(newPath: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/pub/talk/${npc.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ path: newPath }),
      });
      const body = (await res.json()) as PubTalkResponse & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Something went wrong.");
        return;
      }
      setPath(newPath);
      setDialog(body);
    } finally {
      setLoading(false);
    }
  }

  // Auto-open on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void talk(""); }, []);

  return (
    <div style={{
      background: "#16181c", border: "1px solid #2a2d33", borderRadius: 8,
      padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 13 }}>
          {npc.name}
          <span style={{ ...muted, fontSize: 11, fontWeight: 400, marginLeft: 6 }}>({npc.archetype})</span>
        </span>
        {path && (
          <button
            onClick={() => { setPath(""); setDialog(null); void talk(""); }}
            style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}
          >
            ↺ restart
          </button>
        )}
      </div>

      {loading && <p style={{ ...muted, fontSize: 13 }}>…</p>}
      {error && <p style={{ color: "#fca5a5", fontSize: 13 }}>{error}</p>}

      {dialog && !loading && (
        <>
          <p style={{ color: "#e5e7eb", fontSize: 14, lineHeight: 1.55, margin: 0, fontStyle: "italic" }}>
            &ldquo;{dialog.npc_says}&rdquo;
          </p>

          {dialog.payload_applied && (
            <div style={{
              padding: "6px 10px", borderRadius: 6,
              background: "#1a2a1a", border: "1px solid #2d5a2d",
              color: "#86efac", fontSize: 12,
            }}>
              🎁 {dialog.payload_applied}
            </div>
          )}

          {!dialog.is_terminal ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {dialog.options.map((opt) => (
                <button
                  key={opt.index}
                  onClick={() => {
                    const next = path ? `${path},${opt.index}` : String(opt.index);
                    void talk(next);
                  }}
                  style={{
                    padding: "8px 12px", borderRadius: 6, textAlign: "left",
                    border: "1px solid #2a2d33", background: "#1d1f23",
                    color: "#d1d5db", cursor: "pointer", fontSize: 13,
                    fontFamily: "inherit",
                  }}
                >
                  {opt.has_payload && <span style={{ color: "#fbbf24", marginRight: 5 }}>✦</span>}
                  {opt.player_says}
                </button>
              ))}
            </div>
          ) : (
            <button
              onClick={onClose}
              style={{
                padding: "6px 12px", borderRadius: 6, border: "1px solid #2a2d33",
                background: "none", color: "#9ca3af", cursor: "pointer",
                fontSize: 12, fontFamily: "inherit", alignSelf: "flex-start",
              }}
            >
              🚪 Walk away
            </button>
          )}
        </>
      )}
    </div>
  );
}

// =============================================================================
// PUB CARD — Drink menu + Liars' Roll mini-game
// =============================================================================

function PubCard({
  pub,
  navOverlay,
  onBuyDrink,
  onHireMerc,
  onDismissMerc,
  onRefresh,
}: {
  pub: PubResponse;
  navOverlay?: React.ReactNode;
  onBuyDrink: (drinkId: string) => void;
  onHireMerc: (mercId: string) => void;
  onDismissMerc: () => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div style={card}>
      {navOverlay
        ? <LocationHero src={pub.art_url} label="The Pub" nav={navOverlay} />
        : pub.art_url ? <Banner src={pub.art_url} alt="The Pub" /> : null}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: navOverlay ? 0 : undefined }}>
        {!navOverlay && <h2 style={{ ...h2, margin: 0 }}><Icon name="beer-stein" size={18} /> The Pub</h2>}
        <RefreshButton onRefresh={onRefresh} style={{ marginLeft: "auto" }} />
      </div>
      <p style={{ ...muted, marginTop: 4 }}>
        <em>"Smoke, sawdust, a thousand failed deployments worth of regret in the air."</em>
      </p>

      {/* Active drink buff display */}
      {pub.drink_buff && (
        <div
          style={{
            marginTop: 12,
            padding: "8px 12px",
            background: "#1a2a1a",
            border: "1px solid #2d5a2d",
            borderRadius: 8,
            fontSize: 13,
            color: "#86efac",
          }}
        >
          Active buff: <strong>{drinkBuffLabel(pub.drink_buff)}</strong> · {pub.drink_buff.fight_duration ? "lasts this fight" : `${pub.drink_buff.remaining} action${pub.drink_buff.remaining === 1 ? "" : "s"} remaining`}
        </div>
      )}

      {/* Drink menu */}
      <div style={{ marginTop: 16 }}>
        <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Drink Menu · <span style={{ color: "#fbbf24" }}>{pub.gold}g</span></span>
          <span style={{ color: pub.drinks_remaining > 0 ? "#86efac" : "#fca5a5" }}>
            <Icon name="beer-stein" size={10} /> {pub.drinks_remaining}/{2} before quest
          </span>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {pub.drinks.map((d) => (
            <div
              key={d.id}
              style={{
                padding: "10px 12px",
                background: "#1d1f23",
                borderRadius: 8,
                border: d.is_daily_special ? "1px solid #b89b3a" : "1px solid transparent",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ fontSize: 20 }}>{d.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 14, display: "flex", alignItems: "center", gap: 6, fontFamily: DISPLAY_FONT }}>
                  {d.name}
                  {d.is_daily_special && (
                    <span style={{ fontSize: 10, background: "#b89b3a22", color: "#fbbf24", border: "1px solid #b89b3a55", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>
                      SPECIAL
                    </span>
                  )}
                  {d.fight_duration && (
                    <span style={{ fontSize: 10, background: "#1a2a3a", color: "#7dd3fc", border: "1px solid #1e4a6a", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>
                      FULL FIGHT
                    </span>
                  )}
                </div>
                <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{d.blurb}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                <div style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "#fbbf24", fontSize: 14 }}>
                  {d.actual_price}g
                  {d.is_daily_special && (
                    <span style={{ ...muted, textDecoration: "line-through", marginLeft: 4, fontSize: 11 }}>{d.price}g</span>
                  )}
                </div>
                <button
                  onClick={() => onBuyDrink(d.id)}
                  disabled={pub.gold < d.actual_price || pub.drinks_remaining <= 0}
                  style={{
                    ...smallActionBtn(pub.gold >= d.actual_price && pub.drinks_remaining > 0 ? "#1f2a3a" : "#222428", pub.gold >= d.actual_price && pub.drinks_remaining > 0 ? "#7dd3fc" : "#7a7d83"),
                    opacity: pub.gold >= d.actual_price && pub.drinks_remaining > 0 ? 1 : 0.6,
                    cursor: pub.gold >= d.actual_price && pub.drinks_remaining > 0 ? "pointer" : "not-allowed",
                  }}
                >
                  {pub.drinks_remaining <= 0 ? "Cutoff" : "Order"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Mercs for hire */}
      {pub.mercs && pub.mercs.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>
            ⚔️ Looking for Work
          </div>
          {pub.hired_merc ? (
            <div style={{
              padding: "12px 14px",
              background: "#1a2212",
              border: "1px solid #3a5a22",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, color: "#a3e635", fontSize: 14, fontFamily: DISPLAY_FONT }}>
                  {pub.hired_merc.name}
                  <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 11, color: "#86efac" }}>
                    Lv.{pub.hired_merc.level} {pub.hired_merc.class_label}
                  </span>
                </div>
                <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{pub.hired_merc.blurb}</div>
                <div style={{ fontSize: 11, color: "#86efac", marginTop: 4 }}>
                  Hired · fights with you next quest
                </div>
              </div>
              <button
                onClick={onDismissMerc}
                style={{ ...smallActionBtn("#2a1212", "#fca5a5"), flexShrink: 0 }}
              >
                Dismiss
              </button>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {pub.mercs.map((m) => (
                <div
                  key={m.id}
                  style={{
                    padding: "10px 12px",
                    background: "#1d1f23",
                    borderRadius: 8,
                    border: "1px solid transparent",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 14, fontFamily: DISPLAY_FONT, display: "flex", alignItems: "center", gap: 6 }}>
                      {m.name}
                      <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 400 }}>
                        Lv.{m.level} {m.class_label} · {m.position} · {m.weapon_range}
                      </span>
                    </div>
                    <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{m.blurb}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                    <div style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "#fbbf24", fontSize: 14 }}>
                      {m.cost}g
                    </div>
                    <button
                      onClick={() => onHireMerc(m.id)}
                      disabled={pub.gold < m.cost}
                      style={{
                        ...smallActionBtn(pub.gold >= m.cost ? "#1f2a3a" : "#222428", pub.gold >= m.cost ? "#7dd3fc" : "#7a7d83"),
                        opacity: pub.gold >= m.cost ? 1 : 0.6,
                        cursor: pub.gold >= m.cost ? "pointer" : "not-allowed",
                      }}
                    >
                      Hire
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* At the Bar — NPC conversations */}
      {pub.npcs && (pub.npcs.bartender || pub.npcs.regulars.length > 0) && (
        <NpcSection npcs={pub.npcs} />
      )}
    </div>
  );
}

// =============================================================================
// GAME CARDS — Liars' Roll and SPD as standalone cards
// =============================================================================

function GameCardHeader({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
      <div style={{
        width: 56, height: 56, borderRadius: 10,
        background: "#16181c", border: "1px solid #2a2d33",
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}>
        <Icon name={icon} size={32} />
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 16, color: "#f5f5f5", fontFamily: DISPLAY_FONT }}>{title}</div>
        <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{subtitle}</div>
      </div>
    </div>
  );
}

function StakeButtons({
  stakes,
  gold,
  disabled,
  btnStyle,
  customInputStyle,
  onPick,
}: {
  stakes: number[];
  gold: number;
  disabled: boolean;
  btnStyle: (canAfford: boolean) => React.CSSProperties;
  customInputStyle: React.CSSProperties;
  onPick: (amount: number) => void;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [customVal, setCustomVal] = useState("");

  if (showCustom) {
    const parsed = parseInt(customVal, 10);
    const valid = !isNaN(parsed) && parsed >= 1 && parsed <= gold;
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="number"
          min={1}
          max={gold}
          value={customVal}
          onChange={(e) => setCustomVal(e.target.value)}
          placeholder="amount"
          autoFocus
          style={{
            width: 90, padding: "4px 8px", borderRadius: 6,
            border: "1px solid #3a3d44", background: "#0e0f12",
            color: "#f5f5f5", fontSize: 13, fontFamily: "inherit",
          }}
        />
        <button
          disabled={disabled || !valid}
          onClick={() => { onPick(parsed); setShowCustom(false); setCustomVal(""); }}
          style={{ ...customInputStyle, opacity: valid ? 1 : 0.4, cursor: valid ? "pointer" : "not-allowed" }}
        >
          Bet
        </button>
        <button
          onClick={() => { setShowCustom(false); setCustomVal(""); }}
          style={smallActionBtn("#222428", "#94a3b8")}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {stakes.map((s) => (
        <button
          key={s}
          onClick={() => onPick(s)}
          disabled={disabled || gold < s}
          style={{ ...btnStyle(gold >= s), opacity: gold >= s ? 1 : 0.5, cursor: gold >= s ? "pointer" : "not-allowed" }}
        >
          <Icon name="gold-bar" size={11} /> {s}g
        </button>
      ))}
      <button
        onClick={() => setShowCustom(true)}
        disabled={disabled || gold < 1}
        style={{ ...smallActionBtn("#1a1c24", "#94a3b8"), opacity: gold >= 1 ? 1 : 0.5, cursor: gold >= 1 ? "pointer" : "not-allowed" }}
      >
        Custom…
      </button>
    </div>
  );
}

function LiarsRollCard({ gold, onRefresh }: { gold: number; onRefresh: () => Promise<void> }) {
  const [liarsState, setLiarsState] = useState<
    | { phase: "idle" }
    | { phase: "pending"; round: LiarsRoundPending }
    | { phase: "result"; result: LiarsRoundResult }
  >({ phase: "idle" });
  const [loading, setLoading] = useState(false);

  async function startLiars(stake: number) {
    setLoading(true);
    try {
      const res = await fetch("/api/pub/liars/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stake }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
        toast.error(code === "insufficient_gold" ? "Not enough gold." : code);
        return;
      }
      setLiarsState({ phase: "pending", round: body as unknown as LiarsRoundPending });
    } finally {
      setLoading(false);
    }
  }

  async function decideLiars(roundId: number, choice: "trust" | "challenge") {
    setLoading(true);
    try {
      const res = await fetch(`/api/pub/liars/${roundId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ choice }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        toast.error(typeof body.error === "string" ? body.error : "Something went wrong.");
        return;
      }
      setLiarsState({ phase: "result", result: body as unknown as LiarsRoundResult });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={card}>
      <GameCardHeader
        icon="perspective-dice-six"
        title="Liars' Roll"
        subtitle={`Both roll 3d6. Bartender claims a zone — lies 45% of the time. Trust (${LIARS_TRUST_MULT_DISPLAY}×) or Challenge (${LIARS_CHALLENGE_MULT_DISPLAY}×)?`}
      />

      {liarsState.phase === "idle" && (
        <div>
          <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>Pick a stake:</div>
          <StakeButtons
            stakes={[10, 25, 50]}
            gold={gold}
            disabled={loading}
            btnStyle={(can) => ({ ...smallActionBtn(can ? "#2a1f1f" : "#222428", can ? "#fca5a5" : "#7a7d83") })}
            customInputStyle={smallActionBtn("#2a1f1f", "#fca5a5")}
            onPick={(s) => void startLiars(s)}
          />
        </div>
      )}

      {liarsState.phase === "pending" && (() => {
        const r = liarsState.round;
        return (
          <div>
            <div style={{ background: "#1d1f23", borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div style={{ color: "#f5f5f5", fontWeight: 600, marginBottom: 4 }}>
                Bartender&apos;s claim: <span style={{ color: "#fbbf24" }}>{r.claim_label}</span>
              </div>
              <div style={{ ...muted, fontSize: 13 }}>
                Your dice: {r.player_dice.join(", ")} (sum: <strong>{r.player_sum}</strong>)
              </div>
              <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>
                Stake: {r.stake}g · Trust pays {r.trust_mult}× · Challenge pays {r.challenge_mult}× · {r.house_cut_pct}% house rake on wins
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => void decideLiars(r.round_id, "trust")} disabled={loading} style={smallActionBtn("#1f3a1f", "#86efac")}>
                <Icon name="hand" size={12} /> Trust ({r.trust_mult}×)
              </button>
              <button onClick={() => void decideLiars(r.round_id, "challenge")} disabled={loading} style={smallActionBtn("#3a1f1f", "#fca5a5")}>
                <Icon name="fire" size={12} /> Challenge ({r.challenge_mult}×)
              </button>
            </div>
          </div>
        );
      })()}

      {liarsState.phase === "result" && (() => {
        const r = liarsState.result;
        const won = r.payout > 0;
        return (
          <div>
            <div style={{ background: won ? "#1a2a1a" : "#2a1a1a", border: `1px solid ${won ? "#2d5a2d" : "#5a2d2d"}`, borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 700, color: won ? "#86efac" : "#fca5a5", marginBottom: 6, fontFamily: DISPLAY_FONT }}>
                {won
                  ? r.choice === "trust" ? <><Icon name="hand" size={13} /> Trusted correctly — +{r.payout}g!</> : <><Icon name="fire" size={13} /> Called the bluff — +{r.payout}g!</>
                  : r.choice === "trust" ? <><Icon name="daggers" size={13} /> Trusted a liar — lost the stake.</> : <><Icon name="daggers" size={13} /> Called an honest claim — lost the stake.</>}
              </div>
              <div style={{ ...muted, fontSize: 13 }}>
                {r.lied ? "The bartender was lying." : "The bartender told the truth."}{" "}
                True zone: <strong>{r.truth_label}</strong>.
              </div>
              <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>
                Your dice: {r.player_dice.join(", ")} · Bartender: {r.bartender_dice.join(", ")} · Combined: {r.combined}
              </div>
              <div style={{ marginTop: 6, color: "#fbbf24", fontSize: 13, fontWeight: 600 }}>Gold: {r.gold}g</div>
            </div>
            <button onClick={() => { setLiarsState({ phase: "idle" }); onRefresh(); }} style={smallActionBtn("#222428", "#cbd5e1")}>
              Play again
            </button>
          </div>
        );
      })()}
    </div>
  );
}

function SpdCard({ pub, selfId, onRefresh }: { pub: PubResponse; selfId: string; onRefresh: () => Promise<void> }) {
  const [spdStake, setSpdStake] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [spdResult, setSpdResult] = useState<SpdResult | null>(null);

  const SPD_THROW_LABELS: Record<SpdThrow, React.ReactNode> = {
    stone: <><Icon name="rune-stone" size={12} /> Stone</>,
    parchment: <><Icon name="scroll-unfurled" size={12} /> Parchment</>,
    dagger: <><Icon name="plain-dagger" size={12} /> Dagger</>,
  };

  async function spdStart(stake: number, throwChoice: SpdThrow) {
    setLoading(true);
    try {
      const { ok } = await postJson("/api/pub/spd/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stake, throw: throwChoice }) });
      if (ok) { setSpdStake(null); onRefresh(); }
    } finally { setLoading(false); }
  }

  async function spdAccept(matchId: number, throwChoice: SpdThrow) {
    setLoading(true);
    try {
      const res = await fetch(`/api/pub/spd/${matchId}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ throw: throwChoice }) });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) { const code = typeof body.error === "string" ? body.error : `http_${res.status}`; toast.error((ERROR_LABELS as Record<string, string>)[code] ?? code); return; }
      setSpdResult(body as unknown as SpdResult);
      onRefresh();
    } finally { setLoading(false); }
  }

  async function spdBet(matchId: number, side: "initiator" | "challenger", amount: number) {
    setLoading(true);
    try {
      const { ok } = await postJson(`/api/pub/spd/${matchId}/bet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ side, amount }) });
      if (ok) onRefresh();
    } finally { setLoading(false); }
  }

  async function spdCancel(matchId: number) {
    setLoading(true);
    try {
      const { ok } = await postJson(`/api/pub/spd/${matchId}/cancel`, { method: "POST" });
      if (ok) onRefresh();
    } finally { setLoading(false); }
  }

  const spd = pub.spd;
  const openMatch = spd?.open_match ?? null;
  const myBet = spd?.my_bet ?? null;
  const betTotals = spd?.bet_totals ?? { initiator: 0, challenger: 0 };
  const iAmInitiator = openMatch?.initiator_user_id === selfId;
  const iAmChallenger = openMatch?.challenger_user_id === selfId;
  const canBet = openMatch !== null && !iAmInitiator && !iAmChallenger && myBet === null;

  return (
    <div style={card}>
      <GameCardHeader
        icon="plain-dagger"
        title="Stone-Parchment-Dagger"
        subtitle="Commit a throw secretly. Loser pays winner both stakes +20%. Side bets pay 2×. Ties refund all."
      />

      {spdResult && (
        <div>
          <div style={{ background: spdResult.tie ? "#1d2a2d" : spdResult.winner_user_id === selfId ? "#1a2a1a" : "#2a1a1a", border: `1px solid ${spdResult.tie ? "#2d4a5a" : spdResult.winner_user_id === selfId ? "#2d5a2d" : "#5a2d2d"}`, borderRadius: 8, padding: 12, marginBottom: 10 }}>
            <div style={{ fontWeight: 700, color: spdResult.tie ? "#93c5fd" : spdResult.winner_user_id === selfId ? "#86efac" : "#fca5a5", marginBottom: 6, fontFamily: DISPLAY_FONT }}>
              {spdResult.tie ? <><Icon name="hand" size={13} /> Tie! Everything refunded.</> : spdResult.winner_user_id === selfId ? <><Icon name="trophy" size={13} /> You won! +{spdResult.payout}g</> : <><Icon name="daggers" size={13} /> You lost the match.</>}
            </div>
            <div style={{ ...muted, fontSize: 13 }}>
              {spdResult.initiator_name} threw {SPD_THROW_LABELS[spdResult.initiator_throw]} · You threw {SPD_THROW_LABELS[spdResult.challenger_throw]}
            </div>
            {!spdResult.tie && spdResult.house_bump > 0 && <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>House bump: +{spdResult.house_bump}g on total pot</div>}
            <div style={{ marginTop: 6, color: "#fbbf24", fontSize: 13, fontWeight: 600 }}>Gold: {spdResult.gold}g</div>
          </div>
          <button onClick={() => { setSpdResult(null); onRefresh(); }} style={smallActionBtn("#222428", "#cbd5e1")}>Done</button>
        </div>
      )}

      {!spdResult && (<>
        {!openMatch && (
          <div>
            {spdStake === null ? (
              <div>
                <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>Pick a stake:</div>
                <StakeButtons
                  stakes={[10, 25, 50]}
                  gold={pub.gold}
                  disabled={loading}
                  btnStyle={(can) => ({ ...smallActionBtn(can ? "#2a1f2a" : "#222428", can ? "#d8b4fe" : "#7a7d83") })}
                  customInputStyle={smallActionBtn("#2a1f2a", "#d8b4fe")}
                  onPick={(s) => setSpdStake(s)}
                />
              </div>
            ) : (
              <div>
                <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>
                  Stake: <strong style={{ color: "#fbbf24" }}>{spdStake}g</strong> — pick your throw (only you will see it):
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(["stone", "parchment", "dagger"] as SpdThrow[]).map((t) => (
                    <button key={t} onClick={() => void spdStart(spdStake, t)} disabled={loading} style={smallActionBtn("#2a2010", "#fde68a")}>
                      {SPD_THROW_LABELS[t]}
                    </button>
                  ))}
                  <button onClick={() => setSpdStake(null)} disabled={loading} style={smallActionBtn("#222428", "#94a3b8")}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

        {openMatch && iAmInitiator && (
          <div>
            <div style={{ background: "#1d2a1d", border: "1px solid #2d5a2d", borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div style={{ color: "#86efac", fontWeight: 600, marginBottom: 4 }}>Your match is open — waiting for a challenger</div>
              <div style={{ ...muted, fontSize: 13 }}>Stake: <strong style={{ color: "#fbbf24" }}>{openMatch.initiator_stake}g</strong> · Your throw is hidden until someone accepts.</div>
              {(betTotals.initiator > 0 || betTotals.challenger > 0) && <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>Side bets: {betTotals.initiator}g on you · {betTotals.challenger}g on challenger</div>}
            </div>
            <button onClick={() => void spdCancel(openMatch.id)} disabled={loading} style={smallActionBtn("#2a1a1a", "#fca5a5")}>Cancel match (refunds your stake)</button>
          </div>
        )}

        {openMatch && !iAmInitiator && (
          <div>
            <div style={{ background: "#1d1f23", borderRadius: 8, padding: 12, marginBottom: 10, border: "1px solid #3a3d45" }}>
              <div style={{ color: "#f5f5f5", fontWeight: 600, marginBottom: 4 }}>⚔️ {openMatch.initiator_name} threw something for {openMatch.initiator_stake}g</div>
              <div style={{ ...muted, fontSize: 13 }}>Their throw is secret until you accept. Winner gets {openMatch.initiator_stake * 2}g + 20% bump.</div>
              {(betTotals.initiator > 0 || betTotals.challenger > 0) && <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>Side bets: {betTotals.initiator}g on {openMatch.initiator_name} · {betTotals.challenger}g on challenger</div>}
            </div>

            {!iAmChallenger && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>Accept the challenge — pick your throw:</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(["stone", "parchment", "dagger"] as SpdThrow[]).map((t) => (
                    <button key={t} onClick={() => void spdAccept(openMatch.id, t)} disabled={loading || pub.gold < openMatch.initiator_stake}
                      style={{ ...smallActionBtn(pub.gold >= openMatch.initiator_stake ? "#2a1020" : "#222428", pub.gold >= openMatch.initiator_stake ? "#f9a8d4" : "#7a7d83"), opacity: pub.gold >= openMatch.initiator_stake ? 1 : 0.5, cursor: pub.gold >= openMatch.initiator_stake ? "pointer" : "not-allowed" }}>
                      {SPD_THROW_LABELS[t]}
                    </button>
                  ))}
                </div>
                {pub.gold < openMatch.initiator_stake && <div style={{ ...muted, fontSize: 12, marginTop: 6, color: "#fca5a5" }}>Need {openMatch.initiator_stake}g to accept (you have {pub.gold}g)</div>}
              </div>
            )}

            {canBet && (
              <div>
                <div style={{ ...muted, fontSize: 12, marginBottom: 8 }}>Or place a side bet (pays 2× if your pick wins):</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ ...muted, fontSize: 12 }}>Back {openMatch.initiator_name}:</span>
                  <StakeButtons
                    stakes={[5, 10, 25]}
                    gold={pub.gold}
                    disabled={loading}
                    btnStyle={(can) => ({ ...smallActionBtn(can ? "#2a1f10" : "#222428", can ? "#fdba74" : "#7a7d83") })}
                    customInputStyle={smallActionBtn("#2a1f10", "#fdba74")}
                    onPick={(amt) => void spdBet(openMatch.id, "initiator", amt)}
                  />
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ ...muted, fontSize: 12 }}>Back challenger:</span>
                  <StakeButtons
                    stakes={[5, 10, 25]}
                    gold={pub.gold}
                    disabled={loading}
                    btnStyle={(can) => ({ ...smallActionBtn(can ? "#10202a" : "#222428", can ? "#93c5fd" : "#7a7d83") })}
                    customInputStyle={smallActionBtn("#10202a", "#93c5fd")}
                    onPick={(amt) => void spdBet(openMatch.id, "challenger", amt)}
                  />
                </div>
              </div>
            )}

            {myBet && <div style={{ ...muted, fontSize: 13, marginTop: 8 }}>You bet {myBet.amount}g on {myBet.side === "initiator" ? openMatch.initiator_name : "the challenger"}.</div>}
          </div>
        )}
      </>)}
    </div>
  );
}

function PubLeaderboardCard({ entries }: { entries: PubLeaderboardEntry[] }) {
  return (
    <div style={card}>
      <h2 style={{ ...h2, marginBottom: 12 }}>
        <Icon name="trophy" size={1} /> Pub Leaderboard
      </h2>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #2a2d33" }}>
              <th style={{ textAlign: "left", padding: "4px 8px 4px 0", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>#</th>
              <th style={{ textAlign: "left", padding: "4px 8px", color: "#7a7d83", fontWeight: 500 }}>Player</th>
              <th style={{ textAlign: "right", padding: "4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>Games</th>
              <th style={{ textAlign: "right", padding: "4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>Wins</th>
              <th style={{ textAlign: "right", padding: "4px 0 4px 8px", color: "#7a7d83", fontWeight: 500, whiteSpace: "nowrap" }}>Net</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const rank = i + 1;
              const rankColor = rank === 1 ? "#fbbf24" : rank === 2 ? "#d1d5db" : rank === 3 ? "#cd7c2f" : "#7a7d83";
              const netColor = e.net > 0 ? "#86efac" : e.net < 0 ? "#fca5a5" : "#7a7d83";
              const winRate = e.games > 0 ? Math.round((e.wins / e.games) * 100) : 0;
              return (
                <tr key={e.user_id} style={{ borderBottom: "1px solid #1e2025" }}>
                  <td style={{ padding: "6px 8px 6px 0", color: rankColor, fontWeight: rank <= 3 ? 700 : 400 }}>{rank}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <div style={{ fontWeight: 500, color: "#f5f5f5" }}>{e.name}</div>
                    {e.slack_username && <div style={{ color: "#7a7d83", fontSize: 11 }}>@{e.slack_username}</div>}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "#cbd5e1" }}>{e.games}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "#cbd5e1" }}>{e.wins} <span style={{ color: "#7a7d83", fontSize: 11 }}>({winRate}%)</span></td>
                  <td style={{ padding: "6px 0 6px 8px", textAlign: "right", color: netColor, fontWeight: 600 }}>
                    {e.net > 0 ? "+" : ""}{e.net}g
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 10 }}>All-time across Liar's Roll, SPD matches, and side bets.</p>
    </div>
  );
}

export { PubCard, PubLeaderboardCard, LiarsRollCard, SpdCard };
