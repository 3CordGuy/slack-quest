// The emote wheel: wave, cheer, bow, dab, floss, dance, the running man or a breakdance where your hero stands (see
// EMOTES), for everyone in the same place to see. A button beside the chat (or
// in a map's bar, or off the side of the hotbar in a fight) opens it round the
// button; or hold G anywhere, point at a
// slice and let go. Escape, or a click off it, closes it with nothing done.
// Typing /wave (and the rest) into chat does the same (ChatInput.tsx).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EMOTES, type Emote } from "@gantt-quest/world";
import { PixelIcon } from "./PixelIcon";
import "./emoteWheel.css";

/** Each emote's name, and its pixel icon (see PixelIcon: a row to a string, "#" a filled cell). */
export const EMOTE_INFO: Record<Emote, { name: string; icon: string[] }> = {
  wave: {
    name: "Wave",
    // An open hand, thumb out, with the swish of it waving.
    icon: [
      "......#.#.....",
      "....#.#.#.#...",
      "....#.#.#.#...",
      ".#..#.#.#.#...",
      "#...#######.#.",
      "#...#######.#.",
      "#...########..",
      ".#..#######...",
      ".....######...",
      ".....#####....",
      "......###.....",
      "......###.....",
    ],
  },
  cheer: {
    name: "Cheer",
    // Someone with both arms flung up.
    icon: [
      "#.........#",
      "#.........#",
      ".#..###..#.",
      ".#..###..#.",
      "..#.###.#..",
      "...#####...",
      "....###....",
      "....###....",
      "....###....",
      "....#.#....",
      "....#.#....",
      "...##.##...",
    ],
  },
  bow: {
    name: "Bow",
    // Someone seen side on, bent at the waist with the head down.
    icon: [
      "............",
      "......#####.",
      "....#######.",
      ".###.#####..",
      ".###.#..###.",
      ".###.#..###.",
      "........###.",
      "........###.",
      "........#.#.",
      "........#.#.",
      "........#.#.",
      ".......##.##",
    ],
  },
  dab: {
    name: "Dab",
    // One arm flung up and out, the head ducked into the other's raised elbow.
    icon: [
      "...........#",
      "..........#.",
      "..#......#..",
      ".#.#....#...",
      "#...###.#...",
      ".#..####....",
      "..#######...",
      "....###.....",
      "....###.....",
      "....#.#.....",
      "....#.#.....",
      "...##.##....",
    ],
  },
  floss: {
    name: "Floss",
    // Hips swung one way, both straight arms swung down the other.
    icon: [
      "....###....",
      "....###....",
      "....###....",
      "...#####...",
      "..#.###....",
      ".#..###....",
      "#...####...",
      "#....###...",
      ".....#..#..",
      ".....#...#.",
      ".....#...#.",
      "....##..##.",
    ],
  },
  dance: {
    name: "Dance",
    // Someone kicking up a leg, one arm thrown up and the other out.
    icon: [
      ".........#..",
      "....###..#..",
      "....###.#...",
      "....###.#...",
      ".##.#####...",
      "...######...",
      ".....###....",
      ".....###....",
      ".....#.##...",
      ".....#..##..",
      "....##...##.",
      "...........#",
    ],
  },
  runningman: {
    name: "Running man",
    // Someone mid-step, one knee up and the elbows bent.
    icon: [
      ".....###...",
      ".....###...",
      ".....###...",
      "..#..###.#.",
      "..#######..",
      ".....###...",
      ".....######",
      ".....#...#.",
      ".....#...#.",
      "....#......",
      "...#.......",
      "..##.......",
    ],
  },
  breakdance: {
    name: "Breakdance",
    // Someone spinning on their back, knees tucked up to the chest.
    icon: [
      "...........",
      "...........",
      "...........",
      "......###..",
      "....#####..",
      "...######..",
      "...###.....",
      ".#####.....",
      "######.....",
      ".####......",
      "...........",
      "###########",
    ],
  },
};
/** The wheel's own button: a smiling face. */
const FACE = [
  "..######..",
  ".#......#.",
  "#..#..#..#",
  "#..#..#..#",
  "#........#",
  "#.#....#.#",
  "#..####..#",
  ".#......#.",
  "..######..",
];
/** How far out from the middle the slices sit, and how far the pointer must go before one is picked. */
const RING = 100;
const DEAD = 18;
/** The key held to open the wheel where the pointer is. */
const HOLD = "g";

const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]");
/** The slice at angle `a` (0 up, turning clockwise): the slices go round from the top in EMOTES order. */
const sliceAt = (dx: number, dy: number): number => {
  const a = Math.atan2(dx, -dy);
  const step = (Math.PI * 2) / EMOTES.length;
  return ((Math.round(a / step) % EMOTES.length) + EMOTES.length) % EMOTES.length;
};

