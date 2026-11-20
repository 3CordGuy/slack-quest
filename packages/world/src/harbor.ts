// The Harbor: a crew's shared, walkable base.
//
// Unlike a zone it is not turn-based and has no reducer: players walk
// freely, and the HarborRoom Durable Object only validates paths and relays
// them. This file holds the fixed map and the message shapes both sides use.

import type { Appearance } from "./appearance";
import { allHexesInGrid, type HexGrid, type HexPos } from "@gantt-quest/core";
import type { Outfit } from "./gear";
import type { FishSpot, Vessel } from "./fishing";
import type { Resources } from "./hut";
import type { ItemDef } from "./gear";
import type { Stats } from "@gantt-quest/core";
import type { HarborWorks } from "./projects";
import type { Muster } from "./muster";
import { findPath, tileAt, type Biome, type Poi, type PoiKind, type Tile, type WorldMap } from "./map";

/** What the crew's home port is called, wherever its name is shown. */
export const HARBOR_NAME = "Heylets Harbor";

export const HARBOR_GRID: HexGrid = { cols: 40, rows: 31 };

/** Offset column (visual left-to-right index) of an axial hex. */
const colOf = (p: HexPos) => p.q + Math.floor(p.r / 2);
const at = (col: number, r: number): HexPos => ({ q: col - Math.floor(r / 2), r });
const keyOf = (p: HexPos) => `${p.q},${p.r}`;

/**
 * How much ground a building takes, behind its door. The door is the hex a hero stands on to use the place; the
 * building itself stands on the hexes north of it, which nobody can walk through:
 * a `pair` is the two hexes behind the door (three tiles with the doorstep), a `trio` those and the one behind them
 * (a diamond of four with the doorstep), and a `flower` a whole ring of seven whose two nearest petals touch the door.
 * A `single` is one hex, the one up and to the right of where a hero stands to use it: for a thing rather than a
 * building (the town chest, the notice board).
 */
export type Footing = "single" | "pair" | "trio" | "flower";

/**
 * The six sides of a hex, clockwise from the top right: the same order as `HEX_DIRS` (hutroom.ts), which a
 * path's bits and a building's facing both count in. Kept here too so this file does not import the hut room's.
 */
export const HARBOR_SIDES: readonly HexPos[] = [{ q: 1, r: -1 }, { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }];
/** An offset turned a sixth clockwise, `times` times: in the order above, each side becomes the next. */
function turned(d: HexPos, times: number): HexPos {
  let { q, r } = d;
  for (let i = 0; i < ((times % 6) + 6) % 6; i++) [q, r] = [-r, q + r];
  return { q, r };
}

/**
 * The hexes a building with its door on `door` stands on. Facing 0 it stands to the north of its door, its front
 * to the south; each step of `facing` turns it a sixth clockwise about the door, so it can front a road running
 * any of the three ways a row of hexes runs.
 */
export function footing(door: HexPos, shape: Footing, facing = 0): HexPos[] {
  const pair = [{ q: 0, r: -1 }, { q: 1, r: -1 }];
  const offsets = shape === "single" ? [{ q: 1, r: -1 }] : shape === "pair" ? pair : shape === "trio" ? [...pair, { q: 1, r: -2 }] : [...pair, { q: 1, r: -2 }, { q: 0, r: -2 }, { q: 2, r: -2 }, { q: 1, r: -3 }, { q: 2, r: -3 }];
  return offsets.map((d) => {
    const t = turned(d, facing);
    return { q: door.q + t.q, r: door.r + t.r };
  });
}

/**
 * The hexes just in front of a door facing `facing`: the two of its sides the front looks out between. A
 * doorstep's path runs out to whichever of them a road is on.
 */
export function frontOf(door: HexPos, facing = 0): HexPos[] {
  return [2, 3].map((side) => {
    const d = HARBOR_SIDES[(side + facing) % 6];
    return { q: door.q + d.q, r: door.r + d.r };
  });
}

/**
 * The town's plan: a ring on the coast. The waygate hangs in the middle of the island, in the square, and every
 * place stands right on the shoreline all the way round it, like the numbers on a clock: its back to the sea, its
 * front turned in to the gate, a gap between it and its neighbours. Inside the ring there is one open green and
 * nothing built: the square, the lanes that run out from it like spokes, the town well, the old oak.
 *
 * - The square (`HARBOR_SQUARE`) is the gate's hex and the two rings round it, all cobbled, with nothing else in
 *   it. Heroes arrive beside the gate (`HARBOR_SPAWN`), on the side the view opens from.
 * - Round the clock from the top: the caverns' mouth in the cliff (the only wall left on the island); the quarry's
 *   outcrop; the builders' yard and then the pub on the north-east shore, the notice board beside the pub; the
 *   bridge to the housing island (`HARBOR_BRIDGE`), due east, where the High Street ends; the apothecary on the
 *   south-east shore; the lighthouse on its point; the docks along the south shore, with the market stall
 *   standing on the quay itself, a short walk from the gate, the galley toward its east end and the fish shack at its west;
 *   the town chest on its dais on the west shore; the sparring ring where the High Street meets that shore, just
 *   north of the chest; the lapidary just north of the ring;
 *   the smithy on the north-west shore; and the felling copse beyond it, under the cliff's west shoulder.
 * - Nobody lives on this island: every hut plot is on the housing island, scattered along winding paths.
 * - The woods are gone but for the felling copse, and the wall but for the cliff the caverns open in:
 *   the shore is open strand all the way round.
 */
/** The middle of the town's island, in columns across and rows down: what its coast and its wall curve round. */
export const HARBOR_HEART_AT = { col: 13.5, row: 14 };
/** The hex the waygate hangs over: the middle of the square, at the island's heart. Nobody walks through it. */
export const HARBOR_GATE: HexPos = at(13, 16);
/** Where a player appears on arrival: beside the waygate, on its south-east side, where the view opens from. */
export const HARBOR_SPAWN: HexPos = at(13, 17);
/** The square: every hex within two of the waygate. All of it cobbled. */
export const HARBOR_SQUARE: HexPos[] = allHexesInGrid({ cols: 28, rows: 31 }).filter((p) => {
  const dq = p.q - HARBOR_GATE.q, dr = p.r - HARBOR_GATE.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 <= 2;
});
/** Pier heads, off the south shore: the end of each pier's planking. A moored ship lies in the water beyond each one. */
export const HARBOR_PIERS: HexPos[] = [at(8, 26), at(13, 27), at(18, 26)];
/**
 * Hut plots, handed out to crew members in the order they joined: each is the doorstep of a hut that stands on the
 * two hexes behind it. All twelve are on the housing island, over the bridge east of the town, and none is set
 * out with a ruler: they stand here and there along its four winding paths, each turned its own way to face the
 * path it is on, with room between them for a garden and a tree. The first plots handed out are the ones nearest
 * the bridge.
 */
