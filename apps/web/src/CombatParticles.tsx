// Particle bursts for combat events, driven by the Web Animations API.
//
// History: this file went through two prior implementations —
//   v1: @tsparticles/react. Silent loadSlim() gate + canvas-size gotchas.
//   v2: CSS keyframes with `transform: rotate(var(--angle)) translateX(...)`.
//       Looked fine in spec but `var()` interpolation inside transform
//       keyframes is buggy in Safari/Chromium combos and the bursts
//       rendered as static dots at origin in some setups.
//   v3 (this file): element.animate() — explicit, JS-defined keyframes.
//       Each particle gets its own animation with already-computed
//       transform end values, so there's no CSS variable interpolation
//       in the critical path. Works the same way in every modern engine.
//
// triggerBurst(kind) is the imperative escape hatch called from the WS
// event loop in CombatPage. CombatParticles is the overlay that listens
// and renders.

import { useEffect, useRef, useState } from "react";

export type BurstKind = "fire" | "ice" | "lightning" | "frozen" | "victory" | "hit" | "poison" | "bleed" | "shield" | "heal" | "curse" | "deploy" | "music" | "smoke" | "nature" | "dispel" | "slowtime";

// ─── Per-kind visual config ──────────────────────────────────────────────────

interface BurstConfig {
  count: number;       // particle count
  distance: number;    // px from emitter to final position
  duration: number;    // animation length (ms)
  size: number;        // particle base diameter (px)
  colors: string[];    // round-robin per particle
  glow: string;        // box-shadow color
  gravity?: number;    // additional Y px applied at end (positive = falls down)
  scatter?: number;    // random angle jitter (deg)
}

const BURST: Record<BurstKind, BurstConfig> = {
  fire: {
    count: 26, distance: 130, duration: 950, size: 10,
    colors: ["#ff4500", "#ff8c00", "#ffd700", "#ff6347", "#ffffff"],
    glow: "rgba(255,140,0,0.95)",
    gravity: -30,
    scatter: 14,
  },
  ice: {
    count: 22, distance: 100, duration: 1100, size: 8,
    colors: ["#bfdbfe", "#dbeafe", "#ffffff", "#93c5fd"],
    glow: "rgba(191,219,254,0.85)",
    gravity: 45,
    scatter: 22,
  },
  lightning: {
    count: 32, distance: 170, duration: 550, size: 5,
    colors: ["#fbbf24", "#fef08a", "#ffffff", "#fde047"],
    glow: "rgba(254,240,138,1)",
    scatter: 38,
  },
  frozen: {
    count: 20, distance: 80, duration: 1700, size: 7,
    colors: ["#bfdbfe", "#e0f2fe", "#f0f9ff", "#ffffff"],
    glow: "rgba(191,219,254,0.7)",
    gravity: 35,
    scatter: 28,
  },
  victory: {
    count: 44, distance: 210, duration: 1500, size: 11,
    colors: ["#fbbf24", "#34d399", "#60a5fa", "#f472b6", "#a78bfa", "#fb923c"],
    glow: "rgba(251,191,36,0.95)",
    gravity: 90,
    scatter: 18,
  },
  hit: {
    count: 20, distance: 95, duration: 550, size: 7,
    colors: ["#ef4444", "#fca5a5", "#f87171", "#ffffff"],
    glow: "rgba(252,165,165,1)",
    scatter: 28,
  },
  poison: {
    count: 18, distance: 85, duration: 1200, size: 9,
    colors: ["#84cc16", "#a3e635", "#65a30d", "#d9f99d"],
    glow: "rgba(132,204,22,0.85)",
    gravity: 50,
    scatter: 20,
  },
  bleed: {
    count: 14, distance: 70, duration: 900, size: 8,
    colors: ["#ef4444", "#dc2626", "#b91c1c", "#fca5a5"],
    glow: "rgba(220,38,38,0.9)",
    gravity: 80,
    scatter: 12,
  },
  shield: {
    count: 18, distance: 90, duration: 1300, size: 7,
    colors: ["#60a5fa", "#93c5fd", "#bfdbfe", "#e0f2fe", "#ffffff"],
    glow: "rgba(96,165,250,0.8)",
    gravity: -10,
    scatter: 10,
  },
  heal: {
    count: 20, distance: 80, duration: 1100, size: 8,
    colors: ["#86efac", "#4ade80", "#fde68a", "#fcd34d", "#ffffff"],
    glow: "rgba(74,222,128,0.85)",
    gravity: -35,
    scatter: 16,
  },
  curse: {
    count: 22, distance: 110, duration: 1400, size: 7,
    colors: ["#a855f7", "#7c3aed", "#6d28d9", "#ddd6fe", "#1e1b4b"],
    glow: "rgba(168,85,247,0.9)",
    gravity: 20,
    scatter: 45,
  },
  deploy: {
    count: 24, distance: 120, duration: 850, size: 9,
    colors: ["#f59e0b", "#fbbf24", "#fde68a", "#f97316", "#ffffff"],
    glow: "rgba(245,158,11,0.95)",
    gravity: -60,
    scatter: 18,
  },
  // Pink/violet swirl with a musical-note levity — gentle rise like notes on a staff.
  music: {
    count: 22, distance: 130, duration: 1300, size: 8,
    colors: ["#f472b6", "#ec4899", "#c084fc", "#a78bfa", "#fbcfe8", "#ffffff"],
    glow: "rgba(236,72,153,0.85)",
    gravity: -55,
    scatter: 26,
  },
  // Gray/charcoal swirl that lingers and drifts upward like a smoke cloud.
  smoke: {
    count: 24, distance: 95, duration: 1500, size: 11,
    colors: ["#4b5563", "#6b7280", "#9ca3af", "#374151", "#1f2937", "#d1d5db"],
    glow: "rgba(107,114,128,0.6)",
    gravity: -45,
    scatter: 40,
  },
  // Green leafy burst — falls gently like leaves dropping from a canopy.
  nature: {
    count: 24, distance: 110, duration: 1300, size: 9,
    colors: ["#22c55e", "#16a34a", "#65a30d", "#84cc16", "#bbf7d0", "#4ade80"],
    glow: "rgba(34,197,94,0.85)",
    gravity: 55,
    scatter: 28,
  },
  // Bright white shimmer for stripping enchantments — fast, airy, dispersive.
  dispel: {
    count: 28, distance: 140, duration: 850, size: 7,
    colors: ["#ffffff", "#f5f5f4", "#e0e7ff", "#fef9c3", "#fde68a"],
    glow: "rgba(255,255,255,0.95)",
    scatter: 36,
  },
  // Blue clockface glow that lingers slowly, evoking time crawling to a halt.
  slowtime: {
    count: 20, distance: 100, duration: 1700, size: 9,
    colors: ["#60a5fa", "#3b82f6", "#1e3a8a", "#93c5fd", "#bfdbfe", "#ffffff"],
    glow: "rgba(96,165,250,0.85)",
    gravity: 10,
    scatter: 20,
  },
};

