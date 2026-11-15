/**
 * "Name Wins!" over the table the moment a game is won, with a burst of confetti, for every pub table game.
 * It is only for the win as it happens: sitting down at a table already over shows nothing.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { prizeText } from "@gantt-quest/world";
import "./winBanner.css";

/** What every pub table's view has to say who won. */
export interface WonTable {
  phase: string;
  winner: string | null;
  pot: number;
  prize: number;
  seats: { id: string; name: string }[];
}

const SHOW_MS = 6000;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
/** The confetti: each piece flies out at its own angle and distance, spinning, in one of the pub's colours. */
const PIECES = Array.from({ length: 28 }, (_, i) => ({
  angle: (i / 28) * 360 + ((i * 37) % 13),
  dist: 120 + ((i * 53) % 110),
  spin: ((i * 71) % 540) - 270,
  delay: (i % 5) * 0.04,
  colour: ["#ffd23f", "#f08a8a", "#7fd6db", "#a9d4fb", "#ffffff"][i % 5],
}));

export function WinBanner({ table, you, xp }: { table: WonTable | null; you: string; xp?: number }) {
  const was = useRef<string | null | undefined>(undefined);
  const [won, setWon] = useState<{ name: string; sub: string; yours: boolean; key: number } | null>(null);
  const phase = table?.phase ?? null;

  useEffect(() => {
    const before = was.current;
    was.current = phase;
    if (phase !== "done") return setWon(null);
    if (before !== "playing" || !table?.winner) return;
    const seat = table.seats.find((s) => s.id === table.winner);
    const yours = table.winner === you;
    setWon({
      name: firstName(seat?.name ?? "Someone"),
      sub: table.pot > 0 ? `${yours ? "You take" : "Takes"} ${prizeText(table.prize)}` : "A free game: bragging rights",
      yours,
      key: Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (!won) return;
    const t = setTimeout(() => setWon(null), SHOW_MS);
    return () => clearTimeout(t);
  }, [won]);

  if (!won) return null;
  return (
    <div className="win-banner" role="status" aria-live="assertive" key={won.key}>
      <button type="button" className={`win-card${won.yours ? " yours" : ""}`} title="Close" onClick={() => setWon(null)}>
        <span className="win-rays" aria-hidden="true" />
        <span className="win-burst" aria-hidden="true">
          {PIECES.map((p, i) => (
            <i key={i} style={{ "--a": `${p.angle}deg`, "--d": `${p.dist}px`, "--s": `${p.spin}deg`, "--t": `${p.delay}s`, background: p.colour } as CSSProperties} />
          ))}
        </span>
        <span className="win-title">{won.name} Wins!</span>
        <span className="win-sub">
          {won.sub}
          {won.yours && xp ? ` · +${xp} XP` : ""}
        </span>
      </button>
    </div>
  );
}
