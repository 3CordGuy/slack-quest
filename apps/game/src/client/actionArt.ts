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
