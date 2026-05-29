// Pub Errands panel — mounted alongside PubCard inside the pub modal.
//
// Renders patron cards with their daily offer rotation, trust meter, and a
// pinned active-errand strip. Reuses the toast pump in App.tsx (the camp
// status poll also picks up pub errands, surfacing a "[Patron] sent word"
// toast when one completes).

import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import type { CSSProperties, ReactNode } from "react";

import { Icon } from "../icons";
import { RESOURCE_CATALOG, findResource, type ResourceSpec } from "@gantt-quest/core";

import type {
  ActivePubErrand, Item, PubErrandKind, PubErrandOffer, PubErrandsResponse, PubPatron, PubTrust,
} from "../types";
import { card, h2, muted } from "../styles";

interface PubErrandsProps {
  data: PubErrandsResponse | null;
  inventory: Item[];
  onStart: (offerId: number, inputResourceId?: string) => Promise<void>;
  onClaim: (errandId: number) => Promise<void>;
  onCancel: (errandId: number) => Promise<void>;
}

const KIND_META: Record<PubErrandKind, { label: string; icon: string; blurb: string }> = {
  courier:     { label: "Courier",     icon: "scroll-unfurled", blurb: "Run a package to another district." },
  procure:     { label: "Procure",     icon: "cubes",           blurb: "They want resources from the wilds." },
  investigate: { label: "Investigate", icon: "magnifying-glass", blurb: "Chase a rumor; come back with what you learn." },
  mercy:       { label: "Mercy",       icon: "first-aid-kit",   blurb: "Deliver healing to someone who can't make it in." },
  rare:        { label: "Personal favor", icon: "trophy",       blurb: "A one-time ask. They wouldn't trust anyone else." },
};

