// Pixel-art item icons, drawn in code in the same style as the character
// sprites in render/sprites.ts: a 16x16 figure in a few flat colours with a
// dark one-pixel outline, shown with nearest-neighbour scaling.
//
// Each icon is keyed by the item's `icon` name. One colour in every icon,
// the "accent", is the item's rarity colour, so a rare helm has a blue plume
// and an epic one a purple plume. Icons for things that have no rarity (pub
// fare, brews, hut furniture) live in thingArt.ts and are merged in below,
// so they go through the same lookup and admin overrides as gear.

import { parseGarbIcon, type GarbPiece } from "@gantt-quest/world";
import { C, spans, type Art, type Pen } from "./artKit";
import { ACTION_ART } from "./actionArt";
import { THING_ART } from "./thingArt";

const SIZE = 16;
/** Canvas is one pixel larger on every side to leave room for the outline. */
export const ART_PIXELS = SIZE + 2;
const OUTLINE = "#1b1830";

const ART: Record<string, Art> = {
  // ---- weapons ----
  broadsword: (p) => {
    p.r(7, 1, 2, 10, C.steel);
    p.r(7, 1, 1, 10, C.shine);
    p.r(7, 0, 1, 1, C.shine);
    p.r(4, 11, 8, 1, C.gold);
    p.r(7, 12, 2, 3, C.bark);
    p.r(7, 15, 2, 1, p.accent);
  },
  cutlass: (p) => {
    // A cutlass: a broad blade curving back to a clipped point, a brass shell and bow round a corded grip.
    spans(p, C.steel, [[0, 4, 5], [1, 4, 6], [2, 5, 7], [3, 5, 7], [4, 6, 8], [5, 6, 8], [6, 6, 8], [7, 6, 8], [8, 7, 8], [9, 7, 8]]);
    for (const [x, y] of [[4, 0], [5, 2], [6, 4], [6, 6], [7, 8]]) p.r(x, y, 1, 1, C.shine);
    p.r(4, 10, 7, 1, C.gold);
    p.r(10, 11, 1, 3, C.gold);
    p.r(7, 11, 2, 3, p.accent);
    p.r(7, 12, 2, 1, p.shade);
    p.r(7, 14, 4, 1, C.gold);
    p.r(7, 15, 2, 1, C.gold);
  },
  dirks: (p) => {
    // A pair of dirks, crossed at the guards: straight blades, a brass cross, ivory grips banded in the accent.
    p.l(3, 1, 8, 6, C.steel);
    p.l(4, 1, 9, 6, C.shine);
    p.l(12, 1, 7, 6, C.steel);
    p.l(11, 1, 6, 6, C.iron);
    p.r(5, 7, 6, 1, C.gold);
    p.l(9, 8, 12, 11, C.bone);
    p.l(6, 8, 3, 11, C.bone);
    p.r(10, 9, 1, 1, p.accent);
    p.r(5, 9, 1, 1, p.accent);
    p.r(12, 12, 1, 1, C.gold);
    p.r(3, 12, 1, 1, C.gold);
  },
  "hammer-drop": (p) => {
    p.r(7, 6, 2, 9, C.wood);
    p.r(4, 1, 8, 5, C.iron);
    p.r(5, 2, 6, 1, C.steel);
    p.r(3, 2, 1, 3, C.steel);
    p.r(12, 2, 1, 3, C.steel);
    p.r(7, 3, 2, 2, p.accent);
    p.r(7, 15, 2, 1, C.gold);
  },
  "wizard-staff": (p) => {
    // The Squall Staff: an ash staff with a rope grip, and a storm glass at its head, a brass cage round a dark
    // squall with lightning through it.
    p.r(7, 7, 2, 8, C.wood);
    p.r(8, 7, 1, 8, C.bark);
    p.r(7, 10, 2, 2, p.accent);
    p.r(7, 15, 2, 1, C.gold);
    p.r(6, 0, 4, 1, C.gold);
    p.r(5, 1, 6, 1, C.gold);
    p.r(5, 2, 1, 4, C.gold);
    p.r(10, 2, 1, 4, C.gold);
    p.r(6, 2, 4, 4, "#4c5563");
    p.r(6, 3, 2, 2, "#6f7a8a");
    for (const [x, y] of [[8, 2], [7, 3], [8, 4], [7, 5]]) p.r(x, y, 1, 1, "#e8f8ff");
    p.r(5, 6, 6, 1, C.gold);
  },
  "scroll-unfurled": (p) => {
    // A closed tome.
    p.r(3, 2, 10, 12, p.accent);
    p.r(3, 2, 2, 12, p.shade);
    p.r(5, 13, 8, 1, C.paper);
    p.r(7, 5, 4, 4, C.gold);
    p.r(8, 6, 2, 2, p.shade);
    p.r(12, 7, 1, 2, C.gold);
  },
  daggers: (p) => {
    p.l(3, 1, 8, 6, C.steel);
    p.l(4, 1, 9, 6, C.shine);
    p.l(12, 1, 7, 6, C.steel);
    p.l(11, 1, 6, 6, C.iron);
    p.r(5, 7, 6, 1, C.gold);
    p.l(9, 8, 12, 11, C.bark);
    p.l(6, 8, 3, 11, C.bark);
    p.r(12, 12, 1, 1, p.accent);
    p.r(3, 12, 1, 1, p.accent);
  },
  crossbow: (p) => {
    // A short bow with an arrow nocked.
    spans(p, C.wood, [[1, 9, 10], [2, 11, 11], [3, 12, 12], [12, 12, 12], [13, 11, 11], [14, 9, 10]]);
    p.r(12, 4, 2, 8, C.wood);
    p.r(13, 6, 1, 4, p.accent);
    p.r(8, 2, 1, 12, C.paper);
    p.r(2, 7, 11, 1, C.bark);
    spans(p, C.steel, [[6, 2, 2], [7, 1, 2], [8, 2, 2]]);
    p.r(9, 6, 2, 1, p.accent);
    p.r(9, 8, 2, 1, p.accent);
  },

  pistol: (p) => {
    // A flintlock, side on: a long iron barrel, the lock and hammer, a curved wooden butt.
    p.r(3, 5, 11, 2, C.iron);
    p.r(3, 5, 11, 1, C.steel);
    p.r(13, 4, 2, 4, C.iron);
    p.r(4, 7, 5, 1, C.wood);
    p.r(2, 3, 2, 3, C.steel);
    spans(p, C.wood, [[8, 2, 5], [9, 2, 5], [10, 1, 4], [11, 1, 4], [12, 0, 3]]);
    p.r(7, 8, 1, 2, C.iron);
    p.r(1, 12, 2, 1, p.accent);
  },
  blunderbuss: (p) => {
    // A short, fat gun with a flared brass muzzle and a stock.
    spans(p, C.gold, [[2, 11, 14], [3, 10, 14], [4, 10, 14], [5, 11, 14]]);
    p.r(14, 3, 1, 2, C.dark);
    p.r(4, 3, 7, 3, C.iron);
    p.r(4, 3, 7, 1, C.steel);
    p.r(3, 2, 2, 2, C.steel);
    spans(p, C.wood, [[6, 1, 8], [7, 0, 6], [8, 0, 3], [9, 0, 3], [10, 0, 2]]);
    p.r(7, 6, 1, 2, C.iron);
    p.r(1, 12, 3, 1, p.accent);
  },
  "harpoon-gun": (p) => {
    // A stout iron tube with a barbed harpoon standing out of it, a coil of line at its side.
    p.r(2, 7, 8, 3, C.iron);
    p.r(2, 7, 8, 1, C.steel);
    p.r(9, 8, 6, 1, C.steel);
    spans(p, C.shine, [[7, 14, 14], [8, 15, 15], [9, 14, 14]]);
    p.r(12, 6, 1, 1, C.steel);
    p.r(12, 10, 1, 1, C.steel);
    p.r(4, 10, 2, 4, C.wood);
    p.r(3, 11, 1, 3, C.wood);
    p.r(6, 11, 3, 3, C.paper);
    p.r(7, 12, 1, 1, C.bark);
    p.r(1, 14, 3, 1, p.accent);
  },

  "lantern-helm": (p) => {
    // The Lighthouse Paladin's Lantern Helm: a steel dome with a brass comb and side rivets, a band of brass rope,
    // riveted cheek guards, and a lantern burning on top.
    p.r(6, 0, 4, 1, "#c23b30");
    p.r(5, 1, 6, 1, "#c23b30");
    p.r(5, 2, 6, 1, C.gold);
    p.r(6, 3, 4, 2, "#ffd27a");
    p.r(5, 3, 1, 2, C.gold);
    p.r(10, 3, 1, 2, C.gold);
    p.r(5, 5, 6, 1, C.gold);
    spans(p, "#aeb6c2", [[6, 4, 11], [7, 3, 12], [8, 2, 13], [9, 2, 13], [10, 2, 13]]);
    p.r(4, 6, 3, 1, C.shine);
    p.r(2, 11, 12, 1, C.gold);
    p.r(2, 12, 3, 3, "#aeb6c2");
    p.r(11, 12, 3, 3, "#aeb6c2");
    p.r(5, 12, 6, 1, C.dark);
    p.r(7, 6, 2, 5, C.gold);
    for (let x = 3; x <= 13; x += 2) p.r(x, 11, 1, 1, "#a07a22");
    for (const [x, y] of [[3, 7], [2, 9], [12, 7], [13, 9], [3, 13], [12, 13]]) p.r(x, y, 1, 1, C.gold);
  },
  "knit-cap": (p) => {
    // A knitted cap with a rolled brim and a nub.
    spans(p, "#5b3f2a", [[3, 6, 9], [4, 4, 11], [5, 3, 12], [6, 3, 12], [7, 3, 12]]);
    p.r(7, 1, 1, 1, "#5b3f2a");
    p.r(2, 8, 1, 1, "#7a5a3f");
    p.r(2, 8, 12, 4, "#7a5a3f");
    p.r(2, 8, 12, 1, "#8f6c4d");
    p.r(2, 11, 12, 1, "#4a3220");
    p.r(7, 2, 2, 1, "#7a5a3f");
  },
  "naval-tunic": (p) => {
    spans(p, "#2f4562", [[2, 4, 11], [3, 3, 12], [4, 2, 13], [5, 2, 13], [6, 3, 12], [7, 3, 12], [8, 3, 12], [9, 3, 12], [10, 3, 12], [11, 3, 12]]);
    p.r(5, 2, 1, 4, "#2f4562");
    p.r(2, 2, 3, 1, "#e8edf2");
    p.r(11, 2, 3, 1, "#e8edf2");
    p.r(3, 3, 2, 1, "#e8edf2");
    p.r(11, 3, 2, 1, "#e8edf2");
    for (const y of [4, 6, 8]) p.r(8, y, 1, 1, C.gold);
    p.r(3, 9, 10, 1, C.leather);
    p.r(8, 9, 1, 1, C.gold);
  },
  "deck-boots": (p) => {
    for (const x of [2, 9]) {
      p.r(x, 3, 4, 6, "#7a5230");
      p.r(x, 9, 5, 3, "#7a5230");
      p.r(x, 12, 5, 1, C.bark);
    }
  },

  // ---- armor ----
  "root-staff": (p) => {
    // A crooked staff, roots at the top, a leaf budding.
    p.l(4, 15, 9, 4, C.wood);
    p.l(5, 15, 10, 4, C.bark);
    p.l(9, 4, 7, 1, C.wood);
    p.l(10, 4, 13, 2, C.wood);
    p.l(9, 4, 9, 1, C.bark);
    p.r(12, 1, 2, 2, "#a6d06a");
    p.r(6, 0, 2, 1, p.accent);
  },
  sickle: (p) => {
    // A curved blade on a short handle.
    p.l(3, 14, 7, 10, C.wood);
    p.l(4, 14, 8, 10, C.bark);
    spans(p, C.steel, [[2, 7, 11], [3, 11, 13], [4, 13, 14], [5, 14, 14], [6, 14, 14], [7, 13, 14], [8, 11, 13]]);
    spans(p, C.shine, [[3, 8, 10], [4, 11, 12]]);
    p.r(7, 10, 2, 1, p.accent);
  },
  lute: (p) => {
    // A round body, a long neck, the pegs bent back.
    spans(p, C.leather, [[8, 4, 9], [9, 3, 10], [10, 2, 11], [11, 2, 11], [12, 2, 11], [13, 3, 10], [14, 4, 9]]);
    p.r(6, 11, 2, 2, C.dark);
    p.l(8, 8, 13, 3, C.wood);
    p.l(9, 8, 14, 3, C.bark);
    p.r(13, 1, 2, 2, p.accent);
    p.l(5, 10, 11, 4, C.paper);
  },
  flute: (p) => {
    // A pale pipe on the slant, finger holes along it.
    p.l(2, 14, 13, 3, C.paper);
    p.l(3, 14, 14, 3, C.bone);
    p.l(2, 13, 12, 3, C.paper);
    for (const [x, y] of [[5, 11], [7, 9], [9, 7], [11, 5]]) p.r(x, y, 1, 1, C.dark);
    p.r(12, 2, 2, 2, p.accent);
  },
  accordion: (p) => {
    // A squeeze box side on: a lacquered end board each side, the pleated bellows between, keys down one board,
    // buttons on the other, and a strap over the top.
    const lacquer = "#b8333a";
    for (let x = 4; x <= 11; x++) p.r(x, 5, 1, 7, x % 2 ? "#8f8470" : C.paper);
    p.r(1, 3, 3, 11, lacquer);
    p.r(12, 3, 3, 11, lacquer);
    for (const x of [1, 12]) {
      p.r(x, 3, 3, 1, C.gold);
      p.r(x, 13, 3, 1, C.gold);
    }
    for (const y of [5, 7, 9, 11]) p.r(2, y, 1, 1, C.shine);
    p.r(13, 4, 1, 9, C.bone);
    for (const y of [5, 7, 10]) p.r(13, y, 1, 1, C.dark);
    p.r(3, 2, 10, 1, p.accent);
  },
  orb: (p) => {
    // A glowing sphere on a short haft.
    spans(p, p.accent, [[1, 6, 9], [2, 4, 11], [3, 3, 12], [4, 3, 12], [5, 3, 12], [6, 3, 12], [7, 4, 11], [8, 6, 9]]);
    p.r(5, 3, 2, 2, C.shine);
    p.r(7, 9, 2, 6, C.wood);
    p.r(6, 9, 4, 1, C.gold);
  },
  scepter: (p) => {
    // A gold rod with a jewelled head.
    p.l(4, 15, 10, 6, C.gold);
    p.l(5, 15, 11, 6, "#b8891f");
    spans(p, C.gold, [[1, 10, 13], [2, 9, 14], [3, 9, 14], [4, 10, 13], [5, 11, 12]]);
    p.r(11, 2, 2, 2, p.accent);
    p.r(11, 2, 1, 1, C.shine);
  },
  "pager-axe": (p) => {
    // A long haft on the slant and a broad bearded blade.
    p.l(3, 15, 11, 3, C.wood);
    p.l(4, 15, 12, 3, C.bark);
    spans(p, C.steel, [[1, 9, 11], [2, 7, 12], [3, 6, 11], [4, 6, 10], [5, 6, 9], [6, 7, 8]]);
    spans(p, C.shine, [[2, 7, 8], [3, 6, 7]]);
    p.r(10, 1, 2, 1, p.accent);
    p.r(3, 13, 2, 1, p.accent);
  },
  maul: (p) => {
    // A rusted anchor upside down: the eye at the bottom, a broad shank, and at the top the crown's wide arc
    // with a barbed fluke at each end. A band of the accent round the grip.
    const rust = "#7a4b34";
    p.l(3, 14, 11, 4, rust);
    p.l(4, 14, 12, 4, "#5a3626");
    p.l(3, 13, 11, 3, rust);
    spans(p, C.iron, [[12, 1, 3], [13, 1, 1], [13, 4, 4], [14, 1, 1], [15, 2, 3]]);
    spans(p, rust, [[1, 11, 12], [2, 9, 14], [3, 7, 9], [3, 14, 15], [4, 6, 7], [4, 15, 15]]);
    spans(p, "#5a3626", [[2, 5, 7], [3, 4, 6], [4, 4, 5], [5, 5, 5], [6, 5, 5], [2, 15, 15], [3, 15, 15]]);
    p.r(6, 11, 2, 1, p.accent);
  },
  grimoire: (p) => {
    // A dark book, clasped, with glowing runes on the cover.
    spans(p, C.dark, [[2, 3, 12], [3, 3, 12], [4, 3, 12], [5, 3, 12], [6, 3, 12], [7, 3, 12], [8, 3, 12], [9, 3, 12], [10, 3, 12], [11, 3, 12], [12, 3, 12], [13, 3, 12]]);
    p.r(13, 3, 1, 10, C.paper);
    p.r(3, 2, 1, 12, "#3a2a4a");
    p.r(6, 5, 4, 1, p.accent);
    p.r(7, 6, 2, 3, p.accent);
    p.r(6, 10, 4, 1, p.accent);
    p.r(11, 7, 2, 2, C.gold);
  },
  "void-staff": (p) => {
    // A black staff with a hollow ring at the head and a spark inside it.
    p.l(3, 15, 9, 6, C.dark);
    p.l(4, 15, 10, 6, "#3a2a4a");
    spans(p, C.dark, [[0, 10, 13], [1, 9, 9], [1, 14, 14], [2, 9, 9], [2, 14, 14], [3, 9, 9], [3, 14, 14], [4, 10, 13]]);
    p.r(11, 2, 2, 1, p.accent);
    p.r(11, 1, 1, 1, C.shine);
  },
  // ---- signature weapons ----
  "ballast-flail": (p) => {
    // The Chainshot Flail: a short haft banded in the accent, and three chains, each with a small cannon ball.
    p.l(3, 15, 7, 9, C.wood);
    p.l(4, 15, 8, 9, C.bark);
    p.r(7, 8, 2, 2, p.accent);
    for (const [x, y] of [[8, 7], [8, 6], [8, 5], [8, 4]]) p.r(x, y, 1, 1, C.iron);
    for (const [x, y] of [[9, 7], [10, 6], [11, 6]]) p.r(x, y, 1, 1, C.iron);
    for (const [x, y] of [[10, 8], [11, 9], [12, 10]]) p.r(x, y, 1, 1, C.iron);
    spans(p, C.iron, [[0, 8, 9], [1, 7, 10], [2, 7, 10], [3, 8, 9]]);
    spans(p, C.iron, [[4, 12, 13], [5, 12, 14], [6, 12, 14], [7, 13, 13]]);
    spans(p, C.iron, [[10, 13, 14], [11, 12, 15], [12, 12, 15], [13, 13, 14]]);
    for (const [x, y] of [[8, 1], [12, 5], [13, 11]]) p.r(x, y, 1, 1, C.steel);
  },
  "barometer-rod": (p) => {
    // A staff with a dial set in it and a tube of glowing glass at the head.
    p.r(7, 5, 2, 11, C.wood);
    p.r(8, 5, 1, 11, C.bark);
    p.r(6, 0, 4, 1, C.gold);
    p.r(7, 0, 2, 1, p.accent);
    p.r(6, 1, 1, 3, C.gold);
    p.r(9, 1, 1, 3, C.gold);
    p.r(7, 1, 2, 3, "#8fd3ff");
    p.r(6, 4, 4, 1, C.gold);
    spans(p, C.gold, [[6, 5, 10], [7, 4, 11], [8, 4, 11], [9, 4, 11], [10, 5, 10]]);
    spans(p, C.paper, [[7, 6, 9], [8, 5, 10], [9, 6, 9]]);
    p.r(7, 7, 1, 1, C.dark);
    p.r(8, 8, 1, 1, p.accent);
  },
  "gaff-hook": (p) => {
    // Two gaff hooks, crossed, their points curling outward.
    p.l(2, 15, 4, 13, C.wood);
    p.l(3, 15, 5, 13, C.bark);
    p.r(4, 12, 2, 1, p.accent);
    p.l(6, 11, 10, 3, C.steel);
    spans(p, C.steel, [[2, 11, 12], [3, 13, 13], [4, 13, 13], [5, 12, 12]]);
    p.r(12, 6, 1, 1, C.shine);
    p.l(13, 15, 11, 13, C.wood);
    p.l(12, 15, 10, 13, C.bark);
    p.r(10, 12, 2, 1, p.accent);
    p.l(9, 11, 5, 3, C.iron);
    spans(p, C.iron, [[2, 3, 4], [3, 2, 2], [4, 2, 2], [5, 3, 3]]);
    p.r(3, 6, 1, 1, C.shine);
  },
  "coral-staff": (p) => {
    // Bleached driftwood crowned with coral round a pearl.
    p.l(4, 15, 9, 6, "#c2a785");
    p.l(5, 15, 10, 6, "#9c8564");
    p.r(6, 12, 1, 1, C.paper);
    p.l(9, 6, 6, 2, "#ff8f7a");
    p.l(10, 6, 13, 2, "#ff8f7a");
    p.l(10, 4, 10, 1, "#ff8f7a");
    for (const [x, y] of [[6, 1], [13, 1], [10, 0]]) p.r(x, y, 1, 1, "#ffc0ad");
    p.r(8, 3, 2, 2, p.accent);
    p.r(8, 3, 1, 1, C.shine);
  },
  "ships-bell": (p) => {
    // A hand bell: a wooden handle, a flared brass bell, the clapper beneath.
    p.r(7, 0, 2, 4, C.wood);
    p.r(8, 0, 1, 4, C.bark);
    p.r(6, 4, 4, 1, C.gold);
    spans(p, C.gold, [[5, 5, 10], [6, 5, 10], [7, 4, 11], [8, 4, 11], [9, 4, 11], [10, 3, 12], [11, 2, 13]]);
    p.r(2, 12, 12, 1, "#b8891f");
    p.r(5, 6, 1, 4, "#f2d675");
    p.r(7, 13, 2, 2, p.accent);
  },
  astrolabe: (p) => {
    // A brass disc on a short handle: the star plate, the sighting rule, a glowing pin.
    p.r(6, 0, 4, 1, C.gold);
    p.r(6, 1, 1, 1, C.gold);
    p.r(9, 1, 1, 1, C.gold);
    p.r(6, 2, 4, 1, C.gold);
    spans(p, C.gold, [[3, 5, 10], [4, 4, 11], [5, 3, 12], [6, 3, 12], [7, 3, 12], [8, 3, 12], [9, 4, 11], [10, 5, 10]]);
    spans(p, "#2d357a", [[4, 5, 10], [5, 4, 11], [6, 4, 11], [7, 4, 11], [8, 4, 11], [9, 5, 10]]);
    for (const [x, y] of [[5, 5], [10, 5], [6, 8]]) p.r(x, y, 1, 1, C.shine);
    p.l(4, 9, 11, 4, C.steel);
    p.r(7, 6, 2, 2, p.accent);
    p.r(6, 11, 4, 1, C.gold);
    p.r(7, 12, 2, 3, C.wood);
    p.r(7, 15, 2, 1, C.gold);
  },
  "boarding-pike": (p) => {
    // A long pole, an iron band at the grip, a steel spearhead with a pair of lugs at its base.
    p.l(3, 15, 8, 6, C.wood);
    p.l(4, 15, 9, 6, C.bark);
    p.r(4, 12, 2, 1, p.accent);
    p.r(8, 5, 2, 1, C.iron);
    p.r(6, 4, 6, 1, C.iron);
    p.r(8, 2, 2, 2, C.steel);
    p.r(9, 1, 1, 1, C.steel);
    p.r(9, 0, 1, 1, C.shine);
    p.r(8, 2, 1, 2, C.shine);
  },
  "bilge-chalice": (p) => {
    // A gold chalice brimming with glowing bilge, bubbles rising and a drip down the side.
    spans(p, C.gold, [[4, 3, 12], [5, 3, 12], [6, 4, 11], [7, 4, 11], [8, 5, 10], [9, 6, 9]]);
    p.r(4, 3, 8, 1, "#6dff9e");
    p.r(5, 5, 1, 2, "#f2d675");
    p.r(7, 10, 2, 4, C.gold);
    p.r(7, 11, 2, 2, p.accent);
    spans(p, C.gold, [[14, 5, 10], [15, 4, 11]]);
    for (const [x, y] of [[6, 1], [9, 0], [8, 2]]) p.r(x, y, 1, 1, "#6dff9e");
    p.r(12, 5, 1, 3, "#6dff9e");
  },
  "round-shield": (p) => {
    spans(p, C.iron, [[2, 5, 10], [3, 3, 12], [4, 2, 13], [5, 2, 13], [6, 2, 13], [7, 2, 13], [8, 2, 13], [9, 2, 13], [10, 2, 13], [11, 2, 13], [12, 3, 12], [13, 5, 10]]);
    spans(p, p.accent, [[4, 5, 10], [5, 4, 11], [6, 4, 11], [7, 4, 11], [8, 4, 11], [9, 4, 11], [10, 4, 11], [11, 5, 10]]);
    p.r(7, 7, 2, 2, C.gold);
    p.r(5, 3, 3, 1, C.steel);
  },
  shield: (p) => {
    spans(p, C.iron, [[1, 3, 12], [2, 3, 12], [3, 3, 12], [4, 3, 12], [5, 3, 12], [6, 3, 12], [7, 3, 12], [8, 3, 12], [9, 4, 11], [10, 4, 11], [11, 5, 10], [12, 5, 10], [13, 6, 9], [14, 7, 8]]);
    p.r(7, 2, 2, 12, p.accent);
    p.r(4, 5, 8, 2, p.accent);
    p.r(4, 2, 2, 1, C.steel);
  },
  "chest-armor": (p) => {
    p.r(4, 3, 8, 11, C.iron);
    p.r(2, 2, 4, 3, C.steel);
    p.r(10, 2, 4, 3, C.steel);
    p.r(5, 5, 6, 1, C.steel);
    p.r(7, 6, 2, 3, p.accent);
    p.r(4, 11, 8, 1, C.gold);
    p.r(6, 2, 4, 1, C.dark);
  },
  "heavy-helm": (p) => {
    p.r(7, 0, 2, 2, p.accent);
    p.r(5, 2, 6, 2, C.steel);
    p.r(3, 4, 10, 8, C.iron);
    p.r(4, 3, 8, 1, C.steel);
    p.r(5, 7, 6, 1, C.dark);
    p.r(7, 7, 2, 5, C.steel);
    p.r(3, 12, 3, 2, C.iron);
    p.r(10, 12, 3, 2, C.iron);
  },
  "brutal-helm": (p) => {
    // The Spyglass Visor: a lookout's leather cap banded in brass, flaps over the ears, and goggles, the
    // spyglass's lens in the rarity colour.
    spans(p, C.leather, [[1, 6, 9], [2, 4, 11], [3, 3, 12], [4, 2, 13], [5, 2, 13], [6, 2, 13], [7, 2, 13]]);
    p.r(7, 1, 2, 7, C.hide);
    p.r(1, 8, 14, 2, C.gold);
    p.r(3, 8, 1, 1, C.paper);
    p.r(12, 8, 1, 1, C.paper);
    p.r(1, 10, 2, 5, C.leather);
    p.r(13, 10, 2, 5, C.leather);
    p.r(3, 10, 4, 4, C.gold);
    p.r(4, 11, 2, 2, C.dark);
    p.r(7, 11, 2, 1, C.hide);
    p.r(9, 10, 4, 4, C.gold);
    p.r(10, 11, 2, 2, p.accent);
  },
  hood: (p) => {
    // A peaked hood with a lined opening and two eyes in the shadow.
    spans(p, C.leather, [[0, 7, 8], [1, 6, 9], [2, 5, 10], [3, 4, 11], [4, 4, 11], [5, 4, 11], [6, 4, 11], [7, 4, 11], [8, 4, 11], [9, 4, 11], [10, 4, 11], [11, 3, 12]]);
    spans(p, C.hide, [[12, 2, 13], [13, 2, 13], [14, 3, 12]]);
    spans(p, p.accent, [[4, 6, 9], [5, 5, 10], [6, 5, 10], [7, 5, 10], [8, 5, 10], [9, 5, 10], [10, 6, 9]]);
    spans(p, C.dark, [[5, 6, 9], [6, 6, 9], [7, 6, 9], [8, 6, 9], [9, 6, 9]]);
    p.r(6, 7, 1, 1, C.shine);
    p.r(9, 7, 1, 1, C.shine);
    p.r(7, 12, 2, 1, C.gold);
  },
  "armored-pants": (p) => {
    p.r(4, 2, 8, 2, p.accent);
    p.r(4, 4, 3, 10, C.iron);
    p.r(9, 4, 3, 10, C.iron);
    p.r(7, 4, 2, 3, C.iron);
    p.r(4, 8, 3, 2, C.steel);
    p.r(9, 8, 3, 2, C.steel);
    p.r(4, 14, 3, 1, C.hide);
    p.r(9, 14, 3, 1, C.hide);
  },

  // ---- trinkets ----
  boots: (p) => {
    p.r(5, 3, 5, 8, C.leather);
    p.r(4, 2, 7, 2, p.accent);
    p.r(5, 10, 9, 3, C.leather);
    p.r(11, 10, 3, 1, C.hide);
    p.r(5, 13, 10, 1, C.bark);
    p.r(6, 5, 1, 4, C.hide);
  },
  ring: (p) => {
    spans(p, C.gold, [[6, 5, 10], [7, 4, 5], [7, 10, 11], [8, 4, 4], [8, 11, 11], [9, 4, 4], [9, 11, 11], [10, 4, 4], [10, 11, 11], [11, 4, 5], [11, 10, 11], [12, 5, 10]]);
    p.r(6, 2, 4, 4, p.accent);
    p.r(7, 3, 1, 1, C.shine);
  },
  "linked-rings": (p) => {
    const band = (x: number, y: number, color: string) =>
      spans(p, color, [[y, x + 1, x + 5], [y + 1, x, x], [y + 1, x + 6, x + 6], [y + 2, x, x], [y + 2, x + 6, x + 6], [y + 3, x, x], [y + 3, x + 6, x + 6], [y + 4, x, x], [y + 4, x + 6, x + 6], [y + 5, x, x], [y + 5, x + 6, x + 6], [y + 6, x + 1, x + 5]]);
    band(2, 3, C.gold);
    band(7, 6, p.accent);
  },
  "gem-chain": (p) => {
    p.l(3, 1, 7, 8, C.gold);
    p.l(12, 1, 8, 8, C.gold);
    spans(p, p.accent, [[9, 6, 9], [10, 5, 10], [11, 5, 10], [12, 6, 9], [13, 7, 8]]);
    p.r(6, 10, 1, 1, C.shine);
  },
  key: (p) => {
    spans(p, C.gold, [[1, 5, 10], [2, 4, 4], [2, 11, 11], [3, 4, 4], [3, 11, 11], [4, 4, 4], [4, 11, 11], [5, 4, 4], [5, 11, 11], [6, 5, 10]]);
    p.r(7, 3, 2, 2, p.accent);
    p.r(7, 7, 2, 8, C.gold);
    p.r(9, 11, 2, 1, C.gold);
    p.r(9, 13, 3, 1, C.gold);
  },
  "crowned-heart": (p) => {
    p.r(5, 1, 6, 2, C.gold);
    p.r(5, 0, 1, 1, C.gold);
    p.r(7, 0, 2, 1, C.gold);
    p.r(10, 0, 1, 1, C.gold);
    spans(p, p.accent, [[4, 3, 6], [4, 9, 12], [5, 2, 13], [6, 2, 13], [7, 2, 13], [8, 3, 12], [9, 4, 11], [10, 5, 10], [11, 6, 9], [12, 7, 8]]);
    p.r(4, 5, 2, 1, C.shine);
  },

  // ---- hut materials ----
  "res-wood": (p) => {
    // Two stacked logs, cut ends to the right.
    const log = (x: number, y: number) => {
      p.r(x, y, 12, 5, C.wood);
      p.r(x, y, 9, 1, C.leather);
      p.r(x + 2, y + 2, 4, 1, C.bark);
      p.r(x + 9, y, 3, 5, C.paper);
      p.r(x + 10, y + 2, 1, 1, C.wood);
    };
    log(3, 2);
    log(1, 9);
  },
  "res-stone": (p) => {
    spans(p, C.iron, [[3, 6, 10], [4, 4, 12], [5, 3, 13], [6, 2, 13], [7, 2, 14], [8, 1, 14], [9, 1, 14], [10, 1, 14], [11, 2, 14], [12, 3, 13]]);
    spans(p, C.steel, [[4, 6, 9], [5, 4, 8], [6, 3, 5], [7, 3, 3]]);
    spans(p, "#646d7c", [[10, 9, 14], [11, 6, 14], [12, 3, 13]]);
    p.l(10, 5, 8, 8, C.dark);
    p.l(8, 8, 9, 10, C.dark);
  },
  "res-iron": (p) => ingot(p, C.steel, C.iron, "#646d7c", C.shine),
  "res-copper": (p) => ingot(p, "#e39a5c", "#c8743a", "#8f4d24", "#f6c79a"),
  "res-gem": (p) => {
    // A cut gem: a flat table on top, the crown's facets, and the pavilion tapering to a point.
    spans(p, "#ff9be8", [[3, 5, 10], [4, 4, 11], [5, 3, 12]]);
    spans(p, "#ff6fe0", [[6, 2, 13], [7, 3, 12], [8, 4, 11], [9, 5, 10], [10, 6, 9], [11, 7, 8]]);
    spans(p, "#c23fa8", [[6, 9, 13], [7, 9, 12], [8, 8, 11], [9, 8, 10], [10, 8, 9]]);
    spans(p, "#fff4fc", [[3, 6, 7], [4, 5, 5], [6, 4, 5]]);
    p.r(12, 1, 1, 1, "#fff4fc");
    p.r(13, 2, 1, 1, "#ff9be8");
  },
  "res-fur": (p) => {
    // A pelt stretched flat: four legs, a tail, darker along the spine.
    spans(p, C.leather, [[1, 6, 9], [2, 2, 3], [2, 5, 10], [2, 12, 13], [3, 2, 13], [4, 3, 12], [5, 4, 11], [6, 4, 11], [7, 4, 11], [8, 4, 11], [9, 3, 12], [10, 2, 13], [11, 2, 3], [11, 5, 10], [11, 12, 13], [12, 7, 8], [13, 7, 8], [14, 7, 7]]);
    p.r(7, 2, 2, 9, C.hide);
    spans(p, C.paper, [[4, 5, 5], [6, 10, 10], [8, 5, 5], [9, 10, 10]]);
  },
  "res-bone": (p) => {
    p.l(4, 10, 10, 4, C.bone);
    p.l(5, 11, 11, 5, C.bone);
    p.l(5, 10, 10, 5, C.shine);
    p.r(2, 9, 2, 2, C.bone);
    p.r(4, 12, 2, 2, C.bone);
    p.r(10, 2, 2, 2, C.bone);
    p.r(12, 4, 2, 2, C.bone);
    p.r(3, 11, 2, 2, C.bone);
    p.r(11, 3, 2, 2, C.bone);
  },

  "res-herbs": (p) => {
    // A tied bunch of leafy stems with a few small flowers.
    p.l(8, 15, 8, 6, "#3d6b2c");
    p.l(8, 13, 4, 6, "#3d6b2c");
    p.l(8, 13, 12, 6, "#3d6b2c");
    spans(p, "#4f8a3a", [[2, 6, 9], [3, 5, 10], [4, 3, 12], [5, 2, 13], [6, 2, 13], [7, 3, 12], [8, 5, 10]]);
    spans(p, "#6fae4a", [[3, 6, 8], [4, 4, 6], [5, 10, 12], [6, 7, 9]]);
    p.r(4, 2, 2, 2, "#c9a3e6");
    p.r(10, 1, 2, 2, "#c9a3e6");
    p.r(7, 0, 2, 2, C.paper);
    p.r(6, 11, 4, 2, C.leather);
  },
  "res-mushrooms": (p) => {
    // Two caps on pale stems, the near one larger.
    const shroom = (x: number, y: number, w: number) => {
      p.r(x + Math.floor(w / 2) - 1, y + 3, 2, 5, C.paper);
      spans(p, "#b8452f", [[y, x + 1, x + w - 2], [y + 1, x, x + w - 1], [y + 2, x, x + w - 1]]);
      p.r(x + 2, y, 1, 1, "#e07a5f");
      p.r(x + 1, y + 1, 1, 1, C.paper);
      p.r(x + w - 3, y + 1, 1, 1, C.paper);
    };
    shroom(8, 3, 7);
    shroom(1, 6, 9);
    p.r(1, 14, 14, 1, "#4f8a3a");
  },
  "res-slime": (p) => {
    // A wobbling glob of cave slime, dripping, with a shine on top and a bubble caught inside.
    spans(p, "#3f6212", [[13, 2, 13], [14, 3, 12]]);
    spans(p, "#65a30d", [[5, 6, 9], [6, 4, 11], [7, 3, 12], [8, 2, 13], [9, 2, 13], [10, 2, 13], [11, 2, 13], [12, 2, 13]]);
    spans(p, "#a3e635", [[6, 5, 7], [7, 4, 6], [8, 3, 4]]);
    p.r(9, 9, 2, 2, "#d9f99d");
    p.r(3, 13, 1, 2, "#65a30d");
    p.r(11, 13, 1, 3, "#65a30d");
  },

  // ---- interface ----
  hand: (p) => {
    p.r(5, 6, 7, 7, C.leather);
    p.r(5, 2, 1, 4, C.leather);
    p.r(7, 1, 1, 5, C.leather);
    p.r(9, 1, 1, 5, C.leather);
    p.r(11, 2, 1, 4, C.leather);
    p.r(3, 7, 2, 3, C.leather);
    p.r(5, 13, 7, 2, p.accent);
  },
  cash: (p) => {
    spans(p, C.gold, [[2, 5, 10], [3, 4, 11], [4, 3, 12], [5, 3, 12], [6, 3, 12], [7, 3, 12], [8, 3, 12], [9, 3, 12], [10, 3, 12], [11, 4, 11], [12, 5, 10]]);
    p.r(5, 3, 3, 1, C.shine);
    p.r(7, 5, 2, 6, C.wood);
    p.r(6, 6, 4, 1, C.wood);
    p.r(6, 9, 4, 1, C.wood);
  },

  // ---- pub, brews, hut furniture and trophies (thingArt.ts) ----
  ...THING_ART,
  ...ACTION_ART,
};