export const HARBOR_PLOTS: HexPos[] = [
  at(28, 15), at(30, 16), at(28, 17), at(28, 13), at(30, 13), at(32, 15),
  at(31, 18), at(33, 18), at(34, 16), at(32, 12), at(35, 15), at(34, 13),
];
/** Which way each hut plot faces (see `footing`), so its hut fronts the path it stands on. */
export const HARBOR_PLOT_FACING: number[] = [5, 3, 3, 5, 2, 0, 4, 2, 3, 2, 3, 0];
/** The plank bridge from the east end of the High Street over to the housing island, the town's end first. */
export const HARBOR_BRIDGE: HexPos[] = [at(24, 16), at(25, 16), at(26, 16)];
/** The middle of the housing island, and how far out its shore lies, in hex widths. */
const HOME = { x: 31.5, z: 15 * 0.866, coast: 5.5 };
/**
 * The notice board: where a hero stands to read it, at the top of the pub's lane. The board itself stands east
 * of this hex on the shore: to one side of the pub, a hex clear of its wall and in line with its front, turned
 * the way the pub is turned, toward the gate. It is not in front of the pub: nothing stands in front of a place.
 */
export const HARBOR_BOARD: HexPos = at(21, 14);
/**
 * The market stall, where gear is bought and sold: its doorstep, at the end of the walk down the green from the
 * foot of the square. The stall stands south of it on the quay itself, its back to the middle pier, and looks up
 * the green at the gate. (Of all the places on the shore it is the nearest to the gate: it is used every day.)
 */
export const HARBOR_SHOP: HexPos = at(13, 22);
/** The sparring ring, where crewmates try out their gear: on the west shore, where the High Street runs out onto the strand. */
export const HARBOR_RING: HexPos = at(4, 16);
/**
 * Gathering spots, each at the water's edge: the fish shack at the west end of the quay; the felling copse on the
 * north-west shore, between the smithy and the cliff, at the end of a track of its own; and the quarry's outcrop on
 * the north-east shore. Each stands in the open, with nothing built between it and where the view opens from.
 */
export const HARBOR_GATHER = { fishing: at(6, 23), felling: at(8, 6), quarry: at(20, 6) } as const;
/** Where a fishing sitting can be started: each pier head, and the old spot on the south-west shore. The open sea is reached by boat. */
/** The piers and the shore spot. (Afloat, any water hex is a spot: see waterSpotAt.) */
export type ShoreSpot = "west" | "middle" | "east" | "shore";
export const HARBOR_FISH_SPOTS: Record<ShoreSpot, HexPos> = {
  west: HARBOR_PIERS[0],
  middle: HARBOR_PIERS[1],
  east: HARBOR_PIERS[2],
  shore: HARBOR_GATHER.fishing,
};
/** The fishing spot on a hex, if there is one. */
export function fishSpotAt(pos: HexPos): ShoreSpot | null {
  for (const [id, p] of Object.entries(HARBOR_FISH_SPOTS) as [ShoreSpot, HexPos][]) if (p.q === pos.q && p.r === pos.r) return id;
  return null;
}
/** The pub's door, on the north-east shore at the end of its lane, a little north of the bridge: the pub stands behind it with its back to the sea, its front turned in to the south-west. Food, drink, the barkeep and the dice table are inside. */
export const HARBOR_PUB: HexPos = at(21, 12);
/** The works: the builders' yard where the crew's shared projects are paid for, on the north-east shore between the quarry and the pub, at the far end of the pub's lane, its back to the sea and its front turned in to the south-west. */
export const HARBOR_WORKS: HexPos = at(20, 9);
/**
 * The lighthouse's door: out on the south-east point, over the wreck, where
 * ships pass out of the harbour. Not in the plaza, where a tall tower would
 * hide the town. The tower stands in the middle of the seven hexes behind it:
 * a bare point (then a building site) until the crew has paid for it at the works.
 */
export const HARBOR_LIGHTHOUSE: HexPos = at(21, 24);
/**
 * The Lapidary's door: the shop where lodestones are cut and worked (stonecraft.ts) before a crew goes out to
 * the atlas with them, and where gems are bought (lapidary.ts). It stands on the west shore, a few steps north of
 * where the High Street runs out onto the strand, its back to the sea and its front turned in to the east, with
 * the smithy the next place round the shore: the two trades that work stone and iron. It was never a building
 * site: it is open from a crew's first day.
 */
export const HARBOR_LAPIDARY: HexPos = at(5, 14);
/**
 * The town chest, the crew's shared store (townchest.ts): where a hero stands to open it, on the west shore a
 * few steps south of where the High Street runs out onto the strand. The chest itself stands west of this hex on
 * a dais of its own at the water's edge, the sea at its back, open to the sky, and faces in toward the gate.
 * Nobody walks through it, and pointing at it is pointing here.
 */
export const HARBOR_CHEST: HexPos = at(5, 18);
/**
 * The waygate: the ring a lodestone opens, and the crew's way out to the atlas and back. Where a hero stands to
 * step through it: beside where everyone arrives, on the gate's south-west side. The gate itself hangs over the
 * hex up and to the right of that (`HARBOR_GATE`), the middle of the square, with its round court about it
 * (`HARBOR_COURT`). It was here before the town was, and nobody had to build it. Both this hex and the one
 * heroes arrive on are on the side of the gate the view opens from: nobody stands hidden behind it.
 */
export const HARBOR_WAYGATE: HexPos = at(12, 17);
/** The apothecary's door, on the south-east shore at the end of its lane, a little south of the bridge: its back to the sea, its front turned in to the north-west. A building site until the crew has paid for it. */
export const HARBOR_APOTHECARY: HexPos = at(21, 18);
/** The smithy's door, on the north-west shore at the end of its lane from the square: its back to the sea, its front turned in to the south-east. A building site until the crew has paid for it. */
export const HARBOR_SMITHY: HexPos = at(7, 10);
/** The galley's door, toward the east end of the quay, at the end of its lane off the east road: the galley stands south of it with its back to the quay and the east pier, where ships take on provisions, clear of the lighthouse and of the fish shack at the other end. A building site until the crew has paid for it. */
export const HARBOR_GALLEY: HexPos = at(17, 21);

