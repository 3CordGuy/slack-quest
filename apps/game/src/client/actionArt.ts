// Pixel-art icons for what a hero does in a fight: abilities, the common
// actions and the things thrown from the pack. Same 16x16 grid, palette and
// outline as the gear in itemArt.ts, which merges this table into its own,
// so admin overrides and the icon editor cover these too.
//
// Abilities share a handful of drawings (a slash, a shield, a bolt, a
// flame); which drawing and which accent colour each one gets is chosen in
// zone/actionIcons.ts. The accent paints the part that says what it is: the
// spark off a blade, the glow of a bolt, the liquid in a flask.

import { C, spans, type Art } from "./artKit";

const K = {
  ember: "#f08a24",
  flame: "#ffd23f",
  light: "#ffe9a8",
  leaf: "#4f8a3a",
  leafLit: "#6fae4a",
  skin: "#e0b08a",
  skinDark: "#b98562",
  glass: "#cfe6ee",
  drowned: "#b8c2a6",
  drownedDark: "#8a9580",
  paperDark: "#b8a77f",
};

export const ACTION_ART: Record<string, Art> = {
  // ---- blows ----
  "act-slash": (p) => {
    p.l(3, 12, 11, 4, C.steel);
    p.l(4, 12, 12, 4, C.shine);
    p.l(1, 10, 5, 14, C.gold);
    p.l(1, 13, 2, 14, C.bark);
    p.r(12, 1, 2, 2, p.accent);
    p.r(14, 4, 1, 1, p.accent);
    p.r(10, 1, 1, 1, p.accent);
  },
  "act-heavy": (p) => {
    p.r(7, 6, 2, 7, C.wood);
    p.r(3, 1, 10, 5, C.iron);
    p.r(4, 2, 8, 1, C.steel);
    p.r(7, 3, 2, 2, p.accent);
    p.r(1, 14, 14, 1, p.accent);
    p.r(2, 12, 1, 2, p.accent);
    p.r(13, 12, 1, 2, p.accent);
  },
  "act-cleave": (p) => {
    p.l(1, 9, 4, 4, p.accent);
    p.l(4, 4, 11, 4, p.accent);
    p.l(11, 4, 14, 9, p.accent);
    p.l(2, 10, 5, 5, p.shade);
    p.l(5, 5, 10, 5, p.shade);
    p.l(10, 5, 13, 10, p.shade);
    p.r(7, 8, 2, 6, C.steel);
    p.r(7, 8, 1, 6, C.shine);
    p.r(6, 14, 4, 1, C.gold);
  },
  "act-dagger": (p) => {
    p.l(12, 1, 6, 7, C.steel);
    p.l(13, 2, 7, 8, C.shine);
    p.l(4, 6, 8, 10, C.gold);
    p.l(4, 10, 2, 12, C.bark);
    p.l(5, 11, 3, 13, C.bark);
    p.r(11, 10, 2, 2, p.accent);
    p.r(12, 12, 1, 2, p.accent);
  },
  "act-flurry": (p) => {
    p.l(1, 6, 6, 1, C.steel);
    p.l(4, 10, 10, 4, C.shine);
    p.l(8, 14, 14, 8, C.steel);
    p.r(7, 1, 1, 1, p.accent);
    p.r(11, 3, 2, 1, p.accent);
    p.r(14, 6, 1, 2, p.accent);
    p.r(2, 9, 1, 2, p.accent);
  },
  "act-fist": (p) => {
    spans(p, K.skin, [[4, 4, 11], [5, 3, 12], [6, 3, 12], [7, 3, 12], [8, 3, 12], [9, 4, 12], [10, 5, 11]]);
    p.r(5, 4, 1, 3, K.skinDark);
    p.r(7, 4, 1, 3, K.skinDark);
    p.r(9, 4, 1, 3, K.skinDark);
    p.r(6, 11, 5, 3, p.accent);
  },
  "act-hook": (p) => {
    p.r(8, 2, 1, 9, C.steel);
    p.l(8, 11, 6, 13, C.steel);
    p.l(6, 13, 4, 11, C.steel);
    p.r(4, 8, 1, 3, C.steel);
    p.r(5, 8, 1, 1, C.shine);
    p.r(7, 1, 3, 1, C.gold);
    p.r(10, 4, 3, 1, p.accent);
    p.r(11, 6, 3, 1, p.accent);
  },
  "act-quake": (p) => {
    p.r(1, 13, 14, 1, C.bark);
    p.l(2, 11, 6, 7, p.accent);
    p.l(6, 7, 9, 7, p.accent);
    p.l(9, 7, 13, 11, p.accent);
    p.l(4, 12, 7, 10, p.shade);
    p.l(8, 10, 11, 12, p.shade);
    p.r(7, 2, 2, 4, C.iron);
    p.r(6, 1, 4, 2, C.steel);
  },
  // ---- guards and shouts ----
  "act-shield": (p) => {
    spans(p, p.accent, [[2, 3, 12], [3, 3, 12], [4, 3, 12], [5, 3, 12], [6, 3, 12], [7, 3, 12], [8, 4, 11], [9, 4, 11], [10, 5, 10], [11, 6, 9], [12, 7, 8]]);
    p.r(3, 2, 2, 7, p.shade);
    p.r(7, 2, 2, 11, C.gold);
    p.r(3, 5, 10, 2, C.gold);
  },
  "act-shout": (p) => {
    spans(p, C.gold, [[5, 6, 7], [6, 5, 8], [7, 3, 9], [8, 3, 9], [9, 5, 8], [10, 6, 7]]);
    p.r(1, 7, 2, 2, C.bark);
    p.l(11, 3, 13, 5, p.accent);
    p.r(11, 7, 4, 1, p.accent);
    p.r(11, 8, 4, 1, p.shade);
    p.l(11, 12, 13, 10, p.accent);
  },
  "act-beam": (p) => {
    p.r(1, 6, 4, 4, C.gold);
    p.r(2, 5, 2, 1, C.bark);
    p.r(2, 10, 2, 3, C.bark);
    spans(p, K.light, [[4, 13, 14], [5, 10, 14], [6, 7, 14], [7, 5, 14], [8, 5, 14], [9, 7, 14], [10, 10, 14], [11, 13, 14]]);
    spans(p, p.accent, [[7, 5, 9], [8, 5, 9]]);
  },
  "act-bell": (p) => {
    p.r(7, 1, 2, 2, C.bark);
    spans(p, C.gold, [[3, 7, 8], [4, 6, 9], [5, 5, 10], [6, 5, 10], [7, 5, 10], [8, 4, 11], [9, 4, 11], [10, 3, 12]]);
    p.r(5, 5, 1, 4, C.shine);
    p.r(7, 11, 2, 2, p.accent);
    p.r(13, 4, 2, 1, p.accent);
    p.r(1, 4, 2, 1, p.accent);
  },
  // ---- shots ----
  "act-bow": (p) => {
    p.l(5, 1, 2, 5, C.wood);
    p.l(2, 5, 2, 10, C.wood);
    p.l(2, 10, 5, 14, C.wood);
    p.l(5, 1, 5, 14, C.paper);
    p.r(5, 7, 9, 1, C.bark);
    p.r(13, 6, 2, 3, C.steel);
    p.r(6, 6, 2, 1, p.accent);
    p.r(6, 8, 2, 1, p.accent);
  },
  // ---- magic ----
  "act-fire": (p) => {
    spans(p, K.ember, [[2, 8, 8], [3, 7, 9], [4, 7, 9], [5, 6, 10], [6, 5, 10], [7, 4, 11], [8, 4, 11], [9, 4, 11], [10, 4, 11], [11, 5, 10], [12, 6, 9]]);
    spans(p, K.flame, [[6, 7, 8], [7, 7, 9], [8, 6, 9], [9, 6, 9], [10, 6, 9], [11, 7, 8]]);
    p.r(7, 9, 2, 2, p.accent);
  },
  "act-meteor": (p) => {
    p.l(1, 1, 7, 7, K.ember);
    p.l(3, 1, 9, 7, K.flame);
    p.l(1, 3, 7, 9, p.accent);
    spans(p, C.iron, [[7, 9, 12], [8, 8, 13], [9, 8, 13], [10, 8, 13], [11, 9, 12], [12, 10, 11]]);
    p.r(10, 9, 2, 2, C.steel);
    p.r(9, 11, 1, 1, C.dark);
  },
  "act-bolt": (p) => {
    p.l(1, 13, 7, 9, p.shade);
    p.l(1, 11, 6, 8, p.accent);
    p.l(3, 14, 8, 11, p.accent);
    spans(p, p.accent, [[4, 9, 11], [5, 8, 12], [6, 7, 13], [7, 7, 13], [8, 7, 13], [9, 8, 12], [10, 9, 11]]);
    p.r(9, 6, 2, 2, C.shine);
  },
  "act-spark": (p) => {
    p.l(9, 1, 4, 8, K.flame);
    p.l(10, 1, 5, 8, K.flame);
    p.r(5, 7, 6, 1, K.flame);
    p.r(5, 8, 6, 1, p.accent);
    p.l(10, 8, 6, 14, K.flame);
    p.l(11, 8, 7, 14, p.accent);
    p.r(13, 3, 1, 2, p.accent);
    p.r(2, 11, 1, 2, p.accent);
  },
  "act-heal": (p) => {
    p.r(6, 3, 4, 10, p.accent);
    p.r(3, 6, 10, 4, p.accent);
    p.r(6, 3, 1, 10, p.shade);
    p.r(3, 9, 10, 1, p.shade);
    p.r(8, 4, 1, 3, C.shine);
    p.r(13, 2, 1, 1, C.shine);
    p.r(2, 13, 1, 1, C.shine);
  },
  "act-thorn": (p) => {
    p.l(3, 14, 6, 10, K.leaf);
    p.l(6, 10, 5, 6, K.leaf);
    p.l(5, 6, 9, 2, K.leafLit);
    p.l(10, 14, 12, 9, K.leaf);
    p.l(12, 9, 11, 5, K.leafLit);
    p.r(7, 8, 2, 1, K.leafLit);
    p.r(3, 7, 2, 1, K.leafLit);
    p.r(13, 11, 2, 1, K.leafLit);
    p.r(9, 1, 3, 2, p.accent);
    p.r(11, 3, 2, 2, p.accent);
  },
  "act-wave": (p) => {
    spans(p, p.accent, [[5, 3, 5], [6, 2, 7], [7, 1, 8], [8, 1, 9], [9, 1, 13], [10, 2, 14], [11, 3, 14], [12, 5, 14]]);
    p.r(3, 4, 3, 1, C.shine);
    p.r(6, 5, 2, 1, C.shine);
    p.r(8, 7, 1, 1, C.shine);
    p.l(4, 11, 12, 11, p.shade);
  },
  "act-skull": (p) => {
    spans(p, C.bone, [[2, 5, 10], [3, 4, 11], [4, 3, 12], [5, 3, 12], [6, 3, 12], [7, 4, 11], [8, 5, 10], [9, 5, 10]]);
    p.r(5, 5, 2, 2, C.dark);
    p.r(9, 5, 2, 2, C.dark);
    p.r(7, 8, 1, 2, C.dark);
    p.r(9, 8, 1, 2, C.dark);
    p.r(3, 11, 2, 3, p.accent);
    p.r(7, 12, 2, 2, p.accent);
    p.r(11, 11, 2, 3, p.accent);
  },
  "act-drain": (p) => {
    spans(p, p.accent, [[3, 3, 5], [3, 9, 11], [4, 2, 6], [4, 8, 12], [5, 2, 12], [6, 2, 12], [7, 3, 11], [8, 4, 10], [9, 5, 9], [10, 6, 8], [11, 7, 7]]);
    p.r(3, 4, 2, 2, C.shine);
    p.l(12, 13, 14, 11, C.bone);
    p.l(10, 14, 13, 14, C.bone);
  },
  "act-note": (p) => {
    p.r(9, 2, 2, 10, p.accent);
    p.r(11, 2, 3, 2, p.accent);
    p.r(13, 4, 1, 2, p.accent);
    spans(p, p.accent, [[10, 5, 9], [11, 4, 10], [12, 4, 10], [13, 5, 9]]);
    p.r(5, 11, 2, 1, C.shine);
    p.r(2, 4, 2, 1, p.shade);
    p.r(3, 7, 2, 1, p.shade);
  },
  // ---- the Bard's songs: each its own picture, not just a note in another colour ----
  /** Lively Shanty: a tankard raised, its head frothing over, and a note springing off it. */
  "act-shanty-lively": (p) => {
    spans(p, C.bone, [[4, 3, 8], [5, 2, 9], [6, 2, 9]]);
    p.r(3, 3, 2, 1, C.bone);
    p.r(7, 3, 1, 1, C.bone);
    p.r(2, 7, 1, 2, C.bone);
    spans(p, C.wood, [[7, 3, 9], [8, 3, 9], [9, 3, 9], [10, 3, 9], [11, 3, 9], [12, 3, 9], [13, 3, 9], [14, 3, 9]]);
    p.r(3, 9, 7, 1, C.iron);
    p.r(3, 13, 7, 1, C.iron);
    p.r(4, 7, 1, 7, C.leather);
    p.r(10, 8, 2, 1, C.bark);
    p.r(11, 9, 1, 3, C.bark);
    p.r(10, 12, 2, 1, C.bark);
    p.r(13, 1, 1, 5, p.accent);
    p.r(14, 1, 2, 1, p.accent);
    p.r(15, 2, 1, 1, p.accent);
    p.r(11, 5, 3, 2, p.accent);
  },
  /** Dour Shanty: a heavy anchor, its ring and flukes in the song's colour. */
  "act-shanty-dour": (p) => {
    spans(p, p.accent, [[1, 6, 9], [2, 5, 5], [2, 10, 10], [3, 6, 9]]);
    p.r(7, 4, 2, 9, C.iron);
    p.r(8, 4, 1, 9, C.steel);
    p.r(4, 5, 8, 2, C.iron);
    p.r(4, 5, 8, 1, C.steel);
    spans(p, C.iron, [[11, 2, 3], [11, 12, 13], [12, 3, 4], [12, 11, 12], [13, 4, 11], [14, 6, 9]]);
    p.r(1, 9, 2, 2, p.accent);
    p.r(13, 9, 2, 2, p.accent);
  },
  /** Wind-god's Shanty: a cloud with a face, cheeks puffed, blowing gusts off to the side. */
  "act-shanty-wind": (p) => {
    spans(p, C.shine, [[3, 3, 6], [4, 2, 8], [5, 1, 9], [6, 1, 9], [7, 1, 9], [8, 1, 9], [9, 2, 8], [10, 3, 7]]);
    p.r(3, 5, 1, 1, C.dark);
    p.r(6, 5, 1, 1, C.dark);
    p.r(2, 7, 2, 1, C.paper);
    p.r(9, 7, 1, 1, C.dark);
    p.r(11, 5, 4, 1, p.accent);
    p.r(14, 4, 1, 1, p.accent);
    p.r(11, 7, 5, 1, p.accent);
    p.r(11, 9, 3, 1, p.accent);
    p.r(13, 10, 1, 1, p.accent);
    p.r(3, 12, 6, 1, p.shade);
    p.r(5, 14, 7, 1, p.shade);
  },
  /** Chorus: three notes rising together, many voices at once. */
  "act-chorus": (p) => {
    for (const [x, y] of [[1, 9], [6, 5], [11, 1]] as const) {
      p.r(x + 2, y, 1, 5, p.accent);
      p.r(x + 3, y, 1, 1, p.accent);
      p.r(x + 4, y + 1, 1, 1, p.accent);
      spans(p, p.accent, [[y + 5, x, x + 2], [y + 6, x, x + 2]]);
      p.r(x, y + 5, 1, 1, C.shine);
    }
    // Voices rising off the lowest.
    p.r(6, 13, 2, 1, p.shade);
    p.r(10, 11, 2, 1, p.shade);
  },
  // ---- the Sage's stars ----
  /** Falling Star: a star coming down out of the top corner, its trail behind it. */
  "act-falling-star": (p) => {
    p.l(8, 7, 14, 1, p.accent);
    p.l(7, 7, 13, 1, p.shade);
    p.l(8, 8, 15, 1, p.shade);
    p.r(5, 6, 1, 9, p.accent);
    p.r(1, 10, 9, 1, p.accent);
    p.r(4, 9, 3, 3, p.accent);
    for (const [x, y] of [[3, 8], [7, 8], [3, 12], [7, 12]] as const) p.r(x, y, 1, 1, p.shade);
    p.r(5, 10, 1, 1, C.shine);
  },
  /** Constellation: stars joined one to the next by lines of light. */
  "act-constellation": (p) => {
    const stars = [[2, 13], [6, 9], [10, 11], [13, 5], [7, 3]] as const;
    for (let i = 1; i < stars.length; i++) p.l(stars[i - 1][0], stars[i - 1][1], stars[i][0], stars[i][1], p.shade);
    for (const [x, y] of stars) {
      p.r(x - 1, y, 3, 1, p.accent);
      p.r(x, y - 1, 1, 3, p.accent);
      p.r(x, y, 1, 1, C.shine);
    }
  },
  /** New Moon: a dark disc with only a thin rim of light left on it. */
  "act-new-moon": (p) => {
    const disc: [number, number, number][] = [[2, 6, 10], [3, 4, 12], [4, 3, 13], [5, 3, 13], [6, 2, 14], [7, 2, 14], [8, 2, 14], [9, 2, 14], [10, 2, 14], [11, 3, 13], [12, 3, 13], [13, 4, 12], [14, 6, 10]];
    spans(p, C.dark, disc);
    for (const [y, x0] of disc) p.r(x0, y, 1, 1, p.accent);
    p.r(6, 2, 5, 1, p.accent);
    p.r(4, 3, 2, 1, p.shade);
    p.r(14, 2, 1, 1, C.shine);
    p.r(1, 14, 1, 1, C.shine);
  },
  /** Chart a Course: a chart, a dotted way across it, and a red X where it ends. */
  "act-chart": (p) => {
    p.r(1, 2, 14, 12, C.paper);
    p.r(1, 13, 14, 1, C.leather);
    p.r(1, 2, 1, 12, C.leather);
    for (const [x, y] of [[3, 11], [5, 10], [7, 10], [8, 8], [9, 7]] as const) p.r(x, y, 1, 1, C.bark);
    p.l(10, 3, 13, 6, p.accent);
    p.l(11, 3, 14, 6, p.accent);
    p.l(13, 3, 10, 6, p.accent);
    p.l(14, 3, 11, 6, p.accent);
  },
  /** North Star: a compass star, its long point down. */
  "act-north-star": (p) => {
    p.r(7, 0, 1, 15, p.accent);
    p.r(1, 6, 13, 1, p.accent);
    p.r(6, 3, 3, 7, p.accent);
    p.r(4, 5, 7, 3, p.accent);
    for (const [x, y] of [[4, 3], [10, 3], [4, 9], [10, 9]] as const) p.r(x, y, 1, 1, p.shade);
    p.r(7, 6, 1, 1, C.shine);
  },
  // ---- class abilities: each its own picture ----
  /** Beacon Aura: a lantern blazing, its light thrown out all round. */
  "act-beacon": (p) => {
    p.r(7, 1, 2, 1, C.iron);
    spans(p, C.iron, [[2, 5, 10], [3, 6, 9], [10, 5, 10], [11, 6, 9]]);
    p.r(6, 4, 4, 6, p.accent);
    p.r(5, 4, 1, 6, C.iron);
    p.r(10, 4, 1, 6, C.iron);
    p.r(7, 6, 2, 2, K.flame);
    p.r(1, 7, 3, 1, p.accent);
    p.r(12, 7, 3, 1, p.accent);
    p.l(1, 3, 3, 5, p.accent);
    p.l(14, 3, 12, 5, p.accent);
    p.l(1, 12, 3, 10, p.accent);
    p.l(14, 12, 12, 10, p.accent);
    p.r(7, 13, 2, 2, p.shade);
  },
  /** Healing Aura: a cross with a ring of light round it. */
  "act-healing-aura": (p) => {
    p.r(7, 4, 2, 8, p.accent);
    p.r(4, 7, 8, 2, p.accent);
    p.r(7, 4, 1, 2, C.shine);
    for (const [x, y] of [[7, 0], [8, 0], [0, 7], [0, 8], [15, 7], [15, 8], [7, 15], [8, 15]] as const) p.r(x, y, 1, 1, p.accent);
    for (const [x, y] of [[3, 2], [12, 2], [2, 3], [13, 3], [2, 12], [13, 12], [3, 13], [12, 13]] as const) p.r(x, y, 1, 1, p.shade);
  },
  /** Branding Strike: a branding iron, its sigil glowing hot. */
  "act-brand": (p) => {
    p.l(1, 14, 5, 10, C.wood);
    p.l(2, 14, 6, 10, C.bark);
    p.l(6, 9, 8, 7, C.iron);
    p.r(8, 1, 6, 6, p.accent);
    p.r(8, 1, 6, 1, p.shade);
    p.r(10, 2, 2, 4, K.flame);
    p.r(9, 3, 4, 2, K.flame);
    p.r(10, 3, 2, 2, C.shine);
    p.r(15, 3, 1, 1, p.accent);
    p.r(7, 0, 1, 1, p.accent);
  },
  /** Stoke the Fire: a campfire roaring up off its logs, throwing sparks. */
  "act-stoke": (p) => {
    p.l(2, 14, 13, 11, C.wood);
    p.l(2, 11, 13, 14, C.bark);
    spans(p, K.ember, [[2, 7, 8], [3, 6, 9], [4, 5, 10], [5, 4, 10], [6, 4, 11], [7, 3, 11], [8, 3, 12], [9, 4, 11], [10, 5, 10]]);
    spans(p, p.accent, [[5, 7, 8], [6, 6, 9], [7, 6, 9], [8, 6, 9], [9, 7, 8]]);
    p.r(7, 8, 2, 2, K.flame);
    for (const [x, y] of [[2, 3], [13, 1], [12, 4], [1, 7], [14, 8]] as const) p.r(x, y, 1, 1, K.flame);
  },
  /** Bolster: a shield inside a dome of light. */
  "act-bolster": (p) => {
    spans(p, p.accent, [[1, 5, 10]]);
    for (const [x, y] of [[3, 2], [4, 2], [11, 2], [12, 2], [2, 3], [13, 3]] as const) p.r(x, y, 1, 1, p.accent);
    p.r(1, 4, 1, 8, p.accent);
    p.r(14, 4, 1, 8, p.accent);
    p.r(2, 12, 1, 1, p.accent);
    p.r(13, 12, 1, 1, p.accent);
    p.r(1, 14, 14, 1, p.shade);
    spans(p, C.steel, [[4, 5, 10], [5, 5, 10], [6, 5, 10], [7, 5, 10], [8, 6, 9], [9, 6, 9], [10, 7, 8]]);
    p.r(5, 4, 1, 4, C.iron);
    p.r(7, 5, 2, 3, C.gold);
    p.r(3, 4, 1, 2, C.shine);
  },
  /** Show the Way: a signpost pointing on, the path marked beyond it. */
  "act-signpost": (p) => {
    p.r(4, 2, 2, 13, C.wood);
    p.r(4, 2, 1, 13, C.bark);
    spans(p, p.accent, [[3, 3, 11], [4, 3, 12], [5, 3, 13], [6, 3, 12], [7, 3, 11]]);
    p.r(5, 5, 5, 1, p.shade);
    p.r(2, 14, 6, 1, C.bark);
    for (const [x, y] of [[9, 12], [11, 11], [13, 10]] as const) p.r(x, y, 1, 1, p.accent);
  },
  /** Soothing Rain: a soft cloud letting down its rain. */
  "act-rain": (p) => {
    spans(p, C.steel, [[2, 5, 9], [3, 4, 11], [4, 2, 12], [5, 1, 13], [6, 1, 13], [7, 2, 12]]);
    p.r(5, 2, 4, 1, C.shine);
    p.r(2, 7, 11, 1, C.iron);
    for (const [x, y] of [[3, 9], [6, 10], [9, 9], [12, 10], [4, 13], [10, 13], [7, 14]] as const) p.r(x, y, 1, 2, p.accent);
  },
  /** Chain Lightning: one bolt leaping from orb to orb. */
  "act-chain-lightning": (p) => {
    for (const dx of [0, 1]) {
      p.l(3 + dx, 11, 6 + dx, 8, K.flame);
      p.r(4 + dx, 8, 3, 1, K.flame);
      p.l(4 + dx, 8, 7 + dx, 5, K.flame);
      p.l(9 + dx, 5, 11 + dx, 7, K.flame);
      p.r(9 + dx, 8, 3, 1, K.flame);
      p.l(10 + dx, 8, 12 + dx, 10, K.flame);
    }
    for (const [x, y] of [[1, 12], [7, 2], [12, 11]] as const) {
      p.r(x, y, 3, 3, p.accent);
      p.r(x + 1, y + 1, 1, 1, C.shine);
    }
  },
  /** Roar of Thunder: a thunderhead, a bolt out of it and the crack ringing off. */
  "act-thunder": (p) => {
    spans(p, C.iron, [[1, 4, 8], [2, 2, 10], [3, 1, 11], [4, 1, 11], [5, 2, 10]]);
    p.r(4, 1, 3, 1, C.steel);
    p.l(6, 6, 4, 9, p.accent);
    p.r(4, 9, 4, 1, p.accent);
    p.l(7, 10, 5, 14, p.accent);
    p.r(12, 8, 1, 3, p.shade);
    p.r(11, 7, 1, 1, p.shade);
    p.r(11, 11, 1, 1, p.shade);
    p.r(14, 7, 1, 5, p.accent);
    p.r(13, 6, 1, 1, p.accent);
    p.r(13, 12, 1, 1, p.accent);
  },
  /** Trade Winds: gusts curling as they blow. */
  "act-winds": (p) => {
    const gust = (x0: number, x1: number, y: number, color: string) => {
      p.r(x0, y, x1 - x0 + 1, 1, color);
      for (const [dx, dy] of [[1, -1], [2, -2], [1, -3], [0, -2]] as const) p.r(x1 + dx, y + dy, 1, 1, color);
    };
    gust(1, 8, 5, p.accent);
    gust(3, 11, 10, C.shine);
    gust(1, 7, 14, p.accent);
    p.r(13, 13, 2, 1, p.shade);
    p.r(12, 4, 2, 1, p.shade);
  },
  /** Tidal Wave: a wall of water rearing up to break. */
  "act-tidal": (p) => {
    spans(p, p.accent, [[2, 7, 13], [3, 5, 14], [4, 4, 8], [5, 3, 7], [6, 2, 7], [7, 2, 8], [8, 1, 9], [9, 1, 10], [10, 1, 12], [11, 0, 14], [12, 0, 15]]);
    p.r(7, 2, 7, 1, C.shine);
    p.r(12, 4, 2, 1, C.shine);
    p.r(13, 5, 1, 1, C.shine);
    p.l(8, 5, 8, 8, p.shade);
    p.l(9, 7, 11, 9, p.shade);
    p.r(0, 13, 16, 1, p.shade);
  },
  /** Smuggler's Route: off a crate and away along a hidden way, to a spot marked below. */
  "act-route": (p) => {
    p.r(1, 10, 4, 4, C.wood);
    p.r(1, 10, 4, 1, C.bark);
    p.l(1, 13, 4, 10, C.bark);
    for (const [x, y] of [[4, 7], [5, 5], [7, 3], [9, 3], [11, 4]] as const) p.r(x, y, 1, 1, p.accent);
    p.r(12, 6, 1, 3, p.accent);
    p.r(11, 7, 3, 1, p.accent);
    p.r(10, 6, 1, 1, p.accent);
    p.r(14, 6, 1, 1, p.accent);
    p.r(10, 12, 5, 1, p.shade);
    p.r(9, 11, 1, 1, p.shade);
    p.r(15, 11, 1, 1, p.shade);
  },
  /** Sneak: a hood pulled low, only the eyes showing. */
  "act-sneak": (p) => {
    spans(p, p.accent, [[1, 6, 9], [2, 5, 10], [3, 4, 11], [4, 3, 12], [5, 3, 12], [6, 3, 12], [7, 3, 12], [8, 3, 12], [9, 3, 12], [10, 2, 13], [11, 2, 13], [12, 1, 14], [13, 1, 14], [14, 1, 14]]);
    spans(p, C.dark, [[4, 6, 9], [5, 5, 10], [6, 5, 10], [7, 5, 10], [8, 6, 9]]);
    p.r(6, 6, 1, 1, K.flame);
    p.r(9, 6, 1, 1, K.flame);
    p.l(4, 10, 3, 14, p.shade);
    p.l(11, 10, 12, 14, p.shade);
  },
  /** Pickpocket: a purse lifted, coins spilling off it. */
  "act-pickpocket": (p) => {
    spans(p, C.leather, [[3, 5, 6], [3, 9, 10], [4, 6, 9], [6, 5, 10], [7, 4, 11], [8, 3, 12], [9, 3, 12], [10, 3, 12], [11, 3, 12], [12, 4, 11], [13, 5, 10]]);
    p.r(5, 5, 6, 1, C.bark);
    p.r(4, 8, 1, 4, C.hide);
    p.r(7, 9, 2, 2, p.accent);
    p.r(12, 1, 2, 2, p.accent);
    p.r(12, 1, 1, 1, C.shine);
    p.r(14, 4, 1, 1, p.accent);
    p.r(1, 2, 2, 2, p.accent);
    p.r(1, 2, 1, 1, C.shine);
  },
  /** Tactical Retreat: a strike, and straight back the way you came. */
  "act-retreat": (p) => {
    p.r(5, 3, 8, 2, p.accent);
    p.r(12, 5, 2, 4, p.accent);
    p.r(13, 4, 1, 1, p.accent);
    p.r(6, 9, 7, 2, p.accent);
    p.r(12, 9, 1, 1, p.accent);
    spans(p, p.accent, [[7, 5, 5], [8, 4, 5], [9, 3, 5], [10, 3, 5], [11, 4, 5], [12, 5, 5]]);
    p.r(6, 11, 7, 1, p.shade);
    p.l(1, 1, 3, 3, C.steel);
    p.r(1, 4, 1, 1, C.gold);
  },
  /** Contraband: a crate with a bomb in it, its fuse already lit. */
  "act-contraband": (p) => {
    spans(p, C.iron, [[3, 6, 10], [4, 5, 11], [5, 5, 11], [6, 5, 11]]);
    p.r(6, 4, 1, 1, C.steel);
    p.r(10, 2, 1, 1, C.bark);
    p.r(11, 1, 1, 1, C.bark);
    p.r(12, 0, 1, 1, p.accent);
    p.r(13, 1, 1, 1, K.flame);
    p.r(2, 7, 12, 8, C.wood);
    for (const y of [7, 10, 14]) p.r(2, y, 12, 1, C.bark);
    p.r(2, 7, 1, 8, C.bark);
    p.r(13, 7, 1, 8, C.bark);
    p.r(6, 12, 4, 1, p.accent);
  },
  /** Coral Field: coral branching up off the rock. */
  "act-coral": (p) => {
    p.r(7, 8, 2, 7, p.accent);
    p.l(7, 9, 4, 6, p.accent);
    p.r(3, 2, 2, 5, p.accent);
    p.l(8, 8, 11, 5, p.accent);
    p.r(11, 1, 2, 5, p.accent);
    p.r(7, 4, 1, 4, p.accent);
    p.r(1, 4, 2, 1, p.accent);
    p.r(13, 3, 2, 1, p.accent);
    p.r(5, 4, 1, 1, p.accent);
    p.r(8, 9, 1, 6, p.shade);
    p.r(4, 3, 1, 4, p.shade);
    p.r(12, 2, 1, 4, p.shade);
    for (const [x, y] of [[3, 2], [11, 1], [7, 4]] as const) p.r(x, y, 1, 1, C.shine);
    p.r(4, 14, 8, 1, C.iron);
  },
  /** Aqueous Regeneration: a drop of water with healing in it. */
  "act-droplet": (p) => {
    spans(p, p.accent, [[1, 7, 8], [2, 7, 8], [3, 6, 9], [4, 6, 9], [5, 5, 10], [6, 4, 11], [7, 3, 12], [8, 3, 12], [9, 3, 12], [10, 3, 12], [11, 4, 11], [12, 5, 10], [13, 6, 9]]);
    p.r(11, 8, 1, 3, p.shade);
    p.r(7, 6, 2, 6, C.shine);
    p.r(5, 8, 6, 2, C.shine);
    p.r(13, 2, 1, 1, C.shine);
    p.r(2, 4, 1, 1, C.shine);
  },
  /** Coral Armor: a scallop shell, ribbed and hard. */
  "act-shell": (p) => {
    spans(p, p.accent, [[2, 5, 10], [3, 3, 12], [4, 2, 13], [5, 1, 14], [6, 1, 14], [7, 1, 14], [8, 2, 13], [9, 3, 12], [10, 4, 11], [11, 5, 10]]);
    p.l(7, 11, 2, 5, p.shade);
    p.l(7, 11, 5, 3, p.shade);
    p.l(8, 11, 10, 3, p.shade);
    p.l(8, 11, 13, 5, p.shade);
    p.r(6, 2, 4, 1, C.shine);
    p.r(5, 12, 6, 2, p.accent);
    p.r(5, 13, 6, 1, p.shade);
  },
  /** Revitalizing Splash: water bursting up in a crown, healing in its spray. */
  "act-splash": (p) => {
    spans(p, p.accent, [[12, 2, 13], [13, 1, 14], [14, 3, 12]]);
    p.r(4, 8, 2, 4, p.accent);
    p.r(7, 6, 2, 6, p.accent);
    p.r(10, 8, 2, 4, p.accent);
    for (const [x, y, h] of [[3, 5, 2], [12, 5, 2], [1, 8, 1], [14, 8, 1]] as const) p.r(x, y, 1, h, p.accent);
    p.r(7, 2, 2, 2, p.accent);
    p.r(7, 6, 1, 3, C.shine);
    p.r(4, 12, 8, 1, C.shine);
    p.r(13, 0, 1, 3, C.shine);
    p.r(12, 1, 3, 1, C.shine);
  },
  /** Summon Sea Turtle: a sea turtle, head up, coming ashore. */
  "act-turtle": (p) => {
    const skin = "#a8d88c";
    spans(p, p.accent, [[4, 5, 10], [5, 3, 12], [6, 2, 13], [7, 2, 13], [8, 2, 13]]);
    p.r(6, 5, 1, 3, p.shade);
    p.r(9, 5, 1, 3, p.shade);
    p.r(3, 7, 10, 1, p.shade);
    p.r(6, 4, 3, 1, C.shine);
    p.r(2, 9, 12, 1, C.paper);
    spans(p, skin, [[6, 13, 14], [7, 13, 15], [8, 13, 15], [9, 14, 15]]);
    p.r(14, 7, 1, 1, C.dark);
    p.r(3, 10, 2, 2, skin);
    p.r(10, 10, 2, 2, skin);
    p.r(1, 8, 1, 1, skin);
  },
  /** Lead by Example: a banner raised high, a star on it. */
  "act-banner": (p) => {
    p.r(3, 1, 1, 14, C.wood);
    p.r(3, 0, 1, 1, C.gold);
    spans(p, p.accent, [[2, 4, 12], [3, 4, 13], [4, 4, 13], [5, 4, 11], [6, 4, 10], [7, 4, 11], [8, 4, 13], [9, 4, 12]]);
    p.r(4, 2, 1, 8, p.shade);
    p.r(7, 5, 3, 1, C.shine);
    p.r(8, 4, 1, 3, C.shine);
    p.r(1, 15, 5, 1, C.bark);
  },
  /** Against the Waves: a shield held up as a wave breaks white over it. */
  "act-breakwater": (p) => {
    spans(p, C.steel, [[5, 4, 11], [6, 4, 11], [7, 4, 11], [8, 4, 11], [9, 5, 10], [10, 5, 10], [11, 6, 9], [12, 7, 8]]);
    p.r(7, 5, 2, 7, C.gold);
    p.r(4, 5, 1, 4, C.shine);
    spans(p, p.accent, [[1, 6, 12], [2, 3, 14], [3, 1, 4], [3, 12, 15], [4, 1, 2], [4, 14, 15]]);
    p.r(9, 1, 3, 1, C.shine);
    p.r(13, 2, 1, 1, C.shine);
    spans(p, p.shade, [[13, 0, 5], [13, 10, 15], [14, 0, 15]]);
    p.r(1, 12, 2, 1, p.accent);
    p.r(13, 12, 2, 1, p.accent);
  },
  /** Overwhelm: a shoulder driving into a figure, sent back hard against a wall. */
  "act-overwhelm": (p) => {
    p.r(13, 1, 2, 14, C.iron);
    p.r(14, 1, 1, 14, C.dark);
    p.r(13, 4, 1, 1, C.steel);
    p.r(13, 10, 1, 1, C.steel);
    p.r(9, 4, 3, 3, C.bone);
    p.r(9, 7, 3, 6, p.shade);
    p.r(10, 13, 1, 2, p.shade);
    spans(p, p.accent, [[6, 2, 6], [7, 1, 7], [8, 1, 7], [9, 1, 7], [10, 2, 6]]);
    p.r(3, 7, 3, 2, C.shine);
    for (const [x, y] of [[12, 2], [12, 13], [11, 1]] as const) p.r(x, y, 1, 1, C.shine);
  },
  /** Fortify: a short wall of stone blocks, a banner of light along its top. */
  "act-fortify": (p) => {
    p.r(1, 6, 14, 9, C.iron);
    for (const y of [8, 11, 14]) p.r(1, y, 14, 1, C.dark);
    for (const [x, y] of [[5, 6], [10, 6], [3, 9], [8, 9], [13, 9], [5, 12], [10, 12]] as const) p.r(x, y, 1, 2, C.dark);
    p.r(1, 6, 14, 1, C.steel);
    for (const x of [1, 6, 11]) p.r(x, 3, 3, 3, C.iron);
    for (const x of [1, 6, 11]) p.r(x, 3, 3, 1, C.steel);
    spans(p, p.accent, [[1, 4, 12]]);
    p.r(2, 7, 2, 1, p.accent);
    p.r(12, 10, 2, 1, p.accent);
  },
  /** Bulwark Strike: a hammer swung from behind a shield, its blow glowing with the shield's light. */
  "act-bulwark": (p) => {
    spans(p, C.steel, [[6, 1, 7], [7, 1, 7], [8, 1, 7], [9, 1, 7], [10, 2, 6], [11, 2, 6], [12, 3, 5], [13, 4, 4]]);
    p.r(4, 6, 1, 7, C.gold);
    p.r(1, 8, 7, 1, C.gold);
    p.r(1, 6, 1, 3, C.shine);
    p.l(7, 13, 12, 5, C.wood);
    p.r(10, 1, 5, 4, C.iron);
    p.r(10, 1, 5, 1, C.steel);
    for (const [x, y] of [[15, 0], [9, 0], [15, 5], [8, 3]] as const) p.r(x, y, 1, 1, p.accent);
    p.r(11, 2, 3, 2, p.accent);
  },
  /** Taunt: a raised fist, a ring of red shouting out round it. */
  "act-taunt": (p) => {
    p.r(6, 5, 4, 5, C.bone);
    p.r(6, 5, 4, 1, C.shine);
    for (const x of [7, 8]) p.r(x, 6, 1, 3, C.paper);
    p.r(7, 10, 3, 5, C.bone);
    p.r(5, 7, 1, 2, C.bone);
    for (const [x, y] of [[7, 1], [8, 1], [3, 2], [12, 2], [1, 6], [14, 6], [1, 9], [14, 9], [3, 13], [12, 13]] as const) p.r(x, y, 1, 1, p.accent);
    p.l(4, 1, 2, 3, p.shade);
    p.l(11, 1, 13, 3, p.shade);
    p.r(0, 7, 2, 2, p.accent);
    p.r(14, 7, 2, 2, p.accent);
  },
  // ---- the Warlock's ----
  /** Curse of Drowning: a pale drowned hand reaching up out of the waves, bubbles rising off it. */
  "act-drown-curse": (p) => {
    p.r(6, 7, 4, 5, K.drowned);
    p.r(6, 7, 1, 5, K.drownedDark);
    p.r(5, 4, 6, 4, K.drowned);
    p.r(5, 4, 1, 4, K.drownedDark);
    p.r(5, 1, 1, 3, K.drowned);
    p.r(7, 0, 1, 4, K.drowned);
    p.r(9, 1, 1, 3, K.drowned);
    p.r(11, 4, 1, 2, K.drowned);
    spans(p, p.accent, [[11, 0, 5], [11, 10, 15], [12, 0, 15], [13, 0, 15]]);
    spans(p, p.shade, [[14, 0, 15], [15, 1, 14]]);
    p.r(1, 11, 3, 1, C.shine);
    p.r(12, 11, 3, 1, C.shine);
    for (const [x, y] of [[13, 3], [14, 1], [2, 6], [12, 6]] as const) p.r(x, y, 1, 1, C.shine);
  },
  /** Summon Sunken Sailors: a sailor's skull under a tricorn, kelp hanging off it, its eyes lit from the deep. */
  "act-sailors": (p) => {
    spans(p, C.dark, [[1, 5, 10], [2, 4, 11], [3, 1, 14], [4, 2, 13]]);
    p.r(2, 3, 12, 1, C.gold);
    spans(p, K.drowned, [[5, 4, 11], [6, 3, 12], [7, 3, 12], [8, 3, 12], [9, 4, 11], [10, 5, 10]]);
    p.r(5, 7, 2, 2, C.dark);
    p.r(9, 7, 2, 2, C.dark);
    p.r(5, 7, 1, 1, p.accent);
    p.r(10, 7, 1, 1, p.accent);
    p.r(7, 9, 2, 1, C.dark);
    p.r(5, 11, 6, 2, K.drowned);
    p.r(6, 12, 1, 1, C.dark);
    p.r(9, 12, 1, 1, C.dark);
    p.l(3, 8, 2, 15, K.leaf);
    p.l(12, 8, 13, 15, K.leaf);
    p.r(4, 13, 1, 2, K.leafLit);
  },
  /** Red Sky at Morning: a red dawn, the sun half up out of a dark sea and its light running red across the water. */
  "act-red-sky": (p) => {
    spans(p, p.shade, [[1, 2, 13], [2, 1, 14]]);
    spans(p, p.accent, [[3, 1, 14], [4, 1, 14], [5, 1, 14]]);
    spans(p, K.ember, [[6, 1, 14], [7, 1, 14], [8, 1, 14]]);
    spans(p, K.flame, [[5, 6, 9], [6, 5, 10], [7, 4, 11], [8, 4, 11]]);
    spans(p, K.light, [[6, 7, 8], [7, 6, 9]]);
    spans(p, "#24405e", [[9, 1, 14], [10, 1, 14], [11, 2, 13], [12, 2, 13], [13, 3, 12]]);
    p.r(4, 9, 8, 1, K.flame);
    p.r(6, 11, 4, 1, p.accent);
    p.r(7, 13, 2, 1, p.accent);
  },
  /** Unholy Waters: a flood of dark water, and fire bursting up out of the middle of it. */
  "act-unholy": (p) => {
    spans(p, K.ember, [[1, 7, 8], [2, 6, 8], [3, 6, 9], [4, 5, 9], [5, 5, 10], [6, 4, 10], [7, 4, 11], [8, 5, 10], [9, 5, 10]]);
    spans(p, K.flame, [[4, 7, 7], [5, 6, 8], [6, 6, 9], [7, 6, 9], [8, 7, 8]]);
    p.r(7, 7, 1, 2, K.light);
    spans(p, p.accent, [[8, 0, 3], [8, 12, 15], [9, 0, 4], [9, 11, 15], [10, 0, 15], [11, 0, 15]]);
    spans(p, p.shade, [[12, 0, 15], [13, 0, 15], [14, 1, 14]]);
    p.r(1, 8, 2, 1, C.shine);
    p.r(13, 8, 2, 1, C.shine);
    p.r(4, 12, 2, 1, C.shine);
    p.r(10, 13, 2, 1, C.shine);
  },
  /** The Black Spot: a torn scrap of a page, a round black spot daubed on it and a word scrawled under. */
  "act-black-spot": (p) => {
    spans(p, C.paper, [[2, 3, 12], [3, 2, 13], [4, 2, 13], [5, 2, 14], [6, 2, 14], [7, 1, 14], [8, 2, 14], [9, 2, 13], [10, 2, 13], [11, 3, 13], [12, 3, 12], [13, 4, 11]]);
    for (const [x, y] of [[5, 2], [9, 2], [14, 6], [1, 7], [13, 10], [7, 13]] as const) p.r(x, y, 1, 1, K.paperDark);
    p.r(2, 9, 1, 2, K.paperDark);
    spans(p, C.dark, [[4, 6, 9], [5, 5, 10], [6, 5, 10], [7, 5, 10], [8, 6, 9]]);
    p.r(6, 5, 1, 1, p.accent);
    p.r(4, 10, 3, 1, C.bark);
    p.r(8, 10, 4, 1, C.bark);
    p.r(6, 12, 3, 1, C.bark);
  },
  /** A drowned gunner's flintlock: a long iron barrel belled at the muzzle, the lock and hammer, a curved wooden butt. */
  "act-pistol": (p) => {
    p.r(4, 5, 10, 2, C.iron);
    p.r(4, 5, 10, 1, C.steel);
    p.r(14, 4, 1, 4, C.iron);
    p.r(4, 7, 6, 1, C.wood);
    p.r(3, 4, 3, 3, C.steel);
    p.r(3, 2, 1, 2, C.iron);
    spans(p, C.wood, [[7, 1, 4], [8, 1, 4], [9, 0, 3], [10, 0, 3], [11, 0, 3], [12, 0, 2]]);
    p.r(0, 13, 3, 1, C.gold);
    p.r(6, 8, 1, 2, C.iron);
    p.r(15, 3, 1, 1, p.accent);
    p.r(15, 7, 1, 1, p.accent);
  },
  // ---- the common actions ----
  "act-dash": (p) => {
    spans(p, C.leather, [[4, 8, 10], [5, 8, 10], [6, 8, 10], [7, 8, 10], [8, 8, 11], [9, 8, 13], [10, 8, 13]]);
    p.r(8, 3, 3, 1, C.hide);
    p.r(8, 11, 6, 1, C.bark);
    p.r(2, 5, 4, 1, p.accent);
    p.r(1, 8, 5, 1, p.accent);
    p.r(3, 11, 3, 1, p.accent);
  },
  "act-disengage": (p) => {
    p.l(13, 4, 6, 4, p.accent);
    p.l(6, 4, 3, 7, p.accent);
    p.l(3, 7, 3, 10, p.accent);
    p.l(3, 10, 6, 13, p.accent);
    p.l(6, 13, 10, 13, p.accent);
    p.l(13, 4, 10, 1, p.accent);
    p.l(13, 4, 10, 7, p.accent);
    p.r(11, 10, 3, 3, C.steel);
    p.r(12, 9, 1, 1, C.steel);
  },
  "act-jump": (p) => {
    p.l(2, 12, 4, 6, p.accent);
    p.l(4, 6, 8, 3, p.accent);
    p.l(8, 3, 12, 6, p.accent);
    p.l(12, 6, 13, 11, p.accent);
    p.l(13, 11, 10, 9, p.accent);
    p.l(13, 11, 15, 8, p.accent);
    p.r(0, 14, 5, 1, C.bark);
    p.r(11, 14, 5, 1, C.bark);
  },
  "act-shove": (p) => {
    spans(p, K.skin, [[6, 4, 9], [7, 4, 10], [8, 4, 10], [9, 4, 10], [10, 4, 10], [11, 5, 9], [12, 6, 8]]);
    p.r(4, 3, 1, 3, K.skin);
    p.r(6, 2, 1, 4, K.skin);
    p.r(8, 2, 1, 4, K.skin);
    p.r(10, 4, 1, 3, K.skin);
    p.r(5, 9, 4, 1, K.skinDark);
    p.r(12, 5, 3, 1, p.accent);
    p.r(13, 8, 2, 1, p.accent);
    p.r(12, 11, 3, 1, p.accent);
  },
  "act-help": (p) => {
    p.r(7, 2, 2, 8, p.accent);
    p.l(4, 5, 7, 2, p.accent);
    p.l(11, 5, 8, 2, p.accent);
    p.r(2, 12, 12, 2, C.steel);
    p.r(2, 11, 3, 1, K.skin);
  },
  "act-flee": (p) => {
    // The way out: a dark doorway, and an arrow running for it.
    p.r(9, 1, 6, 1, C.wood);
    p.r(9, 2, 1, 12, C.wood);
    p.r(14, 2, 1, 12, C.wood);
    p.r(10, 2, 4, 12, C.dark);
    p.r(1, 7, 9, 2, p.accent);
    p.l(8, 4, 11, 7, p.accent);
    p.l(8, 11, 11, 8, p.accent);
    p.r(0, 14, 16, 1, C.bark);
  },
  // ---- things thrown ----
  "item-flask": (p) => {
    p.r(7, 1, 2, 1, C.bark);
    p.r(7, 2, 2, 3, K.glass);
    spans(p, K.glass, [[5, 5, 10], [6, 4, 11], [7, 4, 11], [8, 4, 11], [9, 4, 11], [10, 4, 11], [11, 5, 10], [12, 6, 9]]);
    spans(p, p.accent, [[8, 5, 10], [9, 5, 10], [10, 5, 10], [11, 6, 9]]);
    p.r(5, 6, 1, 2, C.shine);
  },
  "item-bomb": (p) => {
    spans(p, C.dark, [[6, 6, 10], [7, 5, 11], [8, 4, 12], [9, 4, 12], [10, 4, 12], [11, 5, 11], [12, 6, 10]]);
    p.r(6, 8, 2, 1, C.iron);
    p.r(7, 5, 3, 1, C.iron);
    p.l(9, 4, 11, 2, C.bark);
    p.r(11, 1, 2, 2, p.accent);
    p.r(13, 0, 1, 1, K.flame);
  },
  "item-torch": (p) => {
    // A stick bound with pitch-soaked rag at its head, alight.
    p.l(5, 14, 9, 7, C.bark);
    p.l(6, 14, 10, 7, C.wood);
    spans(p, C.hide, [[5, 9, 12], [6, 9, 12], [7, 8, 11]]);
    spans(p, p.accent, [[1, 11, 11], [2, 10, 12], [3, 9, 13], [4, 9, 13]]);
    spans(p, K.flame, [[0, 11, 11], [2, 11, 11], [3, 10, 12]]);
  },
  "item-waterskin": (p) => {
    p.r(7, 1, 2, 1, C.bark);
    p.r(7, 2, 2, 2, C.hide);
    spans(p, C.leather, [[4, 6, 9], [5, 5, 10], [6, 4, 11], [7, 4, 11], [8, 4, 11], [9, 4, 11], [10, 5, 10], [11, 6, 9]]);
    p.l(4, 6, 2, 3, C.bark);
    p.r(7, 6, 1, 1, p.accent);
    p.r(7, 7, 2, 3, p.accent);
    p.r(5, 5, 1, 2, C.hide);
  },
};
