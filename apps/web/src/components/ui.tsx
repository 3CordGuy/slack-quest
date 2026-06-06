import { cloneElement, isValidElement, useEffect, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react";
import { Icon } from "../icons";
import { artPlaceholder } from "../utils";
import { RARITY_COLOR } from "../constants";
import { muted, DISPLAY_FONT, refreshBtn, smallBadge, button } from "../styles";
import type { HaggleResult, ConfirmRequest, Rarity, Character } from "../types";

// ─── HoverTooltip ────────────────────────────────────────────────────────────
// Reusable hover tooltip that renders into a FloatingPortal so it escapes any
// `overflow: hidden` ancestor (Inventory modal, location modal body, etc.).
// Pass the trigger element as `children` — we forward `onMouseEnter` /
// `onMouseLeave` / `ref` onto it via cloneElement. The tooltip content goes
// in `content`. Provide a `placement` to override the default "top".
//
// Mobile (`(hover: none)`): hover events don't really exist, so on touch
// devices we toggle the tooltip on tap of the trigger and dismiss on the
// next tap anywhere. The dismiss listener fires on `touchstart` in capture
// phase and calls `preventDefault()` — this is the canonical fix for the
// mobile tap-pass-through bug. Without it, the tooltip panel has
// `pointer-events: none` and the tap falls through to whatever is rendered
// beneath, firing that element's click handler (e.g. tapping a tooltip to
// dismiss it would also fire the button it was anchored to). Calling
// `preventDefault()` on `touchstart` suppresses the synthesized `mousedown`
// / `mouseup` / `click` for that touch, so the underlying surface stays
// inert until the user taps again. Same belt-and-suspenders pattern PR #206
// used for toasts.

export function HoverTooltip({
  content,
  placement = "top",
  children,
  panelStyle,
}: {
  content: ReactNode;
  placement?: "top" | "bottom" | "left" | "right" | "top-start" | "top-end";
  children: ReactElement;
  panelStyle?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  // While the tooltip is open on a touch device, listen for the next tap
  // anywhere on the page. We dismiss the tooltip AND swallow the touch via
  // preventDefault so the underlying surface (button, hex, slot) doesn't
  // see a click. The trigger itself is exempt via a contains() check so
  // the trigger's own toggle behaviour still works.
  useEffect(() => {
    if (!open) return;
    if (typeof window === "undefined") return;
    // Only enable the swallow-on-tap behaviour on touch / coarse-pointer
    // devices. On a mouse/trackpad the tooltip auto-closes via mouseleave
    // and an extra capture-phase listener would interfere with normal
    // clicking.
    const isTouch = window.matchMedia?.("(hover: none)").matches ?? false;
    if (!isTouch) return;

    const triggerEl = refs.reference.current as Element | null;
    const floatingEl = refs.floating.current as Element | null;

    const onTouchStart = (e: TouchEvent) => {
      const target = e.target as Node | null;
      // Tapping the trigger itself: let the trigger handle toggling so the
      // user can re-open immediately. Don't preventDefault here.
      if (target && triggerEl && triggerEl.contains(target)) {
        setOpen(false);
        return;
      }
      // Tap anywhere else (including the tooltip panel itself): close the
      // tooltip and swallow the touch so it doesn't bleed through to the
      // element underneath. This is the mobile-tap-passthrough fix.
      setOpen(false);
      if (target && floatingEl && floatingEl.contains(target)) {
        // Tap on the tooltip panel — definitely swallow it.
        if (e.cancelable) e.preventDefault();
        return;
      }
      // Outside tap — also swallow so the user's dismiss-tap doesn't
      // accidentally activate whatever they tapped (matches popover UX).
      if (e.cancelable) e.preventDefault();
    };

    // capture: true so we run before any other listeners (including React's
    // delegated handlers). Non-passive so preventDefault() actually works.
    window.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
    return () => {
      window.removeEventListener("touchstart", onTouchStart, { capture: true } as EventListenerOptions);
    };
  }, [open, refs.reference, refs.floating]);

  const child = isValidElement(children) ? children : <span>{children}</span>;
  // Preserve the child's own onClick (NodeCell / LoadoutSlot need theirs
  // to fire for select / equip). cloneElement would otherwise replace it
  // with our toggle, which is why on mobile tapping an ability cell only
  // brought up the tooltip and never opened the detail panel.
  const childOnClick = (child.props as { onClick?: (e: React.MouseEvent) => void }).onClick;
  const triggerProps = {
    ref: refs.setReference,
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    onClick: (e: React.MouseEvent) => {
      // Run the child's own click first so equip/select wins the round.
      childOnClick?.(e);
      // Touch devices: the document touchstart listener above closes the
      // tooltip when open; this only needs to OPEN on a fresh tap. The
      // listener calls setOpen(false) BEFORE this onClick fires (capture
      // phase, earlier in the event loop than React's synthetic click),
      // so by the time we get here `open` reflects post-dismiss state.
      // Hover devices: harmless — mouseenter already opened it.
      setOpen((prev) => !prev);
    },
  };
  return (
    <>
      {cloneElement(child, triggerProps as never)}
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{
              ...floatingStyles,
              zIndex: 1000,
              // pointer-events: auto so the tooltip panel can receive the
              // dismiss tap on mobile. The document-level touchstart
              // listener above turns that tap into a dismiss + swallow so
              // it doesn't bleed through to the element beneath.
              pointerEvents: "auto",
              background: "var(--bg-panel)",
              border: "1px solid var(--border-base)",
              borderRadius: "var(--radius-md)",
              padding: "8px 10px",
              minWidth: 180,
              maxWidth: 260,
              boxShadow: "var(--shadow-pop)",
              whiteSpace: "pre-line",
              ...panelStyle,
            }}
          >
            {content}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

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

// ─── Fake progress bar ───────────────────────────────────────────────────────
//
// Shown while we wait on AI / procedurally-generated content (opening scenes,
// NPC dialog, monster spawns, minigame procgen). The server doesn't stream
// progress — we just need the player to feel like things are happening. Bar
// eases toward ~95% over `expectedMs` and stops there; whatever's loading
// unmounts us before we'd hit 100, so the player never sees the bar stall at
// the finish line. Tone matches the gold accent used elsewhere; tucks under
// the existing loading text so callers don't restructure layouts.

export function FakeProgressBar({
  label,
  expectedMs = 2200,
  width = 220,
  accent = "var(--accent-gold)",
}: {
  label?: string;
  expectedMs?: number;
  width?: number | string;
  accent?: string;
}) {
  const [target, setTarget] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setTarget(95));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      role="progressbar"
      aria-label={label ?? "Loading"}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        width,
        maxWidth: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
      }}
    >
      {label && (
        <div style={{ ...muted, fontSize: 12, fontFamily: DISPLAY_FONT, letterSpacing: 0.6 }}>
          {label}
        </div>
      )}
      <div
        style={{
          width: "100%",
          height: 6,
          background: "rgba(255,255,255,0.06)",
          border: "1px solid var(--border-faint, #2a2d33)",
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${target}%`,
            height: "100%",
            background: `linear-gradient(90deg, ${accent}, #fbbf24)`,
            transition: `width ${expectedMs}ms cubic-bezier(0.12, 0.85, 0.22, 1)`,
            boxShadow: `0 0 10px ${accent}55`,
          }}
        />
      </div>
    </div>
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

// ─── Global app top bar ──────────────────────────────────────────────────────
//
// Renders across every authenticated screen: brand mark + Metamorphous
// wordmark + view crumb on the left, character chip on the right. Mobile
// drops the crumb and condenses the chip to icon+number readouts.

export function AppTopBar({
  crumb,
  character,
  rightExtras,
  onClickCharacter,
}: {
  crumb: string;
  character: Character | null;
  rightExtras?: ReactNode;
  onClickCharacter?: () => void;
}) {
  return (
    <header className="gq-topbar">
      <div className="gq-brand">
        <Icon name="tower-flag" size={28} color="var(--accent-gold)" />
        <div>
          <div className="gq-wordmark">
            Gantt Quest<sup>™</sup>
          </div>
          <div className="gq-crumb">{crumb}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {character && (
          <button
            type="button"
            onClick={onClickCharacter}
            title={onClickCharacter ? "Open inventory" : undefined}
            disabled={!onClickCharacter}
            style={{
              all: "unset",
              cursor: onClickCharacter ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "6px 12px",
              borderRadius: "var(--radius-md)",
              border: "1px solid transparent",
              transition: "border-color 0.15s, background 0.15s",
            }}
            onMouseEnter={(e) => {
              if (!onClickCharacter) return;
              e.currentTarget.style.borderColor = "var(--border-base)";
              e.currentTarget.style.background = "var(--bg-card-2)";
            }}
            onMouseLeave={(e) => {
              if (!onClickCharacter) return;
              e.currentTarget.style.borderColor = "transparent";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <span
              data-charname
              style={{
                font: "13px/1 var(--font-body)",
                color: "var(--fg-1)",
                whiteSpace: "nowrap",
              }}
            >
              {character.name}
              {" "}
              <span style={{ color: "var(--accent-arcane-2)" }}>· {character.class}</span>
              {" "}
              <span style={{ color: "var(--accent-gold)", fontWeight: 700 }}>L{character.level}</span>
            </span>
            {/* Unspent stat-point pill — visible across every screen the
                topbar mounts on. Clicking the chip opens the character
                slide-over where the points are spent. Pulses so players
                returning from a level-up notice it. Hidden on mobile data-
                charname doesn't apply because the pill is a sibling. */}
            {(character.unspent_points ?? 0) > 0 && (
              <span
                className="gq-unspent-pill"
                title={`${character.unspent_points} unspent stat point${character.unspent_points === 1 ? "" : "s"} — open character to assign`}
              >
                <Icon name="muscle-up" size={12} color="var(--accent-gold, #fbbf24)" />
                +{character.unspent_points} pt{character.unspent_points === 1 ? "" : "s"}
              </span>
            )}
            <span className="gq-charchip">
              <span className="stat" style={{ color: "var(--tone-good-2)" }}>
                <Icon name="health-normal" size={14} color="var(--tone-good-2)" />
                {character.hp}/{character.max_hp}
              </span>
              <span className="stat" style={{ color: "var(--accent-arcane)" }}>
                ✦ {character.mana}/{character.max_mana}
              </span>
              <span className="stat" style={{ color: "var(--accent-gold)" }}>
                <Icon name="gold-bar" size={14} color="var(--accent-gold)" />
                {character.gold.toLocaleString()}
              </span>
            </span>
          </button>
        )}
        {rightExtras}
      </div>
    </header>
  );
}

// ─── Right-side character slide-over ────────────────────────────────────────
//
// Triggered from the AppTopBar character chip. Houses the full
// `CharacterCard` (passed in as `children`) in a fixed right panel with a
// dim scrim behind it. Closes on × button, click-outside (scrim), or Esc.

export function CharacterSlideOver({
  onClose,
  children,
  title = "Character",
  width = 520,
}: {
  onClose: () => void;
  children: ReactNode;
  title?: string;
  width?: number;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 110,
        background: "rgba(0,0,0,0.45)",
        animation: "gq-slideover-scrim-in 160ms ease-out",
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: `min(${width}px, 96vw)`,
          background: "var(--bg-panel)",
          borderLeft: "1px solid var(--border-base)",
          boxShadow: "var(--shadow-deep)",
          display: "flex",
          flexDirection: "column",
          animation: "gq-slideover-in 220ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border-faint)",
            flexShrink: 0,
          }}
        >
          <span
            className="eyebrow"
            style={{
              font: "11px/1.2 var(--font-body)",
              textTransform: "uppercase",
              letterSpacing: 1,
              color: "var(--fg-mute)",
            }}
          >
            {title}
          </span>
          <button
            type="button"
            className="m-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 18,
          }}
        >
          {children}
        </div>
      </aside>
    </div>
  );
}

