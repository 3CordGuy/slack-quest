import { useState } from "react";
import { Icon } from "../icons";
import { artPlaceholder } from "../utils";
import { RARITY_COLOR } from "../constants";
import { muted, DISPLAY_FONT, refreshBtn, smallBadge, button } from "../styles";
import type { HaggleResult, ConfirmRequest, Rarity } from "../types";

// ─── Location art ─────────────────────────────────────────────────────────────

export function LocationHero({
  src,
  label,
  nav,
  flush = false,
}: {
  src?: string | null;
  label: string;
  nav: React.ReactNode;
  flush?: boolean;
}) {
  const ph = artPlaceholder(label);
  return (
    <div style={{
      ...(flush
        ? { width: "100%", margin: "0 0 0", borderRadius: 0 }
        : {
            width: "calc(100% + calc(var(--card-pad, 32px) * 2))",
            margin: "calc(-1 * var(--card-pad, 32px)) calc(-1 * var(--card-pad, 32px)) 20px",
            borderRadius: "12px 12px 0 0",
          }),
      overflow: "hidden",
      position: "relative",
      background: src ? "#0d0d10" : ph.bg,
      ...(src ? { aspectRatio: "16/7" } : { minHeight: 160, display: "flex", alignItems: "center", justifyContent: "center", paddingTop: 44 }),
    }}>
      {src && (
        <img
          src={src}
          alt={label}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          onError={(e) => { e.currentTarget.style.display = "none"; }}
        />
      )}
      {!src && <Icon name={ph.icon} size={48} color={ph.color} style={{ opacity: 0.3 }} />}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0,
        background: "rgba(10,11,14,0.6)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        padding: "10px 20px",
      }}>
        {nav}
      </div>
      {src && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          background: "linear-gradient(transparent, rgba(10,11,14,0.88))",
          padding: "36px 20px 14px",
        }}>
          <span style={{ color: "#f1e8c8", fontSize: 17, fontWeight: 600, letterSpacing: 0.5 }}>
            {label}
          </span>
        </div>
      )}
    </div>
  );
}

export function Banner({ src, alt }: { src: string | null | undefined; alt: string }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  if (!src) {
    const ph = artPlaceholder(alt);
    return (
      <div style={{
        width: "calc(100% + 32px)",
        margin: "-16px -16px 12px",
        aspectRatio: "3 / 2",
        borderRadius: "8px 8px 0 0",
        background: ph.bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
        <Icon name={ph.icon} size={52} color={ph.color} style={{ opacity: 0.3 }} />
      </div>
    );
  }
  return (
    <>
      <div
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: "calc(100% + 32px)",
          margin: "-16px -16px 12px",
          aspectRatio: "3 / 2",
          overflow: "hidden",
          borderRadius: "8px 8px 0 0",
          cursor: "zoom-in",
          position: "relative",
        }}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          style={{
            width: "100%", height: "100%", objectFit: "cover", display: "block",
            transition: "transform 0.2s ease",
            transform: hovered ? "scale(1.03)" : "scale(1)",
          }}
          onError={(e) => {
            (e.currentTarget.parentElement as HTMLDivElement).style.display = "none";
          }}
        />
      </div>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 9999, cursor: "zoom-out",
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

// ─── Item badges ──────────────────────────────────────────────────────────────

export function RarityBadge({ rarity }: { rarity: Rarity }) {
  const color = RARITY_COLOR[rarity];
  return (
    <span
      style={{
        ...smallBadge,
        background: `${color}22`,
        color,
        borderColor: `${color}55`,
      }}
    >
      {rarity}
    </span>
  );
}

export function SmallBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        ...smallBadge,
        background: "#2a2d33",
        color: "#c4c4c4",
        borderColor: "#3a3d44",
      }}
    >
      {children}
    </span>
  );
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

export function RefreshButton({ onRefresh, style }: { onRefresh: () => Promise<void>; style?: React.CSSProperties }) {
  const [spinning, setSpinning] = useState(false);
  async function handleClick() {
    setSpinning(true);
    try { await onRefresh(); } finally { setSpinning(false); }
  }
  return (
    <button onClick={handleClick} disabled={spinning} style={{ ...refreshBtn, ...style, opacity: spinning ? 0.6 : 1 }}>
      {spinning ? "…" : "↺ Refresh"}
    </button>
  );
}

export function RestockButton({ onRestock }: { onRestock: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  async function handleClick() {
    setState("loading");
    try { await onRestock(); setState("done"); } catch { setState("idle"); }
  }
  return (
    <button
      onClick={handleClick}
      disabled={state !== "idle"}
      style={{
        background: "#1a2a1a",
        border: "1px solid #4ade8055",
        borderRadius: 6,
        color: "#4ade80",
        cursor: state === "idle" ? "pointer" : "default",
        fontSize: 12,
        padding: "6px 14px",
        fontFamily: "inherit",
        fontWeight: 600,
        opacity: state === "loading" ? 0.6 : 1,
        marginBottom: 12,
      }}
    >
      {state === "loading" ? "Restocking…" : state === "done" ? "✓ Done" : "🛒 Restock Shop"}
    </button>
  );
}

// ─── Modals ───────────────────────────────────────────────────────────────────

export function ModalBackdrop({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1a1c20",
          border: "1px solid #2a2d33",
          borderRadius: 12,
          padding: 24,
          maxWidth: 460,
          width: "100%",
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function HaggleResultDialog({
  result,
  onClose,
}: {
  result: HaggleResult;
  onClose: () => void;
}) {
  const failed = result.bucket === "failed";
  const steal = result.bucket === "steal";
  const headline = failed
    ? "Haggle failed."
    : steal
      ? `STEAL! −30% off.`
      : `−${result.outcome}% off.`;
  const headlineColor = failed ? "#fca5a5" : steal ? "#fbbf24" : "#86efac";
  return (
    <ModalBackdrop onCancel={onClose}>
      <div style={{ ...muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 1.5, fontFamily: DISPLAY_FONT }}>
        <Icon name="gold-bar" /> Shopkeeper
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: headlineColor, marginTop: 8, fontFamily: DISPLAY_FONT }}>
        {headline}
      </div>
      <div style={{ ...muted, fontSize: 13, marginTop: 4 }}>
        {result.item_name} · 1d6{result.modifier > 0 ? `+${result.modifier}` : result.modifier < 0 ? `${result.modifier}` : ""} = {result.total}
      </div>
      <p style={{ color: "#e6e6e6", fontStyle: "italic", marginTop: 16, lineHeight: 1.5 }}>
        "{result.flavor}"
      </p>
      {!failed && (
        <div style={{ ...muted, fontSize: 13, marginTop: 12 }}>
          Price: <span style={{ textDecoration: "line-through" }}>{result.old_price}g</span>{" "}
          → <strong style={{ color: "#86efac" }}>{result.new_price}g</strong>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
        <button onClick={onClose} style={button}>OK</button>
      </div>
    </ModalBackdrop>
  );
}

export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest;
  onClose: () => void;
}) {
  return (
    <ModalBackdrop onCancel={onClose}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#f5f5f5" }}>{request.title}</div>
      <p style={{ ...muted, marginTop: 8, lineHeight: 1.5 }}>{request.message}</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
        <button onClick={onClose} style={{ ...button, background: "#33363d" }}>Cancel</button>
        <button
          onClick={() => {
            request.onConfirm();
            onClose();
          }}
          style={{
            ...button,
            background: request.destructive ? "#7c2020" : "#1f3a1f",
            color: request.destructive ? "#fecaca" : "#86efac",
          }}
        >
          {request.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </ModalBackdrop>
  );
}