// ─── Imperative trigger API ──────────────────────────────────────────────────

interface BurstEntry { id: string; kind: BurstKind }
type BurstListener = (b: BurstEntry) => void;
const listeners = new Set<BurstListener>();

export function triggerBurst(kind: BurstKind): void {
  const id = `b${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  listeners.forEach((fn) => fn({ id, kind }));
}

// ─── Provider (no-op shell — old @tsparticles version had async init) ────────

export function CombatParticlesProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

export function CombatParticles() {
  const [bursts, setBursts] = useState<BurstEntry[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const handler: BurstListener = (burst) => {
      setBursts((prev) => [...prev, burst]);
      const cfg = BURST[burst.kind];
      const t = setTimeout(() => {
        setBursts((p) => p.filter((x) => x.id !== burst.id));
        timersRef.current.delete(burst.id);
      }, cfg.duration + 250);
      timersRef.current.set(burst.id, t);
    };
    listeners.add(handler);
    const timers = timersRef.current;
    return () => {
      listeners.delete(handler);
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  if (bursts.length === 0) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "visible",
        // Center each burst in this container via the inner emitter.
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {bursts.map((b) => (
        <BurstOverlay key={b.id} kind={b.kind} />
      ))}
    </div>
  );
}

function BurstOverlay({ kind }: { kind: BurstKind }) {
  const cfg = BURST[kind];
  const containerRef = useRef<HTMLDivElement>(null);
  // Pre-roll the per-particle randomness once so re-renders don't shuffle.
  const partsRef = useRef<Array<{ x: number; y: number; color: string; size: number; delay: number }>>([]);
  if (partsRef.current.length === 0) {
    const step = 360 / cfg.count;
    for (let i = 0; i < cfg.count; i++) {
      const jitter = cfg.scatter ? (Math.random() - 0.5) * cfg.scatter : 0;
      const angleDeg = i * step + jitter;
      const angleRad = (angleDeg * Math.PI) / 180;
      partsRef.current.push({
        x: Math.cos(angleRad) * cfg.distance,
        y: Math.sin(angleRad) * cfg.distance + (cfg.gravity ?? 0),
        color: cfg.colors[i % cfg.colors.length],
        size: cfg.size * (0.7 + Math.random() * 0.6),
        delay: Math.random() * 90,
      });
    }
  }

  // Kick off Web Animations API animations after mount. Each particle
  // gets its own .animate() call with absolute pixel keyframes — no CSS
  // variable interpolation, so we sidestep the gotcha that killed v2.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>("[data-gq-burst-particle]"));
    if (els.length === 0) return;

    const animations = els.map((el, idx) => {
      const p = partsRef.current[idx];
      if (!p) return null;
      return el.animate(
        [
          {
            transform: "translate(-50%, -50%) translate(0px, 0px) scale(1)",
            opacity: 1,
          },
          {
            // Mid-flight: still fully visible, almost full distance.
            transform: `translate(-50%, -50%) translate(${p.x * 0.85}px, ${p.y * 0.85}px) scale(0.85)`,
            opacity: 0.85,
            offset: 0.65,
          },
          {
            transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px) scale(0.35)`,
            opacity: 0,
          },
        ],
        {
          duration: cfg.duration,
          delay: p.delay,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "forwards",
        },
      );
    });

    return () => {
      // Cancel any still-running animations on unmount so they don't
      // try to write back to detached elements.
      for (const a of animations) {
        try { a?.cancel(); } catch { /* noop */ }
      }
    };
  }, [cfg.duration]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: 0,
        height: 0,
        // The emitter itself is 0×0 — particles position themselves
        // relative to its top-left, which after centering is the
        // overlay's center point.
      }}
    >
      {partsRef.current.map((p, i) => (
        <span
          key={i}
          data-gq-burst-particle
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: p.size,
            height: p.size,
            borderRadius: "50%",
            background: p.color,
            boxShadow: `0 0 ${p.size * 2}px ${cfg.glow}, 0 0 ${p.size * 4}px ${cfg.glow}`,
            // Initial transform — animation overrides immediately.
            transform: "translate(-50%, -50%)",
            willChange: "transform, opacity",
          }}
        />
      ))}
    </div>
  );
}
