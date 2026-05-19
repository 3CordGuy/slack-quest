// CSS-keyframe particle bursts for combat events.
//
// Previous version used @tsparticles/react which:
//   (a) gated its children behind an async loadSlim() and rendered null
//       until it resolved — fragile, and the dungeon view never mounted
//       a provider at all so triggerBurst() was silently a no-op there;
//   (b) needed a sized positioned ancestor to render, which was easy to
//       get wrong; visible failures were silent.
//
// New version: zero dependencies, plain DOM + CSS keyframes. Each burst
// spawns N <span> particles radiating from center, animated by a single
// keyframe. Cleaned up after their lifetime via a setTimeout. Works in
// any container as long as that container is `position: relative` (the
// overlay handles its own absolute positioning).
//
// triggerBurst(kind) is exported as before; same call sites still work.

import { useEffect, useRef, useState } from "react";

export type BurstKind = "fire" | "ice" | "lightning" | "frozen" | "victory" | "hit";

// ─── Per-kind visual config ──────────────────────────────────────────────────
//
// `colors` are picked round-robin per particle. `count` controls density.
// `distance` is how far particles fly (px). `duration` is animation length
// (ms). `size` is the particle width/height (px). Each kind feels distinct
// because the easing + distance + duration combine differently.

interface BurstConfig {
  count: number;
  distance: number;
  duration: number;
  size: number;
  colors: string[];
  glow: string;       // box-shadow color for the soft halo
  gravity?: boolean;  // if true, particles arc down (post-anim translateY)
  scatter?: number;   // random angle jitter in degrees (default 0)
}

const BURST: Record<BurstKind, BurstConfig> = {
  fire: {
    count: 22, distance: 110, duration: 900, size: 8,
    colors: ["#ff4500", "#ff8c00", "#ffd700", "#ff6347"],
    glow: "rgba(255,140,0,0.85)",
    gravity: false,
    scatter: 10,
  },
  ice: {
    count: 20, distance: 90, duration: 1100, size: 7,
    colors: ["#93c5fd", "#bfdbfe", "#dbeafe", "#ffffff"],
    glow: "rgba(191,219,254,0.8)",
    gravity: true,
    scatter: 20,
  },
  lightning: {
    count: 28, distance: 140, duration: 500, size: 4,
    colors: ["#fbbf24", "#fef08a", "#ffffff", "#fde047"],
    glow: "rgba(254,240,138,0.95)",
    scatter: 35,
  },
  frozen: {
    count: 18, distance: 70, duration: 1600, size: 6,
    colors: ["#93c5fd", "#bfdbfe", "#e0f2fe", "#f0f9ff"],
    glow: "rgba(191,219,254,0.6)",
    gravity: true,
    scatter: 25,
  },
  victory: {
    count: 38, distance: 180, duration: 1500, size: 9,
    colors: ["#fbbf24", "#34d399", "#60a5fa", "#f472b6", "#a78bfa", "#fb923c"],
    glow: "rgba(251,191,36,0.85)",
    gravity: true,
    scatter: 15,
  },
  hit: {
    count: 16, distance: 80, duration: 500, size: 5,
    colors: ["#ef4444", "#fca5a5", "#f87171", "#ffffff"],
    glow: "rgba(252,165,165,0.85)",
    scatter: 25,
  },
};

// ─── CSS injection (matches the pattern in CombatShared) ─────────────────────

