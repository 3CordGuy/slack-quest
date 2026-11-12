// Pixel-art icons for things that are not gear: pub fare, apothecary brews,
// galley dishes, hut furniture, small things and trophies. Same 16x16 grid, palette and
// outline as the gear in itemArt.ts, which merges this table into its own,
// so admin overrides and the icon editor cover these too.
//
// Each entry is keyed `pub-<id>`, `brew-<id>`, `dish-<id>` or `furn-<id>` after the
// catalogue id, so an admin can redraw one piece without touching the
// others. Pieces of one kind share a drawing helper with their own colours.
// The accent colour (chosen per thing in thingIcons.tsx) paints one detail:
// a cushion, a label, a blanket, the liquid in a flask.

import { C, spans, type Art, type Pen } from "./artKit";

const K = {
  copper: "#c8743a",
  copperLit: "#e39a5c",
  copperDark: "#8f4d24",
  glass: "#cfe6ee",
  glassDark: "#9cbac6",
  flame: "#ffd23f",
  ember: "#f08a24",
  stone: "#8b95a5",
  stoneLit: "#a9b2c0",
  stoneDark: "#646d7c",
  clay: "#b8754a",
  clayLit: "#d9955f",
  crust: "#d9a35a",
  crustDark: "#a8742f",
  leaf: "#4f8a3a",
  leafLit: "#6fae4a",
  sea: "#3f6fa8",
  seaLit: "#6b9bd0",
  cap: "#b8452f",
  foam: "#f4efe0",
};

// ---------- shared shapes ----------

/** A tankard with metal bands and a head of foam. */
function tankard(p: Pen) {
  p.r(3, 5, 8, 10, C.wood);
  p.r(4, 5, 1, 10, C.leather);
  p.r(3, 7, 8, 1, C.iron);
  p.r(3, 12, 8, 1, C.iron);
  p.r(6, 9, 2, 2, p.accent);
  // The handle.
  p.r(11, 7, 3, 1, C.bark);
  p.r(13, 8, 1, 3, C.bark);
  p.r(11, 11, 3, 1, C.bark);
  spans(p, K.foam, [[2, 4, 8], [3, 3, 10], [4, 3, 10]]);
  p.r(9, 5, 1, 2, K.foam);
}

/** A stoppered bottle with a paper label; `glass` and `lit` for its colour. */
function bottle(p: Pen, glass: string, lit: string) {
  p.r(7, 0, 2, 2, C.leather);
  p.r(7, 2, 2, 3, glass);
  spans(p, glass, [[5, 5, 10], [6, 4, 11]]);
  p.r(4, 7, 8, 8, glass);
  p.r(5, 7, 1, 7, lit);
  p.r(5, 9, 6, 4, C.paper);
  p.r(6, 10, 4, 2, p.accent);
}

/** A small flame two pixels wide, its foot at (x, y). */
function flame(p: Pen, x: number, y: number) {
  p.r(x, y - 3, 2, 3, K.flame);
  p.r(x, y - 1, 2, 1, K.ember);
  p.r(x, y - 4, 1, 1, K.flame);
}

/** A fire in an opening, from `x0` to `x1`, its foot on row `y`. */
function fire(p: Pen, x0: number, x1: number, y: number) {
  p.r(x0, y, x1 - x0 + 1, 1, C.bark);
  for (let x = x0; x <= x1; x++) {
    const tall = (x - x0) % 3 === 1 ? 4 : 2;
    p.r(x, y - tall, 1, tall, K.ember);
    p.r(x, y - tall, 1, 1, K.flame);
  }
  p.r(Math.floor((x0 + x1) / 2), y - 5, 1, 2, K.flame);
}

/** A lidded chest: `w` wide, its lid at row `y`, iron straps and a gold lock. */
function chest(p: Pen, x: number, y: number, w: number, h: number) {
  spans(p, C.wood, [[y, x + 1, x + w - 2], [y + 1, x, x + w - 1], [y + 2, x, x + w - 1]]);
  p.r(x + 2, y + 1, w - 4, 1, p.accent);
  p.r(x, y + 3, w, 1, C.bark);
  p.r(x, y + 4, w, h - 4, C.wood);
  p.r(x, y + 4, w, 1, C.leather);
  p.r(x + 2, y, 1, h, C.iron);
  p.r(x + w - 3, y, 1, h, C.iron);
  p.r(x + Math.floor(w / 2) - 1, y + 3, 2, 3, C.gold);
}

