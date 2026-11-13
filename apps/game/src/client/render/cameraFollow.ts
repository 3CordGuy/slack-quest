// Whether the camera keeps your own hero centred as they walk. One setting
// for every view (the Harbor, huts, the pub, voyages), remembered on this
// device. On unless the player has turned it off.

const KEY = "gq.camera.follow";

export function readFollow(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeFollow(on: boolean) {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "0");
  } catch {
    // Private windows and blocked storage: the setting lasts until the page closes.
  }
}

/**
 * A pinch drifts a little as the fingers spread. Following stays on until the
 * pinch's midpoint has wandered this far (CSS pixels) from where it started;
 * past that it is a pan, and following stops.
 */
export const PINCH_PAN_SLACK = 28;

/** The icon: a hero inside the corners of a viewfinder. */
export const FOLLOW_ICON = [
  "###.....###",
  "#.........#",
  "#...###...#",
  "....###....",
  ".....#.....",
  "...#####...",
  ".....#.....",
  "....#.#....",
  "#...#.#...#",
  "#.........#",
  "###.....###",
];

/** The same icon as an SVG element, for the renderer's plain-DOM buttons. */
export function followIconSvg(size = 22): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const w = FOLLOW_ICON[0].length;
  const h = FOLLOW_ICON.length;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(Math.round((size * h) / w)));
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("pixel-glyph");
  FOLLOW_ICON.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c !== "#") return;
      const r = document.createElementNS(ns, "rect");
      r.setAttribute("x", String(x));
      r.setAttribute("y", String(y));
      r.setAttribute("width", "1");
      r.setAttribute("height", "1");
      svg.appendChild(r);
    }),
  );
  return svg;
}
