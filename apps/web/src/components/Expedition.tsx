// Expedition — top-level screen for an in-progress expedition run.
//
// Owns: fetching /api/expedition/:id, dispatching player picks, switching
// between map / event / shrine / treasure / camp sub-views.
//
// Combat picks are handled by the parent: when the picker returns
// dispatch.action === "spawn_combat", we surface the new quest_id via
// onCombatSpawned so App.tsx's existing CombatPage flow takes over.

import { useCallback, useEffect, useState } from "react";
import type { ExpeditionMap } from "@gantt-quest/core";
import { ExpeditionMapView } from "./ExpeditionMapView";
import { ExpeditionEvent, type EventOutcomePayload } from "./ExpeditionEvent";
import { RailParticipantCard, type PawnLike } from "../PawnCallout";

interface ProgressRow {
  node_id: string;
  resolved_at: number;
  outcome: Record<string, unknown> & { kind?: string };
}

interface ExpeditionViewResponse {
  expedition: {
    id: number;
    status: "active" | "completed" | "failed" | "abandoned";
    seed: string;
    current_node: string | null;
    created_at: number;
    completed_at: number | null;
  };
  map: ExpeditionMap;
  progress: ProgressRow[];
  party: string[];
  party_details: Array<{
    character_id: string;
    name: string;
    class: string;
    level: number;
    hp: number;
    max_hp: number;
    mana: number;
    max_mana: number;
  }>;
  buffs: Array<{
    kind: string;
    value: number;
    stat?: string;
    node_id: string;
    applied_at: number;
  }>;
  available_picks: string[];
}

type Dispatch =
  | { kind: "combat" | "elite" | "boss"; action: "spawn_combat"; tier: string; node_id: string; quest_id: number; elite?: boolean }
  | {
      kind: "event";
      action: "present_event";
      node_id: string;
      event: { id: string; title: string; body: string; branches: { id: string; label: string }[] } | null;
    }
  | {
      kind: "shrine";
      action: "present_choices";
      node_id: string;
      choices: ReadonlyArray<{ id: string; label: string; description: string; buff: { kind: string; value: number } }>;
    }
  | { kind: "camp"; action: "rested"; outcome: { kind: string; gold_awarded: number } }
  | {
      kind: "treasure";
      action: "present_offer";
      node_id: string;
      offer: {
        item_name: string;
        item_type: string;
        item_subtype: string | null;
        power: number;
        rarity: string;
      };
    };

export interface ExpeditionProps {
  expeditionId: number;
  /** Current user's slack_user_id — used to highlight the player's own
   *  pawn card in the party rail (matches CombatPage / dock behavior). */
  selfId: string;
  /** Notify parent when a combat node spawns a quest — parent routes to combat UI. */
  onCombatSpawned: (questId: number) => void;
  /** Called when the player abandons the run (status → abandoned). */
  onExit: () => void;
}