/** `tab`: the button sits in a hotbar tab, which has its own tooltip, so it gives none. */
export function EmoteWheel({ onEmote, blocked, tab = false }: { onEmote(emote: Emote): void; blocked?: string; tab?: boolean }) {
  /** Where the wheel is open (its middle, on the screen), and whether it was opened by holding the key. */
  const [open, setOpen] = useState<{ x: number; y: number; held: boolean } | null>(null);
  const [hot, setHot] = useState<number | null>(null);
  const pointer = useRef({ x: innerWidth / 2, y: innerHeight / 2 });
  const button = useRef<HTMLButtonElement>(null);
  const emote = useRef(onEmote);
  emote.current = onEmote;
  const state = useRef({ open, hot, blocked });
  state.current = { open, hot, blocked };

  const close = () => {
    setOpen(null);
    setHot(null);
  };
  const pick = (i: number) => {
    emote.current(EMOTES[i]);
    close();
  };
  /** Opened round `x, y`, kept clear of the window's edges (the ring is 304px across). */
  const openAt = (x: number, y: number, held: boolean) => {
    const pad = 158;
    setOpen({ x: Math.min(innerWidth - pad, Math.max(pad, x)), y: Math.min(innerHeight - pad, Math.max(pad, y)), held });
    setHot(null);
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      const at = state.current.open;
      // A finger has no pointer hovering: on a touch screen a slice is only ever tapped.
      if (!at || e.pointerType === "touch") return;
      const [dx, dy] = [e.clientX - at.x, e.clientY - at.y];
      setHot(Math.hypot(dx, dy) < DEAD ? null : sliceAt(dx, dy));
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state.current.open) {
        // Only the wheel closes: not the game's menu as well.
        e.stopImmediatePropagation();
        return close();
      }
      if (e.key.toLowerCase() !== HOLD || e.repeat || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (state.current.blocked || state.current.open) return;
      // Not over the game menu or another window that has the screen.
      if (document.querySelector(".game-menu, .overlay, .look-dialog-backdrop")) return;
      openAt(pointer.current.x, pointer.current.y, true);
    };
    const onUp = (e: KeyboardEvent) => {
      const { open: at, hot: i } = state.current;
      if (e.key.toLowerCase() !== HOLD || !at?.held) return;
      if (i !== null) pick(i);
      else close();
    };
    addEventListener("pointermove", onMove);
    // Heard before anything else (in capture), so an Escape that closes the wheel goes no further.
    addEventListener("keydown", onDown, true);
    addEventListener("keyup", onUp);
    return () => {
      removeEventListener("pointermove", onMove);
      removeEventListener("keydown", onDown, true);
      removeEventListener("keyup", onUp);
    };
  }, []);

  // Blocked while it is open (the hero went down): put away.
  useEffect(() => {
    if (blocked) close();
  }, [blocked]);

  const fromButton = () => {
    if (open) return close();
    const r = button.current!.getBoundingClientRect();
    openAt(r.left + r.width / 2, r.top + r.height / 2, false);
  };

  return (
    <>
      <button ref={button} type="button" className="emote-button" disabled={!!blocked} title={blocked ?? (tab ? undefined : "Emotes (hold G)")} aria-label="Emotes" aria-expanded={!!open} onClick={fromButton}>
        <PixelIcon rows={FACE} size={16} />
      </button>
      {open && createPortal(
        <div className="emote-veil" onPointerDown={(e) => e.target === e.currentTarget && close()}>
          <div className="emote-wheel" role="menu" aria-label="Emotes" style={{ left: open.x, top: open.y }}>
            <div className="emote-hub">{hot === null ? (open.held ? "Let go on one" : "Emote") : EMOTE_INFO[EMOTES[hot]].name}</div>
            {EMOTES.map((e, i) => {
              const a = (i / EMOTES.length) * Math.PI * 2;
              return (
                <button
                  key={e}
                  type="button"
                  role="menuitem"
                  className={`emote-slice${hot === i ? " hot" : ""}`}
                  style={{ left: Math.sin(a) * RING, top: -Math.cos(a) * RING }}
                  title={`${EMOTE_INFO[e].name} (/${e})`}
                  onPointerEnter={(ev) => ev.pointerType !== "touch" && setHot(i)}
                  onClick={() => pick(i)}
                >
                  <span className="emote-glyph"><PixelIcon rows={EMOTE_INFO[e].icon} size={EMOTE_INFO[e].icon[0].length * 2} /></span>
                  <span className="emote-name">{EMOTE_INFO[e].name}</span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
