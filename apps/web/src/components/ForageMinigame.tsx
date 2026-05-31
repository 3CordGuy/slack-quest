// ForageMinigame — immediate-action mini-game for the Forage camp node.
//
// 4x4 grid of "places in the forest" hiding herbs, landmarks, and hazards.
// The server owns the grid (mini-game state in D1's forage_games table);
// each tap calls /api/camp/forage/flip to reveal what's under that place
// and apply any hazard damage. Player can Bank early to lock in the haul.
//
// Adjacency layer is the puzzle: a revealed landmark (rock / tree) or herb
// tints its unrevealed neighbors so the player can deduce where to flip.
//
// Built as DOM cells (proper buttons → free focus + a11y + tap feedback)
// with a transparent canvas overlaid for particle bursts on each reveal.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";

import { Icon } from "../icons";
import {
  getMuted,
  playForageBank,
  playHerbSparkle,
  playLeafRustle,
  playMinigameComplete,
  playMushroomPop,
  setMuted,
} from "../sound";

type CellKind = "empty" | "mossroot" | "sunleaf" | "mushroom";

interface StartResponse {
  rows: number;
  cols: number;
  flips_total: number;
  flips_used: number;
  hp: number;
  max_hp: number;
}

// One cell that the server revealed in response to a manual flip. The first
// entry is always the cell the player tapped; the rest are cells the cascade
// auto-revealed (only from 0-hazard-count cells).
interface RevealedCell {
  r: number;
  c: number;
  cell: CellKind;
  hazard_count: number;
}

interface FlipResponse {
  cell: CellKind;
  hazard_count: number;
  cascade: RevealedCell[];
  hp_damage: number;
  hp: number;
  max_hp: number;
  flips_used: number;
  flips_total: number;
}

// Stored per revealed cell so we can render its hazard-count badge later.
interface KnownCell {
  kind: CellKind;
  hazard_count: number;
}

interface FinishResource { name: string; qty: number; rarity?: string }
interface FinishResponse {
  xp: number;
  gold: number;
  levelsGained: number;
  newLevel: number;
  resources: FinishResource[];
  herbs: number;
  hazards: number;
  hp_taken: number;
  flawless: boolean;
  vigor?: number;
}

function describeServerError(code: string | undefined): string {
  switch (code) {
    case "no_vigor": return "The garden is picked clean — herbs return in an hour."; // legacy path; new code uses stock
    case "downed": return "You're downed — rest at the Inn first.";
    case "no_active_game": return "Your forage game has expired. Open a fresh one.";
    case "no_flips_left": return "No more flips — bank what you've found.";
    case "already_revealed": return "Already searched that place.";
    case "bad_flip": return "Couldn't search that place.";
    default: return code ? `Couldn't forage: ${code}` : "Something went wrong.";
  }
}

const CELL_LABEL: Record<CellKind, string> = {
  empty: "Empty",
  mossroot: "Mossroot",
  sunleaf: "Sunleaf",
  mushroom: "Toxic Mushroom",
};

const CELL_ICON: Record<CellKind, string | null> = {
  empty: null,
  mossroot: "tree-roots",
  sunleaf: "chestnut-leaf",
  mushroom: "super-mushroom",
};

const CELL_COLOR: Record<CellKind, string> = {
  empty: "#3a3530",
  mossroot: "#6b9248",
  sunleaf: "#c7a04a",
  mushroom: "#a55ec2",
};

// Color for the hazard-count number badge. Mirrors classic Minesweeper —
// brighter / hotter as the count climbs.
function hazardCountColor(n: number): string {
  switch (n) {
    case 0: return "rgba(200, 220, 255, 0.35)";
    case 1: return "#7fbf6c";
    case 2: return "#d9c14a";
    case 3: return "#e08f4a";
    default: return "#d24a3c"; // 4+
  }
}

interface ForageMinigameProps {
  /** Player INT score — drives how many flips you get per play (5-7). */
  int_stat?: number;
  /** Optional AI-generated forage art rendered behind the grid. */
  backgroundArtUrl?: string | null;
  onClose: () => void;
  onComplete?: (result: FinishResponse) => void;
}