/** A cast bar seen from above and in front: lit top face, darker front, a glint. */
function ingot(p: Pen, top: string, front: string, under: string, glint: string) {
  spans(p, top, [[4, 5, 12], [5, 4, 13], [6, 3, 14]]);
  spans(p, front, [[7, 2, 14], [8, 2, 14], [9, 1, 14], [10, 1, 14]]);
  p.r(1, 11, 14, 1, under);
  p.r(6, 5, 4, 1, glint);
}

function darken(hex: string, by = 0.35): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - by)).toString(16).padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

const cache = new Map<string, string>();

// ---------- admin icon overrides ----------
//
// An admin can replace an icon with their own 16x16 pixels (uploaded PNG or
// drawn in the admin page's editor). Two reserved colours keep the rarity
// tint working: pure magenta is drawn in the accent (rarity) colour and dark
// purple in its shade. The outline is added here, as for the code-drawn art.

export const ICON_SIZE = SIZE;
export const MARKER_ACCENT = "#ff00ff";
export const MARKER_SHADE = "#800080";

/** 16x16 RGBA, row by row, as from ImageData. */
export type IconPixels = Uint8ClampedArray;

let iconOverrides: Record<string, IconPixels> = {};

/** Replace the icon overrides in force (decoded from the content bundle). Clears the cache so every icon redraws. */
export function setIconOverrides(next: Record<string, IconPixels>): void {
  iconOverrides = next;
  cache.clear();
  for (const fn of iconArtListeners) fn();
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/**
 * The colour to paint for one opaque pixel of an override: the markers
 * become the accent and its shade, anything else is drawn as it is.
 */
export function markerColour(r: number, g: number, b: number, accent: string, shade: string): string {
  const hex = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  if (hex === MARKER_ACCENT) return accent;
  if (hex === MARKER_SHADE) return shade;
  return hex;
}

/** Art that paints an override's pixels; fully or mostly transparent pixels are left empty. */
function pixelArt(pixels: IconPixels): Art {
  return (p) => {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4;
        if (pixels[i + 3] < 128) continue;
        p.r(x, y, 1, 1, markerColour(pixels[i], pixels[i + 1], pixels[i + 2], p.accent, p.shade));
      }
    }
  };
}

