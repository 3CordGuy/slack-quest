// FishingMinigame — immediate-action mini-game for the Fish camp node.
//
// Two phases, full canvas:
//   1. WAIT  — bobber bobs on procedural water ripples. After a random
//              delay (server-picked at /cast), a bite cue fires (big
//              ripple + bobber tug + sound). Player taps within the
//              bite_window_ms to set the hook.
//   2. REEL  — vertical tension bar. Fish pulls the indicator DOWN; the
//              player holds (mouse/touch down) to reel it UP. Indicator
//              must stay in the SAFE zone to fill the catch meter.
//              SLACK (top) and SNAP (bottom) leak the catch meter back.
//
// Server picks bite_at and bite_window at /cast. Client uses its own
// time origin to render. /strike sends the player's strike timestamp;
// server validates against its own clock. /reel sends the safe-zone
// fraction of total reel time; server scores quality + grants loot.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";

import {
  getMuted,
  playBiteAlert,
  playBobberCast,
  playFishCaught,
  playFishEscaped,
  playMinigameComplete,
  playReelClick,
  setMuted,
} from "../sound";

interface CastResponse {
  bite_at_ms: number;
  bite_window_ms: number;
  reel_target_ms: number;
  pull_rate: number;
  vigor?: number;
  vigor_full_at?: number | null;
}

interface StrikeResponse {
  result: "hooked" | "too_early" | "too_late";
  reaction_ms?: number;
  reel_target_ms?: number;
}

interface FinishResource { name: string; qty: number; rarity?: string }
interface ReelResponse {
  fish: "river_carp" | "silverfin" | null;
  quality: number;
  reaction_ms: number;
  xp: number;
  gold: number;
  levelsGained: number;
  newLevel: number;
  resources: FinishResource[];
  vigor?: number;
}

function describeServerError(code: string | undefined): string {
  switch (code) {
    case "no_vigor": return "You're out of fishing vigor — rest up and try again in an hour.";
    case "downed": return "You're downed — rest at the Inn first.";
    case "no_active_game": return "Your fishing line drifted away. Cast again.";
    case "bad_phase": return "Out-of-order — refresh and try again.";
    case "bad_strike":
    case "bad_reel": return "Bad input — refresh and try again.";
    default: return code ? `Couldn't fish: ${code}` : "Something went wrong.";
  }
}

interface FishingMinigameProps {
  /** DEX score — widens the bite window. */
  dex_stat?: number;
  /** STR score — softens the fish's reel-phase pull rate. */
  str_stat?: number;
  /** Optional AI-generated pond art rendered behind the canvas. */
  backgroundArtUrl?: string | null;
  onClose: () => void;
  onComplete?: (result: ReelResponse) => void;
}

type Phase = "loading" | "waiting" | "reeling" | "result" | "failed";

