// Themed combat backdrops — replace the live monster portrait that used
// to bleed through the room view with a stable "place" image. Each scene
// is hand-built from layered CSS gradients + an inline SVG silhouette so
// the room reads as a location (catacomb / cubicle farm / data center)
// without depending on remote AI art. Scene picked deterministically by
// hashing the quest id so the same fight always opens in the same room.

import type { CSSProperties, ReactNode } from "react";

export type SceneKey =
  | "server_catacomb"
  | "cubicle_forest"
  | "warehouse_floor"
  | "fluorescent_office"
  | "neon_basement"
  | "deadline_dungeon";

const SCENES: SceneKey[] = [
  "server_catacomb",
  "cubicle_forest",
  "warehouse_floor",
  "fluorescent_office",
  "neon_basement",
  "deadline_dungeon",
];

export function pickScene(questId: number | null | undefined): SceneKey {
  if (questId == null || !Number.isFinite(questId)) return "server_catacomb";
  const idx = Math.abs(Math.floor(questId)) % SCENES.length;
  return SCENES[idx];
}

// Maps the local SceneKey to the `combat_*` ViewArtKey registered in
// apps/web/src/ai.ts → VIEW_ART_PROMPTS. The web client fetches the
// flux-generated image at `/api/art/view/<viewArtKey>`; on miss the
// CombatBackdropLayer SVG fallback renders instead. Keep these in lockstep.
export function viewArtKeyForScene(scene: SceneKey): string {
  return `combat_${scene}`;
}

const wrap: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
};

// Reusable layered gradient — wash + floor vignette + atmosphere haze.
function base(top: string, mid: string, bottom: string): CSSProperties {
  return {
    ...wrap,
    background: `
      radial-gradient(ellipse 90% 70% at 50% 110%, ${bottom} 0%, transparent 60%),
      radial-gradient(ellipse 120% 60% at 50% 0%, ${top} 0%, transparent 50%),
      linear-gradient(to bottom, ${mid} 0%, #0a0b10 100%)
    `,
  };
}