function paintIcon(art: Art, accent: string, silhouette: boolean, lines = false): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = ART_PIXELS;
  canvas.height = ART_PIXELS;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const paint = (color: string) => (silhouette ? accent : color);
  const pen: Pen = {
    accent,
    shade: darken(accent),
    r: (x, y, w, h, color) => {
      ctx.fillStyle = paint(color);
      ctx.fillRect(x + 1, y + 1, w, h);
    },
    l: (x0, y0, x1, y1, color) => {
      ctx.fillStyle = paint(color);
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        ctx.fillRect(Math.round(x0 + (x1 - x0) * t) + 1, Math.round(y0 + (y1 - y0) * t) + 1, 1, 1);
      }
    },
  };
  art(pen);

  if (lines) {
    // A blueprint: the figure's edges, and every seam where one colour meets another, as pale lines over a faint fill.
    const img = ctx.getImageData(0, 0, ART_PIXELS, ART_PIXELS);
    const at = (x: number, y: number) => (y * ART_PIXELS + x) * 4;
    const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < ART_PIXELS && y < ART_PIXELS && img.data[at(x, y) + 3] > 0;
    const differs = (x: number, y: number, nx: number, ny: number) =>
      filled(nx, ny) && [0, 1, 2].some((c) => img.data[at(x, y) + c] !== img.data[at(nx, ny) + c]);
    ctx.clearRect(0, 0, ART_PIXELS, ART_PIXELS);
    for (let y = 0; y < ART_PIXELS; y++) {
      for (let x = 0; x < ART_PIXELS; x++) {
        if (!filled(x, y)) continue;
        const edge = !filled(x - 1, y) || !filled(x + 1, y) || !filled(x, y - 1) || !filled(x, y + 1) || differs(x, y, x - 1, y) || differs(x, y, x, y - 1);
        ctx.fillStyle = edge ? accent : "rgba(214, 232, 255, 0.22)";
        ctx.fillRect(x, y, 1, 1);
      }
    }
  } else if (!silhouette) {
    // Same outline pass as the character sprites: empty pixels touching a filled one go dark.
    const img = ctx.getImageData(0, 0, ART_PIXELS, ART_PIXELS);
    const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < ART_PIXELS && y < ART_PIXELS && img.data[(y * ART_PIXELS + x) * 4 + 3] > 0;
    ctx.fillStyle = OUTLINE;
    for (let y = 0; y < ART_PIXELS; y++) {
      for (let x = 0; x < ART_PIXELS; x++) {
        if (!filled(x, y) && (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1))) ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  return canvas;
}

const drawIcon = (art: Art, accent: string, silhouette: boolean, lines = false): string => paintIcon(art, accent, silhouette, lines).toDataURL();

/** The flat picture of a class's own piece of starting clothes ("garb-tunic:staff_sage"): the plain one of its kind. */
const GARB_ART: Record<GarbPiece, string> = { hat: "knit-cap", tunic: "naval-tunic", trousers: "armored-pants", shoes: "deck-boots" };
const codeArt = (name: string): Art => {
  const garb = parseGarbIcon(name);
  return ART[garb ? GARB_ART[garb.piece] : name] ?? ART["gem-chain"];
};

/**
 * Image URL for an item icon. `accent` is the rarity colour. With
 * `silhouette` the whole figure is drawn flat in the accent colour and
 * without an outline, for empty equipment slots. An admin override, when
 * there is one, replaces the code-drawn art.
 */
export function itemArtUrl(name: string, accent: string, silhouette = false): string {
  const key = `${name}|${accent}|${silhouette}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const over = iconOverrides[name];
  const url = drawIcon(over ? pixelArt(over) : codeArt(name), accent, silhouette);
  cache.set(key, url);
  return url;
}

/** The icon as it is drawn (ART_PIXELS square, outline and all, any admin override applied): what the voxel icons are built from. */
export function itemArtPixels(name: string, accent: string): ImageData {
  const over = iconOverrides[name];
  const canvas = paintIcon(over ? pixelArt(over) : codeArt(name), accent, false);
  return canvas.getContext("2d")!.getImageData(0, 0, ART_PIXELS, ART_PIXELS);
}

/** Whether an admin has redrawn this icon (then its pixels, not any model, are what is shown). */
export const hasIconOverride = (name: string) => !!iconOverrides[name];

/** Called whenever the icon overrides change, so pictures built from the icons can be redrawn. */
export const iconArtListeners = new Set<() => void>();

/**
 * A blueprint of an icon: its edges and inner seams as lines in `line`, for
 * a plan of a piece rather than the piece. Goes through the same overrides.
 */
export function blueprintArtUrl(name: string, line: string): string {
  const key = `${name}|${line}|blueprint`;
  const hit = cache.get(key);
  if (hit) return hit;
  const over = iconOverrides[name];
  const url = drawIcon(over ? pixelArt(over) : codeArt(name), line, false, true);
  cache.set(key, url);
  return url;
}

/** An icon drawn from pixels not (yet) in force, or the code art when null: the admin page's live preview. */
export function previewIconUrl(name: string, pixels: IconPixels | null, accent: string, silhouette = false): string {
  return drawIcon(pixels ? pixelArt(pixels) : codeArt(name), accent, silhouette);
}

/**
 * The code-drawn icon as 16x16 pixels without its outline, with the accent
 * and shade drawn in the marker colours: a starting point for the editor
 * that keeps the rarity tint.
 */
export function codeIconPixels(name: string): IconPixels {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const pen: Pen = {
    accent: MARKER_ACCENT,
    shade: MARKER_SHADE,
    r: (x, y, w, h, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    },
    l: (x0, y0, x1, y1, color) => {
      ctx.fillStyle = color;
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        ctx.fillRect(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), 1, 1);
      }
    },
  };
  codeArt(name)(pen);
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

export const ITEM_ART_NAMES = Object.keys(ART);