// ─── Location modal shell ────────────────────────────────────────────────────
//
// Wraps a town location (Smithy, Shop, Pub, Inn, Apothecary, Outskirts) in
// the modal kit from the design handoff: dimmed backdrop, centered .modal,
// head with icon disc + title + sub + gold chip + × close, body, optional foot.
// Closes on × button, click-outside (scrim), or Esc.
//
// The existing merchant cards still render their full content inside `children`
// — title and hero get suppressed by not passing `navOverlay`.

export function LocationModal({
  icon,
  title,
  subtitle,
  gold,
  art,
  onClose,
  bodyPadding,
  maxWidth = 720,
  foot,
  children,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  gold?: number;
  /** Cached location art (R2 URL in prod, placeholder in local dev).
      Renders as a 16:7 banner between the modal head and body. Pass null
      to skip — modal then falls back to an icon-only chrome. */
  art?: string | null;
  onClose: () => void;
  bodyPadding?: number | string;
  maxWidth?: number;
  foot?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    // Lock body scroll while modal is open so the dimmed town doesn't scroll
    // out from underneath.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="scene" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <div className="m-disc">
            <Icon name={icon} size={32} color="var(--accent-gold)" />
          </div>
          <div className="m-titles">
            <h2>{title}</h2>
            {subtitle && <div className="m-sub">{subtitle}</div>}
          </div>
          {typeof gold === "number" && (
            <span className="m-gold">
              <Icon name="gold-bar" size={14} color="var(--accent-gold)" />
              {gold.toLocaleString()}
            </span>
          )}
          <button
            type="button"
            className="m-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {art !== undefined && (
          <div
            style={{
              position: "relative",
              width: "100%",
              aspectRatio: "16 / 7",
              background: "var(--bg-void)",
              borderBottom: "1px solid var(--border-faint)",
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            {art ? (
              <img
                src={art}
                alt={title}
                loading="lazy"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  display: "block",
                }}
                onError={(e) => {
                  // Hide broken art so the dark void shows through; the
                  // location icon in the head still communicates the place.
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--fg-faintest)",
                }}
              >
                <Icon name={icon} size={56} color="var(--fg-faint)" />
              </div>
            )}
            {/* Bottom gradient so any embedded text reads cleanly on art. */}
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: "45%",
                background: "linear-gradient(to bottom, transparent, rgba(18,20,26,0.85))",
                pointerEvents: "none",
              }}
            />
          </div>
        )}
        <div
          className="modal-body"
          style={{
            // Inline overrides only what the .modal-body class doesn't already
            // set; padding stays in CSS so the @media (max-width: 720px) rule
            // can shrink it on phones.
            ...(bodyPadding ? { padding: bodyPadding } : null),
            overflowY: "auto",
            maxHeight: "calc(100vh - 220px)",
          }}
        >
          {children}
        </div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

