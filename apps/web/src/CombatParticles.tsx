// Canvas particle bursts for combat events.
//
// Architecture: CombatParticlesProvider wraps the combat view once and
// initialises the tsParticles engine via loadSlim. CombatParticles is the
// overlay that mounts individual burst instances. triggerBurst() is an
// imperative escape hatch called from the WS event loop.

import { useCallback, useEffect, useRef, useState } from "react";
import { Particles, ParticlesProvider, useParticlesProvider } from "@tsparticles/react";
import { loadSlim } from "@tsparticles/slim";
import type { IParticlesProps } from "@tsparticles/react";

type ParticleOptions = IParticlesProps["options"];

// ─── Burst presets ────────────────────────────────────────────────────────────

export type BurstKind = "fire" | "ice" | "lightning" | "frozen" | "victory" | "hit";

function burstOptions(kind: BurstKind): ParticleOptions {
  switch (kind) {
    case "fire":
      return {
        fullScreen: { enable: false },
        fpsLimit: 60,
        particles: {
          color: { value: ["#ff4500", "#ff8c00", "#ffd700", "#ff6347"] },
          shape: { type: "circle" },
          size: { value: { min: 4, max: 12 } },
          move: { enable: true, speed: { min: 3, max: 8 }, direction: "top", outModes: { default: "destroy" }, gravity: { enable: true, acceleration: -2 } },
          life: { duration: { value: 0.9 }, count: 1 },
          number: { value: 0 },
          opacity: { value: { min: 0.4, max: 1 }, animation: { enable: true, speed: 2, destroy: "min" } },
          rotate: { value: { min: 0, max: 360 }, animation: { enable: true, speed: 20 } },
        },
        emitters: { position: { x: 50, y: 60 }, rate: { quantity: 45, delay: 0 }, life: { count: 1, duration: 0.15 } },
      };

    case "ice":
      return {
        fullScreen: { enable: false },
        fpsLimit: 60,
        particles: {
          color: { value: ["#93c5fd", "#bfdbfe", "#dbeafe", "#ffffff"] },
          shape: { type: ["circle", "square"] },
          size: { value: { min: 3, max: 9 } },
          move: { enable: true, speed: { min: 2, max: 6 }, direction: "none", random: true, outModes: { default: "destroy" }, gravity: { enable: true, acceleration: 1.5 } },
          rotate: { value: { min: 0, max: 360 }, animation: { enable: true, speed: 15 } },
          life: { duration: { value: 1.1 }, count: 1 },
          number: { value: 0 },
          opacity: { value: { min: 0.3, max: 1 }, animation: { enable: true, speed: 1.5, destroy: "min" } },
        },
        emitters: { position: { x: 50, y: 50 }, rate: { quantity: 35, delay: 0 }, life: { count: 1, duration: 0.15 } },
      };

    case "lightning":
      return {
        fullScreen: { enable: false },
        fpsLimit: 60,
        particles: {
          color: { value: ["#fbbf24", "#fef08a", "#ffffff", "#fde047"] },
          shape: { type: "circle" },
          size: { value: { min: 2, max: 6 } },
          move: { enable: true, speed: { min: 5, max: 14 }, direction: "none", random: true, outModes: { default: "destroy" } },
          life: { duration: { value: 0.5 }, count: 1 },
          number: { value: 0 },
          opacity: { value: { min: 0.5, max: 1 }, animation: { enable: true, speed: 5, destroy: "min" } },
        },
        emitters: { position: { x: 50, y: 50 }, rate: { quantity: 55, delay: 0 }, life: { count: 1, duration: 0.05 } },
      };

    case "frozen":
      return {
        fullScreen: { enable: false },
        fpsLimit: 60,
        particles: {
          color: { value: ["#93c5fd", "#bfdbfe", "#e0f2fe", "#f0f9ff"] },
          shape: { type: ["circle", "square"] },
          size: { value: { min: 2, max: 7 } },
          move: { enable: true, speed: { min: 0.5, max: 2 }, direction: "top", random: true, outModes: { default: "destroy" } },
          life: { duration: { value: 1.8 }, count: 1 },
          number: { value: 0 },
          opacity: { value: { min: 0.2, max: 0.8 }, animation: { enable: true, speed: 0.8, destroy: "min" } },
        },
        emitters: { position: { x: 50, y: 50 }, rate: { quantity: 28, delay: 0 }, life: { count: 1, duration: 0.3 } },
      };

    case "victory":
      return {
        fullScreen: { enable: false },
        fpsLimit: 60,
        particles: {
          color: { value: ["#fbbf24", "#34d399", "#60a5fa", "#f472b6", "#a78bfa", "#fb923c"] },
          shape: { type: ["circle", "square"] },
          size: { value: { min: 4, max: 10 } },
          move: { enable: true, speed: { min: 3, max: 9 }, direction: "top", outModes: { default: "destroy" }, gravity: { enable: true, acceleration: 2 } },
          rotate: { value: { min: 0, max: 360 }, animation: { enable: true, speed: 30 } },
          life: { duration: { value: 1.5 }, count: 1 },
          number: { value: 0 },
          opacity: { value: { min: 0.4, max: 1 }, animation: { enable: true, speed: 1.5, destroy: "min" } },
        },
        emitters: [
          { position: { x: 25, y: 85 }, rate: { quantity: 30, delay: 0 }, life: { count: 1, duration: 0.2 } },
          { position: { x: 75, y: 85 }, rate: { quantity: 30, delay: 0 }, life: { count: 1, duration: 0.2 } },
          { position: { x: 50, y: 92 }, rate: { quantity: 25, delay: 0.15 }, life: { count: 1, duration: 0.2 } },
        ],
      };

    case "hit":
    default:
      return {
        fullScreen: { enable: false },
        fpsLimit: 60,
        particles: {
          color: { value: ["#ef4444", "#fca5a5", "#f87171", "#ffffff"] },
          shape: { type: "circle" },
          size: { value: { min: 2, max: 5 } },
          move: { enable: true, speed: { min: 3, max: 7 }, direction: "none", random: true, outModes: { default: "destroy" } },
          life: { duration: { value: 0.5 }, count: 1 },
          number: { value: 0 },
          opacity: { value: { min: 0.3, max: 1 }, animation: { enable: true, speed: 4, destroy: "min" } },
        },
        emitters: { position: { x: 50, y: 50 }, rate: { quantity: 22, delay: 0 }, life: { count: 1, duration: 0.1 } },
      };
  }
}

