// MiningMinigame — immediate-action canvas game for the Mine camp node.
//
// A marker oscillates left-right across a pressure gauge with three zones:
//   - dull rock (outer, wide, common loot)
//   - thin seam (middle, uncommon eligible)
//   - rich vein (center, narrow, rare eligible)
// The player gets three strikes (Space / Enter / click). After the last
// strike the client POSTs the captured zones to /api/camp/minigame; the
// server rolls loot + XP and persists. STR widens the rich-vein zone.
//
// Audio is procedural via ../sound.ts — no asset files.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";

import {
  getMuted,
  playDullRock,
  playMinigameComplete,
  playRichVein,
  playThinSeam,
  setMuted,
} from "../sound";

export type MiningZone = "dull" | "thin" | "rich";

interface MinigameResultResource { name: string; qty: number; rarity?: string }
interface MinigameResult {
  xp: number;
  gold: number;
  levelsGained: number;
  newLevel: number;
  resources: MinigameResultResource[];
  richHits: number;
  /** Remaining vigor after this play. Disables Play Again at 0. */
  vigor?: number;
}

function describeServerError(code: string | undefined): string {
  switch (code) {
    case "no_vigor": return "You're out of vigor — your arms need rest. Try again in an hour.";
    case "downed": return "You're downed — rest at the Inn first.";
    case "unauthenticated": return "Your session expired. Please sign in again.";
    case "no_character": return "No character found. Reload the page.";
    case "bad_strikes":
    case "bad_node": return "Strike data was rejected. Refresh and try again.";
    default: return code ? `Couldn't strike: ${code}` : "Something went wrong.";
  }
}

interface MiningMinigameProps {
  /** Player STR score (default 5). Wider rich-vein zone for high STR. */
  str?: number;
  /** Optional AI-generated mine art rendered behind the gauge for atmosphere. */
  backgroundArtUrl?: string | null;
  onClose: () => void;
  /** Called after the server returns spoils so the parent can refresh status. */
  onComplete?: (result: MinigameResult) => void;
}

const TOTAL_STRIKES = 3;
// Base zone half-widths as a fraction of the gauge half-width. Mirrored on
// each side of center: rich is innermost, thin surrounds it, the rest is dull.
// Tight zones — rare strikes need to feel earned. Don't widen these without
// re-tuning the server's per-zone drop rates.
const BASE_RICH_HALF = 0.01;   // ~2% of gauge centered on the midpoint
const BASE_THIN_HALF = 0.07;   // ~14% of gauge as the thin-seam band
// Each STR point above 5 adds 0.2% to the rich-vein half-width, capped at +1.2%.
function richHalfForStr(str: number): number {
  const bonus = Math.min(0.012, Math.max(0, (str - 5) * 0.002));
  return BASE_RICH_HALF + bonus;
}

function classifyHit(markerPos: number, str: number, veinCenter: number): MiningZone {
  // markerPos and veinCenter are both in [0, 1].
  const offset = Math.abs(markerPos - veinCenter);
  if (offset <= richHalfForStr(str)) return "rich";
  if (offset <= BASE_THIN_HALF) return "thin";
  return "dull";
}

// Random vein center in [0.12, 0.88] so the thin band (±0.07) never clips
// the gauge edges. Each strike repositions the vein for the next swing —
// no two strikes use the same timing.
function randomVeinCenter(): number {
  return 0.12 + Math.random() * 0.76;
}