/** A table seen from the side: top from `x0` to `x1` on row `y`, legs to the floor. */
function table(p: Pen, x0: number, x1: number, y: number) {
  p.r(x0, y, x1 - x0 + 1, 2, C.wood);
  p.r(x0, y, x1 - x0 + 1, 1, C.leather);
  p.r(x0 + 1, y + 2, 2, 15 - y - 1, C.bark);
  p.r(x1 - 2, y + 2, 2, 15 - y - 1, C.bark);
  p.r(x0 + 3, y + 2, x1 - x0 - 5, 1, C.bark);
}

/** A tall wooden piece with drawers or doors; `rows` are the seams across it. */
function cabinet(p: Pen, x: number, y: number, w: number, rows: number[]) {
  p.r(x, y + 1, w, 15 - y - 1, C.wood);
  p.r(x - 1, y, w + 2, 2, C.leather);
  p.r(x, 15, 2, 1, C.bark);
  p.r(x + w - 2, 15, 2, 1, C.bark);
  for (const r of rows) p.r(x + 1, r, w - 2, 1, C.bark);
}

/** A lantern in a frame, with a handle ring, flame in its glass. */
function lantern(p: Pen) {
  spans(p, K.copperDark, [[0, 6, 9], [1, 5, 5], [1, 10, 10], [2, 5, 5], [2, 10, 10]]);
  p.r(4, 3, 8, 2, K.copper);
  p.r(5, 3, 6, 1, K.copperLit);
  p.r(4, 5, 8, 7, "#ffe9a0");
  p.r(7, 6, 2, 5, K.ember);
  p.r(7, 8, 2, 3, K.flame);
  p.r(4, 5, 1, 7, K.copper);
  p.r(11, 5, 1, 7, K.copper);
  p.r(3, 12, 10, 2, K.copper);
  p.r(3, 12, 10, 1, K.copperLit);
  p.r(6, 14, 4, 1, p.accent);
}

/** A round-bottomed flask, the liquid in the accent. */
function flask(p: Pen) {
  p.r(6, 0, 4, 2, C.leather);
  p.r(7, 2, 2, 3, K.glass);
  spans(p, K.glass, [[5, 5, 10], [6, 4, 11], [7, 3, 12], [8, 2, 13]]);
  spans(p, p.accent, [[9, 2, 13], [10, 2, 13], [11, 2, 13], [12, 3, 12], [13, 4, 11], [14, 5, 10]]);
  spans(p, p.shade, [[13, 6, 11], [14, 6, 10]]);
  p.r(4, 7, 1, 2, C.shine);
  p.r(5, 11, 1, 1, C.shine);
  p.r(9, 10, 1, 1, C.shine);
}

// ---------- the table ----------