// ─── Imperative trigger API ───────────────────────────────────────────────────

type BurstEntry = { id: string; kind: BurstKind };
type BurstListener = (burst: BurstEntry) => void;
const listeners = new Set<BurstListener>();

export function triggerBurst(kind: BurstKind): void {
  const id = `burst-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  listeners.forEach((fn) => fn({ id, kind }));
}

// ─── Provider (mounts once around the combat view) ───────────────────────────

export function CombatParticlesProvider({ children }: { children: React.ReactNode }) {
  return (
    <ParticlesProvider init={loadSlim}>
      {children}
    </ParticlesProvider>
  );
}

// ─── Overlay (mounted inside the room view) ───────────────────────────────────

export function CombatParticles() {
  const { loaded } = useParticlesProvider();
  const [bursts, setBursts] = useState<BurstEntry[]>([]);
  const timerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeBurst = useCallback((id: string) => {
    setBursts((prev) => prev.filter((b) => b.id !== id));
    timerRefs.current.delete(id);
  }, []);

  useEffect(() => {
    const handler: BurstListener = (burst) => {
      setBursts((prev) => [...prev, burst]);
      const t = setTimeout(() => removeBurst(burst.id), 3000);
      timerRefs.current.set(burst.id, t);
    };
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
      timerRefs.current.forEach(clearTimeout);
    };
  }, [removeBurst]);

  if (!loaded || bursts.length === 0) return null;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 50 }}>
      {bursts.map((burst) => (
        <Particles
          key={burst.id}
          id={burst.id}
          options={burstOptions(burst.kind)}
          style={{ position: "absolute", inset: 0 }}
        />
      ))}
    </div>
  );
}