/**
 * The oak on the hill: one great old tree on a rise in the open ground at the back of the island, north-east of
 * the plaza behind Hut Row, with tall grass all round it. Nobody walks through the oak; the hill itself is to climb.
 */
export const HARBOR_OAK: HexPos = at(16, 6);

/** The mouth of the Haunted Caverns: a way into the rocks through the north wall. */
export const HARBOR_CAVE: HexPos = at(13, 3);

/** Rocks standing out of the water, and the wreck on them. Scenery: nobody can reach them. */
export const HARBOR_ROCKS: HexPos[] = [at(3, 22), at(5, 26), at(23, 25), at(24, 6), at(2, 7)];
export const HARBOR_WRECK: HexPos = at(22, 23);

/**
 * The town's buildings: where each one's door is, how much ground it stands on behind it, and what that ground
 * is. The town's places stand on cobbles; the lighthouse and the fish shack on the bare shore; huts on the grass.
 */
export const HARBOR_BUILDINGS: { id: string; door: HexPos; shape: Footing; ground: Biome; facing?: number }[] = [
  { id: "pub", door: HARBOR_PUB, shape: "trio", ground: "cobble", facing: 1 },
  { id: "lighthouse", door: HARBOR_LIGHTHOUSE, shape: "flower", ground: "mud" },
  { id: "works", door: HARBOR_WORKS, shape: "pair", ground: "cobble", facing: 1 },
  { id: "shop", door: HARBOR_SHOP, shape: "pair", ground: "cobble", facing: 3 },
  { id: "apothecary", door: HARBOR_APOTHECARY, shape: "trio", ground: "cobble", facing: 2 },
  { id: "smithy", door: HARBOR_SMITHY, shape: "trio", ground: "cobble", facing: 5 },
  { id: "galley", door: HARBOR_GALLEY, shape: "trio", ground: "cobble", facing: 3 },
  { id: "fishing", door: HARBOR_GATHER.fishing, shape: "pair", ground: "mud" },
  { id: "townchest", door: HARBOR_CHEST, shape: "single", ground: "cobble", facing: 4 },
  { id: "board", door: HARBOR_BOARD, shape: "single", ground: "cobble", facing: 1 },
  { id: "lapidary", door: HARBOR_LAPIDARY, shape: "pair", ground: "cobble", facing: 5 },
  { id: "waygate", door: HARBOR_WAYGATE, shape: "single", ground: "cobble" },
  ...HARBOR_PLOTS.map((door, i) => ({ id: `plot:${i}`, door, shape: "pair" as const, ground: "plains" as const, facing: HARBOR_PLOT_FACING[i] })),
];

/**
 * The town's roads, each a straight run (or a zigzag, for a lane that must head due north or south, which no
 * row of hexes does): where it starts and the sides it steps out through, in `HARBOR_SIDES` order. Cobbled
 * streets are laid as cobble hexes; dirt lanes as paths across the grass, joining wherever they meet.
 */
export interface HarborRoad {
  kind: "cobble" | "dirt";
  from: HexPos;
  steps: number[];
}
const run = (side: number, n: number) => Array<number>(n).fill(side);
const zigzag = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? b : a));
export const HARBOR_ROADS: HarborRoad[] = [
  // The High Street, west and east out of the square, shore to shore: west to the sparring ring on the strand,
  // east to the bridge.
  { kind: "cobble", from: at(4, 16), steps: run(1, 7) },
  { kind: "cobble", from: at(15, 16), steps: run(1, 8) },
  // The two roads down from the foot of the square to the quay, the green between them.
  { kind: "cobble", from: at(12, 18), steps: run(3, 5) },
  { kind: "cobble", from: at(14, 18), steps: run(2, 5) },
  // The walk down the middle of the green from the foot of the square to the market stall's door.
  { kind: "cobble", from: at(13, 18), steps: [2, 3, 2] },
  // The lane up to the caverns' mouth from the head of the square: due north, so zigzagging.
  { kind: "dirt", from: at(13, 14), steps: zigzag(0, 5, 11) },
  // The smithy's lane: from the square's north-west corner out to the north-west shore.
  { kind: "cobble", from: at(12, 14), steps: [...run(5, 4), 4, 4] },
  // The quay: paved along the water's edge from the west pier to the lighthouse's point, past the foot of every pier.
  { kind: "cobble", from: at(9, 24), steps: run(1, 11) },
  // The spokes out to the rest of the ring. From the High Street a little short of the bridge: one lane north
  // along the shore past the pub's door to the builders' yard, and one south-east to the apothecary.
  { kind: "cobble", from: at(19, 16), steps: [0, 0, 0, 5, 0, 5] },
  { kind: "cobble", from: at(19, 16), steps: run(2, 2) },
  // From the High Street by the west shore, a few steps north to where the lapidary stands.
  { kind: "cobble", from: at(6, 16), steps: [5] },
  // And off the east road to the quay, the lane to the galley.
  { kind: "cobble", from: at(15, 20), steps: run(1, 2) },
  // The track on from the builders' yard to the quarry, clear of the oak's hill.
  { kind: "dirt", from: at(20, 10), steps: [5, 0, 5, 0] },
  // And a few steps south from the same place to the town chest.
  { kind: "cobble", from: at(6, 16), steps: [3] },
  // The track to the felling copse, north off the smithy's lane.
  { kind: "dirt", from: at(10, 10), steps: run(5, 4) },
  // The housing island's paths, none of them straight: in from the bridge to the middle of the island, and from
  // there north, east and south. (From here on every road is one of the housing island's: `HARBOR_HOME_ROADS`.)
  { kind: "dirt", from: at(26, 16), steps: [1, 1, 1, 0, 1, 2, 1] },
  { kind: "dirt", from: at(29, 15), steps: [0, 5, 0, 1] },
  { kind: "dirt", from: at(32, 16), steps: [1, 0, 1, 0] },
  { kind: "dirt", from: at(31, 16), steps: [2, 2, 2] },
];