let injected = false;
function injectStylesOnce() {
  if (injected || typeof document === "undefined") return;
  const STYLE_ID = "gq-combat-particles-style";
  if (document.getElementById(STYLE_ID)) {
    injected = true;
    return;
  }
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
@keyframes gq-burst-fly {
  0% {
    transform: rotate(var(--angle)) translateX(0) scale(1);
    opacity: 1;
  }
  60% {
    opacity: 0.85;
  }
  100% {
    transform: rotate(var(--angle)) translateX(var(--distance)) translateY(var(--gravity, 0px)) scale(0.4);
    opacity: 0;
  }
}
.gq-burst {
  position: absolute; inset: 0; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  overflow: visible;
  z-index: 50;
}
.gq-burst-emitter {
  position: relative; width: 0; height: 0;
}
.gq-burst-particle {
  position: absolute;
  left: 0; top: 0;
  border-radius: 50%;
  animation-name: gq-burst-fly;
  animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
  animation-fill-mode: forwards;
  will-change: transform, opacity;
}
`;
  document.head.appendChild(s);
  injected = true;
}

// ─── Imperative trigger API (same signature as before) ───────────────────────

interface BurstEntry { id: string; kind: BurstKind }
type BurstListener = (b: BurstEntry) => void;
const listeners = new Set<BurstListener>();

export function triggerBurst(kind: BurstKind): void {
  const id = `b${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  listeners.forEach((fn) => fn({ id, kind }));
}

// ─── Provider (kept as a no-op shell for back-compat with existing call sites) ─

export function CombatParticlesProvider({ children }: { children: React.ReactNode }) {
  // Previously this gated children behind an async loadSlim. With the CSS
  // implementation there's nothing to load — render children straight
  // through. Kept as a component so existing JSX doesn't have to change.
  return <>{children}</>;
}

// ─── Overlay — mount inside any positioned container ─────────────────────────

export function CombatParticles() {
  const [bursts, setBursts] = useState<BurstEntry[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    injectStylesOnce();
    const handler: BurstListener = (burst) => {
      setBursts((prev) => [...prev, burst]);
      // Lifetime = animation duration + 200ms buffer.
      const cfg = BURST[burst.kind];
      const t = setTimeout(() => {
        setBursts((p) => p.filter((x) => x.id !== burst.id));
        timersRef.current.delete(burst.id);
      }, cfg.duration + 200);
      timersRef.current.set(burst.id, t);
    };
    listeners.add(handler);
    // Snapshot the ref's current value for cleanup — eslint requires this so
    // the closure doesn't read a future map after unmount.
    const timers = timersRef.current;
    return () => {
      listeners.delete(handler);
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  if (bursts.length === 0) return null;

  return (
    <>
      {bursts.map((b) => (
        <BurstOverlay key={b.id} kind={b.kind} />
      ))}
    </>
  );
}

function BurstOverlay({ kind }: { kind: BurstKind }) {
  const cfg = BURST[kind];
  // Pre-compute the random per-particle values once on mount so the burst
  // is deterministic for its lifetime (re-rendering doesn't shuffle).
  const particles = useRef<Array<{ angle: number; color: string; size: number; delay: number }>>([]);
  if (particles.current.length === 0) {
    const evenly = 360 / cfg.count;
    for (let i = 0; i < cfg.count; i++) {
      const jitter = cfg.scatter ? (Math.random() - 0.5) * cfg.scatter : 0;
      particles.current.push({
        angle: i * evenly + jitter,
        color: cfg.colors[i % cfg.colors.length],
        size: cfg.size * (0.7 + Math.random() * 0.6),
        delay: Math.random() * 80,
      });
    }
  }

  return (
    <div className="gq-burst" aria-hidden="true">
      <div className="gq-burst-emitter">
        {particles.current.map((p, i) => (
          <span
            key={i}
            className="gq-burst-particle"
            style={{
              width: p.size,
              height: p.size,
              background: p.color,
              boxShadow: `0 0 ${p.size * 1.6}px ${cfg.glow}`,
              // CSS custom properties drive the keyframe.
              ["--angle" as string]: `${p.angle}deg`,
              ["--distance" as string]: `${cfg.distance}px`,
              ["--gravity" as string]: cfg.gravity ? `${cfg.distance * 0.35}px` : "0px",
              animationDuration: `${cfg.duration}ms`,
              animationDelay: `${p.delay}ms`,
            } as React.CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}