export function FishingMinigame({ backgroundArtUrl, onClose, onComplete }: FishingMinigameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animRef = useRef<number | null>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [castData, setCastData] = useState<CastResponse | null>(null);
  const [result, setResult] = useState<ReelResponse | null>(null);
  const [failure, setFailure] = useState<"too_early" | "too_late" | "snapped" | "drifted" | null>(null);
  const [muted, setMutedState] = useState<boolean>(() => getMuted());

  // Phase 1 (waiting) — bite timing.
  const castOriginRef = useRef<number>(0);                // performance.now() at /cast success
  const biteFiredRef = useRef<boolean>(false);            // whether the bite cue has triggered locally
  const biteFireAtRef = useRef<number>(0);                // perf.now when the cue should fire
  const biteCloseAtRef = useRef<number>(0);               // window close
  const tooLateFiredRef = useRef<boolean>(false);
  const strikeSubmittedRef = useRef<boolean>(false);

  // Phase 2 (reeling) — tension bar physics.
  // Indicator y in [0, 1] (0 = top SLACK, 1 = bottom SNAP).
  // Safe zone is the inner ~36% (0.32..0.68).
  const indicatorRef = useRef<number>(0.5);
  const reelPressedRef = useRef<boolean>(false);
  const reelStartedAtRef = useRef<number>(0);
  const safeTimeMsRef = useRef<number>(0);
  const lastTickMsRef = useRef<number>(0);
  const lastReelClickAtRef = useRef<number>(0);
  const finishSubmittedRef = useRef<boolean>(false);

  // Ripples — pre-allocated pool ticked every frame.
  type Ripple = { x: number; y: number; bornAt: number; life: number; maxRadius: number; color: string };
  const ripplesRef = useRef<Ripple[]>([]);

  // ── /cast on mount ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/camp/fish/cast", { method: "POST", credentials: "include" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(describeServerError(body.error));
          if (!cancelled) onClose();
          return;
        }
        const data = (await res.json()) as { ok: true } & CastResponse;
        if (cancelled) return;
        setCastData(data);
        castOriginRef.current = performance.now();
        biteFireAtRef.current = castOriginRef.current + data.bite_at_ms;
        biteCloseAtRef.current = biteFireAtRef.current + data.bite_window_ms;
        setPhase("waiting");
        playBobberCast();
      } catch (e) {
        toast.error(`Network error: ${(e as Error).message}`);
        if (!cancelled) onClose();
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Abandon server-side game if user closes mid-play.
  useEffect(() => {
    return () => {
      if (phase === "waiting" || phase === "reeling") {
        void fetch("/api/camp/fish/abandon", { method: "POST", credentials: "include" });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "waiting" && phase !== "reeling") return;

    function spawnIdleRipple(now: number, cx: number, cy: number) {
      ripplesRef.current.push({
        x: cx + (Math.random() - 0.5) * 40,
        y: cy + (Math.random() - 0.5) * 8,
        bornAt: now,
        life: 1400,
        maxRadius: 60 + Math.random() * 30,
        color: "rgba(180,220,255,0.45)",
      });
    }

    function spawnBiteRipple(now: number, cx: number, cy: number) {
      for (let i = 0; i < 3; i++) {
        ripplesRef.current.push({
          x: cx,
          y: cy,
          bornAt: now + i * 80,
          life: 900,
          maxRadius: 130,
          color: "rgba(255,235,170,0.7)",
        });
      }
    }

    let lastIdleSpawnAt = 0;
    const tick = (now: number) => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) { animRef.current = null; return; }
      const ctx = canvas.getContext("2d");
      if (!ctx) { animRef.current = null; return; }
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }
      const w = rect.width;
      const h = rect.height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Background water tone gradient (drawn behind the SVG bg art via
      // opacity — actual art is below the canvas in the DOM stack).
      const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
      bgGrad.addColorStop(0, "rgba(34, 56, 80, 0.55)");
      bgGrad.addColorStop(1, "rgba(8, 18, 32, 0.85)");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // Water surface horizon line.
      const waterY = h * 0.62;
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(0, waterY - 1, w, 2);

      // ── Phase 1: WAITING ────────────────────────────────────────────────
      if (phase === "waiting" && castData) {
        const bobberX = w / 2;
        const bobberY = waterY - 4 + Math.sin(now * 0.005) * 3;
        // Idle ripples every ~600ms.
        if (now - lastIdleSpawnAt > 600) {
          spawnIdleRipple(now, bobberX, bobberY + 6);
          lastIdleSpawnAt = now;
        }
        // Bite cue fires once.
        if (!biteFiredRef.current && now >= biteFireAtRef.current) {
          biteFiredRef.current = true;
          spawnBiteRipple(now, bobberX, bobberY + 6);
          playBiteAlert();
        }
        // Window closes → too_late.
        if (biteFiredRef.current && !tooLateFiredRef.current && now >= biteCloseAtRef.current) {
          tooLateFiredRef.current = true;
          void submitStrike();
        }

        // Draw ripples first so the bobber sits on top.
        drawRipples(ctx, now);

        // Hint / cue label.
        const timeToBite = biteFireAtRef.current - now;
        const inWindow = biteFiredRef.current && now < biteCloseAtRef.current;
        ctx.font = `600 ${inWindow ? 28 : 14}px "Metamorphous", "Iowan Old Style", serif`;
        ctx.textAlign = "center";
        if (inWindow) {
          const flash = 0.55 + 0.45 * Math.sin(now * 0.04);
          ctx.shadowColor = "rgba(255,220,120,0.9)";
          ctx.shadowBlur = 18;
          ctx.fillStyle = `rgba(255, 230, 140, ${flash})`;
          ctx.fillText("Strike!", w / 2, h * 0.25);
          ctx.shadowBlur = 0;
        } else if (timeToBite > 0) {
          ctx.fillStyle = "rgba(200,210,225,0.55)";
          ctx.fillText("Wait for the tug…", w / 2, h * 0.25);
        }

        // Bobber: red top, white bottom, hanging slightly below the water.
        const bobR = 9;
        ctx.beginPath();
        ctx.arc(bobberX, bobberY - 3, bobR, Math.PI, 0);
        ctx.fillStyle = "#d24a3c";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(bobberX, bobberY - 3, bobR, 0, Math.PI);
        ctx.fillStyle = "#f4ecd9";
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(bobberX, bobberY - 3, bobR, 0, Math.PI * 2);
        ctx.stroke();
        // Antenna.
        ctx.strokeStyle = "rgba(40,40,40,0.7)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bobberX, bobberY - 12);
        ctx.lineTo(bobberX, bobberY - 22);
        ctx.stroke();
        // Fishing line coming off the top edge of the canvas down to the bobber.
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(w * 0.85, 6);
        ctx.bezierCurveTo(w * 0.78, h * 0.3, w * 0.55, h * 0.4, bobberX, bobberY - 22);
        ctx.stroke();
      }

      // ── Phase 2: REELING ────────────────────────────────────────────────
      if (phase === "reeling" && castData) {
        // Init reel timing on first frame of the phase.
        if (reelStartedAtRef.current === 0) {
          reelStartedAtRef.current = now;
          lastTickMsRef.current = now;
        }
        const dt = (now - lastTickMsRef.current) / 1000;
        lastTickMsRef.current = now;

        // Fish pulls the indicator DOWN at pull_rate; reeling pushes UP.
        const reelStrength = 0.9;
        const delta = (reelPressedRef.current ? -reelStrength : 0) + castData.pull_rate;
        indicatorRef.current = Math.max(0, Math.min(1, indicatorRef.current + delta * dt));

        // Tally safe-zone time.
        const safeLo = 0.32;
        const safeHi = 0.68;
        const inSafe = indicatorRef.current >= safeLo && indicatorRef.current <= safeHi;
        if (inSafe) safeTimeMsRef.current += dt * 1000;

        // Rhythmic reel-click sound while pressing.
        if (reelPressedRef.current && now - lastReelClickAtRef.current > 110) {
          lastReelClickAtRef.current = now;
          playReelClick();
        }

        // Fish escaped? End at full reel target time.
        const reelElapsed = now - reelStartedAtRef.current;
        const reelOver = reelElapsed >= castData.reel_target_ms;
        if (reelOver && !finishSubmittedRef.current) {
          finishSubmittedRef.current = true;
          const safeFraction = Math.max(0, Math.min(1, safeTimeMsRef.current / castData.reel_target_ms));
          void submitReel(safeFraction);
        }

        // Draw the tension bar in the right side of the canvas.
        const barX = w * 0.72;
        const barW = 22;
        const barY = h * 0.18;
        const barH = h * 0.66;
        // Zones.
        ctx.fillStyle = "rgba(200,100,100,0.35)";
        ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = "rgba(110,170,90,0.55)";
        ctx.fillRect(barX, barY + barH * safeLo, barW, barH * (safeHi - safeLo));
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
        // Indicator.
        const indicatorY = barY + barH * indicatorRef.current;
        ctx.shadowColor = inSafe ? "rgba(120,220,120,0.9)" : "rgba(255,200,160,0.8)";
        ctx.shadowBlur = 14;
        ctx.fillStyle = "#f5f5f5";
        ctx.beginPath();
        ctx.arc(barX + barW / 2, indicatorY, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(barX + barW / 2, indicatorY, 11, 0, Math.PI * 2);
        ctx.stroke();

        // Catch meter on the left side.
        const meterX = w * 0.12;
        const meterY = barY;
        const meterW = 18;
        const meterH = barH;
        const fillFrac = Math.min(1, safeTimeMsRef.current / castData.reel_target_ms);
        ctx.fillStyle = "rgba(30,40,30,0.7)";
        ctx.fillRect(meterX, meterY, meterW, meterH);
        ctx.fillStyle = "rgba(140, 200, 100, 0.85)";
        ctx.fillRect(meterX, meterY + meterH * (1 - fillFrac), meterW, meterH * fillFrac);
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.strokeRect(meterX + 0.5, meterY + 0.5, meterW - 1, meterH - 1);
        // Labels.
        ctx.fillStyle = "rgba(220,230,255,0.65)";
        ctx.font = "600 10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("CATCH", meterX + meterW / 2, meterY - 8);
        ctx.fillText("TENSION", barX + barW / 2, barY - 8);
        // Instructions.
        ctx.font = `600 14px "Metamorphous", "Iowan Old Style", serif`;
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(220,230,255,0.85)";
        ctx.fillText("Hold to reel — keep the line in the green", w / 2 - 30, h * 0.45);
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillStyle = "rgba(200,210,225,0.55)";
        ctx.fillText(`${Math.ceil((castData.reel_target_ms - reelElapsed) / 1000)}s left`, w / 2 - 30, h * 0.52);
      }

      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);

    return () => {
      if (animRef.current != null) cancelAnimationFrame(animRef.current);
      animRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, castData]);

  function drawRipples(ctx: CanvasRenderingContext2D, now: number) {
    const live: typeof ripplesRef.current = [];
    for (const r of ripplesRef.current) {
      const age = now - r.bornAt;
      if (age < 0) { live.push(r); continue; } // not started yet
      if (age >= r.life) continue;
      const t = age / r.life;
      const radius = r.maxRadius * t;
      const alpha = 0.7 * (1 - t);
      ctx.strokeStyle = r.color.replace(/[\d.]+\)$/, `${alpha.toFixed(3)})`);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, radius, radius * 0.4, 0, 0, Math.PI * 2);
      ctx.stroke();
      live.push(r);
    }
    ripplesRef.current = live;
  }

  // ── /strike submitter ───────────────────────────────────────────────────
  async function submitStrike() {
    if (strikeSubmittedRef.current) return;
    strikeSubmittedRef.current = true;
    try {
      const strikeAt = Date.now();
      const res = await fetch("/api/camp/fish/strike", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strike_at: strikeAt }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(describeServerError(body.error));
        onClose();
        return;
      }
      const data = (await res.json()) as { ok: true } & StrikeResponse;
      if (data.result === "hooked") {
        setPhase("reeling");
      } else {
        setFailure(data.result === "too_early" ? "too_early" : "drifted");
        setPhase("failed");
        playFishEscaped();
      }
    } catch (e) {
      toast.error(`Network error: ${(e as Error).message}`);
      onClose();
    }
  }

  // ── /reel submitter ─────────────────────────────────────────────────────
  async function submitReel(safeFraction: number) {
    try {
      const res = await fetch("/api/camp/fish/reel", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ safe_fraction: safeFraction }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(describeServerError(body.error));
        onClose();
        return;
      }
      const data = (await res.json()) as { ok: true } & ReelResponse;
      setResult(data);
      setPhase("result");
      if (data.fish) {
        playFishCaught();
        playMinigameComplete();
      } else {
        playFishEscaped();
      }
      onComplete?.(data);
    } catch (e) {
      toast.error(`Network error: ${(e as Error).message}`);
      onClose();
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────
  function onPointerDown(e: React.PointerEvent) {
    if (phase === "waiting") {
      e.preventDefault();
      void submitStrike();
    } else if (phase === "reeling") {
      e.preventDefault();
      reelPressedRef.current = true;
    }
  }
  function onPointerUp() {
    reelPressedRef.current = false;
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (phase === "waiting" && (e.code === "Space" || e.key === "Enter")) {
        e.preventDefault();
        void submitStrike();
      } else if (phase === "reeling" && (e.code === "Space" || e.key === "Enter")) {
        if (!e.repeat) {
          e.preventDefault();
          reelPressedRef.current = true;
        }
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (phase === "reeling" && (e.code === "Space" || e.key === "Enter")) {
        reelPressedRef.current = false;
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [phase, onClose]);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  // ── Render ──────────────────────────────────────────────────────────────
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
        aria-label="Fishing mini-game"
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
              Quick Cast
            </div>
            <div style={{ fontSize: 20, fontFamily: "var(--font-display)" }}>Fishing Hole</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button type="button" onClick={toggleMute} title={muted ? "Unmute sounds" : "Mute sounds"} style={iconBtn}>
              {muted ? "🔇" : "🔊"}
            </button>
            <button type="button" onClick={onClose} title="Close (Esc)" style={iconBtn}>✕</button>
          </div>
        </div>

        {/* Status row */}
        {(phase === "waiting" || phase === "reeling") && (
          <div style={{ color: "var(--fg-mute)", fontSize: 13 }}>
            {phase === "waiting"
              ? "Wait for the tug, then tap (or press Space) to strike."
              : "Hold (tap & hold or Space) to reel. Keep the dot in the green zone."}
          </div>
        )}

        {/* Canvas area */}
        <div
          ref={containerRef}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            position: "relative",
            borderRadius: 10,
            overflow: "hidden",
            border: "1px solid rgba(255,255,255,0.06)",
            background: "linear-gradient(180deg, #0e1a26 0%, #060c14 100%)",
            touchAction: "none",
            userSelect: "none",
            WebkitUserSelect: "none",
            WebkitTapHighlightColor: "transparent",
            cursor: (phase === "waiting" || phase === "reeling") ? "pointer" : "default",
            minHeight: 240,
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
                  opacity: 0.45,
                  filter: "saturate(0.85) brightness(0.65)",
                  pointerEvents: "none",
                }}
              />
              <div
                aria-hidden="true"
                style={{
                  position: "absolute", inset: 0,
                  background: "radial-gradient(ellipse at center, rgba(6,12,20,0.10) 0%, rgba(6,12,20,0.55) 80%)",
                  pointerEvents: "none",
                }}
              />
            </>
          )}
          <canvas
            ref={canvasRef}
            style={{ position: "relative", display: "block", width: "100%", height: 280, pointerEvents: "none" }}
          />
          {phase === "loading" && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-mute)" }}>
              Casting the line…
            </div>
          )}
        </div>

        {phase === "failed" && failure && (
          <div style={{
            padding: 14,
            border: "1px solid rgba(231,111,81,0.45)",
            borderRadius: 10,
            background: "rgba(231,111,81,0.07)",
            color: "var(--fg-1)",
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            <div style={{ font: "12px/1 var(--font-display)", textTransform: "uppercase", letterSpacing: 1.6, color: "#e76f51" }}>
              Got Away
            </div>
            <div style={{ fontSize: 14 }}>
              {failure === "too_early"
                ? "You jumped too early — the bobber didn't even dip."
                : "Too slow — the fish spit the hook before you set it."}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" onClick={onClose} style={primaryBtn}>Done</button>
            </div>
          </div>
        )}

        {phase === "result" && result && (
          <ResultPanel result={result} onClose={onClose} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function ResultPanel({ result, onClose }: { result: ReelResponse; onClose: () => void }) {
  const caught = result.fish != null;
  return (
    <div
      style={{
        marginTop: 4,
        padding: 14,
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 10,
        background: "rgba(18, 24, 32, 0.65)",
        display: "flex", flexDirection: "column", gap: 8,
      }}
    >
      <div style={{ font: "12px/1 var(--font-display)", textTransform: "uppercase", letterSpacing: 1.6, color: "var(--fg-mute)" }}>
        Catch
      </div>
      <div style={{ fontSize: 14 }}>
        +{result.xp} XP{result.gold > 0 ? ` · +${result.gold} gold` : ""}
        {result.levelsGained > 0 ? ` · Level up! (now ${result.newLevel})` : ""}
      </div>
      {caught && result.resources.length > 0 ? (
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
          The line went slack — the fish slipped the hook.
        </div>
      )}
      <div style={{ fontSize: 12, color: "var(--fg-mute)" }}>
        Reaction: {result.reaction_ms} ms · Quality: {Math.round(result.quality * 100)}%
      </div>
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
