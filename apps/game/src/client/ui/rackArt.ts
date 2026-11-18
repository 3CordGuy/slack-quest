// The bottom bar, as pixel art drawn in code. From the top: two meters in
// timber housings with a brass stud and a turned finial at each outer end,
// and between them a plaque on a ribbon, trimmed in brass, for the hero's
// level; a stepped cornice; a beam with the experience bar's channel cut in;
// and the rack itself, a long board of warm red-brown timber with pale slots
// let into it, sectioned by two turned posts, with small tabs hanging off
// each end. One pixel here is one pixel of art (the stylesheet draws it
// large, with hard edges), and the boards carry a grain of short lighter and
// darker dashes.
//
// The picture is fixed; what changes (how full a meter is, what the plaque
// says, what is in a slot, what a tab does) is laid over it by Hud.tsx, at
// the places given in RACK.

import { BAR_ROW } from "../zone/hotbar";

/** Rows the meters and plaque take up, over the cornice. */
const TOP = 15;
/** Where the slots between the posts start, and how far apart they are. Everything right of them follows from how many there are. */
const MID_X = 51;
const MID_STEP = 16;
const POST_RIGHT = MID_X + BAR_ROW * MID_STEP;
const BAG = POST_RIGHT + 10;
const W = BAG + 23;

/** The bar's layout, in art pixels from the picture's top left. */
export const RACK = {
  w: W,
  h: TOP + 36,
  /** A slot's well, across and down, outline included. */
  slot: 14,
  /** The wells' top edge. */
  slotY: TOP + 16,
  /** The two wells left of the first post: weapon and shield. */
  hands: [9, 25],
  /** The row's worth between the posts (the bottom row lies under them). */
  mid: Array.from({ length: BAR_ROW }, (_, i) => MID_X + i * MID_STEP),
  /** The one right of the second post: the bag. */
  bag: BAG,
  posts: [41, POST_RIGHT],
  /** The tabs off each end: where they start, and the two heights they hang at. */
  tabs: { left: 0, right: W - 7, w: 7, h: 9, y: [TOP + 14, TOP + 24] },
  /** The experience bar's channel in the beam. */
  xp: { x: 22, y: TOP + 7, w: W - 44, h: 3 },
  /** The two meters' channels: health on the left, the view's other count on the right. */
  meters: [{ x: 22, y: 7, w: 60, h: 4 }, { x: W - 82, y: 7, w: 60, h: 4 }],
  /** The plaque's face, for the level (or the turn) to be written on, in the middle. */
  plaque: { x: (W - 36) / 2, y: 2, w: 36, h: 11 },
};

/** How much taller the rack is for each row of slots after the first (a fight's bar has two). */
export const RACK_ROW = 16;

const OUT = "#3a1d20";
const DARK = "#6b3524";
const MID = "#8e4a2f";
const LIGHT = "#b1633c";
const HIGH = "#d18a55";
const SLOT_EDGE = "#d99b73";
const SLOT = "#f3bc93";
const CHANNEL = "#3b2119";
const BRASS = "#f4c64e";
const BRASS_DARK = "#b9822a";
const RIBBON = "#7c2f2a";
const RIBBON_DARK = "#56201f";

const hash = (x: number, y: number) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

/** A board's colour at a pixel: its own tone, with a grain of short dashes a shade lighter or darker. */
function grain(x: number, y: number, tone: string, lighter: string, darker: string): string {
  const dash = hash(Math.floor((x + y * 5) / 3), y);
  return dash > 0.9 ? lighter : dash < 0.1 ? darker : tone;
}