/** The housing island's paths: the last four of the roads. */
export const HARBOR_HOME_ROADS: HarborRoad[] = HARBOR_ROADS.slice(-4);

/**
 * The waygate's court: the six hexes round the gate, all paved, so the gate hangs in the middle of a round of
 * stone at the corner of the square (the renderer lays one round of paving over the lot). In `HARBOR_SIDES` order.
 */
export const HARBOR_COURT: HexPos[] = HARBOR_SIDES.map((d) => ({ q: HARBOR_GATE.q + d.q, r: HARBOR_GATE.r + d.r }));

/**
 * The forecourt of the caverns: a paved terrace under the mouth, a step above the grass, with the lane coming
 * up to it by two broad steps (`HARBOR_CAVE_STEPS`, the lower first).
 */
export const HARBOR_FORECOURT: HexPos[] = [at(12, 4), at(13, 4), at(14, 4), at(15, 4), at(12, 5), at(13, 5), at(14, 5)];
export const HARBOR_CAVE_STEPS: HexPos[] = [at(13, 7), at(13, 6)];
/** How far the forecourt stands above the streets, in the map's heights; each step up to it is a third of that. */
const FORECOURT_RISE = 0.18;

/** The crane's mole: one hex of stone built out from the quay into the harbour, for the crane to stand on. */
export const HARBOR_MOLE: HexPos = at(11, 25);

/**
 * The small boats in the harbour: each floats on a hex of water beside a pier or the quay, made fast to it, and
 * rides the swell. None is ever drawn up on land. `turn` is which way her bow points, in sixths clockwise from north.
 * (They are for show: the water under them is still water, and a hero's own boat passes them by.)
 */
export const HARBOR_BOATS: { at: HexPos; turn: number }[] = [
  { at: at(9, 25), turn: 2 },
  { at: at(19, 26), turn: 0 },
];

/**
 * What dresses the town and is not a place: nothing here is used, bought or opened. Most of it stands on a
 * `corner` of its hex (0 the north one, then clockwise: three hexes meet at each, and nobody walking from the
 * middle of one hex to the middle of the next ever crosses one), so it is in nobody's way. The few big things
 * stand in the middle of a hex of their own, which nobody can then walk through (`HARBOR_FIXTURES`), the same as
 * the ground under a building. `turn` turns a piece, in sixths clockwise.
 */
export type DecorKind =
  | "lamp" | "pillar" | "pillar_broken" | "stump" | "brazier" | "planter" | "bench" | "crates" | "barrels" | "nets" | "bollard"
  | "banner" | "milestone" | "rack" | "cairn" | "railpost" | "garden" | "mast" | "well" | "statue" | "crane";
export interface HarborDecor {
  kind: DecorKind;
  at: HexPos;
  corner?: number;
  turn?: number;
}
/** The kinds that stand in the middle of a hex and fill it. */
const FIXTURE_KINDS: ReadonlySet<DecorKind> = new Set(["well", "statue", "crane"]);
/** The corner of a hex of the court's ring that points at the gate's `j`th standing stone (see HARBOR_COURT). */
const courtStone = (j: number, kind: DecorKind): HarborDecor => ({ kind, at: HARBOR_COURT[j], corner: (j + 5) % 6, turn: j });
const lamps = (...spots: [col: number, r: number, corner: number][]): HarborDecor[] => spots.map(([col, r, corner]) => ({ kind: "lamp", at: at(col, r), corner }));
export const HARBOR_DECOR: HarborDecor[] = [
  // The waygate's court: standing stones round it, whole behind it (to the north and east), broken toward the sea,
  // (The stones stand on the six corners of the court: three whole ones behind the gate as it is first seen, a
  // broken one either side, and in front, between where heroes arrive and where they stand to use it, only a stump.)
  courtStone(0, "pillar"), courtStone(1, "pillar"), courtStone(5, "pillar"), courtStone(2, "pillar_broken"), courtStone(4, "pillar_broken"), courtStone(3, "stump"),
  // Lamps stand only where one would: two at the gate's court, one where the lanes fork off the High Street on
  // either side of the square, one at each end of the bridge, one at each pier head and one where the housing
  // island's paths meet. (Every place has a lantern of its own at its door.)
  ...lamps([11, 17, 4], [14, 17, 2], [12, 14, 5], [19, 16, 3]),
  ...HARBOR_PIERS.map((p): HarborDecor => ({ kind: "lamp", at: p, corner: 5 })),
  // The High Street: a milestone at each end, and casks outside the pub.
  { kind: "milestone", at: at(5, 16), corner: 3 }, { kind: "milestone", at: at(22, 16), corner: 3 },
  { kind: "barrels", at: at(21, 12), corner: 2 },
  // The green: the town well, and one bench.
  { kind: "well", at: at(16, 13) },
  { kind: "bench", at: at(12, 20), corner: 0 },
  // The quay: the crane on its mole with one lot of cargo waiting by it, mooring posts along the water, the
  // harbour's signal mast at the foot of the middle pier, and the fishers' drying rack by their shack. Nothing else.
  { kind: "crane", at: HARBOR_MOLE },
  ...[9, 12, 16, 20].map((col): HarborDecor => ({ kind: "bollard", at: at(col, 24), corner: 3 })),
  { kind: "crates", at: at(12, 24), corner: 5 }, { kind: "barrels", at: at(11, 24), corner: 0 },
  { kind: "mast", at: at(13, 24), corner: 3 },
  { kind: "rack", at: at(7, 23), corner: 3 },
  // The lane up to the caverns: cairns where it starts to climb; and at the top the
  // forecourt, a great stone figure either side of it and a brazier at the head of the steps on each hand. Banners fly by the mouth.
  { kind: "cairn", at: at(13, 7), corner: 4 }, { kind: "cairn", at: at(13, 7), corner: 2 },
  { kind: "statue", at: at(12, 4), turn: 0 }, { kind: "statue", at: at(15, 4), turn: 0 },
  { kind: "brazier", at: at(13, 5), corner: 4 }, { kind: "brazier", at: at(13, 5), corner: 2 },
  { kind: "banner", at: at(13, 4), corner: 5 }, { kind: "banner", at: at(14, 4), corner: 1 },
  { kind: "pillar_broken", at: at(12, 5), corner: 4, turn: 2 }, { kind: "stump", at: at(14, 5), corner: 2, turn: 1 },
  // The bridge: a post with a rope rail at every point of its planking on both sides, and a lamp at each end.
  ...HARBOR_BRIDGE.flatMap((p): HarborDecor[] => [{ kind: "railpost", at: p, corner: 0 }, { kind: "railpost", at: p, corner: 3 }]),
  ...lamps([23, 16, 0], [27, 16, 3]),
  // The housing island: a lamp where its paths meet, a bench on the green in the middle, and by every hut's door a
  // patch of garden of its own behind a few pickets.
  ...lamps([29, 15, 0]),
  { kind: "bench", at: at(31, 15), corner: 0 },
  ...HARBOR_PLOTS.map((p, i): HarborDecor => ({ kind: "garden", at: p, corner: (HARBOR_PLOT_FACING[i] + 4) % 6, turn: 2 })),
];
/** The hexes the big pieces of the town's dressing stand on: nobody walks through them. */
export const HARBOR_FIXTURES: HexPos[] = HARBOR_DECOR.filter((d) => d.corner === undefined && FIXTURE_KINDS.has(d.kind)).map((d) => d.at);

