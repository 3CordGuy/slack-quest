// ExpeditionEvent — renders the active event for the current expedition node.
//
// Props:
//   * nodeId      — the expedition node id this event is attached to
//   * event       — the event payload (id, title, body, branches)
//   * onResolve   — async callback when the player commits to a branch
//   * resolved    — optional already-resolved outcome to render in "after" mode
//
// Two states:
//   1) Pre-pick: title, body, branch buttons.
//   2) Post-pick: shows the outcome text + any deltas (gold, hp, mana, item).
//      Includes a "Continue" affordance so the parent can dismiss the panel
//      and re-render the map.

import { useState } from "react";

export interface ExpeditionEventChoice {
  id: string;
  label: string;
}

export interface ExpeditionEventData {
  id: string;
  title: string;
  body: string;
  branches: ExpeditionEventChoice[];
}

export interface EventOutcomePayload {
  kind: "event";
  event_id: string;
  branch_id: string;
  outcome_text: string;
  effects: {
    gold?: number;
    hp?: number;
    mana?: number;
    xp?: number;
    item?: string;
    effect?: string;
  } | null;
  applied: {
    gold_delta: number;
    hp_delta: number;
    mana_delta: number;
    xp_delta: number;
    item_granted: string | null;
    effect_applied: string | null;
  };
}

export interface ExpeditionEventProps {
  nodeId: string;
  event: ExpeditionEventData;
  resolved: EventOutcomePayload | null;
  onPickBranch: (branchId: string) => Promise<void>;
  onContinue: () => void;
}

export function ExpeditionEvent({
  event,
  resolved,
  onPickBranch,
  onContinue,
}: ExpeditionEventProps) {
  const [pending, setPending] = useState<string | null>(null);

  async function handlePick(branchId: string) {
    if (pending) return;
    setPending(branchId);
    try {
      await onPickBranch(branchId);
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      style={{
        background: "var(--bg-card-2)",
        border: "1px solid var(--border-faint)",
        borderRadius: "var(--radius-2xl)",
        padding: 20,
        boxSizing: "border-box",
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
        An Event on the Road
      </div>
      <h2 style={{ margin: "0 0 10px", fontSize: 22, color: "var(--fg-base)" }}>
        {event.title}
      </h2>
      <p
        style={{
          margin: "0 0 16px",
          lineHeight: 1.55,
          color: "var(--fg-mute)",
          fontSize: 14,
        }}
      >
        {event.body}
      </p>

      {!resolved && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {event.branches.map((b) => (
            <button
              key={b.id}
              onClick={() => handlePick(b.id)}
              disabled={pending !== null}
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border-faint)",
                borderLeft: "3px solid var(--accent-gold)",
                borderRadius: "var(--radius-lg)",
                padding: "10px 14px",
                cursor: pending ? "wait" : "pointer",
                textAlign: "left",
                color: "var(--fg-base)",
                fontSize: 14,
                opacity: pending && pending !== b.id ? 0.5 : 1,
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      {resolved && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border-faint)",
            borderRadius: "var(--radius-lg)",
            padding: 14,
            marginTop: 6,
          }}
        >
          <div
            style={{
              fontStyle: "italic",
              color: "var(--fg-base)",
              marginBottom: 10,
              lineHeight: 1.5,
            }}
          >
            {resolved.outcome_text}
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12 }}>
            {resolved.applied.gold_delta !== 0 && (
              <span style={{ color: resolved.applied.gold_delta > 0 ? "var(--accent-gold)" : "var(--fg-warn)" }}>
                {resolved.applied.gold_delta > 0 ? "+" : ""}
                {resolved.applied.gold_delta} gold
              </span>
            )}
            {resolved.applied.hp_delta !== 0 && (
              <span style={{ color: resolved.applied.hp_delta > 0 ? "var(--accent-hp)" : "var(--fg-warn)" }}>
                {resolved.applied.hp_delta > 0 ? "+" : ""}
                {resolved.applied.hp_delta} HP
              </span>
            )}
            {resolved.applied.mana_delta !== 0 && (
              <span style={{ color: resolved.applied.mana_delta > 0 ? "var(--accent-mana)" : "var(--fg-warn)" }}>
                {resolved.applied.mana_delta > 0 ? "+" : ""}
                {resolved.applied.mana_delta} mana
              </span>
            )}
            {resolved.applied.xp_delta > 0 && (
              <span style={{ color: "var(--fg-mute)" }}>
                +{resolved.applied.xp_delta} XP
              </span>
            )}
            {resolved.applied.item_granted && (
              <span style={{ color: "var(--fg-base)" }}>
                got {resolved.applied.item_granted}
              </span>
            )}
            {resolved.applied.effect_applied && (
              <span style={{ color: "var(--fg-warn)" }}>
                ({resolved.applied.effect_applied})
              </span>
            )}
          </div>
          <button
            onClick={onContinue}
            style={{
              marginTop: 14,
              width: "100%",
              background: "var(--bg-elev)",
              border: "1px solid var(--accent-gold)",
              borderRadius: "var(--radius-lg)",
              padding: "10px 14px",
              cursor: "pointer",
              color: "var(--accent-gold)",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            Continue
          </button>
        </div>
      )}
    </div>
  );
}