export function PubErrands({ data, inventory, onStart, onClaim, onCancel }: PubErrandsProps) {
  if (!data) return null;
  const active = data.active;
  const trustByPatron = useMemo(() => {
    const m = new Map<string, PubTrust>();
    for (const t of data.trust) m.set(t.patron_id, t);
    return m;
  }, [data.trust]);
  const offersByPatron = useMemo(() => {
    const m = new Map<string, PubErrandOffer[]>();
    for (const o of data.offers) {
      if (!m.has(o.patron_id)) m.set(o.patron_id, []);
      m.get(o.patron_id)!.push(o);
    }
    return m;
  }, [data.offers]);

  return (
    <div style={card}>
      <h2 style={{ ...h2, display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <Icon name="conversation" size={20} /> Errands
      </h2>
      <p style={muted}>
        <em>"Regulars'll ask favors. Sometimes they pay better than the job board."</em>
      </p>

      {active && (
        <ActiveErrandRow
          active={active}
          patron={data.patrons.find((p) => p.id === active.patron_id)!}
          now={data.now}
          onClaim={onClaim}
          onCancel={onCancel}
        />
      )}

      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {data.patrons.map((p) => (
          <PatronCard
            key={p.id}
            patron={p}
            trust={trustByPatron.get(p.id) ?? { patron_id: p.id, score: 0, rare_claimed: false, cap: 10 }}
            offers={offersByPatron.get(p.id) ?? []}
            inventory={inventory}
            active={active}
            onStart={onStart}
          />
        ))}
      </div>
    </div>
  );
}

function ActiveErrandRow({
  active, patron, now, onClaim, onCancel,
}: {
  active: ActivePubErrand;
  patron: PubPatron;
  now: number;
  onClaim: (errandId: number) => Promise<void>;
  onCancel: (errandId: number) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const ready = active.ready || active.expires_at <= now;
  const remainingMs = Math.max(0, active.expires_at - now);
  const totalMs = active.expires_at - active.started_at;
  const pct = totalMs > 0 ? Math.min(100, ((totalMs - remainingMs) / totalMs) * 100) : 100;
  const kindMeta = KIND_META[active.kind];

  async function handleClaim() {
    setBusy(true);
    try { await onClaim(active.id); } finally { setBusy(false); }
  }
  async function handleCancel() {
    setBusy(true);
    try { await onCancel(active.id); } finally { setBusy(false); }
  }

  return (
    <div style={{
      marginTop: 14,
      padding: "12px 14px",
      borderRadius: "var(--radius-lg)",
      border: ready ? "1px solid var(--accent-go-1, #4ade80)" : "1px solid var(--border-base)",
      background: "var(--bg-card-2)",
      display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 14, alignItems: "center",
    }}>
      <Icon name={kindMeta.icon} size={22} color={ready ? "#4ade80" : "var(--fg-mute)"} />
      <div>
        <div style={{ fontWeight: 600 }}>{patron.name} · {kindMeta.label}</div>
        <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>
          {ready ? "Back in the pub — they have your reward." : `${formatRemaining(remainingMs)} left`}
        </div>
        <div style={{
          height: 4, marginTop: 6, borderRadius: 999, background: "var(--bg-void)", position: "relative", overflow: "hidden",
        }}>
          <div style={{
            position: "absolute", inset: 0, width: `${pct}%`,
            background: ready ? "#4ade80" : "var(--accent-ink-blue-2)",
            transition: "width 1s linear",
          }} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {!ready && (
          <button
            type="button"
            disabled={busy}
            onClick={handleCancel}
            style={ghostBtn}
            title="Cancel and refund any consumed resources"
          >Cancel</button>
        )}
        <button
          type="button"
          disabled={!ready || busy}
          onClick={handleClaim}
          style={{ ...primaryBtn, opacity: ready && !busy ? 1 : 0.6 }}
        >
          {busy ? "…" : ready ? "Collect" : "Working"}
        </button>
      </div>
    </div>
  );
}

function PatronCard({
  patron, trust, offers, inventory, active, onStart,
}: {
  patron: PubPatron;
  trust: PubTrust;
  offers: PubErrandOffer[];
  inventory: Item[];
  active: ActivePubErrand | null;
  onStart: (offerId: number, inputResourceId?: string) => Promise<void>;
}) {
  return (
    <div style={{
      padding: 14, borderRadius: "var(--radius-lg)", border: "1px solid var(--border-base)", background: "var(--bg-card-2)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Icon name={patron.icon} size={26} color="var(--fg-1)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontFamily: "var(--font-display)", fontSize: 16 }}>{patron.name}</div>
          <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>{patron.archetype}</div>
        </div>
        <TrustMeter score={trust.score} cap={trust.cap} />
      </div>
      <div style={{ ...muted, fontSize: 12, marginTop: 6 }}>{patron.blurb}</div>

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {offers.length === 0 ? (
          <div style={{ ...muted, fontSize: 12 }}>Nothing on their list today.</div>
        ) : offers.map((offer) => (
          <OfferRow
            key={offer.id}
            offer={offer}
            patron={patron}
            inventory={inventory}
            disabled={!!active}
            onStart={onStart}
          />
        ))}
      </div>
    </div>
  );
}

function OfferRow({
  offer, patron, inventory, disabled, onStart,
}: {
  offer: PubErrandOffer;
  patron: PubPatron;
  inventory: Item[];
  disabled: boolean;
  onStart: (offerId: number, inputResourceId?: string) => Promise<void>;
}) {
  const kindMeta = KIND_META[offer.kind];
  const [busy, setBusy] = useState(false);
  // Procure: pick which resource from the patron's family to spend.
  const procureChoices = useMemo(() => {
    if (offer.kind !== "procure") return [];
    return resourcesForNode(inventory, patron.procure_resource_node);
  }, [offer.kind, patron.procure_resource_node, inventory]);
  const [picked, setPicked] = useState<string>(procureChoices[0]?.spec.id ?? "");

  const enoughProcureInputs = offer.kind !== "procure" || (() => {
    const choice = procureChoices.find((c) => c.spec.id === picked);
    return choice ? choice.qty >= offer.procure_qty : false;
  })();
  const canStart = !disabled && enoughProcureInputs && (offer.kind !== "procure" || !!picked);

  async function handle() {
    if (!canStart) return;
    setBusy(true);
    try { await onStart(offer.id, offer.kind === "procure" ? picked : undefined); } finally { setBusy(false); }
  }

  return (
    <div style={{
      padding: "10px 12px", borderRadius: "var(--radius-md)",
      border: "1px solid var(--border-base)", background: "var(--bg-card)",
      display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, alignItems: "center",
    }}>
      <Icon name={kindMeta.icon} size={18} color="var(--fg-mute)" />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {kindMeta.label}{" "}
          <span style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2 }}>
            · {tierLabel(offer.tier)} · {formatDuration(offer.duration_ms)}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>{kindMeta.blurb}</div>
        <div style={{ fontSize: 11, color: "var(--fg-mute)", marginTop: 4 }}>
          +{offer.base_xp} XP · +{offer.base_gold} gold
          {offer.kind === "procure" && (
            <> · needs {offer.procure_qty} × {patron.procure_resource_node} resource</>
          )}
          {offer.kind === "mercy" && <> · +1 apothecary discount stack</>}
          {offer.kind === "rare" && <> · grants <em>{patron.rare_item.item_name}</em></>}
        </div>
        {offer.kind === "procure" && (
          <div style={{ marginTop: 6 }}>
            {procureChoices.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--accent-no-1, #f87171)" }}>
                No {patron.procure_resource_node} resources on hand.
              </div>
            ) : (
              <select
                value={picked}
                onChange={(e) => setPicked(e.target.value)}
                disabled={disabled || busy}
                style={{
                  background: "var(--bg-card-2)", color: "var(--fg-1)",
                  border: "1px solid var(--border-base)", borderRadius: "var(--radius-md)",
                  padding: "3px 6px", fontFamily: "inherit", fontSize: 12,
                }}
              >
                {procureChoices.map((c) => (
                  <option key={c.spec.id} value={c.spec.id}>
                    {c.spec.emoji} {c.spec.name} ({c.qty} on hand)
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        disabled={!canStart || busy}
        onClick={handle}
        style={{ ...primaryBtn, opacity: canStart && !busy ? 1 : 0.6 }}
        title={disabled ? "Finish your current errand first" : ""}
      >
        {busy ? "…" : disabled ? "Busy" : !enoughProcureInputs ? "Need inputs" : "Accept"}
      </button>
    </div>
  );
}

function TrustMeter({ score, cap }: { score: number; cap: number }) {
  const filled = Math.max(0, Math.min(cap, score));
  return (
    <div title={`Trust ${score}/${cap}`} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
      <div style={{ fontSize: 10, color: "var(--fg-mute)", textTransform: "uppercase", letterSpacing: 1.2 }}>
        Trust
      </div>
      <div style={{ display: "flex", gap: 2 }}>
        {Array.from({ length: cap }).map((_, i) => (
          <span key={i} style={{
            width: 6, height: 8, borderRadius: 2,
            background: i < filled ? "var(--accent-go-1, #4ade80)" : "var(--bg-void)",
            border: "1px solid var(--border-base)",
          }} />
        ))}
      </div>
    </div>
  );
}

function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function formatDuration(ms: number): string {
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60000)} min`;
  const hours = Math.round(ms / (60 * 60 * 1000) * 10) / 10;
  return `${hours} hr`;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "ready";
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec.toString().padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${(min % 60).toString().padStart(2, "0")}m`;
}

function resourcesForNode(inventory: Item[], node: "mine" | "forage" | "fish"): Array<{ spec: ResourceSpec; qty: number }> {
  return RESOURCE_CATALOG
    .filter((s) => s.node === node)
    .map((spec) => {
      const fullName = `${spec.emoji} ${spec.name}`;
      const qty = inventory
        .filter((it) => it.item_type === "resource" && it.item_name === fullName)
        .reduce((sum, it) => sum + (it.qty ?? 1), 0);
      return { spec, qty };
    })
    .filter((entry) => entry.qty > 0);
}

const primaryBtn: CSSProperties = {
  padding: "6px 14px",
  border: "1px solid var(--border-base)",
  borderRadius: "var(--radius-md)",
  background: "var(--accent-ink-blue-2)",
  color: "#fff",
  cursor: "pointer",
  fontFamily: "inherit",
  fontWeight: 600,
};

const ghostBtn: CSSProperties = {
  padding: "6px 14px",
  border: "1px solid var(--border-base)",
  borderRadius: "var(--radius-md)",
  background: "transparent",
  color: "var(--fg-mute)",
  cursor: "pointer",
  fontFamily: "inherit",
};