export function ForageMinigame({ backgroundArtUrl, onClose, onComplete }: ForageMinigameProps) {
  const [phase, setPhase] = useState<"loading" | "playing" | "submitting" | "done">("loading");
  const [grid, setGrid] = useState<StartResponse | null>(null);
  const [revealed, setRevealed] = useState<Map<string, KnownCell>>(new Map());
  // Cells the player has flagged as a suspected hazard. Purely visual, no
  // server round-trip, doesn't count against the flip budget. Right-click on
  // desktop, long-press on touch.
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [hp, setHp] = useState<{ current: number; max: number } | null>(null);
  const [flipsUsed, setFlipsUsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FinishResponse | null>(null);
  const [muted, setMutedState] = useState<boolean>(() => getMuted());
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animRef = useRef<number | null>(null);

  // Open the game on mount: spend vigor + generate grid server-side.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/camp/forage/start", {
          method: "POST",
          credentials: "include",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(describeServerError(body.error));
          if (!cancelled) onClose();
          return;
        }
        const data = (await res.json()) as { ok: true } & StartResponse;
        if (cancelled) return;
        setGrid(data);
        setHp({ current: data.hp, max: data.max_hp });
        setFlipsUsed(data.flips_used);
        setPhase("playing");
      } catch (e) {
        toast.error(`Network error: ${(e as Error).message}`);
        if (!cancelled) onClose();
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Abandon the server-side game if the modal closes mid-play. Vigor stays
  // spent — that's the deterrent to "open then bail" cheese.
  useEffect(() => {
    return () => {
      if (phase === "playing" || phase === "submitting") {
        void fetch("/api/camp/forage/abandon", { method: "POST", credentials: "include" });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Particle overlay ─────────────────────────────────────────────────────
  type Particle = {
    x: number; y: number;
    vx: number; vy: number;
    color: string;
    size: number;
    bornAt: number;
    life: number;
    gravity: number;
    twinkle: boolean;
  };
  const particlesRef = useRef<Particle[]>([]);

  function spawnBurst(centerX: number, centerY: number, kind: CellKind) {
    const palette: Record<CellKind, { count: number; colors: string[]; speed: number; life: number; size: number; twinkle: boolean; gravity: number; spreadRad: number; baseAngle: number }> = {
      empty:    { count: 6,  colors: ["#7a6a5b", "#a89580", "#4a3f33"], speed: 110, life: 480, size: 2.2, twinkle: false, gravity: 480, spreadRad: Math.PI * 0.9, baseAngle: -Math.PI / 2 },
      mossroot: { count: 18, colors: ["#7fb858", "#3e7d2c", "#9cc870"], speed: 200, life: 720, size: 3.0, twinkle: false, gravity: 400, spreadRad: Math.PI * 0.9, baseAngle: -Math.PI / 2 },
      sunleaf:  { count: 26, colors: ["#f5d56b", "#ffe9a8", "#b08a40"], speed: 240, life: 880, size: 3.4, twinkle: true, gravity: 350, spreadRad: Math.PI * 1.0, baseAngle: -Math.PI / 2 },
      mushroom: { count: 22, colors: ["#a55ec2", "#5d2e74", "#d39be3"], speed: 220, life: 800, size: 3.2, twinkle: true, gravity: 380, spreadRad: Math.PI * 1.1, baseAngle: -Math.PI / 2 },
    };
    const cfg = palette[kind];
    const now = performance.now();
    for (let i = 0; i < cfg.count; i++) {
      const angle = cfg.baseAngle + (Math.random() - 0.5) * cfg.spreadRad;
      const speed = cfg.speed * (0.4 + Math.random() * 0.8);
      particlesRef.current.push({
        x: centerX + (Math.random() - 0.5) * 8,
        y: centerY + (Math.random() - 0.5) * 6,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color: cfg.colors[Math.floor(Math.random() * cfg.colors.length)],
        size: cfg.size * (0.6 + Math.random() * 0.8),
        bornAt: now,
        life: cfg.life * (0.7 + Math.random() * 0.6),
        gravity: cfg.gravity,
        twinkle: cfg.twinkle,
      });
    }
    runAnimLoop();
  }

  function runAnimLoop() {
    if (animRef.current != null) return;
    const tick = (now: number) => {
      const canvas = canvasRef.current;
      if (!canvas) { animRef.current = null; return; }
      const container = gridContainerRef.current;
      if (!container) { animRef.current = null; return; }
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) { animRef.current = null; return; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const dt = 1 / 60;
      const live: Particle[] = [];
      for (const p of particlesRef.current) {
        const age = now - p.bornAt;
        if (age >= p.life) continue;
        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const t = age / p.life;
        const alpha = 1 - t;
        const flicker = p.twinkle ? 0.55 + 0.45 * Math.sin(age * 0.04 + p.x) : 1;
        ctx.globalAlpha = Math.max(0, alpha * flicker);
        ctx.fillStyle = p.color;
        if (p.twinkle) {
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 8;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - t * 0.4), 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        live.push(p);
      }
      particlesRef.current = live;
      ctx.globalAlpha = 1;
      if (live.length === 0) {
        animRef.current = null;
        return;
      }
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
  }

  useEffect(() => {
    return () => {
      if (animRef.current != null) cancelAnimationFrame(animRef.current);
      animRef.current = null;
    };
  }, []);

  // ── Reveal handler ───────────────────────────────────────────────────────
  async function flipCell(r: number, c: number, btn: HTMLButtonElement) {
    if (busy || phase !== "playing") return;
    const key = `${r},${c}`;
    if (revealed.has(key)) return;
    if (!grid) return;
    if (flipsUsed >= grid.flips_total) return;
    setBusy(true);
    playLeafRustle();
    try {
      const res = await fetch("/api/camp/forage/flip", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ r, c }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(describeServerError(body.error));
        return;
      }
      const data = (await res.json()) as { ok: true } & FlipResponse;
      // Update revealed map with the cascade — every cell the server flipped
      // in response (the manual tap plus any 0-hazard chain).
      setRevealed((prev) => {
        const next = new Map(prev);
        for (const rc of data.cascade) {
          next.set(`${rc.r},${rc.c}`, { kind: rc.cell, hazard_count: rc.hazard_count });
        }
        return next;
      });
      // Clear any flag the player had placed on the cells we just revealed.
      setFlagged((prev) => {
        if (data.cascade.every((rc) => !prev.has(`${rc.r},${rc.c}`))) return prev;
        const next = new Set(prev);
        for (const rc of data.cascade) next.delete(`${rc.r},${rc.c}`);
        return next;
      });
      setFlipsUsed(data.flips_used);
      setHp({ current: data.hp, max: data.max_hp });
      // Spawn a particle burst at the tap location for the cell the player
      // actually tapped (data.cell). Cascade cells don't burst — they fade in
      // visually via the cell's CSS transition.
      const cellRect = btn.getBoundingClientRect();
      const containerRect = gridContainerRef.current?.getBoundingClientRect();
      if (containerRect) {
        const cx = cellRect.left - containerRect.left + cellRect.width / 2;
        const cy = cellRect.top - containerRect.top + cellRect.height / 2;
        spawnBurst(cx, cy, data.cell);
      }
      if (data.cell === "mossroot" || data.cell === "sunleaf") playHerbSparkle();
      else if (data.cell === "mushroom") playMushroomPop();
      // If that was the last flip, auto-finish.
      if (data.flips_used >= data.flips_total) {
        setTimeout(() => void bank(), 600);
      }
    } catch (e) {
      toast.error(`Network error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function toggleFlag(r: number, c: number) {
    if (phase !== "playing") return;
    const key = `${r},${c}`;
    if (revealed.has(key)) return;
    setFlagged((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function bank() {
    if (phase !== "playing") return;
    setPhase("submitting");
    try {
      const res = await fetch("/api/camp/forage/finish", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(describeServerError(body.error));
        setPhase("playing");
        return;
      }
      const data = (await res.json()) as { ok: true } & FinishResponse;
      setResult(data);
      setPhase("done");
      playMinigameComplete();
      playForageBank();
      onComplete?.(data);
    } catch (e) {
      toast.error(`Network error: ${(e as Error).message}`);
      setPhase("playing");
    }
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  // Keyboard: Esc closes, Enter banks (when playing) or done (when done).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (phase === "playing" && flipsUsed > 0) void bank();
        else if (phase === "done") onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, flipsUsed, onClose]);

  // ── Render ───────────────────────────────────────────────────────────────
  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(8, 10, 14, 0.78)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-label="Foraging mini-game"
        style={{
          position: "relative",
          width: "min(560px, 100%)",
          background: "var(--bg-panel, #12141a)",
          border: "1px solid var(--border-base)",
          borderRadius: "var(--radius-lg, 12px)",
          padding: 20,
          display: "flex", flexDirection: "column", gap: 14,
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div>
            <div style={{ font: "11px/1 var(--font-display)", textTransform: "uppercase", letterSpacing: 1.6, color: "var(--fg-mute)" }}>
              Quick Forage
            </div>
            <div style={{ fontSize: 20, fontFamily: "var(--font-display)" }}>The Herb Garden</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button type="button" onClick={toggleMute} title={muted ? "Unmute sounds" : "Mute sounds"} style={iconBtn}>
              {muted ? "🔇" : "🔊"}
            </button>
            <button type="button" onClick={onClose} title="Close (Esc)" style={iconBtn}>✕</button>
          </div>
        </div>

        {/* Status row */}
        {grid && hp && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", color: "var(--fg-mute)", fontSize: 12 }}>
            <span><strong style={{ color: "var(--fg-1)" }}>{grid.flips_total - flipsUsed}</strong> flips left</span>
            <span aria-hidden="true">·</span>
            <span><strong style={{ color: hp.current < hp.max * 0.4 ? "#e76f51" : "var(--fg-1)" }}>{hp.current}/{hp.max}</strong> HP</span>
            <span aria-hidden="true">·</span>
            <span>🍄 numbers show mushrooms nearby. Long-press (or right-click) to flag a suspected mushroom.</span>
          </div>
        )}

        {/* Grid + particle overlay */}
        {phase === "loading" && (
          <div style={{ padding: "30px 0", textAlign: "center", color: "var(--fg-mute)" }}>
            Walking into the garden…
          </div>
        )}
        {grid && (
          <div
            ref={gridContainerRef}
            style={{
              position: "relative",
              borderRadius: 10,
              overflow: "hidden",
              background: "linear-gradient(180deg, #1a1f15 0%, #0d0f0a 100%)",
              border: "1px solid rgba(255,255,255,0.06)",
              padding: 10,
              touchAction: "manipulation",
              userSelect: "none",
              WebkitUserSelect: "none",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {backgroundArtUrl && (
              <>
                <img
                  src={backgroundArtUrl}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  style={{
                    position: "absolute", inset: 0,
                    width: "100%", height: "100%",
                    objectFit: "cover",
                    opacity: 0.4,
                    filter: "saturate(0.85) brightness(0.6)",
                    pointerEvents: "none",
                  }}
                />
                <div
                  aria-hidden="true"
                  style={{
                    position: "absolute", inset: 0,
                    background: "radial-gradient(ellipse at center, rgba(8,12,8,0.10) 0%, rgba(8,12,8,0.55) 80%)",
                    pointerEvents: "none",
                  }}
                />
              </>
            )}
            <div
              role="grid"
              aria-label="Forage grid"
              style={{
                position: "relative",
                display: "grid",
                gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
                gap: 6,
              }}
            >
              {Array.from({ length: grid.rows }).flatMap((_, r) =>
                Array.from({ length: grid.cols }).map((_, c) => {
                  const key = `${r},${c}`;
                  const known = revealed.get(key);
                  return (
                    <ForageCell
                      key={key}
                      r={r}
                      c={c}
                      known={known ?? null}
                      flagged={flagged.has(key)}
                      disabled={phase !== "playing" || busy || flipsUsed >= grid.flips_total}
                      onFlip={flipCell}
                      onToggleFlag={toggleFlag}
                    />
                  );
                }),
              )}
            </div>
            <canvas
              ref={canvasRef}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
              }}
            />
          </div>
        )}

        {/* Controls */}
        {phase === "playing" && grid && (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => void bank()}
              disabled={flipsUsed === 0}
              title={flipsUsed === 0 ? "Reveal at least one place first." : "Bank your haul (Enter)"}
              style={flipsUsed === 0 ? disabledBtn : primaryBtn}
            >
              {flipsUsed === 0 ? "Bank (need a flip)" : `Bank (Enter)`}
            </button>
          </div>
        )}
        {phase === "submitting" && (
          <div style={{ color: "var(--fg-mute)", textAlign: "center", padding: "10px 0" }}>
            Packing the basket…
          </div>
        )}
        {phase === "done" && result && (
          <ResultPanel result={result} onClose={onClose} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function ForageCell({
  r, c, known, flagged, disabled, onFlip, onToggleFlag,
}: {
  r: number; c: number;
  known: KnownCell | null;
  flagged: boolean;
  disabled: boolean;
  onFlip: (r: number, c: number, btn: HTMLButtonElement) => void;
  onToggleFlag: (r: number, c: number) => void;
}) {
  const revealed = known != null;
  const kind = known?.kind ?? null;
  const hazardCount = known?.hazard_count ?? 0;
  const iconName = kind ? CELL_ICON[kind] : null;
  // Long-press detection for touch — track pointerdown time and fire flag on
  // 350ms+ press. If the player lifts before 350ms, fire the normal flip.
  const pressTimerRef = useRef<number | null>(null);
  const longPressFiredRef = useRef<boolean>(false);
  const cellBg = kind
    ? CELL_COLOR[kind]
    : flagged
      ? "rgba(56, 38, 18, 0.85)"
      : "rgba(36, 42, 30, 0.85)";
  const outline = flagged
    ? "inset 0 0 0 2px rgba(245, 213, 107, 0.55)"
    : "inset 0 0 0 1px rgba(255,255,255,0.06)";
  // For a revealed cell, we always show its hazard count badge (even 0) so the
  // player can audit any cell at a glance. Landmarks/herbs render their icon
  // PLUS a small corner badge; empty cells render the number large in the
  // center (real Minesweeper style).
  const showCenterNumber = revealed && (kind === "empty");
  const showCornerBadge = revealed && kind != null && kind !== "empty";
  const numberColor = hazardCountColor(hazardCount);
  return (
    <button
      type="button"
      aria-label={
        revealed
          ? `${CELL_LABEL[kind!]}${hazardCount > 0 ? ` — ${hazardCount} mushrooms nearby` : ""}`
          : flagged ? "Flagged — suspected mushroom" : "Hidden — long-press or right-click to flag"
      }
      title={
        revealed
          ? `${CELL_LABEL[kind!]}${hazardCount > 0 ? ` (${hazardCount} mushrooms adjacent)` : ""}`
          : flagged ? "Flagged" : undefined
      }
      disabled={disabled || revealed}
      onPointerDown={(e) => {
        if (disabled || revealed) return;
        // Start the long-press timer; if it fires we treat this as a flag
        // and suppress the upcoming flip.
        longPressFiredRef.current = false;
        const target = e.currentTarget;
        pressTimerRef.current = window.setTimeout(() => {
          longPressFiredRef.current = true;
          onToggleFlag(r, c);
        }, 350);
        // Don't preventDefault here yet — we want the click event to fire too
        // unless long-press triggers.
        // Cancel long-press on pointer leave/cancel below.
        target.setPointerCapture?.(e.pointerId);
      }}
      onPointerUp={(e) => {
        if (disabled || revealed) return;
        if (pressTimerRef.current != null) {
          window.clearTimeout(pressTimerRef.current);
          pressTimerRef.current = null;
        }
        if (longPressFiredRef.current) return; // long-press already flagged
        e.preventDefault();
        onFlip(r, c, e.currentTarget);
      }}
      onPointerCancel={() => {
        if (pressTimerRef.current != null) {
          window.clearTimeout(pressTimerRef.current);
          pressTimerRef.current = null;
        }
      }}
      onContextMenu={(e) => {
        if (revealed) return;
        e.preventDefault();
        onToggleFlag(r, c);
      }}
      style={{
        position: "relative",
        aspectRatio: "1 / 1",
        background: cellBg,
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        cursor: disabled || revealed ? "default" : "pointer",
        padding: 0,
        boxShadow: outline,
        touchAction: "manipulation",
        transition: "transform 240ms ease, background 240ms ease, box-shadow 240ms ease",
        transform: revealed ? "scale(0.98)" : "scale(1)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {revealed && iconName && (
        <Icon name={iconName} size={32} color="#fff" />
      )}
      {showCenterNumber && (
        hazardCount === 0 ? (
          // 0-hazard empty cell — keep it visually quiet; the cell is just safe ground.
          <span
            style={{
              fontSize: 22,
              fontFamily: "var(--font-display)",
              color: "rgba(255,255,255,0.18)",
            }}
          >
            ·
          </span>
        ) : (
          // Real Minesweeper-style: a 🍄 emoji paired with the count so the
          // type of hazard is self-evident. Color graduates with the count.
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span aria-hidden="true" style={{ fontSize: 16 }}>🍄</span>
            <span
              style={{
                fontSize: 22,
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                color: numberColor,
                textShadow: "0 0 6px rgba(0,0,0,0.6)",
              }}
            >
              {hazardCount}
            </span>
          </span>
        )
      )}
      {showCornerBadge && hazardCount > 0 && (
        <span
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            padding: "1px 5px 1px 4px",
            borderRadius: 6,
            background: "rgba(0,0,0,0.8)",
            border: `1px solid ${numberColor}`,
            color: numberColor,
            fontSize: 11,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            gap: 2,
            lineHeight: 1,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 10 }}>🍄</span>
          <span>{hazardCount}</span>
        </span>
      )}
      {!revealed && !flagged && (
        <span aria-hidden="true" style={{ fontSize: 22, fontFamily: "var(--font-display)", color: "rgba(255,255,255,0.18)" }}>?</span>
      )}
      {!revealed && flagged && (
        <span
          aria-hidden="true"
          style={{
            fontSize: 22,
            color: "#f5d56b",
            textShadow: "0 0 4px rgba(245,213,107,0.6)",
            lineHeight: 1,
          }}
        >
          ⚑
        </span>
      )}
    </button>
  );
}

function ResultPanel({ result, onClose }: { result: FinishResponse; onClose: () => void }) {
  return (
    <div
      style={{
        marginTop: 4,
        padding: 14,
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 10,
        background: "rgba(20, 24, 18, 0.6)",
        display: "flex", flexDirection: "column", gap: 8,
      }}
    >
      <div style={{ font: "12px/1 var(--font-display)", textTransform: "uppercase", letterSpacing: 1.6, color: "var(--fg-mute)" }}>
        Basket
      </div>
      <div style={{ fontSize: 14 }}>
        +{result.xp} XP{result.gold > 0 ? ` · +${result.gold} gold` : ""}
        {result.levelsGained > 0 ? ` · Level up! (now ${result.newLevel})` : ""}
      </div>
      {result.resources.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {result.resources.map((r, i) => (
            <span
              key={i}
              style={{
                padding: "4px 8px",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 999,
                fontSize: 12,
                background: "rgba(0,0,0,0.25)",
              }}
            >
              {r.name} ×{r.qty}
            </span>
          ))}
        </div>
      ) : (
        <div style={{ color: "var(--fg-mute)", fontSize: 13 }}>
          Empty basket — only thorns and dirt today.
        </div>
      )}
      {result.hazards > 0 && (
        <div style={{ fontSize: 12, color: "#e76f51" }}>
          Hazards triggered: {result.hazards} · {result.hp_taken} HP lost
        </div>
      )}
      {result.flawless && (
        <div style={{ fontSize: 12, color: "#f5d56b" }}>
          ✦ Flawless forage — no hazards triggered!
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
        <button type="button" onClick={onClose} style={primaryBtn}>
          Done (Enter)
        </button>
      </div>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  minWidth: 40,
  minHeight: 40,
  padding: "8px 12px",
  border: "1px solid var(--border-base)",
  borderRadius: 6,
  background: "transparent",
  color: "var(--fg-1)",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 16,
  touchAction: "manipulation",
};

const primaryBtn: React.CSSProperties = {
  minHeight: 44,
  padding: "10px 18px",
  border: "1px solid var(--border-base)",
  borderRadius: 6,
  background: "var(--accent-ink-blue-2, #2c4a8a)",
  color: "#fff",
  cursor: "pointer",
  fontFamily: "inherit",
  fontWeight: 600,
  fontSize: 14,
  touchAction: "manipulation",
};

const disabledBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "var(--bg-card)",
  color: "var(--fg-mute)",
  cursor: "not-allowed",
};