export interface LocWideSection {
  id: string;
  label: string;
  icon: string;
  /** Optional background art URL for this specific section. Overrides the modal-level art. */
  art?: string | null;
}

/**
 * Full-viewport location modal with a sidebar nav on desktop and a horizontal
 * tab strip on mobile (≤ 768px). Children is a render prop that receives the
 * currently-active section id.
 */
export function LocationModalWide({
  sections,
  defaultSection,
  section,
  onSectionChange,
  icon,
  title,
  subtitle,
  gold,
  art,
  onClose,
  children,
}: {
  sections: LocWideSection[];
  defaultSection?: string;
  /** Controlled active section id. When provided, the modal is controlled and onSectionChange must update it. */
  section?: string;
  onSectionChange?: (id: string) => void;
  icon: string;
  title: string;
  subtitle?: string;
  gold?: number;
  /** Fallback background art URL shown behind all sections. Individual sections may override via LocWideSection.art. */
  art?: string | null;
  onClose: () => void;
  children: (activeSection: string) => ReactNode;
}) {
  const [internal, setInternal] = useState(defaultSection ?? sections[0]?.id ?? "");
  const active = section ?? internal;
  const setActive = (id: string) => {
    if (onSectionChange) onSectionChange(id);
    else setInternal(id);
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return (
    <div className="scene" onClick={onClose}>
      <div className="loc-wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        {/* ── Header ── */}
        <div className="loc-wide-head">
          <div className="m-disc">
            <Icon name={icon} size={28} color="var(--accent-gold)" />
          </div>
          <div className="m-titles" style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ font: "22px/1 var(--font-display)", color: "var(--fg-1)", margin: 0 }}>{title}</h2>
            {subtitle && <div className="m-sub">{subtitle}</div>}
          </div>
          {typeof gold === "number" && (
            <span className="m-gold">
              <Icon name="gold-bar" size={14} color="var(--accent-gold)" />
              {gold.toLocaleString()}
            </span>
          )}
          <button type="button" className="m-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* ── Body: sidebar + content ── */}
        <div className="loc-wide-body">
          <nav className="loc-wide-sidebar" aria-label="Sections">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`loc-wide-nav-item${active === s.id ? " active" : ""}`}
                onClick={() => setActive(s.id)}
                aria-current={active === s.id ? "page" : undefined}
              >
                <Icon name={s.icon} size={16} color={active === s.id ? "var(--accent-gold)" : "var(--fg-mute)"} />
                <span>{s.label}</span>
              </button>
            ))}
          </nav>
          <div className="loc-wide-content">
            {/* Per-section art overrides modal-level art */}
            {(() => {
              const activeArt = sections.find((s) => s.id === active)?.art ?? art ?? null;
              return activeArt ? (
                <div
                  className="loc-wide-art-bg"
                  style={{ backgroundImage: `url(${activeArt})` }}
                  aria-hidden="true"
                />
              ) : null;
            })()}
            <div className="loc-wide-content-inner">
              {children(active)}
            </div>
          </div>
        </div>
      </div>
    </div>
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