export function MiningMinigame({ str = 5, backgroundArtUrl, onClose, onComplete }: MiningMinigameProps) {
  // Eagerly load the Metamorphous font so canvas text isn't drawn with the
  // serif fallback for the first few frames. document.fonts is a no-op if it
  // was already loaded (e.g. from another component using --font-display).
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!("fonts" in document)) return;
    document.fonts.load("600 24px Metamorphous").catch(() => {});
  }, []);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const markerRef = useRef<number>(0.5);
  const startedAtRef = useRef<number>(performance.now());
  const animRef = useRef<number | null>(null);
  const lastFeedbackRef = useRef<{ zone: MiningZone; t: number } | null>(null);
  const lastStrikeAtRef = useRef<number>(-Infinity);
  // The marker pauses briefly on each strike so the player sees exactly where
  // their swing landed (rather than the gauge continuing past the strike
  // point in the next frame). Held position is the zero-latency snapshot we
  // also use to classify the hit.
  const freezeUntilRef = useRef<number>(0);
  const freezePosRef = useRef<number>(0.5);
  // Persistent marks where each strike landed during this play. Lets the
  // player verify after the fact that the visible needle position matches
  // the awarded zone (no more "the bar said thin but I got rich" confusion).
  const strikePositionsRef = useRef<Array<{ pos: number; zone: MiningZone }>>([]);
  // Live particle pool — pushed on each strike, ticked + drawn every frame,
  // removed when their life expires. Positions are in canvas pixel space.
  type Particle = {
    x: number; y: number;
    vx: number; vy: number;
    color: string;
    size: number;
    bornAt: number;
    life: number; // ms
    gravity: number;
    twinkle: boolean;
  };
  const particlesRef = useRef<Particle[]>([]);
  // Pending burst from a strike — consumed by the draw loop once it has the
  // real canvas pixel position. Avoids stuffing canvas geometry into the
  // strike handler.
  const spawnBurstRef = useRef<{ pos: number; zone: MiningZone; t: number } | null>(null);
  // The rich vein moves to a new random spot after each strike — eliminates
  // muscle memory. veinCenterRef is the current rendered position; we defer
  // updating it until the post-strike freeze ends so the player can see
  // their hit before the next puzzle appears.
  const veinCenterRef = useRef<number>(randomVeinCenter());
  const pendingVeinCenterRef = useRef<number | null>(null);
  const submittedRef = useRef(false);

  const [strikes, setStrikes] = useState<MiningZone[]>([]);
  const [phase, setPhase] = useState<"playing" | "submitting" | "done">("playing");
  const [result, setResult] = useState<MinigameResult | null>(null);
  const [muted, setMutedState] = useState<boolean>(() => getMuted());

  // Reset everything to a fresh play (used by Play Again on the result panel).
  function resetForNewPlay() {
    submittedRef.current = false;
    strikePositionsRef.current = [];
    lastFeedbackRef.current = null;
    lastStrikeAtRef.current = -Infinity;
    freezeUntilRef.current = 0;
    freezePosRef.current = 0.5;
    veinCenterRef.current = randomVeinCenter();
    pendingVeinCenterRef.current = null;
    startedAtRef.current = performance.now();
    setStrikes([]);
    setResult(null);
    setPhase("playing");
  }

  const richHalf = useMemo(() => richHalfForStr(str), [str]);

  // ── Game loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "playing") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cancelled = false;

    function draw(now: number) {
      if (cancelled) return;
      const c = canvasRef.current;
      if (!c) return;
      const ctx2 = c.getContext("2d");
      if (!ctx2) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = c.clientWidth;
      const cssH = c.clientHeight;
      if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
        c.width = cssW * dpr;
        c.height = cssH * dpr;
      }
      ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2.clearRect(0, 0, cssW, cssH);

      // Gauge geometry: full-width bar sitting in the UPPER portion so the
      // pickaxe (head at gauge, handle extending DOWN) has room to swing below
      // it. Chevrons + feedback text live ABOVE the gauge in the headroom.
      const padX = 16;
      const gaugeY = cssH * 0.30;
      const gaugeH = 34;
      const gaugeW = cssW - padX * 2;
      const gaugeX = padX;
      // The vein center is wherever the current puzzle put it — NOT necessarily
      // the geometric middle. cx is the on-canvas pixel coord of the vein.
      const veinCenter = veinCenterRef.current;
      const cx = gaugeX + gaugeW * veinCenter;

      // Zones.
      const dullColor = "#3a2a20";
      const thinColor = "#675233";
      const richColor = "#c6a14a";

      // Dull (full bar).
      ctx2.fillStyle = dullColor;
      ctx2.fillRect(gaugeX, gaugeY, gaugeW, gaugeH);
      // Thin seam (middle band).
      const thinW = gaugeW * (BASE_THIN_HALF * 2);
      ctx2.fillStyle = thinColor;
      ctx2.fillRect(cx - thinW / 2, gaugeY, thinW, gaugeH);
      // Rich vein (center).
      const richW = gaugeW * (richHalf * 2);
      ctx2.fillStyle = richColor;
      ctx2.fillRect(cx - richW / 2, gaugeY, richW, gaugeH);

      // Border + tick marks.
      ctx2.strokeStyle = "rgba(255,255,255,0.18)";
      ctx2.lineWidth = 1;
      ctx2.strokeRect(gaugeX + 0.5, gaugeY + 0.5, gaugeW - 1, gaugeH - 1);

      // Update marker position from oscillator — UNLESS we're in a post-strike
      // freeze, in which case the marker stays pinned where the strike landed
      // so the player can confirm what they hit.
      const elapsed = (now - startedAtRef.current) / 1000;
      const speed = 5.5;
      const t = Math.sin(elapsed * speed);
      const livePos = 0.5 + 0.5 * t * 0.95;
      const frozen = now < freezeUntilRef.current;
      const markerPos = frozen ? freezePosRef.current : livePos;
      // markerRef tracks the LIVE position so doStrike() classifies based on
      // where the needle actually is at click time — not a stale freeze value.
      markerRef.current = livePos;
      // Apply the pending vein move once the freeze ends — keeps the old
      // vein visible while the player sees their hit, then shifts.
      if (!frozen && pendingVeinCenterRef.current != null) {
        veinCenterRef.current = pendingVeinCenterRef.current;
        pendingVeinCenterRef.current = null;
      }
      const markerX = gaugeX + gaugeW * markerPos;

      // (Pickaxe is drawn AFTER the feedback text + chevrons below so it sits
      // on top — see further down.)

      // Convert any pending strike burst into real particles now that we
      // have canvas pixel coordinates for the strike point.
      const burst = spawnBurstRef.current;
      if (burst) {
        const bx = gaugeX + gaugeW * burst.pos;
        const by = gaugeY + gaugeH * 0.5;
        const config =
          burst.zone === "rich" ? { count: 28, color: ["#f5d56b", "#ffe9a8", "#c6a14a"], speed: 280, life: 900, size: 3.4, twinkle: true, gravity: 420 } :
          burst.zone === "thin" ? { count: 18, color: ["#d8b88a", "#a88454", "#705236"], speed: 200, life: 720, size: 2.8, twinkle: false, gravity: 500 } :
                                  { count: 10, color: ["#7e6655", "#544236", "#9c8a78"], speed: 140, life: 560, size: 2.4, twinkle: false, gravity: 560 };
        for (let i = 0; i < config.count; i++) {
          // Spray UPWARD (negative y) since the strike happens at the bottom
          // of the gauge — particles fly up from the rock face.
          const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
          const speed = config.speed * (0.4 + Math.random() * 0.8);
          const c = config.color[Math.floor(Math.random() * config.color.length)];
          particlesRef.current.push({
            x: bx + (Math.random() - 0.5) * 6,
            y: by + (Math.random() - 0.5) * 4,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            color: c,
            size: config.size * (0.6 + Math.random() * 0.8),
            bornAt: now,
            life: config.life * (0.7 + Math.random() * 0.6),
            gravity: config.gravity,
            twinkle: config.twinkle,
          });
        }
        spawnBurstRef.current = null;
      }

      // Tick + draw particles. Each particle integrates simple ballistic
      // motion (gravity pulls them back down) and fades over its life.
      const dt = 1 / 60; // 60fps frame budget — close enough for visuals.
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
        ctx2.globalAlpha = Math.max(0, alpha * flicker);
        ctx2.fillStyle = p.color;
        if (p.twinkle) {
          ctx2.shadowColor = p.color;
          ctx2.shadowBlur = 8;
        }
        ctx2.beginPath();
        ctx2.arc(p.x, p.y, p.size * (1 - t * 0.4), 0, Math.PI * 2);
        ctx2.fill();
        ctx2.shadowBlur = 0;
        live.push(p);
      }
      particlesRef.current = live;
      ctx2.globalAlpha = 1;

      // Persistent strike chevrons — DOWNWARD triangle pointing at the gauge
      // FROM ABOVE at each landed strike. The labels sit above the chevrons.
      // Gauge sits below; pickaxe below that.
      for (const s of strikePositionsRef.current) {
        const sx = gaugeX + gaugeW * s.pos;
        const fill =
          s.zone === "rich" ? "#f5d56b" :
          s.zone === "thin" ? "#c2a070" : "#b08a76";
        ctx2.fillStyle = fill;
        ctx2.strokeStyle = "rgba(0,0,0,0.55)";
        ctx2.lineWidth = 1.5;
        ctx2.beginPath();
        ctx2.moveTo(sx, gaugeY - 2);
        ctx2.lineTo(sx - 9, gaugeY - 16);
        ctx2.lineTo(sx + 9, gaugeY - 16);
        ctx2.closePath();
        ctx2.fill();
        ctx2.stroke();
        ctx2.fillStyle = fill;
        ctx2.font = "600 10px system-ui, sans-serif";
        ctx2.textAlign = "center";
        ctx2.fillText(s.zone.toUpperCase(), sx, gaugeY - 22);
      }

      // Pickaxe-as-needle. The HEAD sits at the marker position on the gauge
      // (this is the strike point), and the handle extends DOWN from the head
      // through the lower half of the canvas. As the marker oscillates, the
      // handle trails the motion (head leads at the gauge, handle follows
      // through below).
      const elapsedNow = (now - startedAtRef.current) / 1000;
      const velocity = frozen ? 0 : Math.cos(elapsedNow * speed); // [-1, 1]
      const swingRad = -velocity * 0.55; // ~31° max in either direction
      const sinceStrike = now - lastStrikeAtRef.current;
      const punch = sinceStrike < 200 ? 1 + 0.22 * (1 - sinceStrike / 200) : 1;
      const handleLen = 90;

      ctx2.save();
      // Anchor at the bottom of the gauge — head straddles this seam, handle
      // hangs down from it.
      ctx2.translate(markerX, gaugeY + gaugeH + 1);
      ctx2.rotate(swingRad);
      ctx2.scale(punch, punch);

      // Glow on the head during the post-strike freeze, color-coded to the
      // awarded zone.
      const headGlow = frozen && lastFeedbackRef.current
        ? (lastFeedbackRef.current.zone === "rich" ? "rgba(245,213,107,0.95)" :
           lastFeedbackRef.current.zone === "thin" ? "rgba(216,184,138,0.85)" :
           "rgba(255,255,255,0.6)")
        : "rgba(255,255,255,0.25)";

      // HEAD — sits at the gauge, partly embedded in the bar. Drawn first so
      // the handle's connection to it covers the seam cleanly.
      const headY = 0; // anchor row = gauge bottom
      ctx2.shadowColor = headGlow;
      ctx2.shadowBlur = frozen ? 22 : 6;
      ctx2.fillStyle = "#aab0b8";
      ctx2.strokeStyle = "#2a2d32";
      ctx2.lineWidth = 1.4;
      // Center block — straddles the gauge bottom edge (top half inside the
      // gauge bar, bottom half hanging just below).
      ctx2.beginPath();
      ctx2.moveTo(-5, headY - 12);
      ctx2.lineTo(5, headY - 12);
      ctx2.lineTo(5, headY + 6);
      ctx2.lineTo(-5, headY + 6);
      ctx2.closePath();
      ctx2.fill();
      ctx2.stroke();
      // Left spike — angled slightly upward into the gauge so it reads as a
      // pick striking up into the rock.
      ctx2.beginPath();
      ctx2.moveTo(-5, headY - 10);
      ctx2.lineTo(-24, headY - 4);
      ctx2.lineTo(-24, headY + 2);
      ctx2.lineTo(-5, headY + 5);
      ctx2.closePath();
      ctx2.fill();
      ctx2.stroke();
      // Right spike.
      ctx2.beginPath();
      ctx2.moveTo(5, headY - 10);
      ctx2.lineTo(24, headY - 4);
      ctx2.lineTo(24, headY + 2);
      ctx2.lineTo(5, headY + 5);
      ctx2.closePath();
      ctx2.fill();
      ctx2.stroke();
      // Highlight along the bottom edge of the head (catches light from below).
      ctx2.strokeStyle = "rgba(255,255,255,0.35)";
      ctx2.lineWidth = 1;
      ctx2.beginPath();
      ctx2.moveTo(-22, headY + 3);
      ctx2.lineTo(22, headY + 3);
      ctx2.stroke();
      ctx2.shadowBlur = 0;

      // Wrap binding just below the head where the haft meets the iron.
      ctx2.fillStyle = "#2a1a0e";
      ctx2.fillRect(-4, headY + 6, 8, 5);

      // Handle — extends DOWNWARD from the head.
      ctx2.fillStyle = "#6b4a2a";
      ctx2.strokeStyle = "#3a2616";
      ctx2.lineWidth = 1;
      ctx2.beginPath();
      ctx2.rect(-3, headY + 10, 6, handleLen);
      ctx2.fill();
      ctx2.stroke();
      // Pommel knob at the far end of the handle.
      ctx2.fillStyle = "#3a2616";
      ctx2.beginPath();
      ctx2.arc(0, headY + handleLen + 12, 4, 0, Math.PI * 2);
      ctx2.fill();
      ctx2.restore();

      // Strike feedback flash — uses the app's display font (Metamorphous) for
      // an in-world, "loot tier announcement" feel. Lifts UPWARD slightly +
      // fades. Sits in the headroom above the gauge.
      const fb = lastFeedbackRef.current;
      if (fb) {
        const age = now - fb.t;
        if (age < 800) {
          const alpha = 1 - age / 800;
          const lift = age * 0.05;
          const sizePx = fb.zone === "rich" ? 32 : fb.zone === "thin" ? 22 : 18;
          ctx2.globalAlpha = alpha;
          ctx2.font = `600 ${sizePx}px "Metamorphous", "Iowan Old Style", serif`;
          ctx2.textAlign = "center";
          ctx2.shadowColor = fb.zone === "rich" ? "rgba(245,213,107,0.9)" : "rgba(0,0,0,0.6)";
          ctx2.shadowBlur = fb.zone === "rich" ? 18 : 6;
          ctx2.fillStyle =
            fb.zone === "rich" ? "#f5d56b" :
            fb.zone === "thin" ? "#d8b88a" : "#b08a76";
          ctx2.fillText(
            fb.zone === "rich" ? "Rich Vein!" :
            fb.zone === "thin" ? "Thin Seam" : "Dull Rock",
            cssW / 2,
            22 - lift,
          );
          ctx2.shadowBlur = 0;
          ctx2.globalAlpha = 1;
        }
      }

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      if (animRef.current != null) cancelAnimationFrame(animRef.current);
      animRef.current = null;
    };
  }, [phase, richHalf]);

  // ── Strike handler ─────────────────────────────────────────────────────
  function doStrike() {
    if (phase !== "playing") return;
    // Already mid-freeze from a prior strike? Don't double-fire — players
    // wouldn't expect a single hammer press to register twice.
    const now = performance.now();
    if (now < freezeUntilRef.current) return;
    const pos = markerRef.current;
    const zone = classifyHit(pos, str, veinCenterRef.current);
    lastFeedbackRef.current = { zone, t: now };
    lastStrikeAtRef.current = now;
    // Pin the needle at the exact strike position so the visible bar matches
    // the awarded zone.
    freezePosRef.current = pos;
    freezeUntilRef.current = now + 280;
    strikePositionsRef.current = [...strikePositionsRef.current, { pos, zone }];
    // Queue a new vein position for the next strike. Applied at end-of-freeze
    // so the player gets to see their hit before the puzzle changes.
    pendingVeinCenterRef.current = randomVeinCenter();
    // Spawn a burst of particles at the strike point. The canvas pixel
    // position is computed inside the draw loop the next frame; we record an
    // intent and the loop turns it into real Particles with the right x/y.
    spawnBurstRef.current = { pos, zone, t: now };
    if (zone === "rich") playRichVein();
    else if (zone === "thin") playThinSeam();
    else playDullRock();

    setStrikes((prev) => {
      const next = [...prev, zone];
      if (next.length >= TOTAL_STRIKES) {
        // Defer submit so React can flush the final visual.
        setTimeout(() => submit(next), 0);
      }
      return next;
    });
  }

  async function submit(zones: MiningZone[]) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setPhase("submitting");
    try {
      const res = await fetch("/api/camp/minigame", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ node: "mine", strikes: zones }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const code = (errBody as { error?: string }).error;
        toast.error(describeServerError(code));
        onComplete?.({ xp: 0, gold: 0, levelsGained: 0, newLevel: 0, resources: [], richHits: 0 });
        onClose();
        return;
      }
      const data = (await res.json()) as { ok: true } & MinigameResult;
      setResult(data);
      setPhase("done");
      playMinigameComplete();
      onComplete?.(data);
    } catch (e) {
      toast.error(`Network error: ${(e as Error).message}`);
      onClose();
    }
  }

  // ── Keyboard handlers ──────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (phase === "playing" && (e.code === "Space" || e.key === "Enter")) {
        e.preventDefault();
        doStrike();
      }
      if (phase === "done") {
        const outOfVigor = result?.vigor != null && result.vigor <= 0;
        if (e.code === "Space" && !outOfVigor) {
          e.preventDefault();
          resetForNewPlay();
        } else if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // doStrike captures fresh refs each render; we want the latest phase too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, onClose, result]);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  // ── Render ─────────────────────────────────────────────────────────────
  // Portal to document.body so we escape the camp `LocationModalWide`
  // stacking context — otherwise our z-index sits below the camp panel.
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
        aria-label="Mining mini-game"
        style={{
          position: "relative",
          width: "min(640px, 100%)",
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
              Quick Strike
            </div>
            <div style={{ fontSize: 20, fontFamily: "var(--font-display)" }}>The Mine</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              onClick={toggleMute}
              title={muted ? "Unmute sounds" : "Mute sounds"}
              style={iconBtn}
            >
              {muted ? "🔇" : "🔊"}
            </button>
            <button type="button" onClick={onClose} title="Close (Esc)" style={iconBtn}>✕</button>
          </div>
        </div>

        {/* Hint */}
        <div style={{ color: "var(--fg-mute)", fontSize: 13 }}>
          Tap the gauge (or press Space) when the needle crosses the rich vein. Three swings, then the haul is rolled.
        </div>

        {/* Canvas — also the primary tap target on mobile */}
        <div
          role="button"
          tabIndex={-1}
          onPointerDown={(e) => {
            // Use pointerdown so taps register without waiting for click's
            // 300ms tolerance window on older mobile browsers. Pointer events
            // unify mouse + touch + pen so we don't need separate handlers.
            if (phase !== "playing") return;
            e.preventDefault();
            doStrike();
          }}
          style={{
            position: "relative",
            cursor: phase === "playing" ? "pointer" : "default",
            borderRadius: 8,
            overflow: "hidden",
            background: "linear-gradient(180deg, #1a1410 0%, #0d0907 100%)",
            border: "1px solid rgba(255,255,255,0.06)",
            // Prevent double-tap zoom + scrolling while striking on mobile.
            touchAction: "manipulation",
            userSelect: "none",
            WebkitUserSelect: "none",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          {/* Atmospheric mine art behind the gauge. Dimmed + slightly
              blurred so the gauge stays readable on any image. */}
          {backgroundArtUrl && (
            <img
              src={backgroundArtUrl}
              alt=""
              aria-hidden="true"
              draggable={false}
              style={{
                position: "absolute", inset: 0,
                width: "100%", height: "100%",
                objectFit: "cover",
                opacity: 0.5,
                filter: "saturate(0.85) brightness(0.7)",
                pointerEvents: "none",
              }}
            />
          )}
          {/* Vignette overlay — keeps zone bands legible against the art. */}
          {backgroundArtUrl && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute", inset: 0,
                background: "radial-gradient(ellipse at center, rgba(8,10,14,0.10) 0%, rgba(8,10,14,0.55) 80%)",
                pointerEvents: "none",
              }}
            />
          )}
          <canvas
            ref={canvasRef}
            style={{ position: "relative", display: "block", width: "100%", height: 220, pointerEvents: "none" }}
          />
        </div>

        {/* Strike tracker */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.4, color: "var(--fg-mute)" }}>
            Strikes
          </span>
          {Array.from({ length: TOTAL_STRIKES }).map((_, i) => {
            const z = strikes[i];
            const color =
              z === "rich" ? "#c6a14a" :
              z === "thin" ? "#675233" :
              z === "dull" ? "#3a2a20" : "transparent";
            return (
              <span
                key={i}
                style={{
                  width: 18, height: 18, borderRadius: 4,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: color,
                  display: "inline-block",
                }}
              />
            );
          })}
          <span style={{ flex: 1 }} />
          {phase === "playing" && (
            <button
              type="button"
              onPointerDown={(e) => { e.preventDefault(); doStrike(); }}
              style={primaryBtn}
            >
              Strike
            </button>
          )}
        </div>

        {/* Submit / result / error */}
        {phase === "submitting" && (
          <div style={{ color: "var(--fg-mute)", textAlign: "center", padding: "10px 0" }}>
            Hauling rock out…
          </div>
        )}
        {phase === "done" && result && (
          <ResultPanel result={result} onRetry={resetForNewPlay} onClose={onClose} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function ResultPanel({ result, onRetry, onClose }: { result: MinigameResult; onRetry: () => void; onClose: () => void }) {
  // Server returns vigor remaining; if it's missing (older response), assume
  // OK to retry — the server will gate it.
  const outOfVigor = result.vigor != null && result.vigor <= 0;
  return (
    <div
      style={{
        marginTop: 4,
        padding: 14,
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 10,
        background: "rgba(20, 24, 34, 0.6)",
        display: "flex", flexDirection: "column", gap: 8,
      }}
    >
      <div style={{ font: "12px/1 var(--font-display)", textTransform: "uppercase", letterSpacing: 1.6, color: "var(--fg-mute)" }}>
        Haul
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
          No ore today — just sweat. Try again.
        </div>
      )}
      {result.richHits > 0 && (
        <div style={{ fontSize: 12, color: "#f5d56b" }}>
          Rich vein strikes: {result.richHits}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onRetry}
          disabled={outOfVigor}
          title={outOfVigor ? "Out of vigor — rest up first." : "Swing again"}
          style={outOfVigor ? disabledBtn : secondaryBtn}
        >
          {outOfVigor ? "Out of vigor" : "Play Again"}
        </button>
        <button type="button" onClick={onClose} style={primaryBtn}>
          Done (Enter)
        </button>
      </div>
    </div>
  );
}

// Tap targets sized for thumbs: ≥40px tall on both buttons.
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

const secondaryBtn: React.CSSProperties = {
  minHeight: 44,
  padding: "10px 18px",
  border: "1px solid #c6a14a",
  borderRadius: 6,
  background: "rgba(198, 161, 74, 0.18)",
  color: "#f5d56b",
  cursor: "pointer",
  fontFamily: "inherit",
  fontWeight: 600,
  fontSize: 14,
  touchAction: "manipulation",
};

const disabledBtn: React.CSSProperties = {
  ...secondaryBtn,
  border: "1px solid var(--border-base)",
  background: "var(--bg-card)",
  color: "var(--fg-mute)",
  cursor: "not-allowed",
};