export function Expedition({ expeditionId, selfId, onCombatSpawned, onExit }: ExpeditionProps) {
  const [view, setView] = useState<ExpeditionViewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [activePanel, setActivePanel] = useState<Dispatch | null>(null);
  const [eventOutcome, setEventOutcome] = useState<EventOutcomePayload | null>(null);
  const [campOutcome, setCampOutcome] = useState<Dispatch | null>(null);
  const [treasureOutcome, setTreasureOutcome] = useState<{ accepted: boolean; item?: { name: string; rarity: string; power: number } } | null>(null);
  const [shrineOutcome, setShrineOutcome] = useState<{ choice_id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/expedition/${expeditionId}`, { credentials: "include" });
      if (!res.ok) {
        setError(`Could not load expedition: ${res.statusText}`);
        return;
      }
      const body = (await res.json()) as ExpeditionViewResponse;
      setView(body);
      setError(null);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [expeditionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handlePick(nodeId: string) {
    if (pending) return;
    setPending(true);
    setActivePanel(null);
    setEventOutcome(null);
    setCampOutcome(null);
    setTreasureOutcome(null);
    setShrineOutcome(null);
    try {
      const res = await fetch(`/api/expedition/${expeditionId}/pick`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: nodeId }),
      });
      const body = (await res.json()) as { ok?: boolean; dispatch?: Dispatch; error?: string };
      if (!body.ok) {
        setError(`Could not pick node: ${body.error ?? res.statusText}`);
        await refresh();
        return;
      }
      const dispatch = body.dispatch ?? null;
      if (dispatch?.action === "spawn_combat") {
        onCombatSpawned(dispatch.quest_id);
        return;
      }
      if (dispatch?.kind === "camp" && dispatch.action === "rested") {
        setCampOutcome(dispatch);
      } else if (dispatch) {
        setActivePanel(dispatch);
      }
      await refresh();
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setPending(false);
    }
  }

  async function handleEventBranch(branchId: string) {
    if (!activePanel || activePanel.kind !== "event") return;
    const nodeId = activePanel.node_id;
    const res = await fetch(`/api/expedition/${expeditionId}/resolve-event`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: nodeId, branch_id: branchId }),
    });
    const body = (await res.json()) as { ok?: boolean; outcome?: EventOutcomePayload; error?: string };
    if (!body.ok || !body.outcome) {
      setError(`Event resolution failed: ${body.error ?? res.statusText}`);
      return;
    }
    setEventOutcome(body.outcome);
    await refresh();
  }

  async function handleShrineChoose(choiceId: string) {
    if (!activePanel || activePanel.kind !== "shrine") return;
    setPending(true);
    try {
      const res = await fetch(`/api/expedition/${expeditionId}/shrine/choose`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: activePanel.node_id, choice_id: choiceId }),
      });
      const body = (await res.json()) as { ok?: boolean; outcome?: { choice_id: string }; error?: string };
      if (!body.ok) {
        setError(`Shrine choice failed: ${body.error ?? res.statusText}`);
        return;
      }
      setShrineOutcome({ choice_id: choiceId });
      await refresh();
    } finally {
      setPending(false);
    }
  }

  async function handleTreasureChoose(accept: boolean) {
    if (!activePanel || activePanel.kind !== "treasure") return;
    setPending(true);
    try {
      const res = await fetch(`/api/expedition/${expeditionId}/treasure/choose`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: activePanel.node_id, accept }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        outcome?: { accepted: boolean; item?: { name: string; rarity: string; power: number } };
        error?: string;
      };
      if (!body.ok) {
        setError(`Treasure choice failed: ${body.error ?? res.statusText}`);
        return;
      }
      setTreasureOutcome({
        accepted: body.outcome?.accepted ?? accept,
        item: body.outcome?.item,
      });
      await refresh();
    } finally {
      setPending(false);
    }
  }

  async function handleAbandon() {
    if (!window.confirm("Abandon this expedition? All progress will be lost.")) return;
    setPending(true);
    try {
      await fetch(`/api/expedition/${expeditionId}/abandon`, {
        method: "POST",
        credentials: "include",
      });
      onExit();
    } finally {
      setPending(false);
    }
  }

  if (loading || !view) {
    return (
      <div style={{ padding: 20, color: "var(--fg-mute)", fontFamily: "var(--font-body)" }}>
        Loading expedition…
      </div>
    );
  }

  const resolvedNodeIds = new Set(view.progress.map((p) => p.node_id));
  const availablePickIds = new Set(view.available_picks);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 980, margin: "0 auto", padding: "0 12px" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "var(--bg-card-2)",
          border: "1px solid var(--border-faint)",
          borderRadius: "var(--radius-2xl)",
          padding: "12px 16px",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              font: "10px/1 var(--font-body)",
              textTransform: "uppercase",
              letterSpacing: 1.4,
              fontWeight: 700,
              color: "var(--accent-gold)",
              marginBottom: 4,
            }}
          >
            Expedition #{view.expedition.id}
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>
            {view.progress.length} of {view.map.nodes.length - 2} nodes cleared
            {view.expedition.status !== "active" && (
              <span style={{ marginLeft: 8, color: "var(--accent-gold)" }}>
                ({view.expedition.status})
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {view.expedition.status === "active" && (
            <button
              onClick={handleAbandon}
              disabled={pending}
              style={{
                background: "transparent",
                border: "1px solid var(--border-faint)",
                color: "var(--fg-warn)",
                borderRadius: "var(--radius-lg)",
                padding: "6px 12px",
                cursor: pending ? "wait" : "pointer",
                fontSize: 12,
              }}
            >
              Abandon
            </button>
          )}
          {/* "← Town" header button only makes sense once the expedition is
              over — clicking it mid-run did nothing user-visible (App.tsx's
              auto-detect re-fetched /api/expedition/recent and snapped the
              user straight back to this screen on the next render). For an
              in-progress run, Abandon is the only real escape. */}
          {view.expedition.status !== "active" && (
            <button
              onClick={onExit}
              style={{
                background: "transparent",
                border: "1px solid var(--border-faint)",
                color: "var(--fg-mute)",
                borderRadius: "var(--radius-lg)",
                padding: "6px 12px",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              ← Town
            </button>
          )}
        </div>
      </header>

      {/* Party rail + run buffs.
          Reuses the same RailParticipantCard component the combat dock uses,
          so the avatar + HP/shield/mana stack + level chip in expedition mode
          matches what the player sees mid-fight. Previously this slot
          rendered a one-off PartyHpBar that just showed HP/mana bars without
          portraits or class affiliation — no visual continuity with combat. */}
      <div
        style={{
          background: "var(--bg-card-2)",
          border: "1px solid var(--border-faint)",
          borderRadius: "var(--radius-2xl)",
          padding: "12px 16px",
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {view.party_details.map((p) => {
          const pawn: PawnLike = {
            id: p.character_id,
            name: p.name,
            class: p.class,
            level: p.level,
            hp: p.hp,
            max_hp: p.max_hp,
            mana: p.mana,
            max_mana: p.max_mana,
          };
          const isSelf = p.character_id === selfId;
          // Match CombatPage's palette: cyan for self, purple for party-
          // mates. Keeps the "this one is you" cue consistent across modes.
          const themeColor = isSelf ? "#7dd3fc" : "#a78bfa";
          return (
            <RailParticipantCard
              key={p.character_id}
              pawn={pawn}
              side="fighter"
              themeColor={themeColor}
              isSelf={isSelf}
            />
          );
        })}
        {view.buffs.length > 0 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: "var(--fg-mute)", textTransform: "uppercase", letterSpacing: 1 }}>
              Run buffs:
            </span>
            {view.buffs.map((b, i) => (
              <span
                key={i}
                style={{
                  fontSize: 11,
                  background: "var(--bg-card)",
                  border: "1px solid var(--accent-gold)",
                  color: "var(--accent-gold)",
                  borderRadius: 999,
                  padding: "2px 8px",
                }}
              >
                {buffLabel(b)}
              </span>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div
          style={{
            color: "var(--fg-warn)",
            background: "var(--bg-card)",
            border: "1px solid var(--fg-warn)",
            borderRadius: "var(--radius-lg)",
            padding: "8px 12px",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* Active node interaction — event / shrine / treasure / camp.
          Wrapped in a fixed-position modal so it's always visible regardless
          of where the player has the map scrolled. Previously these
          rendered inline below the map, which on a tall map (or after a
          vertical-mode scroll on mobile) could leave the panel completely
          off-screen — the player tapped a node and saw no UI change, looked
          like the game broke. The modal forces focus on the interaction. */}
      <ExpeditionPanelModal
        open={
          activePanel != null
          || shrineOutcome != null
          || treasureOutcome != null
          || campOutcome != null
        }
      >
        {activePanel?.kind === "event" && activePanel.event && (
          <ExpeditionEvent
            nodeId={activePanel.node_id}
            event={activePanel.event}
            resolved={eventOutcome}
            onPickBranch={handleEventBranch}
            onContinue={() => {
              setActivePanel(null);
              setEventOutcome(null);
            }}
          />
        )}
        {activePanel?.kind === "shrine" && !shrineOutcome && (
          <ShrinePanel choices={activePanel.choices} pending={pending} onChoose={handleShrineChoose} />
        )}
        {shrineOutcome && (
          <CompletionPanel
            title="Blessing received"
            body="The shrine's gift settles over the party."
            onContinue={() => {
              setActivePanel(null);
              setShrineOutcome(null);
            }}
          />
        )}
        {activePanel?.kind === "treasure" && !treasureOutcome && (
          <TreasurePanel
            offer={activePanel.offer}
            pending={pending}
            onChoose={handleTreasureChoose}
          />
        )}
        {treasureOutcome && (
          <CompletionPanel
            title={treasureOutcome.accepted ? "You picked up the loot" : "You left it behind"}
            body={
              treasureOutcome.accepted && treasureOutcome.item
                ? `${treasureOutcome.item.name} — power ${treasureOutcome.item.power}, ${treasureOutcome.item.rarity}.`
                : "Sometimes the cache stays closed."
            }
            onContinue={() => {
              setActivePanel(null);
              setTreasureOutcome(null);
            }}
          />
        )}
        {campOutcome?.kind === "camp" && (
          <CompletionPanel
            title="Camped for the night"
            body={`The party rests. HP and mana refilled. +${campOutcome.outcome.gold_awarded} gold from foraging.`}
            onContinue={() => setCampOutcome(null)}
          />
        )}
      </ExpeditionPanelModal>

      {/* Map view always visible at bottom (or top if no panel). */}
      <ExpeditionMapView
        map={view.map}
        currentNode={view.expedition.current_node}
        resolvedNodeIds={resolvedNodeIds}
        availablePickIds={availablePickIds}
        onPick={(id) => void handlePick(id)}
      />

      {/* Boss-clear summary */}
      {view.expedition.status === "completed" && (
        <div
          style={{
            background: "var(--bg-card-2)",
            border: "1px solid var(--accent-gold)",
            borderRadius: "var(--radius-2xl)",
            padding: 20,
            textAlign: "center",
          }}
        >
          <h2 style={{ color: "var(--accent-gold)", margin: 0 }}>Expedition Complete</h2>
          <p style={{ color: "var(--fg-mute)", marginTop: 8 }}>
            The boss is down. The road home is the long way around.
          </p>
          <button
            onClick={onExit}
            style={{
              marginTop: 14,
              background: "var(--bg-elev)",
              border: "1px solid var(--accent-gold)",
              borderRadius: "var(--radius-lg)",
              padding: "10px 22px",
              cursor: "pointer",
              color: "var(--accent-gold)",
              fontWeight: 600,
            }}
          >
            Return to town
          </button>
        </div>
      )}
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buffLabel(b: { kind: string; value: number; stat?: string }): string {
  if (b.kind === "max_hp") return `+${b.value} max HP`;
  if (b.kind === "mana_refill") return `Mana refilled`;
  if (b.kind === "stat") return `+${b.value} ${b.stat ?? "stat"}`;
  return b.kind;
}

// PartyHpBar removed — the expedition rail now reuses RailParticipantCard
// from PawnCallout.tsx for visual continuity with combat. See the party
// render block in <Expedition> above.

// Modal scaffold for the active node panel (event / shrine / treasure / camp
// outcome). Borrowed from the VictoryModal pattern in CombatPage so the
// player gets a centered card that owns the viewport — no risk of the
// panel rendering off-screen below a scrolled map. The card itself
// scrolls if its content is taller than the viewport, important for the
// longer event payloads. There's no scrim-tap-to-dismiss because each
// inner panel owns its own "continue" / "pick branch" affordance — every
// path through these screens has a deliberate exit, so dismiss-by-accident
// would only cause confusion.
function ExpeditionPanelModal({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.78)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        zIndex: 100,
        padding: 16,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 560,
          margin: "24px auto auto",
          boxSizing: "border-box",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ShrinePanel({
  choices,
  pending,
  onChoose,
}: {
  choices: ReadonlyArray<{ id: string; label: string; description: string }>;
  pending: boolean;
  onChoose: (id: string) => void;
}) {
  return (
    <div
      style={{
        background: "var(--bg-card-2)",
        border: "1px solid var(--border-faint)",
        borderRadius: "var(--radius-2xl)",
        padding: 20,
      }}
    >
      <div
        style={{
          font: "10px/1 var(--font-body)",
          textTransform: "uppercase",
          letterSpacing: 1.4,
          fontWeight: 700,
          color: "var(--accent-gold)",
          marginBottom: 6,
        }}
      >
        A Shrine
      </div>
      <h2 style={{ margin: "0 0 14px", fontSize: 20 }}>Choose a blessing</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {choices.map((c) => (
          <button
            key={c.id}
            onClick={() => onChoose(c.id)}
            disabled={pending}
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border-faint)",
              borderLeft: "3px solid var(--accent-gold)",
              borderRadius: "var(--radius-lg)",
              padding: "12px 14px",
              cursor: pending ? "wait" : "pointer",
              textAlign: "left",
              color: "var(--fg-base)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{c.label}</div>
            <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>{c.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TreasurePanel({
  offer,
  pending,
  onChoose,
}: {
  offer: { item_name: string; item_type: string; power: number; rarity: string };
  pending: boolean;
  onChoose: (accept: boolean) => void;
}) {
  return (
    <div
      style={{
        background: "var(--bg-card-2)",
        border: "1px solid var(--border-faint)",
        borderRadius: "var(--radius-2xl)",
        padding: 20,
      }}
    >
      <div
        style={{
          font: "10px/1 var(--font-body)",
          textTransform: "uppercase",
          letterSpacing: 1.4,
          fontWeight: 700,
          color: "var(--accent-gold)",
          marginBottom: 6,
        }}
      >
        A Cache
      </div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>{offer.item_name}</h2>
      <div style={{ color: "var(--fg-mute)", fontSize: 12, marginBottom: 14 }}>
        {offer.rarity} {offer.item_type} · power {offer.power}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={() => onChoose(true)}
          disabled={pending}
          style={{
            flex: 1,
            background: "var(--bg-elev)",
            border: "1px solid var(--accent-gold)",
            borderRadius: "var(--radius-lg)",
            padding: "10px 14px",
            cursor: pending ? "wait" : "pointer",
            color: "var(--accent-gold)",
            fontWeight: 600,
          }}
        >
          Take it
        </button>
        <button
          onClick={() => onChoose(false)}
          disabled={pending}
          style={{
            flex: 1,
            background: "transparent",
            border: "1px solid var(--border-faint)",
            borderRadius: "var(--radius-lg)",
            padding: "10px 14px",
            cursor: pending ? "wait" : "pointer",
            color: "var(--fg-mute)",
          }}
        >
          Leave it
        </button>
      </div>
    </div>
  );
}

function CompletionPanel({
  title,
  body,
  onContinue,
}: {
  title: string;
  body: string;
  onContinue: () => void;
}) {
  return (
    <div
      style={{
        background: "var(--bg-card-2)",
        border: "1px solid var(--border-faint)",
        borderRadius: "var(--radius-2xl)",
        padding: 20,
      }}
    >
      <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>{title}</h2>
      <p style={{ margin: "0 0 14px", color: "var(--fg-mute)" }}>{body}</p>
      <button
        onClick={onContinue}
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--accent-gold)",
          borderRadius: "var(--radius-lg)",
          padding: "10px 22px",
          cursor: "pointer",
          color: "var(--accent-gold)",
          fontWeight: 600,
        }}
      >
        Continue
      </button>
    </div>
  );
}