function Cubicles({ color = "#1e3a5f" }: { color?: string }) {
  // Stylized grid of cubicle walls — receding parallax via SVG.
  return (
    <svg
      viewBox="0 0 1200 700"
      preserveAspectRatio="xMidYMax slice"
      style={{ ...wrap, opacity: 0.35 }}
    >
      <defs>
        <linearGradient id="cube-fade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0" />
          <stop offset="1" stopColor={color} stopOpacity="0.9" />
        </linearGradient>
      </defs>
      {Array.from({ length: 5 }).map((_, row) => {
        const y = 350 + row * 70;
        const inset = row * 60;
        return (
          <g key={row}>
            <line x1={inset} y1={y} x2={1200 - inset} y2={y} stroke={color} strokeWidth="1.5" opacity={0.4 + row * 0.1} />
            {Array.from({ length: 6 }).map((__, c) => {
              const x = inset + (c * (1200 - inset * 2)) / 6;
              return (
                <rect
                  key={c}
                  x={x}
                  y={y - 56}
                  width={(1200 - inset * 2) / 6 - 12}
                  height={56}
                  fill="url(#cube-fade)"
                  opacity={0.5 + row * 0.08}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function ServerRacks() {
  return (
    <svg
      viewBox="0 0 1200 700"
      preserveAspectRatio="xMidYMax slice"
      style={{ ...wrap, opacity: 0.55 }}
    >
      <defs>
        <linearGradient id="rack-fade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#0a1622" stopOpacity="0.6" />
          <stop offset="1" stopColor="#03070d" stopOpacity="1" />
        </linearGradient>
      </defs>
      <g>
        {Array.from({ length: 8 }).map((_, i) => {
          const x = 60 + i * 145;
          const h = 280 + (i % 2) * 30;
          const y = 700 - h;
          return (
            <g key={i}>
              <rect x={x} y={y} width={110} height={h} fill="url(#rack-fade)" stroke="#1a2d44" strokeWidth="1" />
              {Array.from({ length: 10 }).map((__, r) => {
                const ry = y + 10 + r * (h / 12);
                const glow = (i + r) % 3 === 0 ? "#22d3ee" : (i + r) % 5 === 0 ? "#fb923c" : "#1a2d44";
                return <rect key={r} x={x + 8} y={ry} width={94} height={6} fill={glow} opacity={0.85} />;
              })}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function Arches() {
  return (
    <svg
      viewBox="0 0 1200 700"
      preserveAspectRatio="xMidYMax slice"
      style={{ ...wrap, opacity: 0.5 }}
    >
      <defs>
        <linearGradient id="arch-stone" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#3a3530" stopOpacity="0.9" />
          <stop offset="1" stopColor="#0a0908" stopOpacity="1" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3].map((i) => {
        const cx = 150 + i * 280;
        const w = 200;
        const h = 380;
        return (
          <g key={i}>
            <path
              d={`M ${cx - w / 2} 700 V ${700 - h} A ${w / 2} ${w / 2} 0 0 1 ${cx + w / 2} ${700 - h} V 700 Z`}
              fill="url(#arch-stone)"
              stroke="#1a1612"
              strokeWidth="1"
            />
          </g>
        );
      })}
    </svg>
  );
}

function Trees({ tint = "#0e2218" }: { tint?: string }) {
  return (
    <svg
      viewBox="0 0 1200 700"
      preserveAspectRatio="xMidYMax slice"
      style={{ ...wrap, opacity: 0.55 }}
    >
      {Array.from({ length: 14 }).map((_, i) => {
        const x = 30 + i * 90 + (i % 2 ? 24 : 0);
        const h = 360 + (i % 3) * 50;
        return (
          <g key={i}>
            <rect x={x - 4} y={700 - h * 0.4} width={8} height={h * 0.4} fill="#1a1206" opacity={0.85} />
            <polygon
              points={`${x - 60},${700 - h * 0.4} ${x},${700 - h} ${x + 60},${700 - h * 0.4}`}
              fill={tint}
              opacity={0.9}
            />
            <polygon
              points={`${x - 50},${700 - h * 0.55} ${x},${700 - h * 1.1} ${x + 50},${700 - h * 0.55}`}
              fill={tint}
              opacity={0.7}
            />
          </g>
        );
      })}
    </svg>
  );
}

function Pallets() {
  return (
    <svg
      viewBox="0 0 1200 700"
      preserveAspectRatio="xMidYMax slice"
      style={{ ...wrap, opacity: 0.45 }}
    >
      {Array.from({ length: 3 }).map((_, row) => {
        const y = 460 + row * 70;
        return (
          <g key={row}>
            {Array.from({ length: 6 }).map((__, c) => {
              const x = 60 + c * 190;
              const w = 130;
              const h = 55;
              return (
                <g key={c}>
                  <rect x={x} y={y} width={w} height={h} fill="#3a2f1f" stroke="#1a140a" strokeWidth="1" />
                  <rect x={x + 6} y={y + 6} width={w - 12} height={h - 12} fill="#5a4a2f" opacity={0.55} />
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function Monitors() {
  return (
    <svg
      viewBox="0 0 1200 700"
      preserveAspectRatio="xMidYMax slice"
      style={{ ...wrap, opacity: 0.4 }}
    >
      {Array.from({ length: 10 }).map((_, i) => {
        const x = 50 + i * 120;
        const y = 380 + (i % 2 ? 24 : 0);
        const w = 96;
        const h = 56;
        const tint = i % 3 === 0 ? "#22d3ee" : i % 4 === 0 ? "#fbbf24" : "#60a5fa";
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} fill="#0a0d14" stroke="#1a1d24" strokeWidth="1.5" />
            <rect x={x + 4} y={y + 4} width={w - 8} height={h - 8} fill={tint} opacity={0.35} />
          </g>
        );
      })}
    </svg>
  );
}

export function CombatBackdrop({ scene }: { scene: SceneKey }) {
  switch (scene) {
    case "server_catacomb":
      return (
        <>
          <div style={base("rgba(34,211,238,0.18)", "#0c1320", "rgba(34,211,238,0.18)")} />
          <Arches />
          <div
            style={{
              ...wrap,
              background: `
                radial-gradient(circle at 50% 90%, rgba(34,211,238,0.22) 0%, transparent 55%)
              `,
            }}
          />
        </>
      );
    case "cubicle_forest":
      return (
        <>
          <div style={base("rgba(34,197,94,0.10)", "#0c1812", "rgba(167,139,250,0.10)")} />
          <Trees tint="#0e2218" />
          <Cubicles color="#1a2d3a" />
        </>
      );
    case "warehouse_floor":
      return (
        <>
          <div style={base("rgba(251,191,36,0.10)", "#181410", "rgba(245,158,11,0.10)")} />
          <Pallets />
          <ServerRacks />
        </>
      );
    case "fluorescent_office":
      return (
        <>
          <div style={base("rgba(96,165,250,0.18)", "#0e1320", "rgba(96,165,250,0.10)")} />
          <Cubicles color="#1e3a5f" />
          <Monitors />
        </>
      );
    case "neon_basement":
      return (
        <>
          <div style={base("rgba(168,85,247,0.18)", "#10081a", "rgba(236,72,153,0.18)")} />
          <ServerRacks />
        </>
      );
    case "deadline_dungeon":
      return (
        <>
          <div style={base("rgba(239,68,68,0.18)", "#1a0d0a", "rgba(251,146,60,0.15)")} />
          <Arches />
          <Monitors />
        </>
      );
    default:
      return <div style={base("rgba(96,165,250,0.10)", "#0e1320", "rgba(96,165,250,0.05)")} />;
  }
}

// Helper to embed the backdrop in CombatPage. The atmospheric vignette is
// rendered by CombatPage itself (so it can sit above the AI-generated room
// photo when one loads) — this layer paints only the deterministic CSS/SVG
// scenery so it always paints, even before the flux art arrives.
export function CombatBackdropLayer({ scene, children }: { scene: SceneKey; children?: ReactNode }) {
  return (
    <>
      <CombatBackdrop scene={scene} />
      {children}
    </>
  );
}