/** The hexes a road covers, its start first. */
export function roadHexes(road: HarborRoad): HexPos[] {
  const out = [road.from];
  for (const side of road.steps) {
    const p = out[out.length - 1];
    const d = HARBOR_SIDES[side];
    out.push({ q: p.q + d.q, r: p.r + d.r });
  }
  return out;
}

/** Every hex a building stands on, by the door it belongs to. */
const DOOR_OF = new Map<string, HexPos>(HARBOR_BUILDINGS.flatMap((b) => footing(b.door, b.shape, b.facing).map((p) => [keyOf(p), b.door] as [string, HexPos])));

/**
 * The door of the building standing on a hex, if one does: pointing at any part of a building is pointing at the
 * place, and walking "to" it is walking to its door.
 */
export function harborDoor(pos: HexPos): HexPos | null {
  return DOOR_OF.get(keyOf(pos)) ?? null;
}

const HEIGHT: Record<Biome, number> = { sand: 0.22, water: 0.05, plains: 0.3, forest: 0.42, hills: 0.75, dock: 0.1, cobble: 0.26, mud: 0.2, rampart: 0.7, floor: 0.1, wall: 0.9, cave: 0.18, rock: 1.4, gate: 0.18, fog: 0.3, paved: 0.3 };

export function harborPoi(id: string, kind: PoiKind, pos: HexPos, facing = 0): Poi {
  return { id, kind, pos, hidden: false, cleared: false, usedBy: [], enemies: [], ...(facing ? { facing } : {}) };
}