export const THING_ART: Record<string, Art> = {
  // ---- pub fare ----
  "pub-ale": tankard,
  "pub-rum": (p) => bottle(p, "#7a3b1c", "#a65a2c"),
  "pub-stew": (p) => {
    // A bowl of stew, a fish tail sticking out, steam rising.
    p.r(4, 0, 1, 3, K.foam);
    p.r(8, 1, 1, 3, K.foam);
    p.r(11, 2, 2, 3, "#8fb4c8");
    p.r(10, 5, 4, 1, "#8fb4c8");
    spans(p, "#d08a4a", [[6, 3, 12], [7, 2, 13]]);
    p.r(5, 6, 2, 1, "#e8b070");
    p.r(1, 8, 14, 1, C.leather);
    spans(p, C.wood, [[9, 2, 13], [10, 2, 13], [11, 3, 12], [12, 4, 11], [13, 5, 10]]);
    p.r(3, 10, 10, 1, p.accent);
    p.r(6, 14, 4, 1, C.bark);
  },
  "pub-pie": (p) => {
    // A domed crust with slits, on a dish.
    p.r(5, 1, 1, 2, K.foam);
    p.r(9, 0, 1, 3, K.foam);
    spans(p, K.crust, [[4, 5, 10], [5, 3, 12], [6, 2, 13], [7, 1, 14], [8, 1, 14], [9, 1, 14], [10, 1, 14]]);
    p.r(5, 4, 4, 1, "#ecc27a");
    for (let x = 1; x <= 13; x += 2) p.r(x, 10, 1, 1, K.crustDark);
    p.r(4, 7, 2, 1, K.crustDark);
    p.r(8, 6, 1, 2, K.crustDark);
    p.r(10, 8, 2, 1, K.crustDark);
    p.r(0, 11, 16, 1, p.accent);
    spans(p, C.steel, [[12, 1, 14], [13, 3, 12]]);
  },

  // ---- apothecary brews ----
  "brew-healing": flask,
  "brew-focus": (p) => {
    // A tall stoppered vial.
    p.r(5, 0, 6, 2, C.leather);
    p.r(6, 2, 4, 2, K.glass);
    p.r(5, 4, 6, 10, K.glass);
    p.r(6, 14, 4, 1, K.glass);
    p.r(5, 7, 6, 7, p.accent);
    p.r(6, 14, 4, 1, p.shade);
    p.r(9, 7, 1, 7, p.shade);
    p.r(6, 5, 1, 7, C.shine);
    p.r(7, 9, 1, 1, C.shine);
  },
  "brew-stoneskin": (p) => {
    // A squat clay pot of salve with a tied cloth lid.
    p.r(7, 1, 2, 1, C.bark);
    spans(p, C.paper, [[2, 4, 11], [3, 3, 12], [4, 3, 12]]);
    p.r(3, 5, 10, 1, C.bark);
    spans(p, K.clay, [[6, 3, 12], [7, 2, 13], [8, 2, 13], [9, 2, 13], [10, 2, 13], [11, 2, 13], [12, 3, 12], [13, 4, 11]]);
    p.r(3, 7, 1, 5, K.clayLit);
    p.r(2, 8, 12, 3, p.accent);
    p.r(2, 10, 12, 1, p.shade);
    p.r(6, 8, 4, 1, C.paper);
  },

  // ---- galley dishes ----
  "dish-chowder": (p) => {
    // A cast-iron pot of chowder on short legs, steaming.
    p.r(5, 1, 1, 3, K.foam);
    p.r(9, 0, 1, 3, K.foam);
    p.r(2, 5, 12, 1, "#efe2c0");
    p.r(4, 5, 2, 1, K.copperLit);
    p.r(9, 5, 1, 1, K.leafLit);
    p.r(1, 6, 14, 1, C.iron);
    p.r(0, 7, 1, 2, C.iron);
    p.r(15, 7, 1, 2, C.iron);
    spans(p, "#4a4e5c", [[7, 1, 14], [8, 1, 14], [9, 1, 14], [10, 1, 14], [11, 2, 13], [12, 3, 12], [13, 4, 11]]);
    p.r(2, 7, 1, 4, "#646d7c");
    p.r(2, 9, 12, 1, p.accent);
    p.r(4, 14, 2, 1, C.dark);
    p.r(10, 14, 2, 1, C.dark);
  },
  "dish-stores": (p) => {
    // Hard tack and dried mushrooms bundled in a hide, tied with rope.
    spans(p, C.leather, [[4, 3, 12], [5, 2, 13], [6, 1, 14], [7, 1, 14], [8, 1, 14], [9, 1, 14], [10, 1, 14], [11, 1, 14], [12, 2, 13], [13, 3, 12]]);
    p.r(2, 5, 1, 7, "#c08050");
    p.r(3, 13, 10, 1, C.hide);
    p.r(4, 2, 3, 2, K.crust);
    p.r(10, 2, 2, 2, K.cap);
    p.r(10, 3, 1, 1, "#e07a5f");
    p.r(7, 4, 2, 10, "#d6c49d");
    p.r(1, 8, 14, 1, "#d6c49d");
    p.r(6, 1, 4, 3, "#d6c49d");
    p.r(7, 2, 2, 1, C.bark);
    p.r(11, 10, 2, 2, p.accent);
  },

  // ---- furniture ----
  "furn-table": (p) => {
    table(p, 1, 14, 6);
    p.r(9, 3, 3, 3, p.accent);
    p.r(10, 3, 1, 1, C.shine);
    p.r(3, 4, 4, 2, C.paper);
  },
  "furn-side_table": (p) => {
    p.r(3, 7, 10, 2, C.wood);
    p.r(3, 7, 10, 1, C.leather);
    p.r(7, 9, 2, 5, C.bark);
    p.r(4, 14, 8, 1, C.bark);
    p.r(5, 4, 2, 3, C.bone);
    p.r(5, 3, 2, 1, K.flame);
    p.r(9, 5, 3, 2, p.accent);
  },
  "furn-desk": (p) => {
    p.r(0, 6, 16, 2, C.wood);
    p.r(0, 6, 16, 1, C.leather);
    p.r(1, 8, 6, 7, C.wood);
    p.r(1, 11, 6, 1, C.bark);
    p.r(3, 9, 2, 1, C.gold);
    p.r(3, 13, 2, 1, C.gold);
    p.r(13, 8, 2, 7, C.bark);
    p.r(7, 8, 6, 1, C.bark);
    p.r(8, 4, 5, 2, C.paper);
    p.l(12, 0, 10, 4, p.accent);
  },
  "furn-chair": (p) => {
    // A three-legged stool with a cushion.
    p.r(4, 5, 8, 1, p.accent);
    p.r(3, 6, 10, 2, C.wood);
    p.r(3, 6, 10, 1, C.leather);
    p.l(4, 8, 2, 15, C.bark);
    p.l(11, 8, 13, 15, C.bark);
    p.r(7, 8, 2, 7, C.bark);
    p.r(4, 11, 8, 1, C.bark);
  },
  "furn-rug": (p) => {
    p.r(2, 3, 12, 10, C.leather);
    p.r(2, 3, 12, 1, C.hide);
    p.r(2, 12, 12, 1, C.hide);
    p.r(3, 5, 10, 1, p.shade);
    p.r(3, 10, 10, 1, p.shade);
    spans(p, p.accent, [[6, 7, 8], [7, 6, 9], [8, 6, 9], [9, 7, 8]]);
    for (let y = 3; y <= 12; y += 2) {
      p.r(1, y, 1, 1, C.paper);
      p.r(14, y, 1, 1, C.paper);
    }
  },
  "furn-lantern": lantern,
  "furn-hand_lantern": lantern,
  "furn-banner": (p) => {
    p.r(2, 0, 1, 16, C.wood);
    p.r(2, 1, 12, 1, C.bark);
    spans(p, p.accent, [[2, 4, 12], [3, 4, 12], [4, 4, 12], [5, 4, 12], [6, 4, 12], [7, 4, 12], [8, 4, 12], [9, 4, 12], [10, 4, 12], [11, 4, 7], [11, 9, 12], [12, 4, 5], [12, 11, 12]]);
    p.r(11, 2, 2, 9, p.shade);
    p.r(6, 4, 4, 4, C.gold);
    p.r(7, 5, 2, 2, p.shade);
  },
  "furn-bed": (p) => {
    // A bunk from the side: headboard, pillow, blanket, footboard.
    p.r(1, 3, 2, 12, C.wood);
    p.r(1, 3, 2, 1, C.leather);
    p.r(13, 7, 2, 8, C.wood);
    p.r(13, 7, 2, 1, C.leather);
    p.r(3, 11, 10, 2, C.bark);
    p.r(3, 9, 10, 2, C.paper);
    p.r(3, 7, 4, 2, C.shine);
    p.r(6, 8, 7, 3, p.accent);
    p.r(6, 10, 7, 1, p.shade);
  },
  "furn-chest": (p) => chest(p, 1, 4, 14, 11),
  "furn-storage_chest": (p) => chest(p, 3, 6, 10, 8),
  "furn-hearth": (p) => {
    // A stone hearth with a pot over the fire.
    spans(p, K.stone, [[2, 2, 13], [3, 1, 14]]);
    p.r(1, 4, 14, 11, K.stone);
    p.r(1, 4, 14, 1, K.stoneLit);
    p.r(4, 6, 8, 8, C.dark);
    for (const [x, y] of [[2, 6], [12, 8], [2, 11], [13, 12], [6, 3], [10, 2]]) p.r(x, y, 1, 1, K.stoneDark);
    p.r(5, 7, 6, 1, C.iron);
    p.r(6, 8, 4, 3, p.accent);
    p.r(6, 10, 4, 1, p.shade);
    fire(p, 5, 10, 13);
  },
  "furn-fireplace": (p) => {
    // A great fireplace with a mantel and things on it.
    p.r(3, 0, 2, 2, p.accent);
    p.r(11, 0, 2, 2, C.gold);
    p.r(0, 2, 16, 2, C.wood);
    p.r(0, 2, 16, 1, C.leather);
    p.r(1, 4, 14, 12, K.stone);
    spans(p, C.dark, [[6, 5, 10], [7, 4, 11], [8, 4, 11], [9, 4, 11], [10, 4, 11], [11, 4, 11], [12, 4, 11], [13, 4, 11], [14, 4, 11]]);
    for (const [x, y] of [[2, 6], [13, 7], [2, 10], [13, 12], [2, 14], [8, 5]]) p.r(x, y, 1, 1, K.stoneDark);
    p.r(1, 15, 14, 1, K.stoneDark);
    fire(p, 4, 11, 14);
  },
  "furn-bookshelf": (p) => {
    p.r(2, 0, 12, 16, C.wood);
    p.r(3, 1, 10, 14, C.dark);
    p.r(3, 5, 10, 1, C.wood);
    p.r(3, 10, 10, 1, C.wood);
    const shelf = (y: number, h: number, colours: string[]) => colours.forEach((c, i) => c && p.r(3 + i, y + (i % 3 === 1 ? 1 : 0), 1, h - (i % 3 === 1 ? 1 : 0), c));
    shelf(1, 4, [K.cap, K.sea, K.sea, p.accent, C.paper, "", K.leaf, K.cap, C.leather, ""]);
    shelf(6, 4, [C.leather, p.accent, p.accent, "", K.sea, K.leaf, K.leaf, C.paper, K.cap, K.sea]);
    shelf(11, 4, [K.leaf, K.cap, "", C.paper, C.paper, p.accent, K.sea, C.leather, "", K.cap]);
  },
  "furn-books": (p) => {
    const book = (x: number, y: number, w: number, cover: string) => {
      p.r(x, y, w, 3, cover);
      p.r(x + w - 1, y + 1, 1, 1, C.paper);
      p.r(x + 1, y + 1, w - 3, 1, C.paper);
    };
    book(1, 12, 13, K.sea);
    book(2, 9, 11, p.accent);
    book(3, 6, 12, K.cap);
    book(4, 3, 9, K.leaf);
    p.r(9, 0, 1, 3, C.gold);
  },
  "furn-workbench": (p) => {
    p.r(0, 6, 16, 3, C.wood);
    p.r(0, 6, 16, 1, C.leather);
    p.r(1, 9, 2, 7, C.bark);
    p.r(13, 9, 2, 7, C.bark);
    p.r(3, 12, 10, 1, C.bark);
    // A hammer and a vice on top.
    p.r(2, 4, 6, 1, C.bark);
    p.r(7, 2, 2, 4, C.iron);
    p.r(7, 2, 2, 1, C.steel);
    p.r(11, 3, 3, 3, p.accent);
    p.r(12, 2, 1, 1, p.shade);
  },
  "furn-weapon_rack": (p) => {
    p.r(1, 2, 2, 14, C.wood);
    p.r(13, 2, 2, 14, C.wood);
    p.r(1, 3, 14, 1, C.bark);
    p.r(1, 12, 14, 1, C.bark);
    // A sword, a spear and an axe.
    p.r(5, 0, 1, 10, C.steel);
    p.r(4, 9, 3, 1, C.gold);
    p.r(5, 10, 1, 4, C.bark);
    p.r(8, 2, 1, 13, C.wood);
    spans(p, C.steel, [[0, 8, 8], [1, 7, 9]]);
    p.r(11, 2, 1, 13, C.wood);
    spans(p, C.steel, [[2, 9, 10], [3, 9, 10], [4, 10, 10]]);
    p.r(6, 13, 4, 2, p.accent);
  },
  "furn-dresser": (p) => {
    cabinet(p, 1, 3, 14, [7, 11]);
    for (const y of [5, 9, 13]) p.r(7, y, 2, 1, C.gold);
    p.r(3, 1, 2, 2, p.accent);
    p.r(10, 2, 3, 1, C.paper);
  },
  "furn-cupboard": (p) => {
    cabinet(p, 3, 0, 10, []);
    p.r(7, 2, 1, 13, C.bark);
    p.r(4, 3, 2, 5, C.bark);
    p.r(9, 3, 2, 5, C.bark);
    p.r(4, 10, 2, 4, C.bark);
    p.r(9, 10, 2, 4, C.bark);
    p.r(6, 8, 1, 1, C.gold);
    p.r(8, 8, 1, 1, C.gold);
    p.r(2, 0, 12, 1, p.accent);
  },
  "furn-crate": (p) => {
    p.r(1, 3, 14, 12, C.wood);
    p.r(1, 3, 14, 2, C.bark);
    p.r(1, 13, 14, 2, C.bark);
    p.r(1, 3, 2, 12, C.bark);
    p.r(13, 3, 2, 12, C.bark);
    p.l(3, 5, 12, 12, C.bark);
    p.l(4, 5, 12, 11, C.leather);
    for (const [x, y] of [[2, 4], [13, 4], [2, 13], [13, 13]]) p.r(x, y, 1, 1, C.iron);
    p.r(10, 6, 2, 2, p.accent);
  },
  "furn-barrel": (p) => {
    spans(p, C.wood, [[1, 4, 11], [2, 3, 12], [3, 2, 13], [4, 2, 13], [5, 2, 13], [6, 2, 13], [7, 2, 13], [8, 2, 13], [9, 2, 13], [10, 2, 13], [11, 2, 13], [12, 2, 13], [13, 3, 12], [14, 4, 11]]);
    p.r(4, 1, 8, 1, C.leather);
    p.r(5, 2, 1, 12, C.bark);
    p.r(10, 2, 1, 12, C.bark);
    p.r(3, 3, 1, 11, C.leather);
    p.r(2, 4, 12, 1, C.iron);
    p.r(2, 11, 12, 1, C.iron);
    p.r(7, 7, 2, 2, p.accent);
  },

  // ---- small things ----
  "furn-candle": (p) => {
    flame(p, 7, 5);
    p.r(7, 5, 1, 1, C.dark);
    p.r(6, 6, 4, 7, C.bone);
    p.r(9, 6, 1, 7, C.paper);
    p.r(6, 7, 1, 2, C.shine);
    p.r(3, 13, 10, 2, p.accent);
    p.r(3, 13, 10, 1, C.gold);
    p.r(13, 13, 2, 1, C.gold);
  },
  "furn-candelabra": (p) => {
    p.r(5, 14, 6, 2, K.copper);
    p.r(7, 8, 2, 6, K.copper);
    p.r(1, 8, 14, 1, K.copper);
    p.r(1, 7, 1, 1, K.copper);
    p.r(14, 7, 1, 1, K.copper);
    for (const x of [1, 7, 13]) {
      p.r(x, 4, 2, 3, C.bone);
      flame(p, x, 4);
    }
    p.r(6, 11, 4, 1, p.accent);
  },
  "furn-mug": tankard,
  "furn-bottle": (p) => bottle(p, "#3d7a44", "#5aa064"),
  "furn-plate": (p) => {
    // A loaf and a wedge of cheese on a clay plate.
    spans(p, K.crust, [[5, 3, 7], [6, 2, 8], [7, 2, 8], [8, 2, 8], [9, 2, 8], [10, 2, 8]]);
    p.r(3, 5, 3, 1, "#ecc27a");
    p.l(3, 9, 5, 7, K.crustDark);
    p.l(5, 10, 7, 8, K.crustDark);
    spans(p, "#f2d04a", [[6, 13, 13], [7, 12, 13], [8, 11, 13], [9, 10, 13], [10, 9, 13]]);
    p.r(11, 9, 1, 1, "#c9a52a");
    p.r(12, 8, 1, 1, "#c9a52a");
    spans(p, K.clay, [[11, 1, 14], [12, 0, 15], [13, 1, 14]]);
    p.r(2, 12, 12, 1, p.accent);
  },
  "furn-potted_herb": (p) => {
    p.r(7, 3, 1, 5, K.leaf);
    spans(p, K.leaf, [[1, 6, 9], [2, 4, 11], [3, 3, 12], [4, 3, 6], [4, 9, 12], [5, 4, 5], [5, 10, 11]]);
    spans(p, K.leafLit, [[2, 6, 7], [3, 9, 10], [4, 4, 4]]);
    p.r(4, 0, 2, 2, p.accent);
    p.r(10, 0, 2, 2, p.accent);
    p.r(2, 8, 12, 2, K.clayLit);
    spans(p, K.clay, [[10, 3, 12], [11, 3, 12], [12, 4, 11], [13, 4, 11], [14, 5, 10]]);
    p.r(4, 10, 1, 3, K.clayLit);
  },
  "furn-mushroom_jar": (p) => {
    p.r(4, 1, 8, 2, C.wood);
    p.r(5, 3, 6, 1, K.glassDark);
    p.r(3, 4, 10, 11, K.glass);
    p.r(4, 8, 8, 6, "#b8c79a");
    const shroom = (x: number, y: number) => {
      p.r(x, y, 3, 2, K.cap);
      p.r(x + 1, y, 1, 1, "#e07a5f");
      p.r(x + 1, y + 2, 1, 3, C.paper);
    };
    shroom(4, 7);
    shroom(8, 9);
    shroom(6, 5);
    p.r(4, 5, 1, 3, C.shine);
    p.r(3, 14, 10, 1, K.glassDark);
    p.r(5, 2, 6, 1, p.accent);
  },
  "furn-skull": (p) => {
    spans(p, C.bone, [[2, 5, 10], [3, 3, 12], [4, 2, 13], [5, 2, 13], [6, 2, 13], [7, 2, 13], [8, 2, 13], [9, 3, 12], [10, 4, 11], [11, 4, 11], [12, 5, 10], [13, 5, 10]]);
    p.r(4, 3, 3, 1, C.shine);
    p.r(4, 6, 3, 3, C.dark);
    p.r(9, 6, 3, 3, C.dark);
    p.r(5, 7, 1, 1, p.accent);
    p.r(10, 7, 1, 1, p.accent);
    p.r(7, 9, 2, 2, C.dark);
    for (const x of [6, 8]) p.r(x, 12, 1, 2, C.dark);
    p.r(5, 14, 6, 1, C.bone);
  },
  "furn-sea_chart": (p) => {
    p.r(2, 2, 12, 12, C.paper);
    p.r(0, 1, 2, 14, "#d6c49d");
    p.r(14, 1, 2, 14, "#d6c49d");
    p.r(1, 2, 1, 12, C.leather);
    p.r(14, 2, 1, 12, C.leather);
    spans(p, K.leafLit, [[3, 3, 5], [4, 3, 6], [5, 4, 5], [9, 10, 12], [10, 9, 12], [11, 10, 11]]);
    p.r(11, 4, 1, 1, K.leafLit);
    for (const [x, y] of [[6, 6], [7, 7], [8, 8], [9, 8]]) p.r(x, y, 1, 1, p.accent);
    p.r(3, 11, 1, 1, K.cap);
    p.r(5, 11, 1, 1, K.cap);
    p.r(4, 12, 1, 1, K.cap);
    p.r(3, 13, 1, 1, K.cap);
    p.r(5, 13, 1, 1, K.cap);
  },
  "furn-hourglass": (p) => {
    p.r(2, 0, 12, 2, C.wood);
    p.r(2, 14, 12, 2, C.wood);
    p.r(3, 2, 1, 12, C.bark);
    p.r(12, 2, 1, 12, C.bark);
    spans(p, K.glass, [[2, 5, 10], [3, 5, 10], [4, 6, 9], [5, 6, 9], [6, 7, 8], [7, 7, 8], [8, 7, 8], [9, 6, 9], [10, 6, 9], [11, 5, 10], [12, 5, 10], [13, 5, 10]]);
    spans(p, p.accent, [[4, 6, 9], [5, 6, 9], [6, 7, 8], [10, 7, 8], [11, 6, 9], [12, 5, 10], [13, 5, 10]]);
    p.r(7, 7, 1, 3, p.accent);
  },
  "furn-writing_set": (p) => {
    // An ink pot with a quill in it.
    spans(p, C.dark, [[9, 5, 9], [10, 4, 10], [11, 3, 11], [12, 3, 11], [13, 3, 11], [14, 4, 10]]);
    p.r(6, 8, 3, 1, C.iron);
    p.r(4, 11, 7, 2, p.accent);
    p.l(7, 9, 13, 1, C.bark);
    spans(p, C.shine, [[0, 13, 15], [1, 12, 15], [2, 11, 14], [3, 10, 13], [4, 10, 12], [5, 9, 11], [6, 9, 10]]);
    p.l(14, 0, 9, 6, C.paper);
  },
  "furn-coin_pile": (p) => {
    spans(p, C.gold, [[6, 6, 9], [7, 4, 11], [8, 3, 12], [9, 2, 13], [10, 2, 13], [11, 1, 14], [12, 1, 14], [13, 1, 14], [14, 2, 13]]);
    for (const [x, y, w] of [[5, 9, 3], [9, 10, 3], [3, 12, 3], [8, 13, 4]]) p.r(x, y, w, 1, "#b8891f");
    p.r(6, 7, 2, 1, C.shine);
    p.r(11, 2, 3, 5, C.gold);
    p.r(12, 3, 1, 3, "#b8891f");
    p.r(11, 2, 1, 1, C.shine);
    p.r(4, 10, 1, 1, p.accent);
    p.r(10, 12, 1, 1, p.accent);
  },

  // ---- far goods ----
  "furn-globe": (p) => {
    spans(p, K.sea, [[1, 6, 9], [2, 4, 11], [3, 3, 12], [4, 3, 12], [5, 3, 12], [6, 3, 12], [7, 3, 12], [8, 4, 11], [9, 6, 9]]);
    spans(p, K.leafLit, [[2, 6, 8], [3, 5, 7], [4, 5, 6], [5, 9, 11], [6, 9, 11], [7, 10, 10]]);
    p.r(4, 2, 1, 1, K.seaLit);
    spans(p, K.copper, [[0, 7, 8], [1, 13, 13], [2, 14, 14], [3, 14, 14], [4, 14, 14], [5, 14, 14], [6, 14, 14], [7, 14, 14], [8, 13, 13], [9, 12, 12], [10, 10, 11]]);
    p.r(7, 10, 2, 3, C.wood);
    p.r(4, 13, 8, 2, C.wood);
    p.r(4, 13, 8, 1, C.leather);
    p.r(6, 14, 4, 1, p.accent);
  },
  "furn-ship_bottle": (p) => {
    // A bottle on its side on a stand, a ship inside.
    p.r(1, 4, 11, 7, K.glass);
    p.r(12, 6, 2, 3, K.glass);
    p.r(14, 6, 2, 3, C.leather);
    p.r(2, 5, 1, 2, C.shine);
    p.r(3, 9, 7, 1, C.wood);
    p.r(4, 10, 5, 1, C.bark);
    p.r(6, 5, 1, 4, C.bark);
    p.r(4, 6, 2, 3, C.paper);
    p.r(7, 6, 2, 3, C.paper);
    p.r(6, 4, 2, 1, p.accent);
    p.r(1, 11, 11, 1, K.glassDark);
    p.r(2, 12, 2, 3, C.bark);
    p.r(8, 12, 2, 3, C.bark);
  },
  "furn-shell_chimes": (p) => {
    p.r(1, 1, 14, 2, C.leather);
    p.r(1, 1, 14, 1, C.paper);
    p.r(7, 0, 2, 1, C.bark);
    const shell = (x: number, y: number, c: string) => {
      spans(p, c, [[y, x, x + 2], [y + 1, x, x + 2], [y + 2, x + 1, x + 1]]);
    };
    for (const [x, len, c] of [[2, 5, "#f2c8b0"], [6, 8, p.accent], [10, 6, "#f2c8b0"], [13, 3, C.bone]] as const) {
      p.r(x + 1, 3, 1, len, C.paper);
      shell(x, 3 + len, c);
    }
  },

  // ---- trophies ----
  "furn-trophy_relic": (p) => {
    // A gold chalice with a jewel.
    spans(p, C.gold, [[1, 3, 12], [2, 3, 12], [3, 3, 12], [4, 4, 11], [5, 4, 11], [6, 5, 10], [7, 6, 9]]);
    p.r(4, 1, 2, 4, C.shine);
    p.r(7, 8, 2, 3, "#b8891f");
    spans(p, C.gold, [[11, 5, 10], [12, 4, 11], [13, 3, 12]]);
    p.r(3, 14, 10, 1, "#b8891f");
    p.r(7, 3, 2, 2, p.accent);
    p.r(7, 3, 1, 1, C.shine);
  },
  "furn-trophy_token": (p) => {
    // A medallion on a ribbon.
    spans(p, p.accent, [[0, 3, 5], [0, 10, 12], [1, 4, 6], [1, 9, 11], [2, 5, 7], [2, 8, 10], [3, 6, 9], [4, 7, 8]]);
    p.r(4, 0, 1, 1, p.shade);
    p.r(11, 0, 1, 1, p.shade);
    spans(p, C.gold, [[5, 6, 9], [6, 4, 11], [7, 3, 12], [8, 3, 12], [9, 3, 12], [10, 3, 12], [11, 3, 12], [12, 4, 11], [13, 6, 9]]);
    spans(p, "#b8891f", [[7, 6, 9], [8, 5, 10], [9, 5, 10], [10, 5, 10], [11, 6, 9]]);
    p.r(7, 8, 2, 2, C.gold);
    p.r(5, 6, 2, 1, C.shine);
  },
  "furn-trophy_pelt": (p) => {
    // A beast's head on a wooden shield.
    spans(p, C.wood, [[1, 2, 13], [2, 1, 14], [3, 1, 14], [4, 1, 14], [5, 1, 14], [6, 1, 14], [7, 1, 14], [8, 1, 14], [9, 2, 13], [10, 3, 12], [11, 4, 11], [12, 6, 9]]);
    p.r(2, 2, 12, 1, C.leather);
    spans(p, "#7a7f8f", [[3, 3, 4], [3, 11, 12], [4, 3, 12], [5, 4, 11], [6, 4, 11], [7, 5, 10], [8, 5, 10], [9, 6, 9], [10, 6, 9], [11, 7, 8]]);
    p.r(3, 3, 1, 1, "#4a4e5c");
    p.r(12, 3, 1, 1, "#4a4e5c");
    p.r(5, 6, 1, 1, p.accent);
    p.r(10, 6, 1, 1, p.accent);
    p.r(7, 10, 2, 1, C.dark);
    p.r(7, 12, 2, 1, C.bone);
  },
  "furn-trophy_core": (p) => {
    // A glowing crystal set in stone.
    spans(p, p.accent, [[0, 7, 8], [1, 6, 9], [2, 5, 10], [3, 4, 11], [4, 4, 11], [5, 4, 11], [6, 5, 10], [7, 6, 9], [8, 7, 8]]);
    spans(p, p.shade, [[3, 8, 11], [4, 9, 11], [5, 9, 11], [6, 8, 10], [7, 8, 9]]);
    p.r(6, 2, 1, 2, C.shine);
    p.r(5, 4, 1, 1, C.shine);
    spans(p, K.stone, [[9, 4, 11], [10, 3, 12], [11, 2, 13], [12, 2, 13], [13, 2, 13]]);
    p.r(3, 10, 3, 1, K.stoneLit);
    p.r(1, 14, 14, 1, K.stoneDark);
  },
};