/** Paint the bar onto a canvas sized RACK.w by RACK.h, taller by RACK_ROW for each row of slots after the first. */
export function paintRack(canvas: HTMLCanvasElement, rows = 1) {
  const { w } = RACK;
  /** The extra depth of board under the first row. */
  const more = (rows - 1) * RACK_ROW;
  const h = RACK.h + more;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  const dot = (x: number, y: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, 1, 1);
  };
  const row = (x0: number, x1: number, y: number, c: string | ((x: number) => string)) => {
    for (let x = x0; x <= x1; x++) dot(x, y, typeof c === "string" ? c : c(x));
  };
  /** A small picture from rows of letters: o outline, h/l/m/d the timber's four tones, b/B brass, r/R ribbon, space nothing. */
  const stamp = (x0: number, y0: number, rows: string[], flip = false) => {
    const ink: Record<string, string> = { o: OUT, h: HIGH, l: LIGHT, m: MID, d: DARK, b: BRASS, B: BRASS_DARK, r: RIBBON, R: RIBBON_DARK };
    rows.forEach((line, y) => {
      [...line].forEach((ch, x) => {
        if (ink[ch]) dot(flip ? x0 + line.length - 1 - x : x0 + x, y0 + y, ink[ch]);
      });
    });
  };

  // ---------- the meters and the plaque ----------

  // A rail runs behind all three, so they read as one fitting.
  row(18, w - 19, 8, OUT);
  row(18, w - 19, 9, (x) => grain(x, 9, MID, LIGHT, DARK));
  row(18, w - 19, 10, DARK);
  row(18, w - 19, 11, OUT);

  RACK.meters.forEach((m, i) => {
    const [x0, x1] = [m.x - 2, m.x + m.w + 1];
    // The housing: a lit top, the channel with a dark line round it, a shadowed foot.
    row(x0, x1, m.y - 3, OUT);
    row(x0, x1, m.y - 2, (x) => grain(x, m.y - 2, HIGH, HIGH, LIGHT));
    row(x0, x1, m.y - 1, OUT);
    for (let y = m.y; y < m.y + m.h; y++) {
      row(m.x, m.x + m.w - 1, y, CHANNEL);
      dot(x0, y, OUT);
      dot(x0 + 1, y, OUT);
      dot(x1 - 1, y, OUT);
      dot(x1, y, OUT);
    }
    row(x0, x1, m.y + m.h, OUT);
    row(x0, x1, m.y + m.h + 1, (x) => grain(x, m.y + m.h + 1, DARK, MID, DARK));
    row(x0, x1, m.y + m.h + 2, OUT);
    // A bracket at each end: a taller block with a brass stud, lit along its top.
    const bracket = ["ooooooo", "ohhhhho", "ollllmo", "olbBlmo", "olBBlmo", "ollllmo", "olllmmo", "ommmmdo", "odddddo", "ooooooo"];
    stamp(x0 - 6, m.y - 4, bracket);
    stamp(x1, m.y - 4, bracket);
    // And a turned finial off the outer end, curling up: the flourish a plain bar lacks.
    const finial = [
      "  oo   ",
      " ohho  ",
      "ohlmo  ",
      "olmdooo",
      "omddlmm",
      " odmmmd",
      "  ooooo",
    ];
    if (i === 0) stamp(x0 - 12, m.y - 2, finial);
    else stamp(x1 + 6, m.y - 2, finial, true);
  });

  // The plaque: a ribbon behind, swallow-tailed, and on it a board trimmed with a brass line and four studs.
  const p = RACK.plaque;
  const tail = ["oooo  ", "orrro ", "oRrrro", " oRrro", "oRrrro", "orrro ", "oooo  "];
  stamp(p.x - 5, p.y + 3, tail.map((line) => [...line].reverse().join("")));
  stamp(p.x + p.w - 1, p.y + 3, tail);
  for (let y = 0; y < p.h + 2; y++) {
    const py = p.y - 1 + y;
    row(p.x - 1, p.x + p.w, py, (x) => {
      const px = x - (p.x - 1);
      const last = p.w + 1;
      // The corners are nipped off.
      if ((px === 0 || px === last) && (y === 0 || y === p.h + 1)) return "rgba(0,0,0,0)";
      if (px === 0 || px === last || y === 0 || y === p.h + 1) return OUT;
      if (y === 1) return grain(x, py, HIGH, HIGH, LIGHT);
      if (y === p.h) return DARK;
      // The brass line, a pixel in from the edge all round, with a stud at each corner.
      const inX = px === 2 || px === last - 2;
      const inY = y === 2 || y === p.h - 1;
      if (inX && inY) return BRASS;
      if ((inX && y > 2 && y < p.h - 1) || (inY && px > 2 && px < last - 2)) return BRASS_DARK;
      return grain(x, py, LIGHT, HIGH, MID);
    });
  }

  // ---------- the cornice, the beam and the rack ----------
  const T = TOP;

  // The cornice: a thin board wider than the beam under it, its ends stepped in.
  row(14, w - 15, T, OUT);
  row(15, w - 16, T + 1, (x) => grain(x, T + 1, HIGH, HIGH, LIGHT));
  row(16, w - 17, T + 2, (x) => grain(x, T + 2, MID, LIGHT, DARK));
  dot(14, T + 1, OUT);
  dot(w - 15, T + 1, OUT);
  dot(15, T + 2, OUT);
  dot(w - 16, T + 2, OUT);
  row(16, w - 17, T + 3, OUT);

  // The beam, with the experience bar's channel cut along it.
  const [bx0, bx1] = [20, w - 21];
  for (let y = T + 4; y <= T + 11; y++) {
    dot(bx0, y, OUT);
    dot(bx1, y, OUT);
  }
  row(bx0 + 1, bx1 - 1, T + 4, (x) => grain(x, T + 4, LIGHT, HIGH, MID));
  row(bx0 + 1, bx1 - 1, T + 5, (x) => grain(x, T + 5, MID, LIGHT, DARK));
  const { xp } = RACK;
  for (let y = T + 6; y <= T + 10; y++) {
    row(bx0 + 1, bx1 - 1, y, (x) => {
      const inX = x >= xp.x && x < xp.x + xp.w;
      if (inX && y >= xp.y && y < xp.y + xp.h) return CHANNEL;
      // A dark line round the channel, where the board's edge shades it.
      if (x >= xp.x - 1 && x <= xp.x + xp.w && y >= xp.y - 1 && y <= xp.y + xp.h) return OUT;
      return grain(x, y, MID, LIGHT, DARK);
    });
  }
  row(bx0 + 1, bx1 - 1, T + 11, DARK);

  // The rack itself: a board with a lit top edge and a shadowed foot.
  const [rx0, rx1] = [6, w - 7];
  row(rx0, rx1, T + 12, OUT);
  row(rx0 + 1, rx1 - 1, T + 13, (x) => grain(x, T + 13, HIGH, HIGH, LIGHT));
  row(rx0 + 1, rx1 - 1, T + 14, (x) => grain(x, T + 14, LIGHT, HIGH, MID));
  for (let y = T + 15; y <= T + 31 + more; y++) row(rx0 + 1, rx1 - 1, y, (x) => grain(x, y, MID, LIGHT, DARK));
  row(rx0 + 1, rx1 - 1, T + 32 + more, (x) => grain(x, T + 32 + more, DARK, MID, DARK));
  row(rx0 + 1, rx1 - 1, T + 33 + more, DARK);
  row(rx0, rx1, T + 34 + more, OUT);
  for (let y = T + 12; y <= T + 34 + more; y++) {
    dot(rx0, y, OUT);
    dot(rx1, y, OUT);
  }

  // The wells: pale squares with a dark outline, a line of shadow over each and of light under it.
  const well = (sx: number, sy = RACK.slotY) => {
    const n = RACK.slot;
    row(sx, sx + n - 1, sy - 1, DARK);
    row(sx, sx + n - 1, sy + n, LIGHT);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const edge = x === 0 || y === 0 || x === n - 1 || y === n - 1;
        const rim = x === 1 || y === 1 || x === n - 2 || y === n - 2;
        dot(sx + x, sy + y, edge ? OUT : rim ? SLOT_EDGE : SLOT);
      }
    }
  };
  for (const sx of [...RACK.hands, ...RACK.mid, RACK.bag]) well(sx);
  // A second row holds slots between the posts only: the hands and the bag stay where they are.
  for (let r = 1; r < rows; r++) for (const sx of RACK.mid) well(sx, RACK.slotY + r * RACK_ROW);

  // The posts: turned columns lit from the left, taller than the board, with a cap and a foot a pixel wider.
  const shaft = [OUT, HIGH, LIGHT, LIGHT, MID, MID, DARK, OUT];
  for (const px of RACK.posts) {
    for (let y = T + 13; y <= T + 33 + more; y++) {
      // A ring turned into the column near each end.
      const ring = y === T + 15 || y === T + 31 + more;
      shaft.forEach((c, i) => dot(px + i, y, ring && i > 0 && i < 7 ? (i < 4 ? MID : DARK) : c));
    }
    for (const y0 of [T + 10, T + 33 + more]) {
      row(px - 1, px + 8, y0, OUT);
      row(px, px + 7, y0 + 1, (x) => (x - px < 2 ? HIGH : x - px < 6 ? LIGHT : MID));
      dot(px - 1, y0 + 1, OUT);
      dot(px + 8, y0 + 1, OUT);
      row(px - 1, px + 8, y0 + 2, OUT);
    }
  }

  // The tabs off each end: small blocks of the same timber, lit along the top.
  const tab = (tx: number, ty: number) => {
    const { w: tw, h: th } = RACK.tabs;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const edge = x === 0 || y === 0 || x === tw - 1 || y === th - 1;
        dot(tx + x, ty + y, edge ? OUT : y === 1 ? HIGH : y === th - 2 ? DARK : grain(tx + x, ty + y, LIGHT, HIGH, MID));
      }
    }
  };
  for (const ty of RACK.tabs.y) {
    tab(RACK.tabs.left, ty);
    tab(RACK.tabs.right, ty);
  }
}