/** A fixed 0..1 value per hex, so the same ground is mud or scrub every time. */
const grit = (col: number, r: number) => {
  const n = Math.sin(col * 127.1 + r * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

/** The middle of the island, in hex widths across and down, and how far out its coast lies. */
const HEART = { x: 13.5, z: 14 * 0.866 };
const COAST = 10;

/** How far either side of due north the cliff runs, in radians: just the caverns' mouth and its shoulders. */
const CLIFF = 0.5;

/** The six hexes round one. */
const NEIGHBOURS: HexPos[] = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
const around = (p: HexPos) => NEIGHBOURS.map((d) => ({ q: p.q + d.q, r: p.r + d.r }));

/**
 * The Harbor map. The same for every crew: a round island with the sea all
 * about it, its coast a little ragged. A line of great mossy boulders on a low
 * bank curves round the north, gapped in places, with the caverns' mouth in the middle of it; trees
 * stand on the west and east shoulders where the wall never reached; and the
 * south shore is a quay of bare earth with three piers, the sea beyond them
 * dotted with rocks and a wreck. Inland it is grass, with a cobbled plaza at
 * the heart, the waygate in the middle of it, and the town laid out along its
 * roads (HARBOR_ROADS; the plan is set out above HARBOR_GATE): the High
 * Street east and west out of the plaza, two roads down to the paved quay, a
 * lane up to the caverns, and Hut Row across the north with every hut on it.
 * Every building fronts a road. At the back, north-east of the plaza behind
 * Hut Row, one old oak stands on a hill in tall grass.
 * A building is bigger than the hex its door is on: it stands on the hexes
 * behind the door (see `footing`), which are marked `built` and cannot be walked through.
 */
export function generateHarbor(): WorldMap {
  const tiles: Tile[] = allHexesInGrid(HARBOR_GRID).map((pos) => {
    const col = colOf(pos);
    let biome: Biome;
    // How far this hex is from the island's heart, and which way: 0 is due north, turning either way to π at south.
    const dx = col + (pos.r % 2 ? 0.5 : 0) - HEART.x;
    const dz = pos.r * 0.866 - HEART.z;
    const out = Math.hypot(dx, dz);
    const turn = Math.atan2(dx, -dz);
    const north = Math.abs(turn);
    // The coast: a circle, pushed in and out a little so it is not drawn with a compass.
    const coast = COAST + 0.4 * Math.sin(3 * turn + 1.0) + 0.3 * Math.sin(5 * turn + 2.2);
    // The housing island, east of the town: smaller, with no wall. A beach round its south and west, grass within,
    // and trees standing in ones and twos all over it (the paths and the plots are cleared of them below).
    const hx = col + (pos.r % 2 ? 0.5 : 0) - HOME.x;
    const hz = pos.r * 0.866 - HOME.z;
    const home = Math.hypot(hx, hz);
    const homeTurn = Math.atan2(hx, -hz);
    const homeCoast = HOME.coast + 0.3 * Math.sin(3 * homeTurn + 0.4) + 0.2 * Math.sin(5 * homeTurn + 1.7);
    if (home <= homeCoast) {
      const biome: Biome = home > homeCoast - 1 ? (Math.abs(homeTurn) > 1.9 || (homeTurn < -0.6 && homeTurn > -1.5) ? "mud" : grit(col, pos.r) < 0.5 ? "forest" : "plains") : grit(col + 3, pos.r) < 0.24 ? "forest" : "plains";
      return { q: pos.q, r: pos.r, biome, h: HEIGHT[biome] + (biome === "plains" ? ((pos.q * 7 + pos.r * 13) % 5) * 0.012 : 0) };
    }
    if (out > coast) biome = "water";
    // The rim: boulders round the north (a gap of rubble here and there), bare shore to the south.
    // (The cliff is only where the caverns open in it; the rest of the shore is open strand, so every place on it
    // has the sea at its back.)
    else if (out > coast - 1) biome = north < CLIFF ? (grit(col, pos.r) < 0.2 ? "hills" : "rampart") : "mud";
    // Inland it is all grass. Only the quay behind the south shore is worn bare.
    else biome = north > 2 && out > coast - 2.6 ? "mud" : "plains";
    // A fixed ripple so the ground is not perfectly flat, and a rampart that is not all one height.
    const ripple = ((pos.q * 7 + pos.r * 13) % 5) * 0.012;
    const h = biome === "rampart" ? HEIGHT.rampart - (grit(col, pos.r) < 0.3 ? 0.3 : 0) + ripple * 4 : HEIGHT[biome] + (biome === "plains" || biome === "mud" ? ripple : 0);
    return { q: pos.q, r: pos.r, biome, h };
  });
  const map: WorldMap = { grid: HARBOR_GRID, tiles, pois: [] };
  const lay = (pos: HexPos, biome: Biome) => {
    const t = tileAt(map, pos);
    if (!t) return undefined;
    t.biome = biome;
    t.h = HEIGHT[biome];
    return t;
  };
  // The square: cobbles under the place everyone arrives and two rings round it. And under the sparring ring.
  for (const p of [...HARBOR_SQUARE, HARBOR_RING]) lay(p, "cobble");
  // The housing island's paths and plots are open grass, whatever grew there; and the bridge is planking, shore to shore.
  for (const road of HARBOR_HOME_ROADS) for (const p of roadHexes(road)) if (tileAt(map, p)?.biome !== "water") lay(p, "plains");
  for (const p of HARBOR_BRIDGE) lay(p, "dock");
  // The cobbled streets, before the buildings that front them.
  for (const road of HARBOR_ROADS) if (road.kind === "cobble") for (const p of roadHexes(road)) lay(p, "cobble");
  // Each building's ground: its doorstep and the hexes it stands on, all level. Nobody walks through the building.
  for (const b of HARBOR_BUILDINGS) {
    lay(b.door, b.ground);
    for (const p of footing(b.door, b.shape, b.facing)) {
      const t = lay(p, b.ground);
      if (t) t.built = true;
    }
  }
  // The piers: planking from each pier head back to the shore.
  for (const head of HARBOR_PIERS) {
    let p = head;
    for (let i = 0; i < 6 && tileAt(map, p)?.biome === "water"; i++) {
      lay(p, "dock");
      // Straight back toward the land: up-right then up-left, so the planking does not wander off sideways.
      p = i % 2 ? { q: p.q, r: p.r - 1 } : { q: p.q + 1, r: p.r - 1 };
    }
  }
  // The lighthouse's point: bare ground round its doorstep, out into the sea, so the tower can be walked up to.
  for (const p of around(HARBOR_LIGHTHOUSE)) if (tileAt(map, p)?.biome === "water") lay(p, "mud");
  // The waygate's court, paved all round the gate; and the crane's mole, built out from the quay.
  for (const p of HARBOR_COURT) lay(p, "cobble");
  lay(HARBOR_MOLE, "cobble");
  // The caverns' forecourt: a paved terrace a step above the grass, and the two broad steps the lane climbs to it.
  for (const p of HARBOR_FORECOURT) lay(p, "cobble")!.h = HEIGHT.cobble + FORECOURT_RISE;
  HARBOR_CAVE_STEPS.forEach((p, i) => (lay(p, "cobble")!.h = HEIGHT.cobble + (FORECOURT_RISE * (i + 1)) / 3));
  // The big pieces of the town's dressing (the well, the stone figures, the crane) fill their hexes, as a building does.
  for (const p of HARBOR_FIXTURES) tileAt(map, p)!.built = true;
  // The caverns' mouth: rubble underfoot where the wall gives way to the rock, one more step up from the forecourt.
  lay(HARBOR_CAVE, "hills")!.h = HEIGHT.cobble + FORECOURT_RISE + 0.08;
  // The gathering spots keep the ground they are about.
  lay(HARBOR_GATHER.quarry, "hills");
  lay(HARBOR_GATHER.felling, "forest");
  // (The copse it stands in: the only woods left on the island.)
  for (const p of [at(8, 5), at(9, 5)]) lay(p, "forest");
  raiseOakHill(map);
  layPaths(map);
  map.pois = [
    harborPoi("board", "board", HARBOR_BOARD), harborPoi("shop", "shop", HARBOR_SHOP), harborPoi("ring", "ring", HARBOR_RING),
    harborPoi("pub", "pub", HARBOR_PUB), harborPoi("works", "works", HARBOR_WORKS),
    harborPoi("apothecary", "apothecary", HARBOR_APOTHECARY), harborPoi("smithy", "smithy", HARBOR_SMITHY),
    harborPoi("galley", "galley", HARBOR_GALLEY),
    harborPoi("lighthouse", "lighthouse", HARBOR_LIGHTHOUSE),
    harborPoi("lapidary", "lapidary", HARBOR_LAPIDARY),
    harborPoi("townchest", "townchest", HARBOR_CHEST),
    harborPoi("waygate", "waygate", HARBOR_WAYGATE),
    harborPoi("fishing", "fishing", HARBOR_GATHER.fishing),
    harborPoi("felling", "felling", HARBOR_GATHER.felling),
    harborPoi("quarry", "quarry", HARBOR_GATHER.quarry),
    harborPoi("cave", "cave", HARBOR_CAVE),
    ...HARBOR_ROCKS.map((p, i) => harborPoi(`rocks:${i}`, "rocks", p)),
    harborPoi("wreck", "wreck", HARBOR_WRECK),
  ].map((p) => {
    const facing = HARBOR_BUILDINGS.find((b) => b.id === p.id)?.facing;
    return facing ? { ...p, facing } : p;
  });
  return map;
}

/**
 * The oak's hill: its hex raised highest, with the oak on it; the six round it raised half as far; and tall
 * grass over all of them and over the open grass at the hill's foot.
 */
function raiseOakHill(map: WorldMap) {
  const top = tileAt(map, HARBOR_OAK);
  if (!top) return;
  top.h = HEIGHT.plains + 0.62;
  top.blocker = "oak";
  top.grass = "tall";
  const ring = around(HARBOR_OAK);
  for (const p of ring) {
    const t = tileAt(map, p);
    if (!t || t.biome !== "plains" || t.built) continue;
    t.h = HEIGHT.plains + 0.3;
    t.grass = "tall";
  }
  const hill = new Set([HARBOR_OAK, ...ring].map(keyOf));
  for (const p of ring.flatMap(around)) {
    const t = tileAt(map, p);
    if (!t || hill.has(keyOf(p)) || t.biome !== "plains" || t.built) continue;
    t.h = HEIGHT.plains + 0.09;
    t.grass = "tall";
  }
}

/** Ground a dirt path can be trodden into: open grass, not under a building. */
const trodden = (t: Tile | undefined): t is Tile => !!t && t.biome === "plains" && !t.built;
/** Ground a path can run up to and stop at: a street, the bare quay, the woods or the hills it leads into. */
const meets = (t: Tile | undefined) => !!t && !t.built && ["cobble", "mud", "dock", "forest", "hills"].includes(t.biome);

/**
 * Tread the dirt lanes into the grass: each step of a lane joins the two hexes it crosses between, on whichever
 * of them is grass. Then each building on the grass (a hut) gets a short path from its doorstep out to the road
 * in front of it, if one passes there.
 */
function layPaths(map: WorldMap) {
  const join = (a: HexPos, side: number) => {
    const d = HARBOR_SIDES[side];
    const b = { q: a.q + d.q, r: a.r + d.r };
    const ta = tileAt(map, a), tb = tileAt(map, b);
    if (!ta || !tb) return;
    const ok = (t: Tile, other: Tile) => trodden(t) && (trodden(other) || meets(other));
    if (ok(ta, tb)) ta.path = (ta.path ?? 0) | (1 << side);
    if (ok(tb, ta)) tb.path = (tb.path ?? 0) | (1 << ((side + 3) % 6));
  };
  for (const road of HARBOR_ROADS) {
    if (road.kind !== "dirt") continue;
    let p = road.from;
    for (const side of road.steps) {
      join(p, side);
      const d = HARBOR_SIDES[side];
      p = { q: p.q + d.q, r: p.r + d.r };
    }
  }
  for (const b of HARBOR_BUILDINGS) {
    if (!trodden(tileAt(map, b.door))) continue;
    for (const [i, front] of frontOf(b.door, b.facing).entries()) {
      const t = tileAt(map, front);
      if (!t || !(t.path || t.biome === "cobble")) continue;
      join(b.door, ([2, 3][i] + (b.facing ?? 0)) % 6);
      break;
    }
  }
}

/** Longest walk the server will accept in one request. */
export const HARBOR_MAX_PATH = 60;

/**
 * A walkable route between two Harbor hexes, or null. Every step costs the same here; the rampart cannot be
 * crossed, nor a building walked through, nor the water crossed without a boat. A barrel keeps to water beside
 * the land; a rowboat goes anywhere on it. Neither goes onto the rocks or the wreck.
 */
export function harborPath(map: WorldMap, from: HexPos, to: HexPos, vessel: Vessel | null = null): HexPos[] | null {
  const route = findPath(map, from, to, HARBOR_MAX_PATH, (t) => {
    if (t.biome === "rampart" || t.built || t.blocker) return Infinity;
    if (t.biome !== "water") return 1;
    if (!vessel || HAZARDS.has(`${t.q},${t.r}`)) return Infinity;
    return vessel === "rowboat" || coastal(map, t) ? 1 : Infinity;
  });
  return route && route.path.length > 0 ? route.path : null;
}

/** The rocks and the wreck stand in the water: no boat goes onto them. */
const HAZARDS = new Set([...HARBOR_ROCKS, HARBOR_WRECK].map((p) => `${p.q},${p.r}`));

/** Water beside land (or a pier): where a barrel can go. */
export function coastal(map: WorldMap, p: HexPos): boolean {
  return around(p).some((n) => {
    const t = tileAt(map, n);
    return !!t && t.biome !== "water";
  });
}

/** A water hex at the edge of the map: from here a rowboat can row out to the open sea. */
export function seaEdge(map: WorldMap, p: HexPos): boolean {
  return tileAt(map, p)?.biome === "water" && around(p).some((n) => !tileAt(map, n));
}

/**
 * The fishing spot for a hero afloat on a water hex: by the rocks or the wreck; otherwise the coast's water by
 * which side of the island it is on. Null on land.
 */
export function waterSpotAt(map: WorldMap, p: HexPos): Exclude<FishSpot, "west" | "middle" | "east" | "shore" | "sea"> | null {
  if (tileAt(map, p)?.biome !== "water") return null;
  if ([...HAZARDS].some((k) => around(p).some((n) => `${n.q},${n.r}` === k))) return "wreck";
  const col = p.q + Math.floor(p.r / 2);
  const mid = HARBOR_SPAWN.q + Math.floor(HARBOR_SPAWN.r / 2);
  return col <= mid - 4 ? "coast_west" : col >= mid + 5 ? "coast_east" : "coast_south";
}

// ---------- wire types ----------

export interface HarborPlayer {
  id: string;
  name: string;
  classId: string;
  level: number;
  /** XP into their current level, for the bar over their head. Absent from presence saved before it was sent. */
  xp?: number;
  pos: HexPos;
  /** What they are visibly wearing. */
  outfit?: Outfit;
  /** Where their bedroll is laid out, until they walk off. */
  bedroll?: HexPos;
  /** Fishing at the pier they stand on, rod in hand, until they stop or walk off. */
  fishing?: boolean;
  /** The best boat they own: drawn under them whenever they are on the water. */
  vessel?: Vessel | null;
  /** They have filled the Catch Book: their rod is gilded. */
  gilded?: boolean;
  /** In a hut: the bed (a furnishing id) they are lying on after a rest, until they walk off. */
  bed?: number;
}

/**
 * What anyone sharing a crew or a map may see of a hero, for the sheet
 * that opens on hovering or clicking them. Game facts only: no email, no
 * gold, nothing in their pack or at home.
 */
export interface PublicHero {
  id: string;
  name: string;
  classId: string;
  level: number;
  /** XP into the current level. */
  xp: number;
  /** Stats without gear, and what the worn gear adds. */
  base: Stats;
  bonus: Partial<Stats>;
  weaponPower: number;
  armor: number;
  /** What they wear, one item per slot. */
  gear: ItemDef[];
  /** How they chose to look, if they did. */
  appearance?: Appearance;
}

export interface HarborMember {
  id: string;
  name: string;
  classId: string;
  level: number;
  /** How big their hut is, so its building can be drawn to match. Absent from boards saved before tiers. */
  hutTier?: number;
  /** Which plot they have bought (an index into HARBOR_PLOTS), or null while they sleep on a bedroll. */
  plot?: number | null;
  /**
   * What is in the resource bin on their plot while the shack is still to be
   * raised. Absent once the shack stands (and on boards saved before bins).
   */
  bin?: Resources;
  /** Out on a zone right now: which one, and whether they are in a fight there (nobody can teleport into one). */
  zone?: { code: string; fighting: boolean };
}

/** A map the crew has open out through the waygate: its code, the atlas node it was made for, and what the place is called. */
export interface HarborMap {
  code: string;
  node: string;
  place: string;
}

export interface HarborBoard {
  members: HarborMember[];
  /** The crew's shared projects and who gave what lately. */
  works?: HarborWorks;
  /**
   * The atlas maps the crew has open (made, not yet cleared, and walked on lately), the latest first. While there
   * is one the town's waygate stands open, and stepping through it goes there. Absent when there is none.
   */
  maps?: HarborMap[];
}

/**
 * A hero just earned XP at the Harbor, in a hut or at the pub. Sent by the
 * server once the award is written, to everyone in the room the hero is in:
 * their new level and XP for the plate, and the amount for the sparkle.
 */
export interface XpMessage {
  type: "xp";
  id: string;
  amount: number;
  level: number;
  xp: number;
  levelsGained: number;
}

export type HarborServerMessage =
  | ({ type: "snapshot"; you: string; crew: { id: string; name: string }; players: HarborPlayer[] } & HarborBoard)
  | ({ type: "board" } & HarborBoard)
  | { type: "joined"; player: HarborPlayer }
  | { type: "left"; id: string }
  | { type: "moved"; id: string; path: HexPos[] }
  /** Someone was put straight onto `pos` (no walk): a stuck hero sent back by "unstick". */
  | { type: "placed"; id: string; pos: HexPos }
  /** A walk you asked for was not made (no way there): you stand where you stood, on `pos`. Sent to you only, so a client that shows its own walks at the click can put the picture right. */
  | { type: "stayed"; id: string; pos: HexPos }
  | { type: "said"; id: string; name: string; text: string }
  /** A trade you are part of changed (opened, laid out, accepted, closed): ask the server for your trades again. Sent to that player only. */
  | { type: "trades" }
  /** The crew's muster as it now stands (muster.ts): someone is setting out and asks who is coming. Null: there is none any more. */
  | { type: "muster"; muster: Muster | null }
  | LookMessage
  | EmoteMessage
  | XpMessage;

export type HarborClientMessage =
  | { type: "move"; to: HexPos }
  | { type: "say"; text: string }
  | LookRequest
  | EmoteRequest
  /** "I changed my gear or level": the server re-reads the sender's character and tells everyone. */
  | { type: "refresh" }
  /** "I have just rested here": lay the sender's bedroll out where they stand, for everyone to see. */
  | { type: "bedroll" }
  /** "I have sat down to fish here" (or stood up again): the sender's hero holds a rod, for everyone to see. */
  | { type: "fishing"; on: boolean }
  /** "I am stuck or lost": put the sender's own hero back where heroes arrive. At most once per UNSTICK_COOLDOWN_MS. */
  | { type: "unstick" };

/**
 * Which way a hero is looking as they stand: toward wherever their player's pointer is on the ground. It is
 * only for show, so it is sent coarsely (one of LOOK_STEPS directions round the compass), at most every
 * LOOK_MIN_MS, relayed to everyone else in the same place and never kept: someone who walks in sees a hero
 * facing the way they last walked until that hero's player next moves the pointer.
 */
export const LOOK_STEPS = 32;
export const LOOK_MIN_MS = 120;
/** "I am looking this way": a step round the compass, 0 toward +z, turning toward +x. */
export type LookRequest = { type: "look"; look: number };
/** "They are looking this way". Not sent back to whoever is looking. */
export type LookMessage = { type: "looked"; id: string; look: number };
/** The step a turn about y, in radians, falls in; and the turn a step stands for. */
export const lookStep = (yaw: number) => ((Math.round((yaw / (Math.PI * 2)) * LOOK_STEPS) % LOOK_STEPS) + LOOK_STEPS) % LOOK_STEPS;
export const lookYaw = (step: number) => (step / LOOK_STEPS) * Math.PI * 2;
/** A look as a client sent it, if it is one: a whole step in range. */
export function validLook(look: unknown): number | null {
  return typeof look === "number" && Number.isInteger(look) && look >= 0 && look < LOOK_STEPS ? look : null;
}

/**
 * Emotes: a hero waves, cheers, bows, dabs, flosses, dances, does the running man or breakdances where they stand, for everyone in the same place to see. Only for
 * show, like a look: relayed to everyone there (the one emoting too) and never kept, at most one per EMOTE_MIN_MS.
 * In the Harbor, a hut, the pub and on a map, in a fight too (free, taking no turn), though not while down.
 */
export const EMOTES = ["wave", "cheer", "bow", "dab", "floss", "dance", "runningman", "breakdance"] as const;
export type Emote = (typeof EMOTES)[number];
export const EMOTE_MIN_MS = 800;
/** "I am waving" (or cheering, bowing, dancing). */
export type EmoteRequest = { type: "emote"; emote: Emote };
/** "They are waving". Sent to everyone in the place, whoever asked too. */
export type EmoteMessage = { type: "emoted"; id: string; emote: Emote };
/** An emote as a client sent it, if it is one. */
export function validEmote(emote: unknown): Emote | null {
  return (EMOTES as readonly unknown[]).includes(emote) ? (emote as Emote) : null;
}
/** The emote a line typed into chat asks for (`/wave`, `/cheer`, `/bow`, `/dab`, `/floss`, `/dance`, `/runningman`, `/breakdance`), or null for a line to say. */
export function emoteTyped(text: string): Emote | null {
  const m = /^\/(\w+)$/.exec(text.trim().toLowerCase());
  return m ? validEmote(m[1]) : null;
}

/** How often a hero may ask to be put back where they arrive (Harbor, hut or pub), per connection. */
export const UNSTICK_COOLDOWN_MS = 3000;

export const HARBOR_MAX_SAY = 200;
export const MAX_CREW = 40;
