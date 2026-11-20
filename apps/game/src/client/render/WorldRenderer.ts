// Three.js view of a place (the Harbor, a room, a map, the atlas): hex
// terrain with modelled figures standing on it. Imperative on purpose. React
// owns the HUD; this class owns the canvas and is told about state (setState)
// and things that just happened (playEvents).
//
// Fights are played on the map itself: enemies stand on their own hexes like the heroes do.

import * as THREE from "three";
import { flamesIn, flickerFlame, torchFlame } from "./torchFlame";
import { buildCaveDressing } from "./caveDressing";
import { reportEnv } from "../ui/env";
import { makeRenderer } from "./graphics";
import { apothecaryWallTexture, galleyWallTexture, lapidaryWallTexture, panelTexture, smithyWallTexture } from "./groundArt";
import { Ambience, type RoomLight, TILE_FILLET, TILE_RADIUS, TORCH_LIFT, dryPatch, hexTop, meadowAt, tallGrass, type BuildingGlow } from "./ambience";
import "./camera.css";
import { PINCH_PAN_SLACK, followIconSvg, readFollow, writeFollow } from "./cameraFollow";
import type { HexPos } from "@gantt-quest/core";
import { hexDistance } from "@gantt-quest/core";
import { lookStep, lookYaw, BASE_HEIGHT, HARBOR_HEART_AT, BIG_REACH, ENEMIES, HEX_DIRS, SEATS, tileCost, WALL_FACE_HALF, WALL_ITEM_BOTTOM, WALL_ITEM_TOP, hexAt, xpProgress, reachable, tileAt, wallFace, wallFaces, type Biome, type Clime, type Outfit, type Poi, type Tile, type WorldMap } from "@gantt-quest/world";
import { fancy, fancyGrass } from "./fancy";
import { NightLife } from "./nightlife";
import { Storm } from "./storm";
import { WIND_DIR, gustAt, setFieldWalkers, updateWind } from "./wind";
import { waveFlag } from "./flag";
import { OAK_SHAPES, Woods, tintOf, type BoulderSpot, type TreeSpot } from "./woods";
import { Gulls, type GullSpot } from "./gulls";
import { OVERLAY_LAYER, PostFx, type Air } from "./post";
import { fishMount } from "./catchArt";
import { FRAME, OUTLINE, SITTING_DROP, inflate, makeFigure, type Figure } from "./figures";
import { HIDES, hidingMaterial } from "./silhouette";
import { BOAT_SCALE, OARLOCKS, ROWER_SEAT, aimOar, rowboatModel, shipOar } from "./rowboat";
import { Rise } from "./rise";
import { gaze } from "../gaze";
import { NIGHT, VEIL_CLEAR_S, Veil } from "./veil";
import { VoidBackdrop, type BackdropKind } from "./backdrop";
import { CAVE_FLOOR, ZoneScenery } from "./zoneScenery";
import { CombatView, cutawayButton, type CutSpot } from "./cutaway";
import type { Waygate } from "./waygate";
import { HoverGlow } from "./hoverGlow";
import { buildTownDressing, type TownDressing } from "./townDressing";
import { GROUND_KIND, addFancyWater, addWaterRipple, setGroundFine, setGroundWet, setWaterNight, setWaterStanding, shoreSide, updateWater, waterAttribute, type Standing } from "./water";
import { ghostModel, propModel, tintGhost, type LightKind } from "./props";
import { LAMP_TABLES, TableLamps } from "./tableLamps";
import { LID_OPEN, chestMouth, crateMiddle, restingLid, sharedShape } from "./caveProps";
import { PLACE_MODELS } from "./places";
import { placeKit } from "./places/kit";
import { SQRT3, UP, hexToWorld, placeOf, yawOf } from "./places/placing";
import { nearWater, openEar, sounds } from "../audio/gameSounds";
import type { AttackStyle, Fighter } from "../audio/names";
import { PUFFS, footfalls, stepGround, worldToHex, type PuffLook } from "./footsteps";
import { badgeTexture, badgesKey, bubbleTexture, fxTexture, labelTexture, lookFor, plateKey, sleepZTexture, spriteKey, textTexture, type Badge, type FxKind, type PlateStats } from "./sprites";

/** Spells fly as a coloured bolt; these are their colours, by ability name. */
const SPELL_COLOR: Record<string, string> = {
  Shock: "#c4b5fd",
  "Slicing Wind": "#dff4ff",
  Waterbolt: "#38bdf8",
  "Lightning Strike": "#ffe98a",
  "Dark Bolt": "#b06cff",
  Immolate: "#ff6a3c",
};
const ARROW_ABILITIES = new Set(["Shot", "Volley", "Barbed Arrow"]);
/** Thrown things: a rock lobbed in an arc, tumbling, that bursts into dust where it lands. */
const THROWN: Record<string, string> = { "Hurl Rock": "#77726a" };
/** Melee blows heavy enough to knock the target back and raise dust at its feet. */
const SMASHES = new Set(["Club Smash"]);
/**
 * Melee blows struck as the figure's heavy strike (see Figure.strike), a great two-handed sweep or with a blade
 * in each hand both tossed and jabbed down: the smashes, and the other all-or-nothing swings.
 */
const HEAVY_SWINGS = new Set([...SMASHES, "Cleave", "Eviscerate", "Crushing Maul", "Crushing Strike", "Sweeping Ruin", "Stone Fist", "Shockwave"]);
/** A ground-pound (the ogre's Stomp, the guardian's Quake): no step in; the ground shakes out from the attacker's feet and jolts whoever it reaches. */
const QUAKES = new Set(["Stomp", "Quake"]);
/** How an attack travels, for its sound: the same split the effects above are drawn by. */
const attackStyle = (ability: string): AttackStyle => (SPELL_COLOR[ability] ? "magic" : ARROW_ABILITIES.has(ability) || THROWN[ability] ? "ranged" : "melee");
const isBoss = (kind: string) => !!ENEMIES[kind]?.boss;
/** Rank-and-file drawn a size up: the heavy hitters. */
const isBig = (kind: string) => kind === "brute" || kind === "bear" || kind === "snow_bear" || kind === "ogre" || kind === "troll";

/** Seconds between one pickup told over a hero's head and the next. */
const PICKUP_GAP = 0.55;

/** Something that just happened in a room, for the renderer to animate: a walk, or XP coming in. */
export type SceneEvent =
  | { t: "moved"; heroId: string; path: HexPos[] }
  | { t: "xp"; heroId: string; amount: number }
  | { t: "level_up"; heroId: string; level: number };

/** What the renderer needs to draw a scene. Each place (the Harbor, a hut, the pub, a map, the atlas) builds one by hand. */
export interface RenderState {
  /** Identifies the map; the terrain is rebuilt when it changes. */
  code: string;
  /** Under ground (no sea or sky, and heroes carry torches), or the pub (its own walls). Absent anywhere else. */
  kind?: "caverns" | "pub";
  you: string;
  map: WorldMap;
  /** `asleep`: lying down with eyes shut, z's rising, as on a bedroll in the Harbor. */
  heroes: RenderHero[];
  /** A zone's enemies: each stands on its own hex, with a bar of what it has left once it is in a fight. */
  units?: RenderUnit[];
  /**
   * Torches lying lit on the ground, underground (a zone in the caves): these light where they lie, and of the
   * heroes only those holding a torch carry light.
   */
  lights?: HexPos[];
  /**
   * Where the viewer can walk, worked out by the caller (a zone's rules know about cliffs, bodies in the way
   * and what is left of a turn's movement). When set it is used as it stands: the tiles lit, the marker
   * under the pointer and the dots along the way all come from it.
   */
  reach?: Map<string, { cost: number; prev: string | null; pos: HexPos; way?: HexPos[] }>;
  /** No turns or movement points: the viewer may walk anywhere reachable, and tiles are not lit. */
  freeRoam?: boolean;
  /** Furniture standing on hexes (a hut's room). Each blocks the hex it is on. */
  props?: SceneProp[];
  /** Inside a building: no sea or sky around the map, and the camera starts closer. */
  indoors?: boolean;
  /** Inside a hut with its hanging lamp put out: the room is lit by its own candles, lanterns and fires. */
  lampOff?: boolean;
  /** With `lampOff`: a room kept dim for the mood of it, each small light a pool with dark between (the apothecary's shop). */
  gloom?: boolean;
  /** How a room's walls are dressed inside: the pub's oak and plaster, the smithy's stone and sooted timber, the apothecary's green wainscot and paper, the galley's oxblood boards, tiles and limewash, the Lapidary's slate-blue boards and stencilled plaster. The pub's is the default for the pub; other rooms have bare walls without it. */
  walls?: WallDressing;
  /** What a room's floor is laid with: boards (the default) or flagstones (the smithy). */
  floor?: "planks" | "flags";
  /** Your gathering outings, shown as lightning bolts on your own plate. */
  stamina?: { left: number; max: number };
  /** A piece being carried: a ghost of it follows the pointer, and a click sets it down (RendererCallbacks.onPlace). */
  holding?: Holding | null;
  /**
   * The turn the view opens at, in radians (0 is from the south, squared to the rows of hexes). A town laid out
   * on the grid is opened a little off it, so its streets do not run dead level across the screen. The turn
   * buttons step round from here by sixths, so they come back to it.
   */
  homeYaw?: number;
  /**
   * A map of the world, looked at from a long way up (the atlas): the camera starts well back and can pull back
   * further, and the land is dressed as a small world, with little trees in clumps, small peaks on its hills and
   * its painted ground drawn finer.
   *
   * Such a map may be one window of a world too big to hold (its tiles at the world's own hexes, not counted
   * from a corner, and none at all where the view draws something of its own over the world, as the atlas does
   * its cloud). Hand over another window under the same `code` and the ground is redrawn while the camera stays
   * where it is, so the world goes on past where the last window ended. The distance is lost in mist well
   * before a window's edge, so the edge is never seen.
   */
  far?: boolean;
  /**
   * What lies round the map. "sea" (or nothing said) is the open sea. Any other is a void the land floats over as
   * a thick slab of rock, with slow cloud below and the distance lost in haze (render/backdrop.ts): `mist` pale
   * grey-green, `abyss` near-black blue with drifting motes, `lava` a molten glow from underneath, `frost` a pale
   * blue sea of cloud, `dusk` warm sand-coloured haze. Each leans on the day's light in its own way.
   */
  backdrop?: BackdropKind;
}

/** The ways a room's walls can be dressed inside (see RenderState.walls). */
export type WallDressing = "pub" | "smithy" | "apothecary" | "galley" | "lapidary";
const WALL_DRESSINGS: Record<WallDressing, () => THREE.CanvasTexture> = { pub: panelTexture, smithy: smithyWallTexture, apothecary: apothecaryWallTexture, galley: galleyWallTexture, lapidary: lapidaryWallTexture };

/** An enemy standing on a hex of its own. */
export interface RenderUnit {
  id: string;
  /** The enemy kind: drives the figure. */
  kind: string;
  pos: HexPos;
  name?: string;
  /** Shown as a bar over its head when set: 0 to 1 of what it can take. */
  hp?: number;
  down?: boolean;
  /** Knocked flat (Prone) but still in the fight. */
  prone?: boolean;
  /** Whose turn it is. */
  active?: boolean;
  /** In a fight: it wears a red ring. */
  hostile?: boolean;
  /** Conditions on it, badged over its head. */
  effects?: Badge[];
}

/**
 * Someone drawn standing on the map. A player's hero carries `level` (and,
 * on a zone's map, `hp`), which puts a plate over their head: the level, the
 * name, an HP bar and an XP bar. Without `level` it is a plain name tag.
 */
export interface RenderHero {
  id: string;
  classId: string;
  pos: HexPos;
  /** The name tag. A zone's heroes have none set, so their `name` is used once they have a plate. */
  label?: string;
  name?: string;
  outfit?: Outfit;
  /** `asleep`: lying down with eyes shut, z's rising, as on a bedroll in the Harbor. */
  asleep?: boolean;
  /** Holding a fishing rod (fishing off a pier). */
  rod?: boolean | "gilded";
  /** Afloat: the boat drawn under them. */
  boat?: "barrel" | "rowboat";
  /** Drawn at this point of its hex instead of the middle, `y` above the floor: lying on a bed in a hut. */
  at?: { x: number; z: number; y: number };
  level?: number;
  /** XP into the current level. */
  xp?: number;
  /** Absent off a zone's map, where every hero is at full health. */
  hp?: number;
  maxHp?: number;
  /** Points of shield (Bolstered), drawn as a pale stretch after the HP. */
  shield?: number;
  /** Knocked down in a fight: drawn lying where they fell. */
  down?: boolean;
  /** Knocked flat (Prone) but still in the fight: lying, not dimmed. */
  prone?: boolean;
  /** Unseen (Sneak): drawn thinned out. */
  unseen?: boolean;
  /** Whose turn it is in a fight on the tiles: their ring pulses. */
  active?: boolean;
  /** Holding a lit torch: underground, its light goes where they go. */
  torch?: boolean;
  /** Conditions on them, badged over their head. */
  effects?: Badge[];
}

/** The first word of a name, for a plate: "Ewan Driftwood" is "Ewan". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** A hero's plate stats, or nothing for someone who is not a player's hero. */
export function plateOf(h: RenderHero): PlateStats | undefined {
  if (h.level === undefined) return undefined;
  const hp = h.hp !== undefined && h.maxHp ? h.hp / h.maxHp : 1;
  const shield = h.shield && h.maxHp ? h.shield / h.maxHp : 0;
  return { level: h.level, hp, xp: xpProgress(h.level, h.xp ?? 0), ...(shield > 0 ? { shield } : {}) };
}

export interface SceneProp {
  id: string | number;
  /** Which model to draw; see render/props.ts. */
  model: string;
  pos: HexPos;
  /** 0 to 5, in sixths of a turn. A wall piece: which side of its wall hex it hangs on. */
  facing: number;
  /** Ringed, to show it is the one being handled. */
  selected?: boolean;
  /** A mounted fish: the catch hung on it, drawn at its real size in place of the empty board. */
  fish?: { species: string; mm: number } | null;
  /** A small thing: stepped over, not walked around. */
  small?: boolean;
  /** Hung on a wall: `pos` is the wall hex, `facing` the side, `x` along it and `y` up from the floor. */
  mount?: boolean;
  /** Offset from the middle of its hex (or of its support's top), and its turn in radians on top of `facing`. */
  x?: number;
  z?: number;
  y?: number;
  angle?: number;
  /** How far out its selection ring goes. */
  ring?: number;
  /** The hexes it covers, when that is more than its own (see hutroom.ts, coveredHexes): kept clear of people unless it is `flat`, and outlined when selected. Small things and wall pieces cover none. */
  covers?: HexPos[];
  /** Floor decor (a rug): walked over, and other pieces stand on it. */
  flat?: boolean;
  /** The prop it stands on; then x/z/angle are in that prop's own frame. */
  on?: string | number;
  /** Its flat top, in its own frame, for small things to stand on. */
  surface?: { y: number; w: number; d: number; x?: number; z?: number };
}

/** Where something carried would be set down: a hex, an offset in it, and (for a small thing on a top) the prop it stands on. */
export interface PlaceTarget {
  pos: HexPos;
  x: number;
  z: number;
  on?: string | number;
  /** On a wall: `pos` is the wall hex, `x` how far along this side of it, `y` how high. */
  wall?: { side: number; y: number };
}

/** Something being carried, to be set down where the pointer is. */
export interface Holding {
  model: string;
  small: boolean;
  /** A wall piece's face, w wide and h tall: it is aimed at the walls, not the floor. */
  mount?: { w: number; h: number };
  /**
   * A floor piece's footprint, in its own frame (see hut.ts, Footprint): drawn
   * under the ghost, and for a long piece reaching across hexes, held by its
   * middle rather than by the hex it is anchored on.
   */
  footprint?: { w: number; d: number; x?: number; z?: number; round?: boolean };
  /** Its turn: `facing` sixths plus `angle` radians. */
  facing: number;
  angle: number;
}

/** Furthest a free-roaming walk may be previewed; matches the Harbor's server-side limit. */
const FREE_ROAM_REACH = 60;
/** Seconds to get up onto a stool, and to get off one. */
/** The hexes that stand up as walls: whoever is behind one is shown through it (see silhouette.ts). */
const WALLS: ReadonlySet<string> = new Set(["wall", "rock", "rampart"]);
/** An enemy in a fight: its ring, and its shape seen through what hides it. */
const ENEMY_RED = "#e23b3b";
const SIT_S = 0.45;
const STAND_S = 0.2;
/**
 * A jump from tile to tile (see leapUnit): how long it is off the ground and how high it goes at the top, each a
 * base and so much more per world unit jumped; the longest it is ever in the air; how far it clears the lip of
 * a ledge it is jumping up onto; and how far into the jump's sound the thud of the landing is.
 */
const LEAP = { air: 0.3, airPer: 0.045, longest: 0.56, high: 0.45, highPer: 0.13, clear: 0.45, thud: 0.3 };

/**
 * The world is drawn at full resolution and smoothed. What is read (plates, speech) is still drawn in chunky
 * pixels, PIXEL screen pixels each, so it keeps its size.
 */
const PIXEL = 2;
/** Nearest and farthest the camera may sit from what it looks at. */
const MIN_ZOOM = 7;
const MAX_ZOOM = 40;
/** On a map of the world (RenderState.far): how far back the camera may pull, and where it starts. */
const FAR_MAX_ZOOM = 66;
const FAR_ZOOM = 40;
/** And how much finer its painted ground and water are drawn than a map a hero walks on. */
const FAR_FINE = 2.6;
/** Below 1 makes a pinch zoom less than the fingers move. */
const PINCH_DAMPING = 0.55;
/** The angle equal to `to` (mod a full turn) that is closest to `from`, so easing takes the short way round. */
function nearestTurn(from: number, to: number): number {
  const full = Math.PI * 2;
  return to + Math.round((from - to) / full) * full;
}
/** Keys that slide the view, as [right, forward]. */
/** A backdrop's place in the sound: none. It hears nothing and is not heard. */
const DEAF: ReturnType<typeof openEar> = { listener() {}, sky() {}, lights() {}, ground() {}, sea() {}, close() {} };
/** How many windows wide the view through a room's windows is: they show one picture between them, side by side. */
const OUTLOOK_PANES = 4;
/** A window's size on the wall, and how far up the wall its middle is. */
const PANE = { w: 0.78, h: 0.62, y: 1.12 };

const PAN_KEYS: Record<string, [number, number]> = {
  w: [0, 1], s: [0, -1], a: [-1, 0], d: [1, 0],
  arrowup: [0, 1], arrowdown: [0, -1], arrowleft: [-1, 0], arrowright: [1, 0],
};
/** Seconds between tellings of which way your own hero looks. */
const LOOK_SEND_S = 0.15;
/** How long a figure lying down is, as a share of its size: its tag hangs over the middle of it. */
const LYING = 0.45;
/** How long a shove that knocks someone off their feet keeps them down, at least, before they get up (longer if Prone). */
const FLOORED_S = 1.4;
/** The turn, about y, from `from` to `to` by the shorter way round. */
const turnBy = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
/** The camera's usual tilt (about 47° above the horizon) and how far it may be tipped. */
const DEFAULT_PITCH = Math.atan2(0.78, 0.72);
const MIN_PITCH = 0.42;
const MAX_PITCH = 1.25;
/** In a fight, with the combat view on, the camera looks down this much more steeply than the player has it (see `pitchWanted`). */
const COMBAT_LIFT = 0.15;
/** Camera distance per unit of zoom, kept from when the tilt was fixed. */
const CAMERA_REACH = Math.hypot(0.72, 0.78);
const PLAYER_COLORS = ["#ffd23f", "#5ce1e6", "#ff7ab6", "#9dff6b"];
const BIOME_COLOR: Record<string, string> = { plains: "#7cb856", forest: "#4c9a52", hills: "#a39672", water: "#3f86dc", dock: "#9a7748", cobble: "#6f7279", mud: "#5f5140", rampart: "#6c6f55", floor: "#b08a5c", wall: "#6e5a48", cave: "#4a4552", rock: "#2a2730", gate: "#4a4552", fog: "#2b3140", sand: "#e2d09a", paved: "#8b8f98" };
/**
 * How the ground is painted in each climate that is not the greenwood (Tile.clime): the same kinds of ground,
 * in that climate's own colours. Snowfields and blue ice in the frost; sand, scrub and red rock in the dunes;
 * moss, mud and dark water in the mire; cinders and black rock in the ashlands.
 */
const CLIME_COLOR: Record<Exclude<Clime, "greenwood">, Partial<Record<Biome, string>>> = {
  frost: { plains: "#e6edf4", forest: "#cfdbe6", hills: "#a3afbf", sand: "#b9dcec", water: "#2b5a8a", rock: "#8793a4", paved: "#9aa6b8" },
  dunes: { plains: "#d9aa66", forest: "#c2965a", hills: "#ad5c38", sand: "#ead29a", water: "#2f9ea4", rock: "#874830", paved: "#cdab7c" },
  mire: { plains: "#586a3a", forest: "#3f5238", hills: "#625d4c", sand: "#66553a", water: "#3b5a44", rock: "#3a372e", paved: "#69725f" },
  ash: { plains: "#58525d", forest: "#443d46", hills: "#36303a", sand: "#29232b", water: "#3b3340", rock: "#221e26", paved: "#4d4751" },
};
/** The ashlands' lowest ground is molten: far brighter than anything lit can be, so it glows where there is glow to be had. */
const MOLTEN = new THREE.Color(1.5, 0.4, 0.07);
const MOLTEN_DEEP = new THREE.Color(0.7, 0.11, 0.03);
/** What a loose stone's own colour is multiplied by in a climate: the stone there is not the greenwood's grey. */
const ROCK_TINT: Partial<Record<Clime, THREE.Color>> = { frost: new THREE.Color(1.3, 1.36, 1.46), dunes: new THREE.Color(1.3, 0.8, 0.55), mire: new THREE.Color(0.74, 0.74, 0.6), ash: new THREE.Color(0.44, 0.41, 0.47) };
/** Such a hex is molten (and not the cooled crust beside it) when it lies this low. */
const MOLTEN_BELOW = 0.09;
/** On a map of the world the greenwood is painted a little deeper than underfoot: seen whole, the brighter greens are too much. */
const FAR_COLOR: Partial<Record<Biome, string>> = { plains: "#6c9c4b", forest: "#3f7b47", hills: "#93886b", sand: "#d8c58f", water: "#2c72c0" };
/** What a tree's own colours are multiplied by in a climate: rimed with frost, dark with wet, charred. */
const TREE_TINT: Partial<Record<Clime, THREE.Color>> = { frost: new THREE.Color(1.22, 1.5, 1.72), mire: new THREE.Color(0.72, 0.82, 0.6), ash: new THREE.Color(0.42, 0.38, 0.4), dunes: new THREE.Color(1.15, 1.0, 0.78) };
/** How much of a greenwood's trees stand in a climate's woods. */
const TREE_SHARE: Partial<Record<Clime, number>> = { dunes: 0.3, ash: 0.5, mire: 0.75 };
/** Which painted detail a hex of ground gets on top (see GROUND_KIND), by its climate: a snowfield has no flowers in it. */
const groundKind = (t: Tile): number => {
  // Laid stone is laid stone in every climate.
  if (t.biome === "paved") return GROUND_KIND.paved;
  if (!t.clime) return GROUND_KIND[t.biome] ?? 0;
  if (t.biome === "water") return 0;
  if (t.clime === "ash" && t.biome === "sand" && t.h < MOLTEN_BELOW) return 0;
  return t.clime === "mire" && (t.biome === "plains" || t.biome === "forest") ? 2 : 3;
};
/** How the water of a climate is told to the shader (see water.ts): 0 the sea as it is, 1 cold, 2 dark and still, 3 clear and green. */
const WATER_KIND: Partial<Record<Clime, number>> = { frost: 1, mire: 2, dunes: 3 };

/** What grass and trees are pulled toward under the Harbor's low cloud. */
const DRAB = new THREE.Color("#5d6a5c");
/** What open grass is pulled toward where it has dried out (see dryPatch): straw under dead grass, dusty brown on dry ground. */
const PARCHED = new THREE.Color("#a59a5a");
const DUSTY = new THREE.Color("#9a835a");
/** The pub's painted sign: a foaming tankard on an oxblood board with a gold edge. Made once and shared. */
let pubSignTexture: THREE.CanvasTexture | null = null;
function pubSign(): THREE.CanvasTexture {
  pubSignTexture ??= pixelTexture(16, 14, (ctx) => {
    ctx.fillStyle = "#6e2b26";
    ctx.fillRect(0, 0, 16, 14);
    stamp(ctx, [
      "BBBBBBBBBBBBBBBB",
      "B              B",
      "B    W  WW     B",
      "B   WWWWWWW    B",
      "B  WWWWWWWWW   B",
      "B   hhhhhhh    B",
      "B   YyYYyYYYY  B",
      "B   YyYYyYY  Y B",
      "B   hhhhhhh  Y B",
      "B   YyYYyYY  Y B",
      "B   YyYYyYYYY  B",
      "B   hhhhhhh    B",
      "B              B",
      "BBBBBBBBBBBBBBBB",
    ], { B: "#d9b45a", W: "#f4efe1", Y: "#d08a3a", y: "#a8662a", h: "#3a2c22" });
  });
  return pubSignTexture;
}
/**
 * Fold a model's pieces that share a look into one mesh each, so a detailed building costs a handful of draw calls
 * rather than one a piece. Plain lambert pieces of the same colour fold together; a piece with any other material
 * (a pane the ambience warms, the painted sign) folds only with pieces using that very material. Glows stay apart.
 */
function foldByLook(g: THREE.Group) {
  const sets = new Map<string, THREE.Mesh[]>();
  for (const o of g.children) {
    if (!(o instanceof THREE.Mesh)) continue;
    const m = o.material as THREE.Material;
    const key = (m instanceof THREE.MeshLambertMaterial && !m.map ? `lambert:${m.color.getHexString()}` : m.uuid) + (o.userData.glow ? ":glow" : "");
    const set = sets.get(key);
    if (set) set.push(o);
    else sets.set(key, [o]);
  }
  for (const meshes of sets.values()) {
    if (meshes.length < 2) continue;
    const parts = meshes.map((mesh) => {
      mesh.updateMatrix();
      const geo = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrix);
      geo.clearGroups();
      return geo;
    });
    const folded = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!folded) continue;
    const mesh = new THREE.Mesh(folded, meshes[0].material);
    mesh.userData.glow = meshes[0].userData.glow;
    for (const m of meshes) {
      g.remove(m);
      m.geometry.dispose();
    }
    g.add(mesh);
  }
}
/** The places that are buildings: inked round with a dark line, like the people, so a hero and the house behind them are drawn alike. */
const BUILDINGS = new Set<Poi["kind"]>(["hut", "plot", "pub", "shop", "works", "lighthouse", "apothecary", "smithy", "galley", "lapidary", "fishing"]);
/**
 * How thick a building's outline is, in world units: a hero's (a 0.12 edge on their 22-unit frame, drawn 1.5
 * tall), made heavier so a building's big plain walls and roofs read as inked from across the plaza.
 */
const BUILDING_EDGE = (0.12 / FRAME) * 1.5 * 1.8;
const INK = new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide });
/** Shapes that are only a face, with no inside: an outline shell round them would show as a dark sheet behind. */
const FLAT_SHAPES = new Set(["PlaneGeometry", "ShapeGeometry", "CircleGeometry", "RingGeometry"]);
/**
 * Ink a building, as the people are inked (figures.ts): round every solid, lit piece of it, a dark shell a
 * little larger than the piece, drawn from the inside only, so it shows as a line round its edges. `scale` is
 * how much the building is drawn larger than its model, so the line is the same width on a hut as on the pub.
 */
function inkBuilding(g: THREE.Group, scale: number) {
  g.updateMatrixWorld(true);
  const toModel = new THREE.Matrix4().copy(g.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const size = new THREE.Vector3();
  const pieces: THREE.Mesh[] = [];
  g.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.userData.glow || o.userData.ink) return;
    const m = o.material as THREE.Material;
    if (!(m instanceof THREE.MeshLambertMaterial) || m.transparent || FLAT_SHAPES.has(o.geometry.type)) return;
    pieces.push(o);
  });
  for (const piece of pieces) {
    // How much larger than its own geometry the piece is drawn, inside the model.
    local.multiplyMatrices(toModel, piece.matrixWorld).decompose(new THREE.Vector3(), new THREE.Quaternion(), size);
    const k = (size.x + size.y + size.z) / 3;
    const geo = piece.geometry.index ? piece.geometry.toNonIndexed() : piece.geometry;
    const shell = new THREE.Mesh(inflate(geo, BUILDING_EDGE / (scale * k)), INK);
    if (geo !== piece.geometry) geo.dispose();
    shell.userData.ink = true;
    piece.add(shell);
  }
}
/** The open sea at the dead of night. */
const NIGHT_SEA = new THREE.Color("#0f1a33");
/** On a map of the world (RenderState.far): what lies under everything the map does not hold, and what the distance is lost in. */
const FAR_FLOOR = new THREE.Color("#4d5568");
export const FAR_MIST = new THREE.Color("#aeb9cf");
/**
 * How far off the distance begins to be lost and where it is gone, in world units past what the camera looks at.
 * On a map of the world the mist closes in just past what the view shows; everywhere else under the open sky it
 * only softens the far sea into the sky, so the sea has no edge.
 */
const MIST = { far: [20, 54], open: [90, 420] } as const;
/** The time of day a map of the world is held at: mid-afternoon, the light warm and the shadows long enough to shape the land. */
const FAR_TIME = 0.6;
/** And the sea there: cold and grey-green. */
const GREY_SEA = new THREE.Color("#2f4a5f");

// Where a hex is in the world: kept with how places are stood (places/placing.ts), and still given out from here.
export { hexToWorld };

export const tileTop = (t: Tile | undefined) => (!t ? 0.2 : t.biome === "water" ? 0.14 : 0.35 + t.h * 1.1);
/** A room's floor, which wall pieces' heights are measured from. */
const FLOOR_TOP = tileTop({ q: 0, r: 0, biome: "floor", h: BASE_HEIGHT.floor });
/** How high the hover marker's column of light rises, in world units. */
const HOVER_BEAM = 1.5;

/** A small square texture filled with a gradient: for soft light that fades away (the hover marker's glow, column and motes). */
function gradientTexture(fill: (ctx: CanvasRenderingContext2D, size: number) => CanvasGradient): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = fill(ctx, size);
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A crew member's plot in the Harbor, at each stage: for sale, a building site, a hut. */
const HUT_KINDS = new Set<Poi["kind"]>(["lot", "site", "plot"]);
const key = (p: HexPos) => `${p.q},${p.r}`;

/** To the nearest thousandth, so offsets sent to the server stay short. */
const round = (n: number) => Math.round(n * 1000) / 1000;
/** The hour the ambience is held at under a roof (the `dark` backdrop): it is not seen, and nothing of the night comes out by it. */
const ROOF_TIME = 0.5;
/** What is heard of the sky there: nothing. And how far toward the night's glow the picture is finished (see post.ts). */
const ROOF_SKY = { time: 0.5, night: 0, rain: 0, storm: 0 };
const ROOF_GLOW = 0.8;
/** Still water under a roof or under ground, where there is no sky in it. */
const DARK_WATER = "#16303f";
/** Nothing of the ground is drawn below this: y = 0. */
const GROUND_FLOOR = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
/** How many frames a view is drawn under its veil once its place is built, before the veil opens: time for shadows and lights to settle. */
const REVEAL_FRAMES = 4;
/** A hex of ground reaches this far down from its top: further than the tallest rock stands, so its foot is always under the sea. */
const TILE_DEPTH = 3;
/**
 * One hex of ground: a column with its top at y = 0, the rim of the top rounded over into the wall (see hexTop).
 * A point toward +z, like the cylinder it replaces. Its height is never scaled (an instance is placed with its
 * top where it belongs), so the rounding is the same on a low hex as on a high one.
 */
function hexColumn(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const vertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
  };
  hexTop(vertex);
  for (let i = 0; i < 6; i++) {
    const [ax, az] = [Math.sin((i * Math.PI) / 3) * TILE_RADIUS, Math.cos((i * Math.PI) / 3) * TILE_RADIUS];
    const [bx, bz] = [Math.sin(((i + 1) * Math.PI) / 3) * TILE_RADIUS, Math.cos(((i + 1) * Math.PI) / 3) * TILE_RADIUS];
    const [ox, oz] = [Math.sin(((i + 0.5) * Math.PI) / 3), Math.cos(((i + 0.5) * Math.PI) / 3)];
    for (const [x, y, z] of [[ax, -TILE_FILLET, az], [ax, -TILE_DEPTH, az], [bx, -TILE_DEPTH, bz], [ax, -TILE_FILLET, az], [bx, -TILE_DEPTH, bz], [bx, -TILE_FILLET, bz]]) vertex(x, y, z, ox, 0, oz);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return geo;
}

/** Small deterministic hash for per-tile variation. */
const noise = (q: number, r: number, salt: number) => {
  const n = Math.sin(q * 127.1 + r * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

interface Unit {
  /** Knocked across the ground (a shove): moved this many times faster than a walk, without steps, until it arrives. */
  rush?: number;
  /** Going into a pit (see sink): until the render clock passes this, nothing else lays it out or clears it away. */
  sinkUntil?: number;
  /** Knocked off its feet: drawn lying until the render clock passes this. */
  floored?: number;
  /** Down in a fight, as last told. */
  down?: boolean;
  /** Its name tag goes once it is down and lying (see UnitWant.nameless). */
  nameless?: boolean;
  /**
   * Just killed, and still on its feet until the blow that did it lands: it falls (a ragdoll, see topple) at its
   * "down" beat, or failing one, when the render clock passes this.
   */
  dying?: number;
  /** Told it fell (see fell) before the picture had it down, at this time on the render clock, and to whom. */
  felled?: { at: number; by?: string; onDown?: () => void };
  /**
   * The waypoints in `path` that are jumped to, not walked: the Jump action (see leapUnit: true, and heard as
   * one), and any step of a walk that goes up or down a level of the ground (see walkUnit: false).
   */
  leaps?: Map<THREE.Vector3, boolean>;
  /**
   * The jump under way, to the next waypoint `to`: from `from`, the feet leaving the ground at `at` on the
   * render clock and off it for `air` seconds, `high` at the top of the arc.
   */
  leap?: { to: THREE.Vector3; from: THREE.Vector3; at: number; air: number; high: number };
  /** Afloat: the boat under them, which kind it is, and how far it sits them down. */
  boat?: THREE.Group | null;
  boatKind?: "barrel" | "rowboat";
  sunk?: number;
  /** On a stool's hex: sat on it once they have walked up to it. `seatTop` is how high the seat is off the floor, and `sit` how far onto it they are, 0 (standing) to 1. */
  seated?: boolean;
  seatTop?: number;
  sit?: number;
  /** Holding a fishing rod: in a rowboat, the oars are shipped and the hands left for the rod. */
  rod?: boolean;
  /** At the oars: how far round the stroke is (radians), and where it has the hands, 0 (forward) to 1 (pulled in). */
  oarPhase?: number;
  oarPull?: number;
  /** The model, and its root: where the unit stands (its feet) and which way it is turned. */
  figure: Figure;
  root: THREE.Group;
  /** How tall it is drawn, in world units. */
  size: number;
  /** Which way it faces, about y (0 is toward +z), and the way it is turning to. */
  turn: number;
  turnGoal: number;
  /** Lying down: out of the fight, or asleep. */
  lying: boolean;
  /** Where, which way round and how big its shadow was last drawn: a change asks the lights near it to redraw. */
  shadowAt: THREE.Vector3;
  shadowTurn: number;
  shadowSize: number;
  ring: THREE.Mesh | null;
  hpBack: THREE.Sprite | null;
  hpFill: THREE.Sprite | null;
  /** Its status badges, and what they were last drawn for. */
  badges?: THREE.Sprite | null;
  badgesKey?: string;
  label: THREE.Sprite | null;
  labelText: string;
  goal: THREE.Vector3;
  /** Waypoints still to walk before settling on `goal`. */
  path: THREE.Vector3[];
  /** Brief attack lunge, decays to zero. */
  kick: THREE.Vector3;
  /** Lean into an attack, in radians; decays to zero. */
  lean: number;
  /** Distance walked, which drives the hop, and the current hop height. */
  stride: number;
  bob: number;
  kind: string;
  /** What its tag should show, kept so the XP glow can redraw it between updates. */
  labelWant?: { label?: string; plate?: PlateStats; size: number; asleep?: boolean; stack?: number };
  /** The XP bar glows until this time on the render clock; `glowing` is whether it is drawn so now. */
  glowUntil: number;
  glowing: boolean;
  /** Lying down asleep; `nextZ` is when its next z rises, on the render clock. */
  asleep: boolean;
  nextZ: number;
  zCount: number;
  /** Arrows that hit it and stayed in, until it goes down or the fight ends. */
  arrows?: StuckArrow[];
  /** How far above its feet the head is, in world units: where its tag and speech hang from. */
  head: number;
  /** Which of the heroes on its hex it is, so its speech clears every plate stacked there. */
  stack: number;
  /** Where its feet are this frame, the hop left out. */
  feet: THREE.Vector3;
}

/** Something a unit just said, hanging over its head for a few seconds. */
interface Bubble {
  sprite: THREE.Sprite;
  width: number;
  rows: number;
  age: number;
  life: number;
  /** Pixels it has been lifted (and, at the top of the view, moved aside) to clear other bubbles and tags; eased. */
  raise: number;
  shift: number;
}

/** Plate pixels between a seated player's head and the edge of their chat bubble. */
const SIDE_GAP = 14;

/** Seconds a bubble stays up: a little longer for a longer line. */
const bubbleLife = (text: string) => Math.min(7, 4 + text.length / 40);
const BUBBLE_FADE = 0.6;

/** An arrow left standing in a combatant: where on the figure it sits, and its tilt. */
interface StuckArrow {
  sprite: THREE.Sprite;
  /** Offset from the unit's feet, in world units. */
  off: THREE.Vector3;
  rot: number;
}

/** No more than this many arrows stay in one combatant; the oldest falls out. */
const MAX_STUCK_ARROWS = 6;

interface Want {
  kind: string;
  /** The conditions on it, shown as a row of badges over its head until each wears off. */
  effects?: Badge[];
  /** Draw the unit wearing this instead of its kind's stock look. */
  outfit?: Outfit;
  pos: THREE.Vector3;
  size: number;
  label?: string;
  /** Level, HP and XP drawn under the name. */
  plate?: PlateStats;
  /** Heroes sharing a hex: which of them this is, so their plates are stacked instead of overlapping. */
  stack?: number;
  ring?: string;
  /** Shown through a tree or a wall it is behind, as a flat shape of this colour (see silhouette.ts). */
  through?: string;
  pulse?: boolean;
  hp?: number;
  down?: boolean;
  /** Seen going down (a hero or an enemy), it falls limp (a ragdoll) rather than being laid out. */
  falls?: boolean;
  /** Its name tag goes once it is down and lying (a dead enemy): it would only be in the way. A fallen hero keeps theirs, to be found and helped up. */
  nameless?: boolean;
  /** Knocked flat but not out: lying, in full colour. */
  prone?: boolean;
  asleep?: boolean;
  rod?: boolean | "gilded";
  /** Afloat: the boat drawn under them. */
  boat?: "barrel" | "rowboat";
  /** A townsperson's or an enemy's id, which picks their face and hair (see makeFigure's `face`). */
  faceKey?: string;
  /** On a stool: how high its seat is off the floor. `pos` is then the stool's own spot. */
  seat?: number;
  /** Unseen (Sneak): drawn thinned out, a ghost of itself. */
  unseen?: boolean;
}

interface Floater {
  sprite: THREE.Sprite;
  age: number;
  /** Seconds before it has faded out; 1 unless set. */
  life?: number;
  /** World units it rises per second; 1.4 unless set. */
  rise?: number;
}

/** How much of an Unseen hero is left to see. */
const UNSEEN_FADE = 0.4;

/** XP motes: gold and pale blue, like the XP bar lighting up. */
const XP_MOTES = ["#ffd23f", "#ffe98a", "#bfe6ff", "#8fd3ff"];

/** A z rising from a sleeper: drifts up and sideways, grows, and fades. */
interface SleepZ {
  sprite: THREE.Sprite;
  age: number;
  x: number;
  z: number;
  y: number;
  size: number;
  sway: number;
}

const Z_LIFE = 2.6;

/**
 * One piece of the puff a footfall kicks up: a little low-poly solid that is thrown out from the foot, tumbles,
 * and shrinks away to nothing (like the lumps of the chimneys' smoke, it is never see-through). Dust swells
 * first and floats; chips of grass and drops are thrown up and fall back. Pooled, so walking makes no garbage.
 */
interface Puff {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  kind: "dust" | "fleck" | "splash";
  age: number;
  life: number;
  /** The ground it was kicked up from: nothing falls below it. */
  floor: number;
  vx: number;
  vy: number;
  vz: number;
  /** How fast it tumbles, about each axis. */
  spin: THREE.Vector3;
  size: number;
}

/** The pieces' shapes, made once: a squat lump of dust, a chip of a grass blade, a drop. Each about 1 across. */
let puffShapes: Record<Puff["kind"], THREE.BufferGeometry> | null = null;
function puffShape(kind: Puff["kind"]): THREE.BufferGeometry {
  if (!puffShapes) {
    const dust = new THREE.IcosahedronGeometry(1, 0);
    dust.scale(1, 0.8, 1);
    const fleck = new THREE.TetrahedronGeometry(1, 0);
    fleck.scale(0.45, 1.5, 0.16);
    const splash = new THREE.OctahedronGeometry(1, 0);
    splash.scale(0.75, 1.15, 0.75);
    puffShapes = { dust, fleck, splash };
  }
  return puffShapes[kind];
}

/** No more puffs than this are ever out at once; past it the oldest is reused. */
const PUFF_POOL = 60;

/** A short-lived effect sprite: a swipe, a projectile in flight, a burst. */
interface Fx {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** Start and end size, in world units. */
  size: [number, number];
  /** Total rotation over its life, in radians. */
  spin: number;
  fade: boolean;
  /** How high it rises over the middle of its flight, in world units: a lob. */
  arc?: number;
  onEnd?: () => void;
}

/**
 * A small game played in the world, seen through its own eyes (felling in the
 * tree line). While it runs it has the view and the input: each frame it says
 * where the eye is, what it looks at and how far over to that view the camera
 * has gone, and the renderer swings there from its usual view; presses on the
 * canvas and keys go to it instead of moving the camera.
 */
export interface WorldMinigame {
  frame(dt: number, now: number, aspect: number): { eye: THREE.Vector3; look: THREE.Vector3; blend: number; fov?: number };
  /** True while the room should still draw your own hero: a game that waits for them to walk up before taking over. Left out, they are hidden from the start. */
  ownHero?(): boolean;
  /** A press on the canvas, in normalized device coordinates, and the camera it was seen through. */
  press?(ndc: THREE.Vector2, camera: THREE.Camera): void;
  /** The pointer moved over the canvas, in normalized device coordinates. */
  hover?(ndc: THREE.Vector2, camera: THREE.Camera): void;
  /** A key pressed; true if the game used it. */
  key?(e: KeyboardEvent): boolean;
  /** Where the head of this unit's seat is, in the world, if the game draws the unit itself (a table's players): their chat bubble is set beside it, rather than over the hex they all stand on. Null for a unit it does not draw, or for you. */
  bubbleAnchor?(unitId: string): THREE.Vector3 | null;
}

export interface RendererCallbacks {
  /** `place` is the id of the point of interest whose model was clicked, when the click landed on one (and so means its door). */
  /** `unit`: the figure that was clicked, if the click landed on one (a hex may hold two). */
  onHexClick(pos: HexPos, place?: string, unit?: string): void;
  /** The town's waygate has just begun to burst open (see setWaygateOpen): the moment for its sound. */
  onWaygateBurst?(): void;
  onHover(pos: HexPos | null): void;
  /**
   * The place whose model is under the pointer changed (null: none is). `onHover` gives that place's door all the
   * while, which cannot tell its roof from the ground at its door; this can.
   */
  onHoverPlace?(place: string | null): void;
  /** A click on a prop. Return true if it was handled; otherwise the click falls through to its hex. */
  onPropClick?(id: string | number): boolean;
  /** The prop under the pointer changed. */
  onPropHover?(id: string | number | null): void;
  /** While carrying something: a click on a spot to set it down. */
  onPlace?(target: PlaceTarget): void;
  /** While carrying something: whether it may go at that spot (the ghost turns red if not). */
  canPlace?(target: PlaceTarget): boolean;
  /**
   * Shift and the wheel, while carrying something: turn it (+1 clockwise).
   * `amount` is how far the wheel moved, from 0 to 1 (a trackpad sends many
   * small ones), and `alt` whether Alt was held, which flips snapping.
   */
  onTurnHeld?(dir: 1 | -1, amount: number, alt: boolean): void;
}

/** A small thing on the floor keeps this close to the middle of its hex. */
const SMALL_REACH = 0.7;

export class WorldRenderer {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
  private renderer: THREE.WebGLRenderer;
  private raycaster = new THREE.Raycaster();
  /** The point on the ground under the pointer, when it was last over the map. */
  private gaze: THREE.Vector3 | null = null;
  /** Your hero faces the camera rather than the pointer. */
  private faceFront = false;
  /** Which way everyone else's hero is looking (a turn about y), as their players' pointers have it; gone once they walk. */
  private looks = new Map<string, number>();
  private unhearLooks: (() => void) | null = null;
  /** The last look of your own hero's that was sent, and when: only a change is sent, and not too often. */
  private lookSent = -1;
  private lookSentAt = 0;
  private resizeObserver: ResizeObserver;
  private raf = 0;
  /** The finishing pass (bloom, tilt-shift, grade), there while "Fancy graphics" is on. On the dev server P switches it alone, to compare. */
  post: PostFx | null = null;
  private unwatchFancy: () => void;
  /** Stops redrawing the grass and the trees when "Fancy grass" changes. */
  private unwatchGrass: () => void;
  /** How many of the view's pixels make one of the plates' chunky pixels. */
  private fine = PIXEL;
  /** A backdrop's fixed point of view (see setVantage), and the lightning it is lent by the view showing it. */
  private vantage: { from: THREE.Vector3; to: THREE.Vector3 } | null = null;
  /** A game being played in the world, the group its things stand in, and how your own hero looked before it hid them. */
  /** Units a minigame is drawing for itself. */
  private stageHidden: string[] = [];
  private minigame: { game: WorldMinigame; group: THREE.Group; hidden: { obj: THREE.Object3D; was: boolean }[]; felled: boolean; sight?: THREE.Vector3 } | null = null;
  /** The trees on forest hexes and the boulder heaps on the hills; a minigame may clear some trees for room. */
  private woods: Woods | null = null;
  /** The camera's normal field of view, which a minigame may widen. */
  private baseFov = 35;
  /**
   * A minigame's own controls lying over the view (a pub table's dock), and how much of it they cover: a share of
   * the height along the bottom, or of the width down the right side. The game is framed in the rest. `cover` eases
   * toward `coverGoal`, so the view slides rather than jumps as the controls change size.
   */
  private coverEl: HTMLElement | null = null;
  private coverGoal = { bottom: 0, right: 0 };
  private cover = { bottom: 0, right: 0 };
  private coverObserver: ResizeObserver | null = null;
  /** The view offset last set on the camera for the cover, to skip setting it again unchanged. */
  private coverShift = "";
  private lentFlash = 0;
  /** A room's windows: the backdrop seen through them, its picture as a texture, and the panes on the wall. */
  private outlook: WorldRenderer | null = null;
  private outlookMap: THREE.CanvasTexture | null = null;
  private panes = new THREE.Group();
  /** The pub's walls inside: oak boards to waist height, plaster above (see buildWallPanels). One mesh per wall hex. */
  private wallPanels = new THREE.Group();
  /** Fireflies and moths, out at night with "Fancy graphics". */
  private nightLife = new NightLife();
  /** The gulls that come and go by day on any map with the sea round it. */
  private gulls = new Gulls();
  /** Lightning in a storm. On the dev server, `__gqWorld.strike()` sets one off. */
  private storm = new Storm();
  /** How wet the ground is, 0 to 1: it follows the rain up quickly and down slowly. */
  private wet = 0;
  /** The middle of this map's land and how far it reaches, for placing the moon's reflection off its shore. */
  private land = { x: 0, z: 0, reach: 6 };
  /** The sky as the finishing pass is told of it each frame. */
  private air: Air = { outdoors: true, clock: 0, sunDir: new THREE.Vector3(0, 1, 0), sun: new THREE.Color(), sky: new THREE.Color(), overcast: 0, sunHeight: 9, flash: 0 };
  private litRim = new THREE.Color();
  private last = performance.now();
  private clock = 0;

  private terrain: THREE.InstancedMesh | null = null;
  /**
   * The hexes that stand up as walls (WALLS), once more: depth and no colour, drawn first, so a figure behind
   * one can be shown through it (see silhouette.ts). `wallTiles` is which of `tiles` each one is.
   */
  private wallMarks: THREE.InstancedMesh | null = null;
  private wallTiles: number[] = [];
  /** Whether the canvas has a stencil buffer to do that with: without one, nobody is shown through anything. */
  private seeThrough = false;
  private tiles: Tile[] = [];
  /** This map's place in the sound: where you stand, its sky, its fires and its water. */
  private ear: ReturnType<typeof openEar>;
  /** The middle of every water hex, for hearing where the sea is. */
  private water: { x: number; z: number }[] = [];
  private frames = 0;
  /** Frames drawn with the place built, until the veil starts to open; -1 once it has. */
  private settling = 0;
  /** The veil over the view while its place is built (a backdrop, seen only through windows, has none), and when it began to clear. */
  private veil: Veil | null = null;
  private openedAt = 0;
  /** The place growing up round your hex as the veil clears; null once it is all up. */
  private rise: Rise | null = null;
  private mapCode = "";
  private ambience: Ambience;
  private decor = new THREE.Group();
  /** The caverns' moss, puddles, rocks and spikes, in the decor while underground. */
  private caveDressing: THREE.Group | null = null;
  /** What stands on a zone's hexes (walls, pillars, braziers, ladders: zoneScenery.ts), in the decor while the map has any. */
  private scenery: ZoneScenery | null = null;
  /** The void a map floats over when it does not stand in the sea (RenderState.backdrop), and which kind was last asked for. */
  private voidBackdrop: VoidBackdrop | null = null;
  private backdropKind: BackdropKind = "sea";
  /**
   * Under a roof or under ground (the `dark` backdrop): no sky, so no hour, weather, wind, birds or sea; the walls
   * and the rock are drawn as a hall's and a cave's (see zoneScenery.ts), and fire is seen as it is at night.
   */
  private get roofed(): boolean {
    return this.backdropKind === "dark";
  }
  private poiGroup = new THREE.Group();
  /** The waygates among the places (the Harbor's): each moves every frame, and is put away when the places are rebuilt. */
  private gates: Waygate[] = [];
  /** What dresses the Harbor and is no place (townDressing.ts): its court, lamps, quay, forecourt. In the decor while the map is the Harbor's. */
  private townDressing: TownDressing | null = null;
  /** The lanterns over the pub's game tables. Hung in poiGroup, and rebuilt with it. */
  private tableLamps = new TableLamps();
  private poiSig = "";
  private propGroup = new THREE.Group();
  private propSig = "";
  /** Each prop's model, by id, and the unseen sheets over the tops small things can stand on. */
  private propModels = new Map<string | number, THREE.Group>();
  private surfaces: THREE.Mesh[] = [];
  private ghost: THREE.Group | null = null;
  private ghostSig = "";
  /** The prop under the pointer, for its tooltip. */
  private hoverProp: string | number | null = null;
  /** The place whose model is under the pointer, as last told to `onHoverPlace`. */
  private hoveredPlace: string | null = null;
  /** The glow round a structure the view says can be gone into with a click (see `setGlow`), and which structure that is. */
  private hoverGlow = new HoverGlow();
  private glowWhat: string | HexPos | null = null;
  private glowAt = new THREE.Vector3();
  private sea: THREE.Mesh;
  private unitGroup = new THREE.Group();
  private fxGroup = new THREE.Group();
  /** Torches lying burning on the ground, and which hexes they are on. */
  private groundTorches = new THREE.Group();
  private groundTorchKey = "";
  /** Every torch flame on the map, in a hand or on the ground, to flicker each frame. */
  private liveFlames = new Set<THREE.Object3D>();
  private pathGroup = new THREE.Group();
  /** The shape and the light of one dot of the way to the hovered hex, shared by every dot: freed in dispose. */
  private pathDot = {
    geometry: new THREE.SphereGeometry(0.09, 8, 6),
    material: new THREE.MeshBasicMaterial({ color: "#eaf6ff", transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
  };
  /** Red outlines around the hexes close enough to join a fight at each camp or lair. */
  /** The marker on the hex under the pointer: a fine bright outline, a soft glow inside it, a column of light rising off it and a few motes drifting up. */
  private hoverRing: THREE.Group;
  private hoverParts!: { line: THREE.MeshBasicMaterial; glow: THREE.MeshBasicMaterial; beam: THREE.MeshBasicMaterial; motes: THREE.Points; seeds: Float32Array };
  /** When the marker last moved to a new hex, so it can bloom up there rather than snap. */
  private hoverBorn = 0;
  /** Whether the hex under the pointer can be walked to: lit and alive if so, a dim outline if not. */
  private hoverLive = false;
  private units = new Map<string, Unit>();
  /** The sea's daytime colour for this map; night deepens it toward navy. */
  private seaBase = new THREE.Color("#3577cf");
  /** How dark the tiles were last painted for, in steps, so they are only repainted when night moves on. */
  private paintedNight = -1;
  private pulsing = new Set<string>();
  private floaters: Floater[] = [];
  private sleepZs: SleepZ[] = [];
  /** Footfall puffs, made as needed up to PUFF_POOL and then reused; `nextPuff` is the one to reuse next. */
  private puffs: Puff[] = [];
  private nextPuff = 0;
  /** The player asked for less motion: footsteps are still heard, but kick up no puffs. */
  private still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private fx: Fx[] = [];
  /** When each attacker last shook the ground, on the render clock: a stomp hits everyone, but shakes the ground once. */
  private quakeAt = new Map<string, number>();
  /** Speech over units' heads, by unit id; kept apart from the unit so a change of gear does not cut it short. */
  private bubbles = new Map<string, Bubble>();
  private pending: { at: number; run: () => void }[] = [];

  private state: RenderState | null = null;
  private reach = new Map<string, { cost: number; prev: string | null; pos: HexPos; way?: HexPos[] }>();
  private hovered: HexPos | null = null;

  private target = new THREE.Vector3();
  private targetGoal = new THREE.Vector3();
  private dist = 24;
  private userDist = 24;
  /** How far back the camera may pull on this map. */
  private maxZoom = MAX_ZOOM;
  /** Active pointers on the canvas, by id. Two of them make a pinch. */
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; x: number; y: number; zoom: number; angle: number } | null = null;
  /**
   * Which way the camera looks from, as a turn about the vertical axis. 0 is
   * the default view from the south. `yaw` eases toward `yawGoal`; `userYaw`
   * is what the player chose.
   */
  private yaw = 0;
  private yawGoal = 0;
  private userYaw = 0;
  /** The top middle of each place's model, in the world, measured when first asked for (see screenAbovePoi). */
  private poiTops = new Map<string, THREE.Vector3>();
  /** Chests being thrown open, by poi id: when the lid began to swing (on the render clock). */
  private lidsSwinging = new Map<string, number>();
  /** Crates rocking from a blow, by poi id: when it landed, and how hard. */
  private poiShakes = new Map<string, { at: number; by: number }>();
  /** Glints on the places that twinkle (a chest not yet opened). Gathered as the places are built. */
  private twinkles: THREE.Object3D[] = [];
  /** The turn this map opens at (RenderState.homeYaw), which the turn buttons' sixths are counted from. */
  private homeYaw = 0;
  /** The current drag turns the camera instead of panning it. */
  private rotating = false;
  /** How steeply the camera looks down, in radians above the horizon. Eases toward `pitchGoal`; `userPitch` is the player's choice. */
  private pitch = DEFAULT_PITCH;
  private pitchGoal = DEFAULT_PITCH;
  private userPitch = DEFAULT_PITCH;
  /** Movement keys held down right now (W A S D and the arrows), for sliding the view. */
  private heldKeys = new Set<string>();
  /** The map is a wet, walled port (it has streets): greens are drawn drab. */
  private sodden = false;
  /** How many hexes the map had when the ground was last drawn (-1: draw it again whatever it has). */
  private hexCount = -1;
  /** Water hexes far enough from land that they are not drawn: the open sea shows instead. */
  private deep = new Set<string>();
  /** The camera turn the indoor walls were last cut for. */
  private wallTurn = NaN;
  /** The middle of the map's ground. Indoors the walls are cut about it, wherever the camera has gone (following a hero, or panned). */
  private middle = new THREE.Vector3();
  /** Indoors, the walls cut down to a kerb so the camera can see in, by hex key. Things hung on them are hidden. */
  private lowered = new Set<string>();
  /** Indoors, the wall sides things can hang on, by hex key: which sides of that hex. */
  private hangable = new Map<string, number[]>();
  /** How high the last wall piece was aimed, for when the pointer is on top of a wall. */
  private wallY = 1.1;
  private rotateButtons: HTMLDivElement;
  /** The camera buttons in that column, hidden in a fight. */
  private turnButtons: HTMLButtonElement[] = [];
  /**
   * The camera keeps your own hero centred as they walk (see cameraFollow.ts). Panning the map turns it off;
   * the button turns it back on. A fight's framing wins while it lasts.
   */
  private follow = readFollow();
  /** Following is paused because the view was sent somewhere else (lookAt); it picks up when your hero next walks. */
  private followHeld = false;
  private followButton: HTMLButtonElement;
  /**
   * The combat view (cutaway.ts): on a battle map, what stands in the way of a fight gives way so it can be read.
   * Only a view that says whether a fight is on (`setCombat`) has it.
   */
  private combat = new CombatView();
  /** How far this turn's walk reaches from your hero, in world units, and the reach it was measured for (see combatSpots). */
  private combatReach: { of: unknown; far: number } = { of: null, far: 0 };
  /**
   * While following, where a pinch started (its midpoint), or where the finger left down after one is: touches
   * near it only zoom and turn. Once they wander PINCH_PAN_SLACK away it is a pan, and following stops.
   */
  private panFrom: { x: number; y: number } | null = null;
  private pointer = { x: 0, y: 0, downX: 0, downY: 0, down: false, dragged: false, dirty: false, inside: false };
  /** Called every frame before drawing, after the camera is placed, by things a view has added to the scene (see addTicker). */
  private tickers = new Set<(dt: number, camera: THREE.PerspectiveCamera, clock: number) => void>();

  /**
   * `backdrop`: a second view drawn off screen for another to show (the Harbor seen through the pub's
   * windows). It makes no sound, takes no keys, and draws only when the view showing it asks (see `step`).
   */
  constructor(private container: HTMLElement, private callbacks: RendererCallbacks, private opts: { backdrop?: boolean } = {}) {
    // First, before anything that would need undoing: the browser may refuse (GraphicsUnavailable).
    this.renderer = makeRenderer({ antialias: true, powerPreference: "low-power", stencil: true });
    this.seeThrough = !!this.renderer.getContext().getContextAttributes()?.stencil;
    this.ear = opts.backdrop ? DEAF : openEar();
    this.renderer.setPixelRatio(1);
    this.renderer.localClippingEnabled = true;
    if (!this.opts.backdrop) {
      this.unhearLooks = gaze.onLooked((id, step) => this.looks.set(id, lookYaw(step)));
      this.veil = new Veil();
      this.rise = new Rise();
    }
    // Dev server only: the latest view, for reading draw calls (`__gqWorld.renderer.info.render.calls`) from the console.
    if (import.meta.env.DEV && !this.opts.backdrop) (globalThis as { __gqWorld?: WorldRenderer }).__gqWorld = this;
    const canvas = this.renderer.domElement;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.touchAction = "none";
    // Under a veil until there is a place to show (see `reveal`): going in or out of a building never flashes
    // an empty sea before the room is built. The canvas itself is the veil's dark until the first frame is drawn.
    canvas.style.background = NIGHT;
    container.appendChild(canvas);

    // Sky, sun and moon, shadows, and the moving decoration.
    this.ambience = new Ambience(this.scene, this.renderer);
    this.scene.add(this.nightLife.group, this.gulls.group, this.storm.bolt, this.panes, this.wallPanels);

    // Far bigger than anything the camera can see the end of: it is kept under the camera (see frame), and its far
    // reaches are lost in the mist.
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshLambertMaterial({ color: "#3577cf" }));
    addFancyWater(sea.material);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = 0.1;
    sea.receiveShadow = true;
    this.scene.add(sea);
    this.sea = sea;

    this.hoverRing = this.buildHoverMarker();
    this.hoverRing.visible = false;

    this.scene.add(this.decor, this.poiGroup, this.propGroup, this.pathGroup, this.hoverRing, this.unitGroup, this.fxGroup, this.groundTorches);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
    if (!opts.backdrop) {
      addEventListener("keydown", this.onKeyDown);
      addEventListener("keyup", this.onKeyUp);
      addEventListener("blur", this.onBlur);
    }

    // Two small buttons at the right edge, for those without a right mouse button or a keyboard.
    this.rotateButtons = document.createElement("div");
    this.rotateButtons.className = "camera-rotate";
    this.followButton = document.createElement("button");
    this.followButton.type = "button";
    this.followButton.className = "camera-follow";
    this.followButton.appendChild(followIconSvg());
    this.followButton.addEventListener("click", () => this.setFollow(!this.follow || this.followHeld));
    this.rotateButtons.appendChild(this.followButton);
    this.turnButtons.push(this.followButton);
    this.showFollow();
    const buttons: [string, string, () => void][] = [
      ["⟲", "Turn the view left (Q)", () => this.rotateBy(-1)],
      ["⟳", "Turn the view right (E)", () => this.rotateBy(1)],
      ["▲", "Tip the view toward overhead (R)", () => this.tiltBy(0.18, true)],
      ["▼", "Tip the view toward the horizon (F)", () => this.tiltBy(-0.18, true)],
    ];
    for (const [label, title, run] of buttons) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", run);
      this.rotateButtons.appendChild(b);
      this.turnButtons.push(b);
    }
    // And the combat view's, under them: there only on a battle map (see setCombat).
    this.rotateButtons.appendChild(cutawayButton(this.combat));
    container.appendChild(this.rotateButtons);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    // Name plates, speech bubbles and health bars sit on their own layer, so the finishing pass can leave them alone.
    this.camera.layers.enable(OVERLAY_LAYER);
    this.raycaster.layers.enable(OVERLAY_LAYER);
    if (fancy.get()) this.post = new PostFx(this.renderer);
    this.unwatchFancy = fancy.subscribe(() => {
      this.setPost(fancy.get());
      this.resize();
    });
    // "Fancy grass" changes what the ground is grown with: the map's ground is drawn again.
    this.unwatchGrass = fancyGrass.subscribe(() => {
      if (!this.state) return;
      this.hexCount = -1;
      this.setState(this.state);
    });
    this.resize();
    if (!opts.backdrop) this.raf = requestAnimationFrame(this.frame);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.veil?.dispose();
    this.unhearLooks?.();
    this.ear.close();
    this.resizeObserver.disconnect();
    this.coverObserver?.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    removeEventListener("keydown", this.onKeyDown);
    removeEventListener("keyup", this.onKeyUp);
    removeEventListener("blur", this.onBlur);
    this.rotateButtons.remove();
    this.unwatchFancy();
    this.unwatchGrass();
    this.nightLife.dispose();
    this.gulls.dispose();
    this.storm.dispose();
    this.outlookMap?.dispose();
    this.scenery?.dispose();
    this.voidBackdrop?.dispose();
    this.ambience.dispose();
    this.tableLamps.clear();
    this.endMinigame();
    this.post?.dispose();
    this.hoverGlow.dispose();
    this.renderer.dispose();
    // Give the WebGL context back now, not whenever the canvas is collected: a page holds only so many, and the
    // browser drops the oldest (the HUD's portrait renderer) to make room. Every view (the Harbor, a hut, the pub
    // and the Harbor through its windows) makes its own canvas, so this one is not drawn on again.
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  // ---------- state ----------

  /** A torch for each lit hex in `state.lights`: a stick lying aslant on the ground with a flame at its head. */
  private buildGroundTorches(state: RenderState) {
    const key = (state.lights ?? []).map((p) => `${p.q},${p.r}`).sort().join(";");
    if (key === this.groundTorchKey) return;
    this.groundTorchKey = key;
    for (const old of [...this.groundTorches.children]) {
      this.groundTorches.remove(old);
      old.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    for (const p of state.lights ?? []) {
      const { x, z } = hexToWorld(p);
      const torch = new THREE.Group();
      torch.position.set(x, tileTop(tileAt(state.map, p)) + 0.05, z);
      torch.rotation.y = ((p.q * 7 + p.r * 13) % 6) * (Math.PI / 3);
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.6, 6), new THREE.MeshLambertMaterial({ color: "#6b4a2b" }));
      stick.rotation.z = Math.PI / 2 - 0.35;
      stick.position.set(0, 0.1, 0);
      const rag = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.14, 6), new THREE.MeshLambertMaterial({ color: "#3a2a1e" }));
      rag.rotation.z = stick.rotation.z;
      rag.position.set(-0.27, 0.2, 0);
      // The flame burns upright off the head of the stick, flickering like the pub's fire.
      const flame = torchFlame(0.24);
      flame.position.set(-0.3, 0.25, 0);
      this.liveFlames.add(flame);
      torch.add(stick, rag, flame);
      this.groundTorches.add(torch);
    }
  }

  setState(state: RenderState) {
    // Dev server only: the view being fed state is the live one (a view torn down after it was made would otherwise be left in the hook).
    if (import.meta.env.DEV && !this.opts.backdrop) (globalThis as { __gqWorld?: WorldRenderer }).__gqWorld = this;
    const first = this.mapCode !== state.code;
    // The ground is redrawn for a new map, and whenever fog lifts off more of this one.
    const lifted = state.map.tiles.reduce((n, t) => n + (t.biome === "fog" ? 0 : 1), 0);
    this.ambience.floorLook = state.floor ?? "planks";
    // What lies round the map, the sea or a void it floats over: known before the ground is built, whose rim is faced to suit.
    const backdrop: BackdropKind = state.indoors || state.far || this.opts.backdrop ? "sea" : (state.backdrop ?? "sea");
    const turned = backdrop !== this.backdropKind;
    this.backdropKind = backdrop;
    // Under a roof the hour stands still (and the weather with it: see the ambience's heldTime).
    if (first || turned) this.ambience.heldTime = state.far ? FAR_TIME : backdrop === "dark" ? ROOF_TIME : null;
    // And for another window of a world (see RenderState.far), under a camera that stays where it is.
    if (first || turned || lifted !== this.lifted || (!!state.far && state.map.tiles !== this.tiles)) this.buildTerrain(state, first);
    if (first || turned) {
      if (this.voidBackdrop) {
        this.scene.remove(this.voidBackdrop.group);
        this.voidBackdrop.dispose();
      }
      this.voidBackdrop = backdrop === "sea" ? null : new VoidBackdrop(backdrop, this.land);
      if (this.voidBackdrop) this.scene.add(this.voidBackdrop.group);
      if (!first) this.sea.visible = !this.voidBackdrop && state.kind !== "caverns";
    }
    if (first) this.buildPanes(state);
    if (first) this.buildWallPanels(state);
    this.hexCount = hexCount;
    this.state = state;
    this.ambience.setGloom(!!state.gloom);
    this.ambience.setLampOn(!state.lampOff);
    this.buildGroundTorches(state);
    this.buildPois(state);
    this.buildProps(state);
    this.updateGhost();
    if (first) {
      // A new map opens at its own turn.
      this.homeYaw = state.homeYaw ?? 0;
      this.userYaw = this.yaw = this.yawGoal = this.homeYaw;
      // No sea under a hut's floor, nor in the caverns; nor under a map of the world, where what is not land is
      // the mist itself (so nothing shows through the thin edge of whatever the view draws over it).
      this.sea.visible = !state.indoors && state.kind !== "caverns" && !state.far && !this.voidBackdrop;
      (this.scene.background as THREE.Color).set(state.indoors ? "#1d1a2b" : "#a9dcf7");
      // A room is framed whole: closer for a hut, further back for the pub.
      if (state.indoors) this.userDist = this.camDist = state.map.grid.cols > 10 ? 21 : 15;
      // A map of the world is looked at from a long way up, and by one unchanging light: it is there to be read.
      this.maxZoom = state.far ? FAR_MAX_ZOOM : MAX_ZOOM;
      if (state.far) this.userDist = this.camDist = FAR_ZOOM;
      // Under the open sky the distance is lost in mist (see frame), and the camera sees as far as the mist does.
      const open = !state.indoors && state.kind !== "caverns" && !this.opts.backdrop;
      this.scene.fog = open ? new THREE.Fog("#a9dcf7", 100, 500) : null;
      this.camera.far = open ? 1600 : 200;
      this.camera.updateProjectionMatrix();
    }

    const me = state.heroes.find((h) => h.id === state.you);
    // Where you can walk: handed in (a map's rules know it), or anywhere in reach where you roam freely.
    const roaming = !!me && !!state.freeRoam;
    this.reach = state.reach ?? (roaming ? reachable(state.map, me!.pos, FREE_ROAM_REACH, this.stepCost(state)) : new Map());
    if (!state.reach && roaming) this.reachSeats(state);
    if (this.paintStale()) this.paintTiles();
    this.syncUnits(state);
    this.updatePath();

    this.dist = this.userDist;
    this.yawGoal = nearestTurn(this.yaw, this.userYaw);
    this.pitchGoal = this.userPitch;
    // A room is small enough to see whole, so indoors the camera stays on its middle.
    // Following, the camera starts on your hero indoors too.
    if (first && me && (this.follow || !state.indoors)) this.target.copy(this.standAt(me.pos));
    if ((first || turnKey !== this.turnKey) && me && (myTurn || first) && !state.indoors) this.targetGoal.copy(this.standAt(me.pos));
    this.turnKey = turnKey;
  }

  /** Animate things that just happened. Call after setState for the same update. */
  /** Animate what just happened. `startBeat` holds the first blow back, for a fight's opening card. */
  playEvents(events: WorldEvent[], startBeat = 0) {
    let beat = startBeat;
    // XP comes in one award at a time (each foe, each rite); one sparkle per hero per update, for the sum.
    const xp = new Map<string, { amount: number; levelUp: boolean }>();
    for (const ev of events) {
      if (ev.t !== "xp" && ev.t !== "level_up") continue;
      const got = xp.get(ev.heroId) ?? { amount: 0, levelUp: false };
      if (ev.t === "xp") got.amount += ev.amount;
      else got.levelUp = true;
      xp.set(ev.heroId, got);
    }
    const ending = events.find((e) => e.t === "battle_end");
    // Your turn coming round gets a soft tick, once, and not as the fight ends.
    let myTurnAt: number | null = null;
    /** Who last struck each target, so one killed falls away from them. */
    const struck = new Map<string, string>();
    for (const ev of events) {
      if (ev.t === "moved") {
        const unit = this.units.get(ev.heroId);
        if (unit) unit.path = ev.path.map((p) => this.standAt(p));
        continue;
      }
      const got = xp.get(ev.heroId) ?? { amount: 0, levelUp: false };
      if (ev.t === "xp") got.amount += ev.amount;
      else got.levelUp = true;
      xp.set(ev.heroId, got);
    }
    for (const [heroId, got] of xp) this.later(() => this.xpGain(heroId, got.amount, got.levelUp));
  }

  /**
   * Show a line of chat in a speech bubble over a unit (a hero, a keeper, one of the pub's people)
   * for a few seconds. A new line from the same unit replaces the last. Text only.
   */
  say(unitId: string, text: string) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || !this.units.has(unitId)) return;
    this.dropBubble(unitId);
    const { texture, width, rows } = bubbleTexture(clean);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: false, opacity: 0 }));
    sprite.renderOrder = 8;
    sprite.visible = false;
    sprite.layers.set(OVERLAY_LAYER);
    this.unitGroup.add(sprite);
    this.bubbles.set(unitId, { sprite, width, rows, age: 0, life: bubbleLife(clean), raise: 0, shift: 0 });
  }

  private dropBubble(unitId: string) {
    const b = this.bubbles.get(unitId);
    if (!b) return;
    this.unitGroup.remove(b.sprite);
    b.sprite.material.map?.dispose();
    b.sprite.material.dispose();
    this.bubbles.delete(unitId);
  }

  /**
   * Hang each bubble over its speaker's head, above their tag, and lift any that
   * would cover another bubble or a tag, lowest on screen first. Worked in view
   * pixels, so a bubble's pixels stay on the view's.
   */
  private placeBubbles(dt: number, labelRow: number) {
    if (this.bubbles.size === 0) return;
    // In plate pixels, which are PIXEL screen pixels each however finely the world is drawn.
    const W = this.renderer.domElement.width / this.fine;
    const H = this.renderer.domElement.height / this.fine;
    const v = new THREE.Vector3();
    const screen = (unit: Unit, anchor?: THREE.Vector3 | null) => {
      if (anchor) v.copy(anchor).project(this.camera);
      else v.set(unit.feet.x, unit.feet.y + unit.head, unit.feet.z).project(this.camera);
      return { x: ((v.x + 1) / 2) * W, y: ((v.y + 1) / 2) * H, behind: v.z > 1 };
    };
    type Box = { l: number; r: number; b: number; t: number };
    const taken: Box[] = [];
    // Tags, where each one sits (see the label's centre in syncUnits).
    const tagTop = new Map<Unit, number>();
    for (const unit of this.units.values()) {
      if (!unit.label) continue;
      const at = screen(unit);
      const rows = unit.label.userData.rows as number;
      const w = rows * (unit.label.userData.aspect as number);
      const bottom = at.y + 5 + unit.stack * (rows + 2);
      tagTop.set(unit, 5 + unit.stack * (rows + 2) + rows);
      taken.push({ l: at.x - w / 2, r: at.x + w / 2, b: bottom, t: bottom + rows });
    }
    const placing: { id: string; b: Bubble; unit: Unit; x: number; y: number; base: number; anchor: THREE.Vector3 | null; fixed: number }[] = [];
    const game = this.minigame?.game;
    for (const [id, b] of this.bubbles) {
      b.age += dt;
      const unit = this.units.get(id);
      if (b.age >= b.life) {
        this.dropBubble(id);
        continue;
      }
      if (!unit) {
        b.sprite.visible = false;
        continue;
      }
      // A player seated at a table: the bubble hangs beside their head, on the side nearer the edge of the view, where the zoomed-in table leaves room.
      const anchor = game?.bubbleAnchor?.(id) ?? null;
      const at = screen(unit, anchor);
      if (at.behind) {
        b.sprite.visible = false;
        continue;
      }
      const fixed = anchor ? (at.x < W / 2 ? 1 : -1) * -(b.width / 2 + SIDE_GAP) : 0;
      placing.push({ id, b, unit, x: at.x, y: at.y, base: anchor ? -b.rows / 2 : (tagTop.get(unit) ?? 3) + 2, anchor, fixed });
    }
    placing.sort((p, q) => p.y + p.base - (q.y + q.base));
    const overlaps = (l: number, r: number, bottom: number, rows: number) => taken.find((o) => o.l < r && o.r > l && o.b < bottom + rows && o.t > bottom);
    for (const p of placing) {
      const { b, unit } = p;
      const half = b.width / 2;
      let bottom = p.y + p.base;
      let shift = p.fixed;
      for (let pass = 0; pass < 24; pass++) {
        const hit = overlaps(p.x + p.fixed - half, p.x + p.fixed + half, bottom, b.rows);
        if (!hit) break;
        bottom = hit.t + 1;
      }
      // Lifted off the top of the view: stay on screen, and step aside instead.
      const ceiling = H - 2 - b.rows;
      if (bottom > ceiling && ceiling > p.y + p.base) {
        bottom = ceiling;
        let side = 0;
        for (let pass = 0; pass < 24; pass++) {
          const hit = overlaps(p.x + shift - half, p.x + shift + half, bottom, b.rows);
          if (!hit) break;
          const right = hit.r + 1 - (p.x + shift - half);
          const left = hit.l - 1 - (p.x + shift + half);
          // Pick a side once, the nearer one, so it does not bounce between two neighbours.
          if (!side) side = right <= -left ? 1 : -1;
          shift += side > 0 ? right : left;
        }
      }
      // Kept inside the view sideways too.
      shift = Math.max(2 + half - p.x, Math.min(W - 2 - half - p.x, shift));
      taken.push({ l: p.x + shift - half, r: p.x + shift + half, b: bottom, t: bottom + b.rows });
      const want = bottom - (p.y + p.base);
      // Eased so a bubble slides out of the way instead of jumping, but snapped to whole pixels.
      const k = 1 - Math.exp(-dt * 14);
      b.raise += (want - b.raise) * k;
      b.shift += (shift - b.shift) * k;
      if (Math.abs(want - b.raise) < 0.5) b.raise = want;
      if (Math.abs(shift - b.shift) < 0.5) b.shift = shift;
      const s = b.sprite;
      s.visible = true;
      if (p.anchor) s.position.copy(p.anchor);
      else s.position.set(unit.feet.x, unit.feet.y + unit.head, unit.feet.z);
      s.center.set(0.5 - Math.round(b.shift) / b.width, -(p.base + Math.round(b.raise)) / b.rows);
      const tall = b.rows * labelRow;
      s.scale.set(tall * (b.width / b.rows), tall, 1);
      s.material.opacity = Math.min(1, b.age / 0.15, (b.life - b.age) / BUBBLE_FADE);
    }
  }

  // ---------- a fight on the tiles ----------
  // A zone plays its own events (ZoneView.tsx) and asks for each piece of the picture here.

  /**
   * Walk a unit along these hexes, after whatever it is already walking. Any unit, not only a hero. A step
   * onto a hex a level higher or lower than the one before is jumped, not walked (see leapUnit).
   */
  walkUnit(id: string, path: HexPos[]) {
    const unit = this.units.get(id);
    if (!unit) return;
    const map = this.state?.map;
    const level = (pos: HexPos) => (map ? (tileAt(map, pos)?.elev ?? 0) : 0);
    // Where it sets off from: the last hex it is already bound for, or the one it stands on (a quarter hex
    // toward the camera from the middle: see syncUnits).
    const last = unit.path[unit.path.length - 1];
    let from: HexPos = last ? worldToHex(last.x, last.z) : worldToHex(unit.root.position.x, unit.root.position.z - 0.25);
    for (const p of path) {
      const at = this.standAt(p);
      unit.path.push(at);
      if (level(from) !== level(p)) (unit.leaps ??= new Map()).set(at, false);
      from = p;
    }
  }

  /**
   * A unit jumps to a hex, after whatever it is already walking: it crouches, springs, goes over in an arc
   * (higher the further it is, and clear of a ledge it is jumping up onto) and lands in a crouch, with a puff
   * of whatever it landed on. Any unit; a creature has no crouch and springs at once.
   */
  leapUnit(id: string, to: HexPos) {
    const unit = this.units.get(id);
    if (!unit) return;
    const at = this.standAt(to);
    unit.path.push(at);
    (unit.leaps ??= new Map()).set(at, true);
  }

  /**
   * A walk that was shown before the server had made it (client/zone/ahead.ts) turned out shorter than shown, or
   * was refused: the unit's walk ends at this hex after all. Whatever it was to walk after that hex is dropped;
   * if it has already gone past (or was never bound for it), it turns round and walks straight back.
   */
  stopWalkAt(id: string, at: HexPos) {
    const unit = this.units.get(id);
    if (!unit) return;
    const stop = this.standAt(at);
    const i = unit.path.findIndex((p) => Math.hypot(p.x - stop.x, p.z - stop.z) < 0.01);
    const dropped = i >= 0 ? unit.path.splice(i + 1) : unit.path.splice(0);
    if (i < 0) unit.path.push(stop);
    for (const p of dropped) unit.leaps?.delete(p);
  }

  /**
   * A unit about to do something to a spot, shown the moment it is asked for, while what comes of it is still
   * being decided elsewhere: it turns to the spot and leans into it. Nothing of the result is shown; the blow,
   * shot or spell itself is played when it is known (blow, cast). Not while it is walking or off its feet.
   */
  ready(id: string, x: number, z: number) {
    const unit = this.units.get(id);
    if (!unit || unit.lying || unit.path.length > 0) return;
    this.face(unit, x, z);
    // Toward the spot as the viewer sees it, as a stomp is leant into (see attack), but slighter.
    const side = new THREE.Vector3(x, unit.goal.y, z).project(this.camera).x >= unit.goal.clone().project(this.camera).x ? 1 : -1;
    unit.lean = -side * 0.35;
  }

  /**
   * A unit knocked from where it stands to another hex (a shove, a blow that throws it back): it is
   * flung there, not walked, and with `fall` lands on its back for a moment before getting up.
   */
  knock(id: string, to: HexPos, fall = true) {
    const unit = this.units.get(id);
    if (!unit) return;
    const dest = this.standAt(to);
    // Knocked off a height: out over the edge first, then straight down to the ground below.
    const drop = unit.root.position.y - dest.y;
    unit.path = drop > 0.6 ? [new THREE.Vector3(dest.x, unit.root.position.y, dest.z), dest] : [dest];
    unit.rush = 3.2;
    unit.bob = 0.22;
    if (fall) this.knockDown(unit, dest.clone().sub(unit.root.position).setY(0), FLOORED_S + (drop > 0.6 ? 0.35 : 0));
  }

  /**
   * A unit goes into a pit (deep water, lava, off the edge of the land): flung out over it and down out of sight.
   * `gone`: it is not seen again (an enemy lost to it); else it is hauled back to where it stood, flat on the ground.
   * `splash` runs as it goes under, with where.
   */
  sink(id: string, into: HexPos, gone: boolean, splash?: (at: THREE.Vector3) => void) {
    const unit = this.units.get(id);
    if (!unit) return;
    const { x, z } = hexToWorld(into);
    const from = unit.root.position.clone();
    const under = new THREE.Vector3(x, -1.6, z);
    unit.path = [new THREE.Vector3(x, from.y, z), under, ...(gone ? [] : [from])];
    unit.rush = 3.2;
    unit.bob = 0.22;
    unit.dying = undefined;
    unit.felled = undefined;
    const fallFor = (Math.hypot(x - from.x, z - from.z) + from.y + 1.6) / (4.2 * 3.2);
    this.pending.push({ at: this.clock + fallFor * 0.8, run: () => splash?.(new THREE.Vector3(x, 0.15, z)) });
    if (gone) this.pending.push({ at: this.clock + fallFor + 0.05, run: () => { unit.root.visible = false; } });
    else this.knockDown(unit, new THREE.Vector3(from.x - x, 0, from.z - z), FLOORED_S + fallFor * 2);
    // Until it is under (or back), nothing else lays it out or clears it away.
    unit.sinkUntil = this.clock + fallFor * (gone ? 1 : 2) + 0.1;
  }

  /** A unit gone from where it stands and on another hex at once (a blink): whatever it was walking is dropped. */
  blinkUnit(id: string, to: HexPos) {
    const unit = this.units.get(id);
    if (!unit) return;
    unit.path = [];
    unit.leaps?.clear();
    unit.leap = undefined;
    unit.rush = undefined;
    // Where it stands on the hex: a quarter hex toward the camera from the middle (see syncUnits). The goal moves with it, so it does not slide back.
    const at = this.standAt(to).add(new THREE.Vector3(0, 0, 0.25));
    unit.root.position.copy(at);
    unit.goal.copy(at);
  }

  /** A unit knocked off its feet where it stands, by `by` if anyone (it falls away from them). */
  floor(id: string, seconds = FLOORED_S, by?: string) {
    const unit = this.units.get(id);
    if (!unit) return;
    const from = by ? this.units.get(by) : undefined;
    this.knockDown(unit, from ? unit.root.position.clone().sub(from.root.position).setY(0) : undefined, seconds);
  }

  /**
   * Off their feet for `seconds` (longer while Prone, or down): they fall limp along `away` (see Figure.fall),
   * and get up again once nothing keeps them lying.
   */
  private knockDown(unit: Unit, away: THREE.Vector3 | undefined, seconds: number) {
    unit.floored = Math.max(unit.floored ?? 0, this.clock + seconds);
    if (unit.lying) return;
    unit.figure.fall(away && away.lengthSq() > 1e-6 ? away : undefined);
  }

  /**
   * Shown going down now (a zone fight's "down"): it falls at once, away from `by`, rather than waiting on a beat.
   * Told before the picture has it down, it falls as soon as the picture does. `onDown` runs once it is down and
   * lying still: at once if it is not here, or is already down, or is laid out without a fall.
   */
  fell(id: string, by?: string, onDown?: () => void) {
    const unit = this.units.get(id);
    if (!unit) return onDown?.();
    // Gone into a pit: it is not laid out where it stood.
    if (unit.sinkUntil !== undefined && this.clock < unit.sinkUntil) return onDown?.();
    if (unit.dying !== undefined) return this.topple(id, by, onDown);
    if (!unit.down) {
      unit.felled?.onDown?.();
      unit.felled = { at: this.clock, by, onDown };
    } else onDown?.();
  }

  /** The top of a unit's head in the world, wherever it has got to: for something drawn over it. Null if it is not on the map. */
  unitHead(id: string): THREE.Vector3 | null {
    const unit = this.units.get(id);
    if (!unit) return null;
    const at = unit.root.position.clone();
    at.y += unit.head - unit.bob;
    return at;
  }

  /**
   * One blow or shot from one unit at another, named for its look and sound. `onImpact` runs as it lands (or flies
   * wide). `color` tints a blow's slash (a critical one is gold whatever it is).
   */
  blow(actorId: string, targetId: string, name: string, opts: { crit?: boolean; landed?: boolean; onImpact?: () => void; color?: string } = {}) {
    const style = attackStyle(name);
    this.attack(actorId, targetId, name, !!opts.crit, () => {
      if (opts.landed) {
        sounds.impact(name, style, !!opts.crit, this.fighter(targetId), this.spot(targetId));
        this.recoil(targetId, actorId, opts.crit ? 0.6 : 0.38);
      } else sounds.miss(name, style, this.spot(targetId));
      opts.onImpact?.();
    }, !!opts.landed, opts.color);
  }

  /** A unit rocked back by a blow: knocked a little away from whoever dealt it (or just jolted), and settling back. */
  private recoil(targetId: string, fromId: string | null, by: number) {
    const t = this.units.get(targetId);
    const a = fromId ? this.units.get(fromId) : undefined;
    if (!t || t.lying) return;
    if (a && a !== t) t.kick.copy(t.goal).sub(a.goal).setLength(by);
    else t.kick.set((Math.random() - 0.5) * by, 0, (Math.random() - 0.5) * by);
    t.bob = Math.max(t.bob, 0.1);
    t.figure.hit();
  }

  /**
   * A shot or a spell going off, drawn elsewhere (SpellFx): the unit turns to face where it is aimed, makes its
   * gesture (a bow is drawn, a gun or crossbow fired, an instrument played; anything else is swung round
   * overhead and pointed), and is heard. `then` is what leaves it (the bolt, the arrow, the flask): it runs as
   * the string is loosed, the gun goes off, the song takes hold or the hand points, not before. `thrown` is something flung by hand, whatever else is carried.
   */
  cast(actorId: string, name: string, x: number, z: number, then?: () => void, thrown = false) {
    const unit = this.units.get(actorId);
    let wait = 0;
    if (unit && !unit.lying) {
      this.face(unit, x, z);
      wait = (!thrown && (unit.figure.loose() || unit.figure.fire() || unit.figure.play())) || unit.figure.cast();
    }
    sounds.attack(name, attackStyle(name), this.fighter(actorId), this.spot(actorId));
    if (!then) return;
    if (wait > 0) this.later(then, wait);
    else then();
  }

  /** Turn a unit to look at a spot, unless it is the one it stands on. */
  private face(unit: Unit, x: number, z: number) {
    const [dx, dz] = [x - unit.goal.x, z - unit.goal.z];
    if (Math.hypot(dx, dz) > 0.05) unit.turn = unit.turnGoal = Math.atan2(dx, dz);
  }

  /**
   * An attack all round where the unit stands (a ring): struck as its heavy blow, or, `sung`, played on what it
   * carries (cast, with no instrument); a ground-pound is leant into. `then` runs as the blow lands.
   */
  burst(actorId: string, name: string, sung: boolean, then: () => void) {
    const unit = this.units.get(actorId);
    let wait = 0;
    if (unit && !unit.lying) {
      if (QUAKES.has(name)) unit.lean = -0.9;
      else wait = sung ? unit.figure.play() || unit.figure.cast() : unit.figure.strike("heavy");
    }
    sounds.attack(name, sung ? "magic" : "melee", this.fighter(actorId), this.spot(actorId));
    if (wait > 0) this.later(then, wait);
    else then();
  }

  /** A heal or a blessing given: the giver turns to whoever it is for (if not themselves) and plays it, or casts it. */
  bless(actorId: string, toward: { x: number; z: number } | null) {
    const unit = this.units.get(actorId);
    if (!unit || unit.lying) return;
    if (toward) this.face(unit, toward.x, toward.z);
    if (!unit.figure.play()) unit.figure.cast();
  }

  /** How high a room's floor is in the world: what stands on it stands this far up. */
  floorTop(): number {
    return FLOOR_TOP;
  }

  /**
   * Someone at their trade (a shopkeeper at work): the unit turns to the spot given and brings a hammer down on it,
   * or stirs the pot there. Returns the seconds until a hammer lands, for its sparks and its ring; 0 for a stir,
   * or for a unit that is not there, is down, or is walking.
   */
  work(unitId: string, how: "hammer" | "stir", at: { x: number; z: number }): number {
    const unit = this.units.get(unitId);
    if (!unit || unit.lying || unit.path.length > 0) return 0;
    this.face(unit, at.x, at.z);
    return unit.figure.work(how);
  }

  /** A challenge bellowed (Taunt): the unit throws its arms wide and roars, and is heard. No weapon in it. */
  roar(actorId: string, name: string) {
    const unit = this.units.get(actorId);
    if (unit && !unit.lying) unit.figure.taunt();
    sounds.attack(name, "melee", this.fighter(actorId), this.spot(actorId));
  }

  /** A guard put up: the unit braces behind its shield, or what it has in hand. */
  brace(actorId: string) {
    const unit = this.units.get(actorId);
    if (unit && !unit.lying) unit.figure.guard();
  }

  /** That shot or spell arriving: the sound of it landing on its target, or going wide. */
  landed(targetId: string, name: string, hit: boolean, crit = false, fromId: string | null = null) {
    if (hit) {
      sounds.impact(name, attackStyle(name), crit, this.fighter(targetId), this.spot(targetId));
      this.recoil(targetId, fromId, crit ? 0.5 : 0.3);
    } else sounds.miss(name, attackStyle(name), this.spot(targetId));
  }

  /** Text rising off a unit: damage, healing, a condition's name. */
  floatOver(id: string, text: string, color: string) {
    this.float(id, text, color);
  }

  /** A glint of light on a unit: healing, a guard going up. */
  glint(id: string, color: string) {
    this.sparkle(id, color);
  }

  /** Where a unit's feet are this frame (the hop left out), or null if it is not on the map. */
  unitFeet(id: string): THREE.Vector3 | null {
    return this.units.get(id)?.feet.clone() ?? null;
  }

  /** Where a unit stands in the world, for a sound's distance. */
  whereIs(id: string): { x: number; z: number } | undefined {
    return this.spot(id);
  }

  /**
   * One just killed falls where it stands, limp (see Figure.fall): knocked away from `by`, who struck the blow.
   * Only for one held up for it (see Unit.dying); anyone else is already lying as they should.
   */
  private topple(id: string, by?: string, onDown?: () => void) {
    const unit = this.units.get(id);
    if (!unit || unit.dying === undefined) return onDown?.();
    unit.dying = undefined;
    unit.lying = true;
    unit.head = unit.size * LYING + 0.3;
    unit.path = [];
    unit.figure.setDim(true);
    this.clearArrows(unit);
    // A dead enemy's name goes as it falls (see nameless).
    this.applyLabel(unit);
    const from = by ? this.units.get(by) : undefined;
    const away = from ? unit.goal.clone().sub(from.goal).setY(0) : undefined;
    unit.figure.fall(away && away.lengthSq() > 1e-6 ? away : undefined, onDown);
  }

  /** Run `run` in `seconds` from now, on the render clock (at the next frame, if none are given). */
  private later(run: () => void, seconds = 0) {
    this.pending.push({ at: this.clock + seconds, run });
  }

  private lunge(actorId: string, targetId: string) {
    const a = this.units.get(actorId);
    const t = this.units.get(targetId);
    if (!a || !t || a === t) return;
    // Right at them: most of the way across the gap, with a spring off the ground.
    a.kick.copy(t.goal).sub(a.goal).setLength(Math.min(1.15, a.goal.distanceTo(t.goal) * 0.6));
    a.bob = 0.2;
  }

  /** Who a unit is in the fight, for its voice: looked up when asked, as the fight's line-up can change. */
  private fighter(id: string): Fighter | undefined {
    const h = this.state?.heroes.find((x) => x.id === id);
    if (h) return { side: "hero", kind: h.classId };
    const u = this.state?.units?.find((x) => x.id === id);
    return u ? { side: "enemy", kind: u.kind } : undefined;
  }

  /** Where a unit stands on the map, for a sound's distance. */
  private spot(id: string): { x: number; z: number } | undefined {
    const p = this.units.get(id)?.root.position;
    return p ? { x: p.x, z: p.z } : undefined;
  }

  /**
   * Play one attack: the attacker leans in, then either a melee swipe lands
   * on the target at once, or a bolt or arrow flies across first. `onImpact`
   * runs when it lands.
   */
  private attack(actorId: string, targetId: string, ability: string, perfect: boolean, onImpact: () => void, landed = false, tint?: string) {
    const a = this.units.get(actorId);
    const t = this.units.get(targetId);
    if (!a || !t || a === t) return onImpact();
    sounds.attack(ability, attackStyle(ability), this.fighter(actorId), this.spot(actorId));
    // Left or right as the viewer sees it, whichever way the camera has been turned.
    const dir = t.goal.clone().project(this.camera).x >= a.goal.clone().project(this.camera).x ? 1 : -1;
    const flip = dir < 0;
    const spell = SPELL_COLOR[ability];
    // A stomp is leant well into, so it is held long enough to be seen. A spell, a shot or a throw is the
    // figure's own gesture, and a blow in the hand its own strike (see below).
    if (QUAKES.has(ability)) a.lean = -dir * 0.9;
    if (!a.lying) a.turn = a.turnGoal = Math.atan2(t.goal.x - a.goal.x, t.goal.z - a.goal.z);
    const hitAt = t.goal.clone().add(new THREE.Vector3(0, t.size * 0.4, 0.05));

    if (QUAKES.has(ability)) {
      // It stays where it is and brings its weight down: dust rings out from its feet (once for the whole crew),
      // and each hero it reaches is jolted off their feet.
      if (this.clock - (this.quakeAt.get(actorId) ?? -Infinity) > 1) {
        this.quakeAt.set(actorId, this.clock);
        this.quakeRing(a);
      }
      if (landed) {
        t.kick.set(dir * 0.12, 0.22, 0);
        this.dustAt(t, perfect);
      }
      onImpact();
      return;
    }
    const rock = THROWN[ability];
    if (rock) {
      // Lobbed high, tumbling, and it breaks into dust where it lands.
      const from = a.goal.clone().add(new THREE.Vector3(dir * 0.5, a.size * 0.7, 0.05));
      const hurl = () =>
        this.spawnFx("rock", rock, flip, { from, to: hitAt, life: 0.4, size: [0.85, 1.0], spin: -dir * 9, fade: false, arc: 0.9, onEnd: () => {
          this.spawnFx("burst", perfect ? "#ffd23f" : "#c9c1aa", false, { from: hitAt, to: hitAt, life: 0.22, size: [0.7, 1.6], spin: 0.5, fade: true });
          if (landed) {
            this.dustAt(t, perfect);
            t.kick.set(dir * 0.18, 0, 0);
          }
          onImpact();
        } });
      // Swung round overhead first: it leaves the hand as the hand comes down to point.
      const wait = a.figure.cast();
      if (wait > 0) this.later(hurl, wait);
      else hurl();
      return;
    }

    if (spell || ARROW_ABILITIES.has(ability)) {
      const kind: FxKind = spell ? "bolt" : "arrow";
      const color = spell ?? "#e8dcc0";
      const from = a.goal.clone().add(new THREE.Vector3(dir * 0.5, a.size * 0.5, 0.05));
      const fly = () =>
        this.spawnFx(kind, color, flip, { from, to: hitAt, life: 0.24, size: [1.0, 1.0], spin: 0, fade: false, onEnd: () => {
          this.spawnFx("burst", perfect ? "#ffd23f" : color, false, { from: hitAt, to: hitAt, life: 0.22, size: [0.7, 1.7], spin: 0.5, fade: true });
          // An arrow that lands stays in: point first, the shaft toward whoever shot it.
          if (kind === "arrow" && landed) this.stickArrow(t, dir);
          onImpact();
        } });
      // An archer draws the bow first, and the arrow leaves when the string does; a bard plays, and the spell
      // goes as the song takes hold; any other spell (or an arrow from no bow) is swung round overhead, and
      // leaves as the hand points.
      const wait = (kind === "arrow" && (a.figure.loose() || a.figure.fire())) || (spell && a.figure.play()) || a.figure.cast();
      if (wait > 0) this.later(fly, wait);
      else fly();
      return;
    }
    // Melee: the figure winds up, steps half way across its tile and strikes (a creature, with no such
    // animation, is sprung at the target instead); the swipe across the target, and all that follows from it,
    // waits for the blow to land.
    const heavy = SMASHES.has(ability);
    const wait = a.figure.strike(HEAVY_SWINGS.has(ability) ? "heavy" : "light");
    const land = () => {
      // A heavy blow comes down from higher, wider, and knocks the target back with dust thrown up round its feet.
      this.spawnFx("slash", perfect ? "#ffd23f" : (tint ?? "#dfe9ff"), flip, { from: hitAt, to: hitAt, life: heavy ? 0.3 : 0.26, size: heavy ? [1.7, 3] : [1.3, 2.3], spin: -dir * (heavy ? 1.6 : 0.9), fade: true });
      // An ability's blow throws a burst of its colour off the target as it lands.
      if (tint && landed) this.spawnFx("burst", tint, flip, { from: hitAt, to: hitAt, life: 0.22, size: [0.7, 1.6], spin: 0.5, fade: true });
      if (heavy && landed) {
        t.kick.set(dir * 0.35, -0.08, 0);
        this.dustAt(t, perfect);
      }
      onImpact();
    };
    if (wait <= 0) {
      this.lunge(actorId, targetId);
      return land();
    }
    this.later(land, wait);
  }

  /** Dust thrown up either side of a unit's feet: a heavy landing, a rock breaking, the ground shaking under it. */
  private dustAt(unit: Unit, perfect = false) {
    const feet = unit.goal.clone().add(new THREE.Vector3(0, 0.15, 0.1));
    for (const side of [-1, 1]) {
      this.spawnFx("dust", perfect ? "#e8d27a" : "#c9b994", side > 0, { from: feet, to: feet.clone().add(new THREE.Vector3(side * 0.55, 0.3, 0)), life: 0.4, size: [0.6, 1.1], spin: 0, fade: true });
    }
  }

  /** The ground shaken by a stomp: a ring of dust rolling out from the unit's feet. */
  private quakeRing(unit: Unit) {
    const feet = unit.goal.clone().add(new THREE.Vector3(0, 0.12, 0));
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const out = new THREE.Vector3(Math.cos(a) * 1.9, 0.12, Math.sin(a) * 1.3);
      this.spawnFx("dust", "#c9b994", Math.cos(a) > 0, { from: feet.clone().add(out.clone().multiplyScalar(0.2)), to: feet.clone().add(out), life: 0.5, size: [0.7, 1.3], spin: 0, fade: true });
    }
  }

  /** Leave an arrow standing in `unit`, shot from the `dir` side (1: from the left). */
  private stickArrow(unit: Unit, dir: number) {
    const arrows = (unit.arrows ??= []);
    if (arrows.length >= MAX_STUCK_ARROWS) this.dropArrow(arrows.shift()!);
    const size = 0.6;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: fxTexture("arrow", "#e8dcc0", dir < 0), transparent: true, depthTest: false }));
    sprite.scale.set(size, size, 1);
    sprite.renderOrder = 5;
    const h = unit.size * 0.8;
    const w = unit.size * 0.5;
    // Somewhere on the body, the point a little inside it, the shaft drooping a touch.
    // Spread over the body: each new one avoids the height of the last so they don't bunch up.
    const last = arrows.at(-1)?.off.y ?? -1;
    let y = h * (0.25 + Math.random() * 0.5);
    if (Math.abs(y - last) < h * 0.12) y = h * 0.25 + ((y - h * 0.25 + h * 0.2) % (h * 0.5));
    const off = new THREE.Vector3(-dir * (size * 0.3) + (Math.random() - 0.5) * w * 0.3, y, 0.06);
    const rot = dir * (-0.05 - Math.random() * 0.35);
    this.fxGroup.add(sprite);
    arrows.push({ sprite, off, rot });
  }

  private dropArrow(a: StuckArrow) {
    this.fxGroup.remove(a.sprite);
    a.sprite.material.dispose();
  }

  private clearArrows(unit: Unit) {
    for (const a of unit.arrows ?? []) this.dropArrow(a);
    unit.arrows = [];
  }

  private sparkle(unitId: string, color: string) {
    const unit = this.units.get(unitId);
    if (!unit) return;
    const from = unit.goal.clone().add(new THREE.Vector3(0, unit.size * 0.4, 0.05));
    this.spawnFx("spark", color, false, { from, to: from.clone().add(new THREE.Vector3(0, 0.9, 0)), life: 0.6, size: [1.2, 1.5], spin: 0, fade: true });
  }

  private spawnFx(kind: FxKind, color: string, flip: boolean, opts: Omit<Fx, "sprite" | "age">) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: fxTexture(kind, color, flip), transparent: true, depthTest: false }));
    sprite.renderOrder = 4;
    sprite.position.copy(opts.from);
    sprite.scale.set(opts.size[0], opts.size[0], 1);
    sprite.renderOrder = 9;
    this.fxGroup.add(sprite);
    this.fx.push({ sprite, age: 0, ...opts });
  }

  private float(unitId: string, text: string, color: string, opts: { life?: number; rise?: number; height?: number; at?: THREE.Vector3 } = {}) {
    const unit = this.units.get(unitId);
    if (!unit) return;
    const map = textTexture(text, color);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
    const height = opts.height ?? 0.45;
    // The texture is 24 rows tall and as wide as the text needs: keep its pixels square.
    sprite.scale.set((height * map.image.width) / 24, height, 1);
    sprite.position.copy(opts.at ?? unit.root.position.clone().add(new THREE.Vector3(0, unit.size + 0.5, 0)));
    sprite.renderOrder = 10;
    this.fxGroup.add(sprite);
    this.floaters.push({ sprite, age: 0, life: opts.life, rise: opts.rise });
  }

  /**
   * A walking hero's hop has just touched the ground: a step sounds, by what they stepped on, and a little
   * puff is kicked up at their feet. Only heroes out of a fight, awake, and in view.
   */
  private footfall(id: string, unit: Unit) {
    const state = this.state;
    if (!state || unit.asleep) return;
    const hero = state.heroes.find((h) => h.id === id);
    if (!hero || hero.asleep) return;
    const feet = unit.feet;
    // Nothing off screen is heard or drawn.
    const seen = feet.clone().project(this.camera);
    if (seen.z > 1 || Math.abs(seen.x) > 1.05 || Math.abs(seen.y) > 1.05) return;
    // Heroes stand a quarter hex toward the camera from the middle of their hex (see syncUnits).
    const under = worldToHex(feet.x, feet.z - 0.25);
    const biome = tileAt(state.map, under)?.biome;
    // At the water's edge the step sets a ring going on the sea beside it.
    if (fancy.get() && biome && biome !== "water") {
      const here = hexToWorld(under);
      let nearest: { x: number; z: number } | null = null;
      let best = Infinity;
      for (const dir of HEX_DIRS) {
        const next = { q: under.q + dir.q, r: under.r + dir.r };
        if (tileAt(state.map, next)?.biome !== "water") continue;
        const there = hexToWorld(next);
        const d = Math.hypot(there.x - feet.x, there.z - feet.z);
        if (d < best) {
          best = d;
          nearest = there;
        }
      }
      // Just over the shared edge, a little along it either way so the rings are not all in one spot.
      if (nearest) {
        const along = (Math.random() - 0.5) * 0.5;
        const dx = nearest.x - here.x;
        const dz = nearest.z - here.z;
        addWaterRipple(here.x + dx * 0.6 - dz * along * 0.5, here.z + dz * 0.6 + dx * along * 0.5);
      }
    }
    const ground = stepGround(biome, !!tileAt(state.map, under)?.path);
    if (!ground || !biome) return;
    // The audio engine plays it, placed where the foot lands and falling off with distance from you.
    sounds.footstep(biome, { x: feet.x, z: feet.z }, id === state.you);
    if (!this.still) this.puff(ground, feet);
  }

  /** A unit has come down from a jump (see leapUnit): what it landed on is thrown up round its feet, twice a step's worth. */
  private touchdown(unit: Unit) {
    const state = this.state;
    if (!state || this.still) return;
    const feet = unit.feet;
    // Everyone stands a quarter hex toward the camera from the middle of their hex (see syncUnits).
    const tile = tileAt(state.map, worldToHex(feet.x, feet.z - 0.25));
    const ground = stepGround(tile?.biome, !!tile?.path);
    if (!ground) return;
    this.puff(ground, feet);
    this.puff(ground, feet);
  }

  private puff(ground: keyof typeof PUFFS, at: THREE.Vector3) {
    for (const look of PUFFS[ground]) this.kick(look, at);
  }

  /** Throw up the pieces of one kind of puff from a foot. */
  private kick(look: PuffLook, at: THREE.Vector3) {
    for (let i = 0; i < look.count; i++) {
      let puff = this.puffs.find((p) => !p.mesh.visible);
      if (!puff && this.puffs.length < PUFF_POOL) {
        const mesh = new THREE.Mesh(puffShape(look.kind), new THREE.MeshLambertMaterial({ flatShading: true }));
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        this.fxGroup.add(mesh);
        puff = { mesh, kind: look.kind, age: 0, life: 0, floor: 0, vx: 0, vy: 0, vz: 0, spin: new THREE.Vector3(), size: 0 };
        this.puffs.push(puff);
      }
      if (!puff) puff = this.puffs[(this.nextPuff = (this.nextPuff + 1) % this.puffs.length)];
      // Kicked out to either side of the foot and a little fore or aft, each piece its own way.
      const side = (i % 2 ? 1 : -1) * (0.5 + Math.random() * 0.5);
      const fore = (Math.random() - 0.5) * 0.9;
      puff.kind = look.kind;
      puff.mesh.geometry = puffShape(look.kind);
      puff.mesh.material.color.set(look.colors[(Math.random() * look.colors.length) | 0]);
      puff.mesh.visible = true;
      puff.age = 0;
      puff.floor = at.y;
      puff.size = look.size * (0.8 + Math.random() * 0.45);
      puff.mesh.position.set(at.x + side * 0.14, at.y + puff.size * 0.6, at.z + fore * 0.1);
      puff.mesh.rotation.set(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3);
      puff.mesh.scale.setScalar(1e-4);
      if (look.kind === "dust") {
        // Dust rolls out low and slow, and hangs.
        puff.life = 0.42 + Math.random() * 0.2;
        puff.vx = side * 0.75;
        puff.vy = 0.22 + Math.random() * 0.14;
        puff.vz = fore * 0.5;
        puff.spin.set((Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 2.4);
      } else {
        // Chips of grass and drops are thrown up and come down again, turning over as they go.
        const drop = look.kind === "splash";
        puff.life = 0.34 + Math.random() * 0.16;
        puff.vx = side * (drop ? 0.8 : 1.0);
        puff.vy = (drop ? 1.7 : 1.35) + Math.random() * 0.5;
        puff.vz = fore * 0.9;
        puff.spin.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16);
      }
    }
  }

  /**
   * What a hero just picked up, told over their head one thing at a time (gold, then XP, then the rest), each
   * rising off the plate and fading in about a second, a beat after the one before. XP is the Harbor's own pop,
   * motes and all. Easier to take in than the feed.
   */
  pickups(unitId: string, lines: { text: string; color: string; xp?: number }[]) {
    lines.forEach((line, i) =>
      this.pending.push({
        at: this.clock + i * PICKUP_GAP,
        run: () => {
          if (line.xp) return this.xpGain(unitId, line.xp);
          const unit = this.units.get(unitId);
          if (!unit) return;
          const head = unit.goal.clone().add(new THREE.Vector3(0, unit.size * 0.75, 0.05));
          const top = Math.max(head.y + 0.4, this.plateTop(unit) ?? 0);
          this.float(unitId, line.text, line.color, { life: 1.05, rise: 0.6, height: 0.38, at: new THREE.Vector3(head.x, top + 0.3, head.z) });
        },
      }),
    );
  }

  /**
   * A hero earned XP: a short burst of gold and pale-blue pixel motes rising
   * off their head and fading, a crisp "+N XP", and their plate's XP bar lit
   * up for a moment. `levelUp` adds a bigger flourish: more motes, a gold
   * burst, a ring of motes thrown outward and "LEVEL UP" over the top.
   */
  xpGain(unitId: string, amount: number, levelUp = false) {
    const unit = this.units.get(unitId);
    if (!unit || !(amount > 0 || levelUp)) return;
    if (levelUp && unitId === this.state?.you) sounds.levelUp();
    const head = unit.goal.clone().add(new THREE.Vector3(0, unit.size * 0.75, 0.05));
    // Everything rises clear of the plate, which floats a fixed number of screen pixels over the head.
    const top = Math.max(head.y + 0.4, this.plateTop(unit) ?? 0);
    const above = (y: number) => new THREE.Vector3(head.x, y, head.z);
    const count = levelUp ? 22 : 10;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.6;
      const spread = levelUp ? 0.55 : 0.35;
      const from = head.clone().add(new THREE.Vector3(Math.cos(a) * spread * Math.random(), Math.random() * 0.25, Math.sin(a) * 0.1));
      const to = new THREE.Vector3(from.x + Math.cos(a) * (levelUp ? 0.45 : 0.15), top + 0.15 + Math.random() * (levelUp ? 0.9 : 0.45), from.z);
      const life = 0.7 + Math.random() * 0.4;
      // The mote is 4 of its tile's 16 pixels: about two of a hero sprite's pixels across.
      const size = 0.4 + Math.random() * 0.25;
      // Each mote starts a little late, so the burst ripples rather than pops.
      const delay = Math.random() * 0.18;
      this.pending.push({ at: this.clock + delay, run: () => this.spawnFx("mote", XP_MOTES[i % XP_MOTES.length], false, { from, to, life, size: [size, size * 0.5], spin: 0, fade: true }) });
    }
    if (amount > 0) this.float(unitId, `+${amount} XP`, "#ffe27a", { life: 1.1, rise: 0.6, height: 0.4, at: above(top + 0.3) });
    unit.glowUntil = this.clock + (levelUp ? 1.2 : 0.7);
    this.applyLabel(unit);
    if (levelUp) {
      this.spawnFx("burst", "#ffd23f", false, { from: head, to: head, life: 0.45, size: [0.8, 2.4], spin: 0.6, fade: true });
      this.pending.push({ at: this.clock + 0.25, run: () => this.float(unitId, "LEVEL UP", "#ffd23f", { life: 1.6, rise: 0.5, height: 0.5, at: above(top + 0.8) }) });
    }
  }

  // ---------- terrain ----------

  private buildTerrain(state: RenderState, recentre = true) {
    this.mapCode = state.code;
    this.sodden = state.map.tiles.some((t) => t.biome === "cobble");
    // Round a map of the world there is only more fog: what lies past its edge is the fog's own grey.
    if (state.far) this.seaBase.copy(FAR_FLOOR);
    else this.seaBase.set(this.sodden ? "#2b4558" : "#3577cf");
    (this.sea.material as THREE.MeshLambertMaterial).color.copy(this.seaBase);
    this.wallTurn = NaN;
    this.lowered.clear();
    this.hangable.clear();
    if (state.indoors) for (const f of wallFaces(state.map)) this.hangable.set(key(f.pos), [...(this.hangable.get(key(f.pos)) ?? []), f.side]);
    this.tiles = state.map.tiles;
    this.water = state.map.tiles.filter((t) => t.biome === "water").map(hexToWorld);
    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.geometry.dispose();
    }
    if (this.wallMarks) {
      this.scene.remove(this.wallMarks);
      (this.wallMarks.material as THREE.Material).dispose();
      this.wallMarks.dispose();
      this.wallMarks = null;
    }
    this.decor.clear();
    this.poiSig = "";
    this.paintedFrom = null;

    const geo = hexColumn();
    // Its normals are its own: flat on the flats, turning smoothly over the fillet. A hex's column is cut off
    // at y = 0, where the old ones ended: a room's walls and floor do not hang down into the dark under it.
    const terrain = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ clippingPlanes: [GROUND_FLOOR], clipShadows: true }), this.tiles.length);
    const m = new THREE.Matrix4();
    // Open sea is left to the sea itself: only water within a couple of hexes of land is drawn as hexes,
    // with a ragged edge, so the map does not end in a straight-sided block of water.
    const land = this.tiles.filter((t) => t.biome !== "water");
    // For the night life: where the grass is, and where the land lies.
    this.nightLife.setGrass(
      this.tiles.filter((t) => (t.biome === "plains" || t.biome === "forest") && !t.built).map((t) => {
        const { x, z } = hexToWorld(t);
        return new THREE.Vector3(x, tileTop(t), z);
      }),
    );
    const spots = (land.length > 0 ? land : this.tiles).map(hexToWorld);
    this.land.x = spots.reduce((n, s) => n + s.x, 0) / Math.max(1, spots.length);
    this.land.z = spots.reduce((n, s) => n + s.z, 0) / Math.max(1, spots.length);
    this.land.reach = Math.max(2, ...spots.map((s) => Math.hypot(s.x - this.land.x, s.z - this.land.z)));
    this.deep = new Set(
      this.tiles
        .filter((t) => {
          // Water with something standing in it (rocks, a wreck) stays, so it can still be pointed at.
          if (t.biome !== "water" || state.map.pois.some((p) => p.pos.q === t.q && p.pos.r === t.r)) return false;
          // A map that is all sea is drawn whole, and so is a map of the world: its seas are part of it, and what
          // lies round it is mist, not water.
          // Nor is any of it left out over a void: there is no sea there to show in its place.
          if (land.length === 0 || state.far || this.backdropKind !== "sea") return false;
          const near = Math.min(...land.map((l) => hexDistance(l, t)));
          return near > 2 || (near === 2 && noise(t.q, t.r, 31) < 0.45);
        })
        .map(key),
    );
    // For the fancy water: which hexes are water, how near the shore, and which of their sides touch land.
    addFancyWater(terrain.material as THREE.MeshLambertMaterial, true);
    setGroundFine(terrain.material, state.far ? FAR_FINE : 1);
    const water = waterAttribute(this.tiles.length);
    const byKey = new Map(this.tiles.map((t) => [key(t), t]));
    const isLand = (t: Tile | undefined) => !!t && t.biome !== "water";
    // Under ground the rock is the scenery's to draw, as one mass: its hexes are left out of the ground. So are those of a hall's outer wall.
    const sceneryOpts = { floating: this.backdropKind !== "sea" && !this.roofed, roofed: this.roofed };
    this.tiles.forEach((t, i) => {
      const { x, z } = hexToWorld(t);
      const shown = this.deep.has(key(t)) || ZoneScenery.draws(t, sceneryOpts, (q, r) => byKey.get(key({ q, r }))) ? 0 : 1;
      m.compose(new THREE.Vector3(x, tileTop(t), z), new THREE.Quaternion(), new THREE.Vector3(shown, shown ? 1 : 0, shown));
      terrain.setMatrixAt(i, m);
      // (A pool in the ashlands is lava: painted molten, and no water is drawn on it.)
      if (t.biome !== "water" || t.clime === "ash") {
        // (A cave's floor is painted as bare rock is.)
        // (And the Harbor's bare shore is a strand of sand and shingle, banded and mottled as worn rock is, not one flat brown.)
        water.setXYZ(i, 0, 0, (this.roofed && t.biome === "cave") || (this.mapCode === "harbor" && t.biome === "mud") ? GROUND_KIND.hills : groundKind(t));
        return;
      }
      let sides = 0;
      for (const dir of HEX_DIRS) {
        const next = { q: t.q + dir.q, r: t.r + dir.r };
        if (!isLand(byKey.get(key(next)))) continue;
        const to = hexToWorld(next);
        sides |= 1 << shoreSide(to.x - x, to.z - z);
      }
      // (Under a roof no wind reaches it: dark and still, whatever the climate.)
      water.setXYZ(i, 1, sides, this.roofed ? 2 : (t.clime && WATER_KIND[t.clime]) || 0);
    });
    geo.setAttribute("aWater", water);
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    this.terrain = terrain;
    this.scene.add(terrain);
    this.wallTiles = this.tiles.flatMap((t, i) => (WALLS.has(t.biome) ? [i] : []));
    if (this.seeThrough && this.wallTiles.length > 0) {
      this.wallMarks = new THREE.InstancedMesh(geo, hidingMaterial([GROUND_FLOOR]), this.wallTiles.length);
      this.wallMarks.renderOrder = HIDES;
      // Like the trees, never worth culling: its hexes are all over the map.
      this.wallMarks.frustumCulled = false;
      this.scene.add(this.wallMarks);
      this.markWalls();
    }

    // The Harbor's dressing (townDressing.ts): the waygate's court, the lamps, the quay, the caverns' forecourt.
    this.townDressing?.dispose();
    this.townDressing = state.code === "harbor" && !state.far ? buildTownDressing(state.map, (p) => ({ ...hexToWorld(p), y: tileTop(tileAt(state.map, p)) })) : null;
    if (this.townDressing) {
      this.decor.add(this.townDressing.group);
      for (const f of flamesIn(this.townDressing.group)) this.liveFlames.add(f);
    }
    // Trees on forest, the thickets and boulder heaps that cannot be walked through, and the boulders that
    // bound the Harbor. POI hexes stay clear. Rocks on open hills, grass and waves come from the ambience.
    const poiKeys = new Set(state.map.pois.map((p) => key(p.pos)));
    const trees: TreeSpot[] = [];
    const boulders: BoulderSpot[] = [];
    const setOaks = this.tiles.filter((t) => t.blocker === "oak");
    for (const t of this.tiles) {
      // Nor where something stands on a zone's hex (a wall, a pillar: see zoneScenery.ts).
      if (poiKeys.has(key(t)) || t.prop) continue;
      const { x, z } = hexToWorld(t);
      const top = tileTop(t);
      const n = (salt: number) => noise(t.q, t.r, salt);
      // What grows is the climate's own: rimed pines in the frost, dead wood in the dunes and the ashlands (and half the mire's).
      const clime = t.clime;
      const tree = (dx: number, dz: number, size: number, salt: number, pine = n(salt + 1) < 0.68) => {
        const tint = tintOf(n(salt + 3), n(salt + 4));
        if (clime && TREE_TINT[clime]) tint.multiply(TREE_TINT[clime]!);
        const dead = clime === "dunes" || clime === "ash" || (clime === "mire" && n(salt + 5) < 0.45);
        trees.push({
          x: x + dx, y: top, z: z + dz, yaw: n(salt + 2) * Math.PI * 2, tint,
          size: dead ? size * 1.2 : size,
          kind: dead ? "snag" : pine || clime === "frost" ? "pine" : "broad",
          ...(dead ? { shape: Math.floor(n(salt + 6) * OAK_SHAPES * 0.999) } : {}),
        });
      };
      const rock = (dx: number, dz: number, size: number, tall: number, salt: number) => {
        const tint = tintOf(n(salt + 3), n(salt + 4));
        if (t.clime && ROCK_TINT[t.clime]) tint.multiply(ROCK_TINT[t.clime]!);
        boulders.push({ x: x + dx, y: top, z: z + dz, size, tall, yaw: n(salt) * Math.PI * 2, tilt: (n(salt + 1) - 0.5) * 0.5, shape: Math.floor(n(salt + 2) * 3.99), tint });
      };
      if (state.far) {
        // A small world: little trees in clumps, thick in the forest and one or two out on the grass, and
        // a few stones where the map has heaped boulders. (Its hills' peaks are the ambience's.)
        const clump = (count: number, least: number, more: number, salt: number) => {
          const turn = n(salt) * Math.PI * 2;
          for (let i = 0; i < count; i++) {
            const a = turn + (i / count) * Math.PI * 2 + (n(salt + 10 + i) - 0.5) * 1.5;
            const d = i === 0 ? n(salt + 20) * 0.2 : 0.3 + n(salt + 20 + i) * 0.46;
            tree(Math.sin(a) * d, Math.cos(a) * d * 0.92, least + n(salt + 30 + i) * more, salt + 40 + i * 5);
          }
        };
        const share = (clime && TREE_SHARE[clime]) || 1;
        // Deep in the woods the trees stand taller and closer; out on the grass, one or two.
        const deep = n(905) > 0.62;
        if (t.biome === "forest") clump(Math.max(1, Math.round((5 + Math.floor(n(900) * 2.99) + (deep ? 2 : 0)) * share)), deep ? 0.34 : 0.26, 0.2, 901);
        else if (t.biome === "plains" && n(960) < 0.16 * share) clump(1 + Math.floor(n(961) * 1.99), 0.22, 0.14, 962);
        if (t.blocker === "boulders") for (let i = 0; i < 3; i++) rock((n(980 + i) - 0.5) * 0.9, (n(984 + i) - 0.5) * 0.8, 0.2 + n(988 + i) * 0.12, 0.3 + n(992 + i) * 0.25, 996 + i * 5);
        // Here and there on open ground, a ring of standing stones: someone was here before the crew.
        else if (t.biome === "plains" && n(1060) < 0.014) {
          const turn = n(1061) * Math.PI * 2;
          for (let i = 0; i < 6; i++) {
            if (i === 4 && n(1062) < 0.5) continue;
            const a = turn + (i / 6) * Math.PI * 2;
            rock(Math.sin(a) * 0.5, Math.cos(a) * 0.46, 0.085, 0.34 + n(1064 + i) * 0.2, 1070 + i * 5);
          }
        }
        // A stone or two lying about on open ground: more of them where little grows.
        else if ((t.biome === "plains" || t.biome === "sand") && top > 0.45 && n(1020) < (clime === "dunes" || clime === "ash" ? 0.34 : 0.1)) {
          for (let i = 0; i < 1 + Math.floor(n(1021) * 1.99); i++) rock((n(1024 + i) - 0.5) * 1.1, (n(1028 + i) - 0.5) * 1.0, 0.09 + n(1032 + i) * 0.1, 0.1 + n(1036 + i) * 0.14, 1040 + i * 5);
        }
        continue;
      }
      if (t.blocker === "trees") {
        // A thicket: a ring of big old trees round one in the middle, and brush between their feet.
        const ring = 5 + Math.floor(n(100) * 2.99);
        const turn = n(101) * Math.PI * 2;
        for (let i = 0; i < ring; i++) {
          const a = turn + (i / ring) * Math.PI * 2 + (n(110 + i) - 0.5) * 0.6;
          const d = 0.5 + n(120 + i) * 0.22;
          tree(Math.sin(a) * d, Math.cos(a) * d * 0.95, 1.15 + n(130 + i) * 0.55, 140 + i * 5);
        }
        tree((n(102) - 0.5) * 0.2, (n(103) - 0.5) * 0.2, 1.6 + n(104) * 0.4, 190);
        for (let i = 0; i < 3; i++) {
          const a = turn + ((i + 0.5) / 3) * Math.PI * 2;
          tree(Math.sin(a) * 0.3, Math.cos(a) * 0.3, 0.42 + n(200 + i) * 0.2, 210 + i * 5, false);
        }
      } else if (t.blocker === "oak") {
        // One great old oak, set down by the map (the Harbor's, on its hill): in the middle of its hex, which
        // nobody can walk onto, the broadest of the oaks and bigger than any that grows wild.
        trees.push({ x, y: top, z, size: 3.7, kind: "oak", shape: 0, yaw: n(810) * Math.PI * 2, tint: tintOf(0.6, 0.55) });
      } else if (t.blocker === "boulders") {
        // A heap of boulders: one big one, a second leaning on it, and a few smaller round their feet.
        const turn = n(300) * Math.PI * 2;
        rock(Math.sin(turn) * 0.12, Math.cos(turn) * 0.12, 0.6 + n(301) * 0.15, 0.75 + n(302) * 0.35, 310);
        rock(Math.sin(turn + 2.4) * 0.45, Math.cos(turn + 2.4) * 0.42, 0.4 + n(303) * 0.12, 0.5 + n(304) * 0.3, 320);
        const small = 2 + Math.floor(n(305) * 2.99);
        for (let i = 0; i < small; i++) {
          const a = turn + 3.6 + i * 1.3 + n(330 + i) * 0.5;
          const d = 0.55 + n(340 + i) * 0.2;
          rock(Math.sin(a) * d, Math.cos(a) * d * 0.9, 0.16 + n(350 + i) * 0.14, 0.18 + n(360 + i) * 0.16, 370 + i * 5);
        }
      } else if (t.biome === "forest") {
        // Open woods: two trees, room to walk between.
        for (let i = 0; i < 2; i++) tree((n(i + 3) - 0.5) * 0.9, (n(i + 7) - 0.5) * 0.8 - 0.1, 0.72 + n(i) * 0.45, 400 + i * 5);
      } else if (t.biome === "rampart" && !t.built) {
        // The Harbor's bounds: great boulders shoulder to shoulder along the rim, so the hexes join into one
        // line round the island. They run across the way out from the island's middle; here and there the
        // line has slumped, and those stones sit lower. Smaller ones have rolled down on the inland side.
        // (The Harbor's wall curves round the middle of the town's own island, not the middle of all its land:
        // the housing island lies off to one side.)
        const heart = this.mapCode === "harbor" ? { x: SQRT3 * HARBOR_HEART_AT.col, z: 1.5 * HARBOR_HEART_AT.row } : this.land;
        const ox = x - heart.x, oz = z - heart.z;
        const out = Math.hypot(ox, oz) || 1;
        const ax = -oz / out, az = ox / out;
        const inx = -ox / out, inz = -oz / out;
        const slumped = n(500) < 0.3 ? 0.72 : 1;
        for (let i = 0; i < 3; i++) {
          const along = (i - 1) * 0.56 + (n(510 + i) - 0.5) * 0.14;
          const back = (n(520 + i) - 0.5) * 0.18;
          const size = (0.42 + n(530 + i) * 0.14) * (i === 1 ? 1.08 : 1);
          rock(ax * along + inx * back, az * along + inz * back, size, (0.9 + n(540 + i) * 0.45) * slumped, 550 + i * 5);
        }
        const small = 1 + Math.floor(n(580) * 2.99);
        for (let i = 0; i < small; i++) {
          const along = (n(590 + i) - 0.5) * 1.3;
          const d = 0.42 + n(600 + i) * 0.2;
          rock(ax * along + inx * d, az * along + inz * d, 0.14 + n(610 + i) * 0.12, 0.16 + n(620 + i) * 0.14, 630 + i * 5);
        }
      } else if (this.sodden && t.biome === "hills") {
        // A gap in the Harbor's line of boulders: a few stones tumbled across it.
        const turn = n(700) * Math.PI * 2;
        const count = 2 + Math.floor(n(701) * 2.99);
        for (let i = 0; i < count; i++) {
          const a = turn + (i / count) * Math.PI * 2 + (n(710 + i) - 0.5) * 0.8;
          const d = i === 0 ? 0.1 : 0.4 + n(720 + i) * 0.25;
          rock(Math.sin(a) * d, Math.cos(a) * d * 0.9, (i === 0 ? 0.3 : 0.16) + n(730 + i) * 0.12, (i === 0 ? 0.4 : 0.2) + n(740 + i) * 0.16, 750 + i * 5);
        }
      } else if (t.biome === "plains" && !t.built && !t.path) {
        // An old oak, here and there in the open grass; where the grass has died, more often, and dead: a snag.
        // Too stout to walk through or push aside, it stands toward a corner of its hex, where three hexes meet
        // and nobody stands, and only where that corner is open ground: nothing built or to be used on the three
        // hexes that meet there, nor on any hex beside them.
        // (No oak keeps its leaves in the dunes or the ashlands, and few stand in the frost: there it is a snag.)
        const dry = dryPatch(t, x, z) >= 0 || clime === "dunes" || clime === "ash" || clime === "frost";
        if (n(800) >= (dry ? 0.45 : 0.2) * (clime === "frost" || clime === "dunes" ? 0.4 : 1)) continue;
        // Where the map has set an oak down, it stands alone: no wild one within a few hexes of it.
        if (setOaks.some((o) => hexDistance(o, t) <= 5)) continue;
        const corner = Math.floor(n(801) * 5.99);
        const beside = [HEX_DIRS[corner], HEX_DIRS[(corner + 1) % 6]].map((d) => byKey.get(key({ q: t.q + d.q, r: t.r + d.r })));
        if (beside.some((b) => !b || b.biome === "water" || b.biome === "dock" || b.path)) continue;
        // (In the Harbor none stands at the edge of a paved lane either: the streets are kept clear.)
        if (this.mapCode === "harbor" && beside.some((b) => b!.biome === "cobble")) continue;
        const taken = (h: Tile | undefined) => !!h && (!!h.built || !!h.blocker || poiKeys.has(key(h)));
        if ([t, ...beside].some((h) => taken(h) || HEX_DIRS.some((d) => taken(byKey.get(key({ q: h!.q + d.q, r: h!.r + d.r })))))) continue;
        const a = ((-30 + 60 * corner) * Math.PI) / 180;
        const ox = x + Math.cos(a) * 0.8, oz = z + Math.sin(a) * 0.8;
        // Old trees keep their distance: none within a couple of hexes of another, so their crowns do not run together.
        if (trees.some((o) => (o.kind === "oak" || o.kind === "snag") && Math.hypot(o.x - ox, o.z - oz) < 3.6)) continue;
        // Nor does one grow up through a lamp post or a bench.
        if (this.townDressing?.spots.some((s) => Math.hypot(s.x - ox, s.z - oz) < 1.5)) continue;
        trees.push({
          x: ox,
          y: top,
          z: oz,
          size: dry ? 2.3 + n(802) * 0.6 : 2.7 + n(802) * 0.7,
          kind: dry ? "snag" : "oak",
          shape: Math.floor(n(803) * OAK_SHAPES * 0.999),
          yaw: n(804) * Math.PI * 2,
          tint: tintOf(n(805), n(806)),
        });
      }
    }
    // Where gulls may land: open ground nobody has built on or uses, low enough underfoot to see them on (no
    // meadow or tall grass). The quay and the piers count three times over, being where a gull would rather be.
    // None indoors or underground, on a map with no sea, for a backdrop, or for anyone who asked for less motion.
    const landings: GullSpot[] = [];
    if (!state.indoors && state.kind !== "caverns" && !this.roofed && !this.opts.backdrop && !this.still && this.tiles.some((t) => t.biome === "water")) {
      for (const t of this.tiles) {
        if (poiKeys.has(key(t)) || t.built || t.blocker) continue;
        const { x, z } = hexToWorld(t);
        const shore = t.biome === "mud" || t.biome === "dock";
        const open = t.biome === "cobble" || (t.biome === "plains" && !t.path && !tallGrass(t, x, z) && !meadowAt(x, z));
        if (!shore && !open) continue;
        for (let i = 0; i < (shore ? 3 : 1); i++) landings.push({ x, y: tileTop(t), z });
      }
    }
    this.gulls.setGround(landings, this.land, Math.min(6, 2 + Math.floor(landings.length / 70)), recentre);
    this.ambience.build(
      // (No wave breaks on a pool under a roof: the ambience is not told of the water there.)
      this.tiles.filter((t) => !this.deep.has(key(t)) && !(this.roofed && t.biome === "water")),
      // Nothing grows or lies about where a place stands, under a building, or in a thicket or a boulder heap.
      // The Harbor's gaps of rubble have their boulders from the woods, not the ambience's hill rocks.
      // (Grass does grow round the foot of a lone oak.)
      (t) => poiKeys.has(key(t)) || !!t.built || !!t.prop || (!!t.blocker && t.blocker !== "oak" && !state.far) || (this.sodden && t.biome === "hills"),
      (t) => ({ ...hexToWorld(t), y: tileTop(t) }),
      !!state.far,
    );
    // Nor does any wind blow there: the ambience's drifting wisps (the one thing of its with that attribute) are put away.
    if (this.roofed) for (const o of this.ambience.group.children) if (o instanceof THREE.Mesh && o.geometry.getAttribute("aSide")) o.visible = false;
    // The trees bend in the wind (fancy graphics), and aside as anyone walks through them.
    this.woods?.dispose();
    // The caverns' entrance is cut into the rampart behind its hex (its model stands back into it): none of the
    // rampart's rubble stands in the way in, or just in front of it, where it would block the arch from view.
    const ways = state.map.pois.filter((p) => p.kind === "cave").map((p) => ({ ...hexToWorld(p.pos), back: placeOf(p, state.far).back }));
    const clearOfWays = boulders.filter((b) => !ways.some((w) => Math.abs(b.x - w.x) < 1.4 && b.z - (w.z - w.back) > -0.9 && b.z - (w.z - w.back) < 1.3));
    this.woods = new Woods(trees, clearOfWays, this.sodden, !fancyGrass.get());
    this.decor.add(this.woods.group);
    // The caverns: moss, puddles, loose rocks, stalagmites and stalactites (caveDressing.ts).
    this.caveDressing?.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    });
    this.caveDressing = state.kind === "caverns" ? buildCaveDressing(this.tiles, (t) => ({ ...hexToWorld(t), y: tileTop(t) }), hexToWorld, (p) => poiKeys.has(key(p))) : null;
    if (this.caveDressing) this.decor.add(this.caveDressing);
    // What stands on a zone's hexes, its ladders and the rock of its cliffs (zoneScenery.ts); and, over a void, the rim of the slab.
    this.scenery?.dispose();
    this.scenery = sceneryOpts.floating || sceneryOpts.roofed || this.tiles.some((t) => t.prop || t.ladder) ? new ZoneScenery(this.tiles, (t) => ({ ...hexToWorld(t), y: tileTop(t) }), sceneryOpts) : null;
    if (this.scenery) this.decor.add(this.scenery.group);

    // Start centred on the map. Redrawing the ground of the same map leaves the camera where the player put it.
    if (!recentre) return;
    const xs = this.tiles.map((t) => hexToWorld(t).x);
    const zs = this.tiles.map((t) => hexToWorld(t).z);
    this.middle.set((Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2);
    this.target.copy(this.middle);
    this.targetGoal.copy(this.target);
  }

  /**
   * Stand the walls' copies (see wallMarks) where the walls are now. One cut down to a kerb for the camera hides
   * nobody, and has no copy.
   */
  private markWalls() {
    if (!this.terrain || !this.wallMarks) return;
    const m = new THREE.Matrix4();
    this.wallTiles.forEach((tile, i) => {
      if (this.lowered.has(key(this.tiles[tile]))) m.makeScale(0, 0, 0);
      else this.terrain!.getMatrixAt(tile, m);
      this.wallMarks!.setMatrixAt(i, m);
    });
    this.wallMarks.instanceMatrix.needsUpdate = true;
  }

  /**
   * Indoors, the walls between the camera and the room are cut down to a
   * kerb, like a doll's house, so the room can be seen from any side.
   */
  private lowerNearWalls() {
    const turn = Math.round(this.yaw * 20);
    if (!this.terrain || turn === this.wallTurn) return;
    this.wallTurn = turn;
    const m = new THREE.Matrix4();
    const upright = new THREE.Quaternion();
    const kerb = tileTop({ q: 0, r: 0, biome: "wall", h: 0.22 } as Tile);
    // A wall away from the camera stands its full height; the low front wall, seen from behind, comes up a little.
    const raised = tileTop({ q: 0, r: 0, biome: "wall", h: 0.9 } as Tile);
    const was = [...this.lowered].join("|");
    this.lowered.clear();
    this.tiles.forEach((t, i) => {
      if ((t.biome as string) !== "wall") return;
      const { x, z } = hexToWorld(t);
      const toward = (x - this.middle.x) * Math.sin(this.yaw) + (z - this.middle.z) * Math.cos(this.yaw);
      if (toward > 0.6) this.lowered.add(key(t));
      m.compose(new THREE.Vector3(x, toward > 0.6 ? kerb : Math.max(raised, tileTop(t)), z), upright, new THREE.Vector3(1, 1, 1));
      this.terrain!.setMatrixAt(i, m);
    });
    this.terrain.instanceMatrix.needsUpdate = true;
    this.markWalls();
    this.hideLoweredWallProps();
    // A wall cut down (or stood back up) and the pieces hung on it change every light's shadows.
    if ([...this.lowered].join("|") !== was) this.ambience.stirAll();
  }

  /** Things hung on a wall that has been cut down for the camera would float in the air: hide them until it stands again. */
  private hideLoweredWallProps() {
    for (const g of this.propModels.values()) {
      const wall = g.userData.wallKey as string | undefined;
      if (wall) g.visible = !this.lowered.has(wall);
    }
    for (const pane of this.panes.children) pane.visible = !this.lowered.has(pane.userData.wallKey as string);
    for (const panel of this.wallPanels.children) panel.visible = !this.lowered.has(panel.userData.wallKey as string);
  }

  // ---------- windows ----------

  /** The picture this view is drawn into, for another view to show. */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** For a backdrop: where it is seen from and what it looks at, and how wide a view that is (degrees, top to bottom). */
  setVantage(from: THREE.Vector3, to: THREE.Vector3, fov: number) {
    this.vantage = { from, to };
    this.baseFov = fov;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** For a backdrop: draw one frame now. The view showing it calls this, so the picture is fresh when it is copied. */
  step(now: number, flash: number) {
    this.lentFlash = flash;
    this.frame(now);
  }

  /**
   * Gives a room windows onto another view: `outside` is a backdrop (the Harbor), drawn off screen and
   * shown through panes set into the back wall. Null takes them away.
   */
  setOutlook(outside: WorldRenderer | null) {
    this.outlook = outside;
    this.outlookMap?.dispose();
    this.outlookMap = null;
    if (outside) {
      const map = new THREE.CanvasTexture(outside.canvas);
      map.magFilter = THREE.NearestFilter;
      map.minFilter = THREE.NearestFilter;
      map.generateMipmaps = false;
      map.colorSpace = THREE.SRGBColorSpace;
      this.outlookMap = map;
    }
    this.buildPanes(this.state);
  }

  /** The windows themselves: a few panes along the back wall, each showing its own slice of the one picture. */
  /**
   * The pub's walls dressed inside to go with the inn outside: on every side of a tall wall that faces the floor,
   * a sheet of oak boards to waist height under a rail, cream plaster above, and a timber beam along the top
   * (panelTexture), from the floor up to where the wall's top starts to round over. Each wall hex's sheets are
   * one mesh, hidden with the wall when it is cut down for the camera.
   */
  private buildWallPanels(state: RenderState) {
    for (const panel of this.wallPanels.children) (panel as THREE.Mesh).geometry.dispose();
    this.wallPanels.clear();
    const dressing = state.walls ?? (state.kind === "pub" ? "pub" : null);
    if (!dressing) return;
    let material = this.panelMaterials.get(dressing);
    if (!material) {
      material = new THREE.MeshLambertMaterial({ map: WALL_DRESSINGS[dressing]() });
      this.panelMaterials.set(dressing, material);
    }
    const byWall = new Map<string, number[][]>();
    for (const f of wallFaces(state.map)) {
      const tile = tileAt(state.map, f.pos);
      if (!tile) continue;
      const at = wallFace(f.pos, f.side);
      const top = tileTop(tile) - TILE_FILLET;
      const lift = 0.006;
      const [cx, cz] = [at.x + at.nx * lift, at.z + at.nz * lift];
      const half = WALL_FACE_HALF;
      // Two triangles, left to right as seen from the room, the sheet's foot on the floor.
      const corner = (s: number, y: number, u: number, v: number) => [cx + at.tx * s * half, y, cz + at.tz * s * half, at.nx, 0, at.nz, u, v];
      const a = corner(-1, FLOOR_TOP, 0, 0);
      const b = corner(1, FLOOR_TOP, 1, 0);
      const c = corner(1, top, 1, 1);
      const d = corner(-1, top, 0, 1);
      const list = byWall.get(key(f.pos)) ?? [];
      list.push(a, b, c, a, c, d);
      byWall.set(key(f.pos), list);
    }
    for (const [wall, verts] of byWall) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(verts.flatMap((v) => v.slice(0, 3)), 3));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(verts.flatMap((v) => v.slice(3, 6)), 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(verts.flatMap((v) => v.slice(6, 8)), 2));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.receiveShadow = true;
      mesh.userData.wallKey = wall;
      mesh.visible = !this.lowered.has(wall);
      this.wallPanels.add(mesh);
    }
  }
  /** One material for each way of dressing walls, made the first time it is wanted. */
  private panelMaterials = new Map<WallDressing, THREE.MeshLambertMaterial>();

  private buildPanes(state: RenderState | null) {
    for (const pane of this.panes.children) {
      pane.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    this.panes.clear();
    if (!this.outlookMap || !state?.indoors) return;
    // The back wall is the row furthest from the door. Its faces, left to right as seen from the room.
    const back = wallFaces(state.map)
      .filter((f) => f.pos.r === 0)
      .map((f) => ({ ...f, at: wallFace(f.pos, f.side) }))
      .sort((a, b) => a.at.x - b.at.x);
    if (back.length === 0) return;
    const count = Math.min(OUTLOOK_PANES, back.length);
    const frame = new THREE.MeshLambertMaterial({ color: "#4a3520", flatShading: true });
    for (let i = 0; i < count; i++) {
      // Spread evenly along the wall, leaving its ends clear.
      const face = back[Math.round(((i + 0.5) / count) * (back.length - 1))];
      const spot = this.wallSpot(face.pos, face.side, 0, PANE.y);
      const pane = new THREE.Group();
      pane.position.copy(spot.at).addScaledVector(new THREE.Vector3(face.at.nx, 0, face.at.nz), 0.03);
      pane.rotation.y = spot.yaw;
      pane.userData.wallKey = key(face.pos);
      // The glass: this pane's slice of the picture, lit from outside and not by the room.
      const glass = new THREE.PlaneGeometry(PANE.w, PANE.h);
      const uv = glass.getAttribute("uv") as THREE.BufferAttribute;
      for (let v = 0; v < uv.count; v++) uv.setX(v, (i + uv.getX(v)) / count);
      const view = new THREE.Mesh(glass, new THREE.MeshBasicMaterial({ map: this.outlookMap, toneMapped: false }));
      view.userData.glow = true;
      pane.add(view);
      // A wooden frame round it, and a bar down and across the middle.
      const bar = (w: number, h: number, x: number, y: number) => {
        const piece = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), frame);
        piece.position.set(x, y, 0.01);
        pane.add(piece);
      };
      bar(PANE.w + 0.1, 0.06, 0, PANE.h / 2 + 0.02);
      bar(PANE.w + 0.1, 0.06, 0, -PANE.h / 2 - 0.02);
      bar(0.06, PANE.h + 0.1, -PANE.w / 2 - 0.02, 0);
      bar(0.06, PANE.h + 0.1, PANE.w / 2 + 0.02, 0);
      bar(0.03, PANE.h, 0, 0);
      bar(PANE.w, 0.03, 0, 0);
      this.panes.add(pane);
    }
    this.hideLoweredWallProps();
  }

  /** Once a frame: has the backdrop draw itself, every other frame, and takes its new picture. */
  private showOutlook() {
    if (!this.outlook || !this.outlookMap || this.panes.children.length === 0) return;
    if (this.frames % 2 !== 0) return;
    this.outlook.step(this.last, this.storm.flash);
    this.outlookMap.needsUpdate = true;
  }

  /** Where a wall piece hangs: on side `side` of wall hex `pos`, `x` along it and `y` up from the floor; and which way it faces. */
  private wallSpot(pos: HexPos, side: number, x: number, y: number): { at: THREE.Vector3; yaw: number } {
    const f = wallFace(pos, side);
    return { at: new THREE.Vector3(f.x + f.tx * x, FLOOR_TOP + y, f.z + f.tz * x), yaw: Math.atan2(f.nx, f.nz) };
  }

  /** The hexes the places stand on, as keys. */
  private placeKeys(): string[] {
    return this.state?.map.pois.map((p) => key(p.pos)) ?? [];
  }

  /** The reach, as far as the paint depends on it: not at all where you roam freely, or with nothing in reach. */
  private paintReach(): Map<string, unknown> | null {
    return this.state?.freeRoam || this.reach.size === 0 ? null : this.reach;
  }

  /** Whether anything paintTiles reads has changed since it last painted (see paintedFrom). */
  private paintStale(): boolean {
    const was = this.paintedFrom;
    return !was || was.terrain !== this.terrain || was.night !== this.paintedNight || was.far !== !!this.state?.far || was.roofed !== this.roofed || was.reach !== this.paintReach() || was.places !== this.placeKeys().join(";");
  }

  private paintTiles() {
    if (!this.terrain) return;
    const c = new THREE.Color();
    const white = new THREE.Color("#ffffff");
    // A place's hex keeps its green: the ambience lays no dry grass there, so it would be parched for nothing.
    const placeKeys = this.placeKeys();
    const places = new Set(placeKeys);
    this.paintedFrom = { terrain: this.terrain, night: this.paintedNight, far: !!this.state?.far, roofed: this.roofed, places: placeKeys.join(";"), reach: this.paintReach() };
    this.tiles.forEach((t, i) => {
      c.set((t.clime && t.clime !== "greenwood" && CLIME_COLOR[t.clime][t.biome]) || (this.state?.far && FAR_COLOR[t.biome]) || BIOME_COLOR[t.biome]);
      // Molten, in the ashlands: brighter and darker in slow patches, like a crust breaking up.
      if (t.clime === "ash" && t.biome === "sand" && t.h < MOLTEN_BELOW) c.copy(MOLTEN_DEEP).lerp(MOLTEN, noise(t.q, t.r, 61));
      // And so is whatever would be water there: a pool of it is a pit of lava.
      const lava = t.clime === "ash" && t.biome === "water";
      if (lava) c.copy(MOLTEN_DEEP).lerp(MOLTEN, noise(t.q, t.r, 61));
      // In a wet, walled port the green is tired.
      if (this.sodden && (t.biome === "plains" || t.biome === "forest")) c.lerp(DRAB, 0.5);
      // The Harbor's shore: damp sand and shingle, paler and warmer than mud, no two hexes quite one shade.
      if (this.mapCode === "harbor" && t.biome === "mud") c.set("#8f7f62").offsetHSL(0, 0, (noise(t.q, t.r, 41) - 0.5) * 0.05);
      // And its piers stand on piles (townDressing.ts): what shows under a deck, between them, is wet shadow, not a block of planks.
      if (this.mapCode === "harbor" && t.biome === "dock") c.set("#2c231c");
      if (t.biome === "plains" && !t.clime && !t.built && !places.has(key(t))) {
        const { x, z } = hexToWorld(t);
        const dry = dryPatch(t, x, z);
        if (dry >= 0) c.lerp(dry === 2 ? DUSTY : PARCHED, dry === 2 ? 0.62 : 0.45);
        // Under tall grass the ground is in its shade.
        else if (tallGrass(t, x, z)) c.multiplyScalar(0.82);
      }
      if (this.roofed && t.biome === "water" && !lava) c.set(DARK_WATER);
      if (this.roofed && t.biome === "cave") c.set(CAVE_FLOOR[t.clime ?? "greenwood"]);
      if (this.sodden && t.biome === "water") c.lerp(GREY_SEA, 0.65);
      if (t.biome === "water" && !lava) c.lerp(NIGHT_SEA, (Math.max(0, this.paintedNight) / 10) * 0.7);
      c.offsetHSL(0, 0, (noise(t.q, t.r, 9) - 0.5) * (t.biome === "rampart" ? 0.1 : 0.06));
      const r = this.reach.get(key(t));
      if (r && r.cost > 0 && !this.state?.freeRoam) c.lerp(white, 0.3);
      this.terrain!.setColorAt(i, c);
    });
    if (this.terrain.instanceColor) this.terrain.instanceColor.needsUpdate = true;
  }

  /** World position for something standing on a hex. */
  private standAt(pos: HexPos): THREE.Vector3 {
    const { x, z } = hexToWorld(pos);
    return new THREE.Vector3(x, tileTop(this.state ? tileAt(this.state.map, pos) : undefined), z);
  }

  /**
   * Where a point above a hex sits on screen, in CSS pixels from the container's top left corner.
   * `lift` is how far above the ground to aim; the default is where a hero's name label hangs.
   * Null when the point is behind the camera or outside the view.
   */
  /**
   * Just above the top of a prop, in container pixels, wherever it stands
   * (on the floor or on another piece's top). Null when it is not drawn or not on screen.
   */
  screenAboveProp(id: string | number, lift = 0.15): { x: number; y: number } | null {
    const g = this.propModels.get(id);
    if (!g) return null;
    const box = new THREE.Box3().setFromObject(g);
    if (box.isEmpty()) return null;
    const v = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y + lift, (box.min.z + box.max.z) / 2);
    v.project(this.camera);
    if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight };
  }

  /**
   * Just above the top of a place's model (a building's roof, a sign's top), in container pixels: where its
   * title hangs. The top is measured once for each model and kept until the places are rebuilt. Null when
   * there is no such place, or it is hidden or off screen.
   */
  screenAbovePoi(id: string, lift = 0.25): { x: number; y: number } | null {
    const g = this.poiObject(id);
    if (!g || !g.visible) return null;
    let top = this.poiTops.get(id);
    if (!top) {
      const box = new THREE.Box3().setFromObject(g);
      if (box.isEmpty()) return null;
      top = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
      this.poiTops.set(id, top);
    }
    const v = top.clone();
    v.y += lift;
    v.project(this.camera);
    if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight };
  }

  /**
   * Where a hex is on the screen, in container pixels, `lift` above its ground, whether or not that is inside
   * the view (`on` says). Null only when it is behind the camera. For things drawn over the map that run off
   * its edge, as a line to somewhere out of sight does.
   */
  screenOf(pos: HexPos, lift = 0): { x: number; y: number; on: boolean } | null {
    if (!this.state) return null;
    const v = this.standAt(pos);
    v.y += lift;
    v.project(this.camera);
    if (v.z < -1 || v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight, on: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 };
  }

  screenAbove(pos: HexPos, lift = 1.8): { x: number; y: number } | null {
    if (!this.state) return null;
    const v = this.standAt(pos);
    v.y += lift;
    v.project(this.camera);
    if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    // The container's own size is what the HUD is laid out in.
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight };
  }

  /**
   * Where a unit's name label sits, in container pixels: just above its head,
   * wherever the unit is drawn (which is not always the middle of its hex).
   * Null when the unit is not on screen.
   */
  screenAboveUnit(id: string): { x: number; y: number } | null {
    const unit = this.units.get(id);
    if (!unit) return null;
    const v = unit.root.position.clone();
    v.y += unit.head - unit.bob;
    v.project(this.camera);
    if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight };
  }

  /** Ease the camera over to a hex. Following your hero pauses there until they next walk. */
  /** Have your hero turn to face the camera and stay so (while the bag is open), or go back to looking toward the pointer. */
  setFacingFront(on: boolean) {
    this.faceFront = on;
  }

  /** The hex the camera is looking at: the one under the middle of the view. */
  focus(): HexPos {
    return worldToHex(this.target.x, this.target.z);
  }

  lookAt(pos: HexPos) {
    this.targetGoal.copy(this.standAt(pos));
    if (this.follow && !this.followHeld) {
      this.followHeld = true;
      this.showFollow();
    }
  }

  /** Keep your hero centred (or stop). Turning it on brings the camera back to them, easing there. */
  setFollow(on: boolean) {
    this.follow = on;
    this.followHeld = false;
    writeFollow(on);
    this.showFollow();
  }

  /** The follow button lit (and pressed) while following. */
  private showFollow() {
    const b = this.followButton;
    const on = this.follow && !this.followHeld;
    const title = on ? "Following your hero; drag the map to look around (C)" : "Follow your hero (C)";
    b.setAttribute("aria-pressed", String(on));
    b.title = title;
    b.setAttribute("aria-label", "Follow your hero");
  }

  /**
   * Hand the view to a game played on a hex: `make` gets a group standing on
   * that hex to build in, and the camera and input until `endMinigame`. Your hero
   * is hidden meanwhile (you are seeing through their eyes), as are the
   * point of interest on the hex (the game brings its own) and the camera
   * buttons.
   */
  startMinigame<T extends WorldMinigame>(make: (group: THREE.Group) => T, at: HexPos, hidePoi?: string): T {
    this.endMinigame();
    const group = new THREE.Group();
    group.position.copy(this.standAt(at));
    this.scene.add(group);
    const game = make(group);
    const hidden: { obj: THREE.Object3D; was: boolean }[] = [];
    const hide = (obj: THREE.Object3D | null | undefined) => {
      if (!obj) return;
      hidden.push({ obj, was: obj.visible });
      obj.visible = false;
    };
    hide(hidePoi ? this.poiObject(hidePoi) : undefined);
    this.minigame = { game, group, hidden, felled: false };
    this.hideOwnHero();
    for (const b of [this.followButton, ...this.turnButtons]) b.style.visibility = "hidden";
    // Bring the usual view over the hex first, so the swing in starts from somewhere near.
    const { x, z } = hexToWorld(at);
    this.targetGoal.set(x, 0.14, z);
    this.heldKeys.clear();
    return game;
  }

  /** Whether your own hero has finished walking and stands where they were going (true if there is none to wait for). */
  heroSettled(): boolean {
    const mine = this.state?.you ? this.units.get(this.state.you) : undefined;
    return !mine || (mine.path.length === 0 && mine.root.position.distanceToSquared(mine.goal) < 0.02);
  }

  /** Give the view back: the game's group is taken down and everything it hid is shown again. */
  endMinigame() {
    const m = this.minigame;
    if (!m) return;
    this.minigame = null;
    this.scene.remove(m.group);
    m.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      // Sprite and effect textures are shared caches: free the materials, not their maps.
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const mat of mats) mat.dispose();
    });
    for (const h of m.hidden) h.obj.visible = h.was;
    if (m.felled) this.woods?.restore();
    const mine = this.state?.you ? this.units.get(this.state.you) : undefined;
    if (mine) for (const obj of [mine.root, mine.label, mine.ring]) if (obj) obj.visible = true;
    for (const id of this.stageHidden) this.showUnit(id);
    this.stageHidden = [];
    for (const b of [this.followButton, ...this.turnButtons]) b.style.visibility = "";
    this.cover = { bottom: 0, right: 0 };
    if (this.camera.fov !== this.baseFov || this.coverShift) {
      this.camera.fov = this.baseFov;
      this.camera.clearViewOffset();
      this.coverShift = "";
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * What is under a point of the map, in world units: the ground there, how
   * high its top stands, and whether a point of interest (a building, a spot)
   * is on that hex. Null off the map.
   */
  groundAt(x: number, z: number): { biome: string; top: number; poi: boolean } | null {
    if (!this.state) return null;
    const pos = worldToHex(x, z);
    const tile = tileAt(this.state.map, pos);
    if (!tile) return null;
    return { biome: tile.biome, top: tileTop(tile), poi: this.state.map.pois.some((p) => p.pos.q === pos.q && p.pos.r === pos.r) };
  }

  /** For the minigame under way: take the forest's own trees out of a circle (world units) so its things stand clear. Put back when it ends. */
  clearTrees(x: number, z: number, radius: number) {
    const m = this.minigame;
    if (!m || !this.woods) return;
    m.felled = true;
    this.woods.clear(x, z, radius);
  }


  /** While a minigame runs you see through your hero's eyes: their figure, tag and ring are not drawn. So are the units a game draws itself (a table's players, who all stand on its one hex). */
  private hideOwnHero() {
    const mine = this.state?.you ? this.units.get(this.state.you) : undefined;
    if (mine) for (const obj of [mine.root, mine.label, mine.ring]) if (obj) obj.visible = false;
    for (const id of this.stageHidden) {
      const u = this.units.get(id);
      if (!u) continue;
      for (const obj of [u.root, u.label, u.ring]) if (obj) obj.visible = false;
    }
  }

  /** Units a minigame draws for itself: hidden while it runs (see hideOwnHero), shown again by the next list or when it ends. */
  setStageHidden(ids: string[]) {
    const gone = this.stageHidden.filter((id) => !ids.includes(id));
    this.stageHidden = ids;
    for (const id of gone) this.showUnit(id);
    if (this.minigame) this.hideOwnHero();
  }

  private showUnit(id: string) {
    const u = this.units.get(id);
    if (!u) return;
    for (const obj of [u.root, u.label, u.ring]) if (obj) obj.visible = true;
  }

  /** Move the lantern over a pub game table across to the seated table that takes its place (0 the room's, 1 the seated one). */
  slideTableLamp(id: string, k: number) {
    this.tableLamps.slide(id, k);
  }

  /** Flare the lantern over a pub game table up by `amount` (0.3 a lift, 1 or more a blaze), settling over about `fade` seconds. */
  flareTableLamp(id: string, amount: number, fade = 1) {
    this.tableLamps.flare(id, amount, fade);
  }

  /** A point of interest's model, by id: for a title hung over it, a glow round it, or a game that hides it and stands its own there (a pub table). */
  poiObject(id: string): THREE.Object3D | undefined {
    return this.poiGroup.children.find((g) => g.userData.poiId === id);
  }

  /**
   * Light a structure up with a glowing outline, and show a hand for the pointer: the view calls this while the
   * pointer is on something a click goes into, and with null when it is not. `what` is a place's id, or the hex a
   * battle map's waygate hangs over. One structure at a time; nothing is drawn for it while none is lit.
   */
  setGlow(what: string | HexPos | null) {
    const name = (w: string | HexPos | null) => (w === null ? "" : typeof w === "string" ? `place ${w}` : `gate ${key(w)}`);
    if (name(what) === name(this.glowWhat)) return;
    this.glowWhat = what;
    this.renderer.domElement.style.cursor = what === null ? "" : "pointer";
    this.hoverGlow.set(this.glowRoot());
  }

  /** The structure `setGlow` named, as it stands now: a place's model, or the waygate over that hex of a battle map. */
  private glowRoot(): THREE.Object3D | null {
    const what = this.glowWhat;
    if (what === null) return null;
    if (typeof what === "string") return this.poiObject(what) ?? null;
    const at = hexToWorld(what);
    for (const pick of this.scenery?.picks ?? []) {
      const p = pick.getWorldPosition(this.glowAt);
      if ((p.x - at.x) ** 2 + (p.z - at.z) ** 2 < 0.8) return pick.parent;
    }
    return null;
  }

  /** Give a unit its boat (made once), or take it away. */
  private syncBoat(unit: Unit, kind: "barrel" | "rowboat" | undefined) {
    if (unit.boatKind === kind) return;
    if (unit.boat) {
      this.unitGroup.remove(unit.boat);
      unit.boat.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      unit.boat = null;
    }
    unit.boatKind = kind;
    if (!kind) return;
    const g = new THREE.Group();
    if (kind === "barrel") {
      const wood = new THREE.MeshLambertMaterial({ color: "#7a5a3a" });
      const dark = new THREE.MeshLambertMaterial({ color: "#4a3322" });
      const iron = new THREE.MeshLambertMaterial({ color: "#5a5e66" });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.21, 0.34, 10), wood);
      body.position.y = 0.05;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.01, 10), dark);
      top.position.y = 0.215;
      g.add(body, top);
      for (const y of [-0.04, 0.16]) {
        const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.012, 4, 14), iron);
        hoop.rotation.x = Math.PI / 2;
        hoop.position.y = y;
        g.add(hoop);
      }
    } else {
      // A proper little rowboat (see rowboat.ts): its oars are put in the rower's hands by rideBoat.
      const boat = rowboatModel();
      g.add(boat.group);
      g.userData.oars = boat.oars;
    }
    g.visible = false;
    this.unitGroup.add(g);
    unit.boat = g;
  }

  /**
   * Whether a unit is sat at the oars of a rowboat afloat (a person, without a rod in hand), and so is to be
   * posed rowing: where its stroke is, 0 (reached forward) to 1 (pulled back), or undefined if not.
   */
  private rowingPose(unit: Unit, p: THREE.Vector3, dt: number): number | undefined {
    if (unit.boatKind !== "rowboat" || unit.rod || unit.lying || this.groundAt(p.x, p.z)?.biome !== "water") return undefined;
    const moving = unit.path.length > 0;
    // Rowing, the stroke goes round steadily; at rest, the hands settle about half way and the oars lie still.
    if (moving) unit.oarPhase = ((unit.oarPhase ?? 0) + dt * 6.2) % (Math.PI * 2);
    const want = moving ? 0.5 - 0.5 * Math.cos(unit.oarPhase ?? 0) : 0.55;
    unit.oarPull = moving ? want : (unit.oarPull ?? want) + (want - (unit.oarPull ?? want)) * Math.min(1, dt * 4);
    return unit.oarPull;
  }

  /**
   * Afloat on a water hex: the boat bobs under the unit, sitting it down in it. A rowboat is turned the way its
   * rower faces, whichever way that is (walking, or looking toward the pointer), with its rowing seat under them;
   * each oar's handle is put in their fist and laid through its oarlock.
   */
  private rideBoat(unit: Unit, p: THREE.Vector3, dt: number) {
    const boat = unit.boat;
    if (!boat) return;
    const ground = this.groundAt(p.x, p.z);
    const afloat = ground?.biome === "water";
    boat.visible = afloat && unit.root.visible;
    if (!afloat) return;
    const swell = Math.sin(this.clock * 1.4 + p.x) * 0.025;
    if (unit.boatKind === "barrel") {
      boat.position.set(p.x, ground!.top + swell, p.z - 0.1);
      const moving = unit.path.length > 0;
      if (moving) {
        const to = unit.path[0];
        boat.rotation.y = Math.atan2(to.x - p.x, to.z - p.z);
      }
      boat.rotation.z = Math.sin(this.clock * 1.1 + p.z) * 0.06;
      // Sat down in it, to the chest.
      unit.sunk = 0.24 - swell;
      p.y -= unit.sunk;
      return;
    }
    // A rowboat: turned with its rower, its seat under them.
    const turn = unit.turn;
    const sin = Math.sin(turn), cos = Math.cos(turn);
    const seatZ = ROWER_SEAT.z * BOAT_SCALE;
    boat.position.set(p.x - sin * seatZ, ground!.top + swell, p.z - cos * seatZ);
    boat.rotation.set(0, turn, Math.sin(this.clock * 1.1 + p.z) * 0.05);
    // Seated on the thwart: the figure's origin as far below the seat as a seated figure's is.
    unit.sunk = SITTING_DROP * unit.size - ROWER_SEAT.y * BOAT_SCALE - swell;
    p.y -= unit.sunk;
    // No hop in a boat.
    unit.bob = 0;
    const oars = boat.userData.oars as [THREE.Group, THREE.Group] | undefined;
    if (!oars) return;
    const hands = unit.oarPull !== undefined && !unit.rod && !unit.lying ? unit.figure.hands() : null;
    if (!hands) {
      oars.forEach((oar, i) => shipOar(oar, OARLOCKS[i]));
      return;
    }
    // Where the fists are now, in the boat model's own units: the figure and the boat brought up to date first.
    unit.root.updateMatrixWorld(true);
    boat.updateMatrixWorld(true);
    const fist = new THREE.Vector3();
    // The left hand takes the left oar (hands are right then left; the oarlocks left then right).
    [hands[1], hands[0]].forEach((hand, i) => {
      hand.getWorldPosition(fist);
      oars[i].parent!.worldToLocal(fist);
      aimOar(oars[i], fist, OARLOCKS[i]);
    });
  }

  /** Whether a unit is still on its way along a walked path. */
  isWalking(id: string): boolean {
    return (this.units.get(id)?.path.length ?? 0) > 0;
  }

  // ---------- for a minigame's own things ----------

  /** The minigame being played, if any. */
  get playing(): WorldMinigame | null {
    return this.minigame?.game ?? null;
  }

  /** How dark it is outdoors, 0 (day) to 1 (dead of night). */
  get night(): number {
    return this.ambience.night;
  }

  /** Add something to the scene outside the minigame's own group (a pick held in front of the camera), or take it away. */
  addObject(obj: THREE.Object3D) {
    this.scene.add(obj);
  }

  removeObject(obj: THREE.Object3D) {
    this.scene.remove(obj);
  }

  /** Run `fn` every frame before drawing, with the frame's time step, the camera and the render clock. Returns the way to stop. */
  addTicker(fn: (dt: number, camera: THREE.PerspectiveCamera, clock: number) => void): () => void {
    this.tickers.add(fn);
    return () => this.tickers.delete(fn);
  }

  /** The nearest of `objects` (and their children) under a point on screen, in client pixels. */
  pickAt(objects: THREE.Object3D[], clientX: number, clientY: number): THREE.Intersection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(objects, true)[0] ?? null;
  }

  // ---------- points of interest ----------

  private buildPois(state: RenderState) {
    const sig = state.map.pois.map((p) => `${p.id}:${p.cleared}:${p.tier ?? ""}:${p.fill ?? ""}:${p.hp ?? ""}`).join("|");
    if (sig === this.poiSig) return;
    this.poiSig = sig;
    this.poiGroup.clear();
    for (const gate of this.gates) gate.dispose();
    this.gates = [];
    this.poiTops.clear();
    this.twinkles = [];
    this.tableLamps.clear();
    this.poiGroup.add(this.tableLamps.group);
    // What stands in the water, for the fancy sea to foam round. Each model sits a little back from its hex's middle.
    const standing: Standing[] = [];
    for (const poi of state.map.pois) {
      const { x, z } = hexToWorld(poi.pos);
      const { scale, back } = placeOf(poi, state.far);
      /** Something in the model, by where it is modelled: where it stands in the world, and how big. */
      const stands = (mx: number, mz: number, half: number, radius: number) => standing.push({ x: x + mx * scale, z: z + mz * scale - back, half: half * scale, radius: radius * scale });
      if (poi.kind === "rocks") stands(-0.05, 0.08, 0.25, 0.5);
      else if (poi.kind === "wreck") stands(0.2, 0.08, 0.75, 0.45);
    }
    setWaterStanding(standing);
    /** Chimney tops, which the ambience draws smoke from. */
    const stacks: THREE.Vector3[] = [];
    /** A lighthouse's lantern, which the ambience turns a beam from. */
    let beacon: THREE.Vector3 | null = null;
    let beaconScale = 1;
    let shine: THREE.ShaderMaterial | undefined;
    /** Buildings' lit windows and lanterns, and the panes that warm at dusk. */
    const glows: BuildingGlow[] = [];
    const panes: THREE.MeshBasicMaterial[] = [];
    /** Glowing mushrooms in the caverns, which light the rock round them until they are picked. */
    const patches: { id: string; at: THREE.Vector3; on: boolean }[] = [];
    for (const poi of state.map.pois) {
      const g = this.poiModel(poi);
      g.userData.poiId = poi.id;
      // Any real flame in it (a torch by the caverns' entrance) flickers with the rest.
      for (const f of flamesIn(g)) this.liveFlames.add(f);
      const at = this.standAt(poi.pos);
      const { scale, back, turn = 0 } = placeOf(poi, state.far);
      if (BUILDINGS.has(poi.kind)) inkBuilding(g, scale);
      // A building turned to front a road (see `facing`) is turned about its door: it stands back from the door
      // the way it faces away from it.
      // A hut is not set out with a surveyor's chain: each stands a few degrees askew of its lane, its own way
      // (the same for a plot staked out, its building site and the hut that goes up on it).
      // (In the Harbor the huts stand in a row along one lane, their fences in line: there it is hardly a degree or two.)
      const askew = HUT_KINDS.has(poi.kind) ? (noise(poi.pos.q, poi.pos.r, 77) - 0.5) * (this.mapCode === "harbor" ? 0.05 : 0.3) : 0;
      const yaw = yawOf((poi.facing ?? 0) + turn) + askew;
      const behind = new THREE.Vector3(0, 0, -back).applyAxisAngle(UP, yaw);
      g.position.set(at.x + behind.x, at.y, at.z + behind.z);
      g.rotation.y = yaw;
      g.scale.setScalar(scale);
      // A building bigger than its hex is pointed at as a whole: anywhere on it means its door.
      if (scale > 1) g.userData.door = poi.pos;
      g.traverse((o) => {
        // A glow is light, not a solid: it neither casts nor takes a shadow.
        if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = !o.userData.glow && !o.userData.ink;
        if (o.userData.twinkle !== undefined) this.twinkles.push(o);
      });
      this.poiGroup.add(g);
      // A game table in a room (the pub's): a lantern hung over it.
      if (state.indoors && LAMP_TABLES.has(poi.kind)) this.tableLamps.hang(poi.id, poi.pos, at);
      /** A point in the model, out in the world. */
      const out = (p: THREE.Vector3) => p.clone().multiplyScalar(scale).applyAxisAngle(UP, yaw).add(g.position);
      if (g.userData.smoke) stacks.push(out(g.userData.smoke as THREE.Vector3));
      if (g.userData.beacon) {
        beacon = out(g.userData.beacon as THREE.Vector3);
        beaconScale = scale;
        shine = g.userData.shine as THREE.ShaderMaterial | undefined;
      }
      for (const glow of (g.userData.glows as BuildingGlow[] | undefined) ?? []) glows.push({ ...glow, pos: out(glow.pos), size: glow.size * scale });
      if (g.userData.glowAt) patches.push({ id: poi.id, at: out(g.userData.glowAt as THREE.Vector3), on: !poi.cleared });
      panes.push(...((g.userData.panes as THREE.MeshBasicMaterial[] | undefined) ?? []));
    }
    this.poiGroup.traverse((o) => {
      const shape = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (shape) oldShapes.delete(shape);
    });
    for (const shape of oldShapes) shape.dispose();
    // The town's own lamps and fires (townDressing.ts) come up at dusk with the buildings'.
    if (this.townDressing) glows.push(...this.townDressing.glows);
    this.ambience.setTableLamps(this.tableLamps.lights());
    this.ambience.setSmoke(stacks);
    this.ambience.setBeacon(beacon, beaconScale, shine);
    this.ambience.setGlows(glows, panes);
    this.ambience.setGlowcaps(patches);
    // The sea breaks around rocks standing out of it, and the wreck on them.
    this.ambience.setSeaRocks(state.map.pois.filter((p) => p.kind === "rocks" || p.kind === "wreck").map((p) => this.standAt(p.pos)));
  }

  /** Furniture: rebuilt whenever a piece is added, moved, turned or selected. */
  private buildProps(state: RenderState) {
    const props = state.props ?? [];
    const sig = props.map((p) => `${p.id}:${p.model}:${key(p.pos)}:${p.facing}:${p.selected ? 1 : 0}:${p.x ?? 0}:${p.z ?? 0}:${p.y ?? 0}:${p.angle ?? 0}:${p.on ?? ""}`).join("|");
    if (sig === this.propSig) return;
    this.propSig = sig;
    this.propGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    });
    this.propGroup.clear();
    this.propModels.clear();
    this.surfaces = [];
    /** The flames the ambience flickers. */
    const flames: THREE.Mesh[] = [];
    // Pieces on the floor first, then the small things standing on them, which are hung on their support so they turn and move with it.
    const ordered = [...props.filter((p) => p.on === undefined), ...props.filter((p) => p.on !== undefined)];
    for (const prop of ordered) {
      const g = prop.fish ? fishMount(prop.fish) : propModel(prop.model);
      const base = prop.on !== undefined ? this.propModels.get(prop.on) : undefined;
      if (prop.on !== undefined && !base) continue;
      if (base) {
        const top = (base.userData.surface as SceneProp["surface"]) ?? { y: 0, w: 0, d: 0 };
        g.position.set(prop.x ?? 0, top.y, prop.z ?? 0);
        g.rotation.y = -(prop.angle ?? 0);
        base.add(g);
      } else if (prop.mount) {
        const { at, yaw } = this.wallSpot(prop.pos, prop.facing, prop.x ?? 0, prop.y ?? 0);
        g.position.copy(at);
        g.rotation.y = yaw;
        g.userData.wallKey = key(prop.pos);
        this.propGroup.add(g);
      } else {
        const at = this.standAt(prop.pos);
        g.position.set(at.x + (prop.x ?? 0), at.y, at.z + (prop.z ?? 0));
        g.rotation.y = yawOf(prop.facing, prop.angle);
        this.propGroup.add(g);
      }
      g.userData.surface = prop.surface;
      this.propModels.set(prop.id, g);
      // A lamp or candle holds its light inside its own frame (a lantern's cage, a candle's wick),
      // so its parts would shadow their own light: it casts none. A fire's light sits in front of
      // the hearth, so a hearth or fireplace still casts shadows from the other lights in the room.
      let lamplike = false;
      g.traverse((o) => {
        if (o.userData.light && o.userData.light !== "fire") lamplike = true;
      });
      g.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.userData.propId = prop.id;
        // Flames and glowing panes give light rather than block it; glass lets it through.
        if (o.userData.flame !== undefined) flames.push(o);
        else if (o.userData.selfLit || o.userData.glass) return;
        else {
          o.castShadow = !lamplike;
          o.receiveShadow = true;
        }
      });
      if (prop.surface) {
        // An unseen sheet over its top, which a carried small thing is aimed at.
        const t = prop.surface;
        const sheet = new THREE.Mesh(new THREE.PlaneGeometry(t.w, t.d), new THREE.MeshBasicMaterial({ visible: false }));
        sheet.rotation.x = -Math.PI / 2;
        sheet.position.set(t.x ?? 0, t.y + 0.002, t.z ?? 0);
        sheet.userData.sheetOf = prop.id;
        g.add(sheet);
        this.surfaces.push(sheet);
      }
    }
    this.propGroup.updateMatrixWorld(true);
    // Rings for the piece being handled, and lights wherever a model asks for one.
    const lights: RoomLight[] = [];
    for (const prop of ordered) {
      const g = this.propModels.get(prop.id);
      if (!g) continue;
      g.traverse((o) => {
        if (o.userData.light) lights.push({ pos: o.getWorldPosition(new THREE.Vector3()), kind: o.userData.light as LightKind, main: !!o.userData.main });
      });
      if (prop.selected && !prop.mount && (prop.covers?.length ?? 0) > 1) {
        // A piece reaching across hexes: outline every hex it covers, as one shape.
        this.propGroup.add(this.coverOutline(prop.covers!));
      } else if (prop.selected) {
        const outer = prop.small ? 0.24 : prop.ring ?? 0.95;
        const inner = prop.small ? 0.18 : outer - 0.13;
        const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, prop.mount ? 16 : 6), new THREE.MeshBasicMaterial({ color: "#ffd23f", side: THREE.DoubleSide, depthTest: !prop.small && !prop.mount }));
        if (prop.mount) {
          // Flat on the wall, just in front of the piece, and hidden with it.
          ring.position.set(0, 0, 0.02);
          g.add(ring);
        } else {
          ring.rotation.x = -Math.PI / 2;
          ring.rotation.z = Math.PI / 6;
          ring.position.copy(g.getWorldPosition(new THREE.Vector3())).setY(g.getWorldPosition(new THREE.Vector3()).y + 0.03);
          this.propGroup.add(ring);
        }
        ring.renderOrder = 2;
      }
    }
    this.hideLoweredWallProps();
    this.ambience.setLights(lights, flames);
    this.ear.lights(lights.map((l) => ({ kind: l.kind, x: l.pos.x, z: l.pos.z })));
  }

  /** A flat gold band just inside the outer edges of a group of hexes, on the floor: the selection ring of a piece covering more than one. */
  private coverOutline(hexes: HexPos[]): THREE.Mesh {
    const inside = new Set(hexes.map(key));
    const points: number[] = [];
    const y = FLOOR_TOP + 0.03;
    for (const h of hexes) {
      const { x, z } = hexToWorld(h);
      for (let i = 0; i < 6; i++) {
        // Edge i runs between corners i and i+1; the neighbour across it lies along the bisector.
        const [a, b] = [(i * Math.PI) / 3, ((i + 1) * Math.PI) / 3];
        const mid = (a + b) / 2;
        const nr = Math.round((z + Math.cos(mid) * SQRT3) / 1.5);
        const nq = Math.round((x + Math.sin(mid) * SQRT3) / SQRT3 - nr / 2);
        if (inside.has(key({ q: nq, r: nr }))) continue;
        const corner = (t: number, k: number) => [x + Math.sin(t) * k, y, z + Math.cos(t) * k];
        const [ao, bo, bi, ai] = [corner(a, 0.97), corner(b, 0.97), corner(b, 0.84), corner(a, 0.84)];
        points.push(...ao, ...bo, ...bi, ...ao, ...bi, ...ai);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const band = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: "#ffd23f", side: THREE.DoubleSide }));
    band.renderOrder = 2;
    return band;
  }

  // ---------- carrying a piece: the ghost that follows the pointer ----------

  /** The ghost of whatever is being carried, rebuilt when that changes. */
  private updateGhost() {
    const holding = this.state?.holding ?? null;
    const sig = holding ? `${holding.model}:${JSON.stringify(holding.footprint ?? null)}` : "";
    if (sig !== this.ghostSig) {
      this.ghostSig = sig;
      if (this.ghost) {
        this.scene.remove(this.ghost);
        this.ghost.traverse((o) => {
          const mesh = o as THREE.Mesh;
          mesh.geometry?.dispose();
          (mesh.material as THREE.Material | undefined)?.dispose();
        });
        this.ghost = null;
      }
      if (holding) {
        this.ghost = ghostModel(holding.model);
        const fp = holding.footprint;
        if (fp) {
          // What it will cover, laid on the floor under it: tinted with the ghost, red where it does not fit.
          const plate = new THREE.Mesh(
            fp.round ? new THREE.CircleGeometry(fp.w / 2, 32) : new THREE.PlaneGeometry(fp.w, fp.d),
            new THREE.MeshBasicMaterial({ color: "#bfe8ff", transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
          );
          plate.rotation.x = -Math.PI / 2;
          plate.position.set(fp.x ?? 0, 0.015, fp.z ?? 0);
          this.ghost.add(plate);
        }
        this.ghost.visible = false;
        this.scene.add(this.ghost);
      }
    }
    this.placeGhost();
  }

  /** Where the pointer would set the carried piece down, or null if it is off the room. */
  private aim(): PlaceTarget | null {
    const holding = this.state?.holding;
    if (!holding || !this.terrain || !this.pointer.inside) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((this.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.pointer.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    if (holding.mount) return this.aimAtWall(holding.mount);
    if (holding.small) {
      // A top first: aimed at, the thing stands on it, kept inside its edges. Not one hidden with its wall.
      const top = this.raycaster.intersectObjects(this.surfaces, false).find((h) => this.propModels.get(h.object.userData.sheetOf as string | number)?.visible !== false);
      if (top) {
        const id = top.object.userData.sheetOf as string | number;
        const base = this.propModels.get(id)!;
        const t = base.userData.surface as NonNullable<SceneProp["surface"]>;
        const local = base.worldToLocal(top.point.clone());
        const x = Math.max((t.x ?? 0) - t.w / 2, Math.min((t.x ?? 0) + t.w / 2, local.x));
        const z = Math.max((t.z ?? 0) - t.d / 2, Math.min((t.z ?? 0) + t.d / 2, local.z));
        const prop = this.state?.props?.find((p) => p.id === id);
        return { pos: prop?.pos ?? { q: 0, r: 0 }, x: round(x), z: round(z), on: id };
      }
    }
    const hit = this.raycaster.intersectObject(this.terrain)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const t = this.tiles[hit.instanceId];
    let pos = { q: t.q, r: t.r };
    let [px, pz] = [hit.point.x, hit.point.z];
    const fp = holding.footprint;
    if (!holding.small && fp && Math.hypot(fp.x ?? 0, fp.z ?? 0) > 0.3) {
      // A long piece is held by its middle: the hex it is anchored on is back along it from the pointer.
      const turn = -yawOf(holding.facing, holding.angle);
      const [c, s] = [Math.cos(turn), Math.sin(turn)];
      const [fx, fz] = [fp.x ?? 0, fp.z ?? 0];
      [px, pz] = [px - (fx * c - fz * s), pz - (fx * s + fz * c)];
      pos = hexAt(px, pz);
    }
    const mid = hexToWorld(pos);
    let x = px - mid.x;
    let z = pz - mid.z;
    const d = Math.hypot(x, z);
    // Furniture goes anywhere in its hex too, but settles in the middle when brought near it, the way it always stood.
    if (!holding.small && d < 0.15) return { pos, x: 0, z: 0 };
    const reach = holding.small ? SMALL_REACH : BIG_REACH;
    if (d > reach) [x, z] = [(x / d) * reach, (z / d) * reach];
    return { pos, x: round(x), z: round(z) };
  }

  /**
   * Where the pointer would hang a wall piece `mount` big: on the side of a
   * back or side wall it is over (or, over the floor, the nearest such side
   * beside it), as far along and as high as it points, kept on that side.
   */
  private aimAtWall(mount: { w: number; h: number }): PlaceTarget | null {
    const hit = this.raycaster.intersectObject(this.terrain!)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const t = this.tiles[hit.instanceId];
    const point = hit.point;
    let pos: HexPos;
    let side: number;
    let y = this.wallY;
    if (t.biome === "wall") {
      if (this.lowered.has(key(t))) return null;
      pos = { q: t.q, r: t.r };
      const mid = hexToWorld(pos);
      const sides = this.hangable.get(key(t));
      if (!sides?.length) return null;
      // The side the pointer is nearest, of those that face the room.
      const score = (s: number) => {
        const f = wallFace(pos, s);
        return f.nx * (point.x - mid.x) + f.nz * (point.z - mid.z);
      };
      side = sides.reduce((a, b) => (score(b) > score(a) ? b : a));
      // On the face of the wall (not its top), the height is where the pointer is.
      if (hit.face && Math.abs(hit.face.normal.y) < 0.5) y = point.y - FLOOR_TOP;
    } else if (t.biome === "floor") {
      // Over the floor beside a wall: the nearest side facing it, at the last height used.
      let best: { pos: HexPos; side: number; d: number } | null = null;
      HEX_DIRS.forEach((dir) => {
        const w = { q: t.q + dir.q, r: t.r + dir.r };
        if (this.lowered.has(key(w))) return;
        const back = HEX_DIRS.findIndex((o) => o.q === -dir.q && o.r === -dir.r);
        if (!this.hangable.get(key(w))?.includes(back)) return;
        const f = wallFace(w, back);
        const d = Math.hypot(point.x - f.x, point.z - f.z);
        if (d < 0.6 && (!best || d < best.d)) best = { pos: w, side: back, d };
      });
      if (!best) return null;
      ({ pos, side } = best);
    } else return null;
    const f = wallFace(pos, side);
    const along = Math.max(0, WALL_FACE_HALF - mount.w / 2);
    const x = Math.max(-along, Math.min(along, (point.x - f.x) * f.tx + (point.z - f.z) * f.tz));
    y = Math.max(WALL_ITEM_BOTTOM + mount.h / 2, Math.min(WALL_ITEM_TOP - mount.h / 2, y));
    this.wallY = y;
    return { pos, x: round(x), z: 0, wall: { side, y: round(y) } };
  }

  private placeGhost() {
    const ghost = this.ghost;
    const holding = this.state?.holding;
    if (!ghost || !holding) return;
    const target = this.aim();
    ghost.visible = !!target;
    if (!target) return;
    const base = target.on !== undefined ? this.propModels.get(target.on) : undefined;
    if (target.wall) {
      const { at, yaw } = this.wallSpot(target.pos, target.wall.side, target.x, target.wall.y);
      ghost.position.copy(at);
      ghost.rotation.y = yaw;
    } else if (base) {
      const t = base.userData.surface as NonNullable<SceneProp["surface"]>;
      ghost.position.copy(base.localToWorld(new THREE.Vector3(target.x, t.y + 0.004, target.z)));
      // Props only ever turn about the vertical, so the support's yaw is all there is to add.
      ghost.rotation.y = new THREE.Euler().setFromQuaternion(base.getWorldQuaternion(new THREE.Quaternion()), "YXZ").y - holding.angle;
    } else {
      const at = this.standAt(target.pos);
      // Anchored off the floor (a long piece held near a wall): drawn at floor height all the same, and red.
      const y = this.state && tileAt(this.state.map, target.pos)?.biome === "floor" ? at.y : FLOOR_TOP;
      ghost.position.set(at.x + target.x, y + 0.004, at.z + target.z);
      ghost.rotation.y = yawOf(holding.facing, holding.angle);
    }
    tintGhost(ghost, this.callbacks.canPlace?.(target) ?? true);
  }

  /** The prop under the pointer, if any. */
  private pickProp(): string | number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((this.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.pointer.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.propGroup, true).find((h) => h.object.userData.propId !== undefined && !h.object.userData.sheetOf);
    return hit ? (hit.object.userData.propId as string | number) : null;
  }

  /** The stools standing on the floor, by the hex each is on: where in the hex to sit, and how high the seat is. */
  private seatsOf(state: RenderState): Map<string, { pos: HexPos; x: number; z: number; top: number }> {
    const out = new Map<string, { pos: HexPos; x: number; z: number; top: number }>();
    for (const p of state.props ?? []) {
      const seat = SEATS[p.model];
      if (seat && !p.small && !p.mount && !p.flat && p.on === undefined) out.set(key(p.pos), { pos: p.pos, x: p.x ?? 0, z: p.z ?? 0, top: seat.top });
    }
    return out;
  }

  /**
   * A stool is furniture, so no walk goes through its hex; but a walk may end on it, to sit down. Each free
   * stool beside somewhere the viewer can walk to is added to their reach, as one more step from there.
   */
  private reachSeats(state: RenderState) {
    const found: { cost: number; prev: string | null; pos: HexPos }[] = [];
    for (const [k, seat] of this.seatsOf(state)) {
      if (this.reach.has(k) || state.heroes.some((h) => key(h.pos) === k)) continue;
      let from: { cost: number; pos: HexPos } | undefined;
      for (const d of HEX_DIRS) {
        const beside = this.reach.get(key({ q: seat.pos.q + d.q, r: seat.pos.r + d.r }));
        if (beside && (!from || beside.cost < from.cost)) from = beside;
      }
      if (from) found.push({ cost: from.cost + 1, prev: key(from.pos), pos: seat.pos });
    }
    for (const f of found) this.reach.set(key(f.pos), f);
  }

  /** Cost of stepping onto a tile: the terrain's, except that furniture cannot be walked through. */
  private stepCost(state: RenderState): ((t: Tile) => number) | undefined {
    if (!state.props?.length) return undefined;
    // Small things are stepped over, and so are rugs.
    const blocked = new Set(state.props.filter((p) => !p.small && !p.mount && !p.flat && p.on === undefined).flatMap((p) => (p.covers ?? [p.pos]).map(key)));
    return (t) => (blocked.has(key(t)) ? Infinity : tileCost(t));
  }

  /**
   * A point out in the world, in the space of `poi`'s model (as the loop over places sets each model down: moved
   * back, turned to face, and scaled).
   */
  private inModel(poi: Poi, x: number, z: number): THREE.Vector2 {
    const { scale, back, turn = 0 } = placeOf(poi, this.state?.far);
    const yaw = yawOf((poi.facing ?? 0) + turn);
    const at = hexToWorld(poi.pos);
    const behind = new THREE.Vector3(0, 0, -back).applyAxisAngle(UP, yaw);
    const p = new THREE.Vector3(x - at.x - behind.x, 0, z - at.z - behind.z).applyAxisAngle(UP, -yaw).divideScalar(scale);
    return new THREE.Vector2(p.x, p.z);
  }

  /**
   * A place's model. Each kind's is built by its own function in render/places (index.ts there lists them, and
   * says how to add one), with a kit of what it may ask of the renderer. A kind with no model is an empty group.
   */
  private poiModel(poi: Poi): THREE.Group {
    const g = new THREE.Group();
    const kit = placeKit(g, {
      sceneKind: this.state?.kind,
      mapCode: this.mapCode,
      map: this.state?.map,
      lidNow: (chest) => this.lidNow(chest),
      inModel: (place, x, z) => this.inModel(place, x, z),
      townLidAt: this.chestLid.at,
      townLidThrown: WorldRenderer.TOWN_LID,
      gateOpen: this.gateOpen,
      onWaygateBurst: () => this.callbacks.onWaygateBurst?.(),
      gates: this.gates,
    });
    PLACE_MODELS.get(poi.kind)?.(poi, kit);
    return g;
  }

  // ---------- chests and crates moving ----------

  /** How long a chest's lid takes to swing open, in seconds. */
  private static readonly LID_SWING = 0.5;
  /** How far back the town chest's lid is thrown when it is open, in radians about its hinges. */
  private static readonly TOWN_LID = -1.9;
  /** The town chest's lid: whether it is meant to be open, how far open it is now (0 shut, 1 thrown back), and how fast it is swinging. */
  private chestLid = { open: false, at: 0, speed: 0, seen: 0 };
  /** Scratch: where the town chest's pennant is, for the gust on it. */
  private flagAt = new THREE.Vector3();
  private flagTurn = new THREE.Quaternion();

  /** Open the town chest's lid, or shut it: it swings on a spring, a little past where it is going and back. */
  setChestOpen(open: boolean) {
    this.chestLid.open = open;
  }

  /** Whether the town's waygate is open (a map is open through it), for a gate made after this was last said. */
  private gateOpen = false;
  /**
   * Open the town's waygate (the crew has a map open through it) or close it (none is). It starts closed and
   * asleep; told to open, it bursts out into its floating self (waygate.ts) and `onWaygateBurst` is called at that
   * moment; told to close, it draws in and folds down. For anyone who asked for less motion it simply changes.
   */
  setWaygateOpen(open: boolean) {
    this.gateOpen = open;
    for (const gate of this.gates) gate.setOpen(open, this.still);
  }

  /** A chest's lid now: swinging open (eased, with a little bounce as it hits the end of its hinge), or at rest. */
  private lidNow(poi: Poi): number {
    const start = this.lidsSwinging.get(poi.id);
    if (start === undefined) return restingLid(poi);
    const t = Math.min(1, Math.max(0, (this.clock - start) / WorldRenderer.LID_SWING));
    // Ease out with an overshoot: it is flung back, knocks against its stop and settles.
    const c = 2.2;
    const k = 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
    const from = restingLid({ ...poi, cleared: false });
    return from + (LID_OPEN - from) * k;
  }

  /** A chest is opened: its lid swings back over half a second. */
  openChest(poiId: string) {
    this.lidsSwinging.set(poiId, this.clock);
  }

  /**
   * A blow struck by hand at a place rather than at a unit (a crate): the unit turns to it, winds up and strikes,
   * and `onImpact` runs as the blow lands.
   */
  strikeAt(actorId: string, at: THREE.Vector3, name: string, onImpact: () => void) {
    const a = this.units.get(actorId);
    if (!a || a.lying) return onImpact();
    sounds.attack(name, attackStyle(name), this.fighter(actorId), this.spot(actorId));
    this.face(a, at.x, at.z);
    const dir = at.clone().project(this.camera).x >= a.goal.clone().project(this.camera).x ? 1 : -1;
    const heavy = SMASHES.has(name);
    const land = () => {
      this.spawnFx("slash", "#dfe9ff", dir < 0, { from: at, to: at, life: heavy ? 0.3 : 0.26, size: heavy ? [1.7, 3] : [1.3, 2.3], spin: -dir * (heavy ? 1.6 : 0.9), fade: true });
      onImpact();
    };
    const wait = a.figure.strike(HEAVY_SWINGS.has(name) ? "heavy" : "light");
    if (wait > 0) return this.later(land, wait);
    // A creature with no swing of its own springs at it.
    a.kick.copy(at).sub(a.goal).setY(0).setLength(Math.min(0.6, a.goal.distanceTo(at) * 0.4));
    a.bob = 0.2;
    land();
  }

  /** A crate takes a blow: it rocks and jolts, `by` hard (1 a good hit). */
  shakePoi(poiId: string, by = 1) {
    this.poiShakes.set(poiId, { at: this.clock, by });
  }

  /** A point in a place's model (caveProps' chestMouth, crateMiddle), out in the world. Null if it is not drawn. */
  poiPoint(poiId: string, local: THREE.Vector3): THREE.Vector3 | null {
    const g = this.poiObject(poiId);
    if (!g) return null;
    g.updateWorldMatrix(true, false);
    return g.localToWorld(local.clone());
  }

  /** Where the middle of a chest's opening or a crate is, in the world: for what spills or flies out of it. */
  poiSpot(poi: Poi): THREE.Vector3 | null {
    return this.poiPoint(poi.id, poi.kind === "crate" ? crateMiddle(poi) : chestMouth(poi));
  }

  /** Text rising off a place: the damage a crate takes. */
  floatAt(poiId: string, text: string, color: string) {
    const g = this.poiObject(poiId);
    if (!g) return;
    const box = new THREE.Box3().setFromObject(g);
    if (box.isEmpty()) return;
    const map = textTexture(text, color);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
    sprite.scale.set((0.45 * map.image.width) / 24, 0.45, 1);
    sprite.position.set((box.min.x + box.max.x) / 2, box.max.y + 0.35, (box.min.z + box.max.z) / 2);
    sprite.renderOrder = 10;
    this.fxGroup.add(sprite);
    this.floaters.push({ sprite, age: 0 });
  }

  /** Each frame: lids swinging, crates rocking, glints twinkling, the town chest's pennant flying. */
  private movePois() {
    for (const gate of this.gates) gate.update(this.clock, this.ambience.night);
    this.townDressing?.update(this.clock, this.ambience.night);
    const flag = this.poiObject("townchest")?.userData.flag as THREE.Mesh | undefined;
    if (flag) {
      // Streamed out downwind, the way the wisps go, however the chest is turned: the wind brought into the
      // chest's own frame, and the cloth (which runs out along -x) turned about the pole to point along it.
      flag.parent!.getWorldQuaternion(this.flagTurn).invert();
      const way = this.flagAt.set(WIND_DIR.x, 0, WIND_DIR.z).applyQuaternion(this.flagTurn);
      flag.rotation.y = Math.atan2(way.z, -way.x);
    }
    if (flag && !this.still) {
      flag.getWorldPosition(this.flagAt);
      // Always a breeze off the sea, and harder as a gust goes by (when the wind is drawn at all).
      waveFlag(flag.geometry, this.clock, 0.45 + gustAt(this.flagAt.x, this.flagAt.z));
    }
    {
      // The town chest's lid, sprung toward open or shut. Opening it is flung; shutting it is let fall and thuds home.
      const lid = this.chestLid;
      const dt = Math.min(0.05, Math.max(0, this.clock - lid.seen));
      lid.seen = this.clock;
      const goal = lid.open ? 1 : 0;
      if (lid.at !== goal || lid.speed !== 0) {
        lid.speed += ((goal - lid.at) * (lid.open ? 150 : 90) - lid.speed * (lid.open ? 13 : 9)) * dt;
        lid.at += lid.speed * dt;
        // It cannot swing down through the chest: it lands on the rim and stops.
        if (lid.at < 0) [lid.at, lid.speed] = [0, 0];
        if (Math.abs(goal - lid.at) < 0.001 && Math.abs(lid.speed) < 0.01) [lid.at, lid.speed] = [goal, 0];
        const model = this.poiObject("townchest")?.userData.townLid as THREE.Object3D | undefined;
        if (model) model.rotation.x = WorldRenderer.TOWN_LID * lid.at;
        // What is in it lights the air over it as the lid goes back.
        const shine = this.poiObject("townchest")?.userData.townShine as THREE.MeshBasicMaterial | undefined;
        if (shine) shine.opacity = 0.5 * Math.max(0, Math.min(1, lid.at));
      }
    }
    for (const [id, start] of this.lidsSwinging) {
      const lid = this.poiObject(id)?.userData.lid as THREE.Object3D | undefined;
      const poi = this.state?.map.pois.find((p) => p.id === id);
      if (lid && poi) lid.rotation.x = this.lidNow({ ...poi, cleared: true });
      if (this.clock - start > WorldRenderer.LID_SWING) this.lidsSwinging.delete(id);
    }
    for (const [id, shake] of this.poiShakes) {
      const body = this.poiObject(id)?.userData.body as THREE.Object3D | undefined;
      const t = (this.clock - shake.at) / 0.35;
      if (body) {
        // A jolt that dies away: rocked side to side and lifted off the ground a moment.
        const k = t < 1 ? (1 - t) ** 2 * shake.by : 0;
        body.rotation.x = Math.sin(t * 22) * 0.09 * k;
        body.rotation.z = (body.userData.lean ??= body.rotation.z) + Math.sin(t * 17 + 1) * 0.12 * k;
        body.position.y = Math.abs(Math.sin(t * 9)) * 0.06 * k;
      }
      if (t >= 1) this.poiShakes.delete(id);
    }
    for (const o of this.twinkles) {
      const phase = o.userData.twinkle as number;
      // Mostly a faint point, flaring now and then, each on its own beat.
      const beat = Math.sin(this.clock * 2.3 + phase);
      const flare = Math.max(0, beat) ** 6;
      o.scale.setScalar((o.userData.size as number) * (0.35 + flare * 1.6));
      o.rotation.y = this.clock * 1.5 + phase;
    }
  }

  // ---------- units ----------

  private syncUnits(state: RenderState) {
    const want = new Map<string, Want>();
    const colorOf = (heroId: string) => PLAYER_COLORS[state.heroes.findIndex((h) => h.id === heroId) % PLAYER_COLORS.length];

    // Whoever shares a hex stands side by side on it: heroes, and on a zone's map the enemy too (the fallen lie where they fell).
    const stacks = new Map<string, number>();
    for (const h of state.heroes) stacks.set(key(h.pos), (stacks.get(key(h.pos)) ?? 0) + 1);
    for (const u of state.units ?? []) if (!u.down) stacks.set(key(u.pos), (stacks.get(key(u.pos)) ?? 0) + 1);
    const seen = new Map<string, number>();
    const seats = this.seatsOf(state);
    for (const h of state.heroes) {
      const n = stacks.get(key(h.pos))!;
      const i = seen.get(key(h.pos)) ?? 0;
      seen.set(key(h.pos), i + 1);
      const pos = this.standAt(h.pos);
      // Whoever is on a stool's hex sits on the stool, wherever in the hex it stands.
      const seat = i === 0 && !h.at && !h.asleep && !h.down && !h.prone ? seats.get(key(h.pos)) : undefined;
      if (h.at) pos.add(new THREE.Vector3(h.at.x, h.at.y, h.at.z));
      else if (seat) {
        pos.x += seat.x;
        pos.z += seat.z;
      } else {
        pos.x += (i - (n - 1) / 2) * 0.6;
        pos.z += 0.25;
      }
      const base = plateOf(h);
      const plate = base && h.id === state.you && state.stamina ? { ...base, bolts: state.stamina } : base;
      // A plate shows a first name only: full names run long over a crowd.
      const full = h.label ?? (plate ? h.name : undefined);
      const label = plate && full ? firstName(full) : full;
      want.set(h.id, { kind: h.classId, outfit: h.outfit, pos, size: 1.5, label, plate: label ? plate : undefined, stack: i, ring: colorOf(h.id), through: colorOf(h.id), pulse: !!h.active, asleep: h.asleep, rod: h.rod, boat: h.boat, down: h.down, falls: true, prone: h.prone, effects: h.effects, seat: seat?.top, unseen: h.unseen });
    }
    // A zone's enemies: beside whoever else is on their hex. The fallen lie in the middle of theirs.
    for (const u of state.units ?? []) {
      const pos = this.standAt(u.pos);
      pos.z += 0.25;
      // The second on a hex has its name a row higher, so the two can be told apart.
      let slot = 0;
      if (!u.down) {
        const n = stacks.get(key(u.pos)) ?? 1;
        slot = seen.get(key(u.pos)) ?? 0;
        seen.set(key(u.pos), slot + 1);
        pos.x += (slot - (n - 1) / 2) * 0.6;
      }
      want.set(u.id, { kind: u.kind, pos, faceKey: u.id, size: isBoss(u.kind) ? 1.9 : isBig(u.kind) ? 1.6 : 1.4, label: u.name, ring: u.hostile ? ENEMY_RED : undefined, through: u.hostile ? ENEMY_RED : undefined, pulse: !!u.active, hp: u.hp, down: u.down, falls: true, nameless: true, prone: u.prone, effects: u.effects, stack: slot });
    }

    const turned = new Map<string, number>();
    for (const [id, unit] of this.units) {
      const w = want.get(id);
      // A change of gear is a different model, so the unit is rebuilt, facing the way it was.
      if (w && spriteKey(w.kind, w.outfit, w.asleep, w.rod) === unit.kind) continue;
      // One still going under a pit is seen out of sight before it is cleared away (the next state clears it).
      if (!w && unit.sinkUntil !== undefined && this.clock < unit.sinkUntil) continue;
      if (w) turned.set(id, unit.turn);
      this.unitGroup.remove(unit.root);
      unit.figure.dispose();
      this.ambience.stir(unit.shadowAt);
      this.syncBoat(unit, undefined);
      if (unit.ring) this.unitGroup.remove(unit.ring);
      if (unit.hpBack) this.unitGroup.remove(unit.hpBack);
      if (unit.hpFill) this.unitGroup.remove(unit.hpFill);
      if (unit.badges) {
        this.unitGroup.remove(unit.badges);
        unit.badges.material.map?.dispose();
        unit.badges.material.dispose();
      }
      this.clearArrows(unit);
      this.dropLabel(unit);
      this.units.delete(id);
    }
    this.pulsing.clear();
    for (const [id, w] of want) {
      let unit = this.units.get(id);
      const seen = !!unit;
      if (!unit) {
        const figure = makeFigure(w.kind, lookFor(w.kind), w.outfit, { asleep: w.asleep, rod: w.rod, face: w.faceKey });
        for (const f of flamesIn(figure.root)) this.liveFlames.add(f);
        figure.root.position.copy(w.pos);
        this.unitGroup.add(figure.root);
        // New arrivals face the camera, turned a little so what they carry shows.
        const turn = turned.get(id) ?? this.yaw + 0.35;
        unit = { figure, root: figure.root, size: w.size, turn, turnGoal: turn, lying: false, shadowAt: w.pos.clone(), shadowTurn: turn, shadowSize: 0, ring: null, hpBack: null, hpFill: null, label: null, labelText: "", goal: w.pos.clone(), path: [], kick: new THREE.Vector3(), lean: 0, stride: 0, bob: 0, kind: spriteKey(w.kind, w.outfit, w.asleep, w.rod), asleep: false, nextZ: 0, zCount: 0, glowUntil: 0, glowing: false, head: w.size + 0.3, stack: 0, feet: w.pos.clone() };
        // Someone found on a stool is found sitting.
        if (w.seat !== undefined) unit.sit = 1;
        this.units.set(id, unit);
      }
      unit.goal.copy(w.pos);
      unit.seated = w.seat !== undefined;
      if (w.seat !== undefined) unit.seatTop = w.seat;
      if (w.asleep && !unit.asleep) unit.nextZ = this.clock + 0.4;
      unit.asleep = !!w.asleep;
      this.syncBoat(unit, w.boat);
      unit.rod = !!w.rod;
      // Seen going down: it stays on its feet for the blow to land, then falls (see topple).
      if (w.down && !unit.down && seen && w.falls && !(unit.sinkUntil !== undefined && this.clock < unit.sinkUntil)) unit.dying = this.clock + 2;
      if (!w.down) unit.dying = undefined;
      // Told it fell just before this: it falls now. (Told long ago, the word is stale.) Down with no fall to show
      // (not seen going down), it is down at once.
      if (unit.felled && (this.clock - unit.felled.at > 1 || (w.down && unit.dying === undefined))) {
        unit.felled.onDown?.();
        unit.felled = undefined;
      }
      if (unit.felled && unit.dying !== undefined) {
        this.topple(id, unit.felled.by, unit.felled.onDown);
        unit.felled = undefined;
      }
      unit.down = !!w.down;
      const fell = !!w.down && unit.dying === undefined;
      // Down or asleep: on their back, low to the ground.
      unit.lying = fell || !!w.asleep || !!w.prone;
      unit.head = unit.lying ? w.size * LYING + 0.3 : w.size + 0.3;
      unit.stack = w.stack ?? 0;
      unit.size = w.size;
      unit.figure.setSize(w.size);
      unit.figure.setDim(fell);
      unit.figure.setFade(w.unseen ? UNSEEN_FADE : 1);
      // A hero always, and an enemy once it is in a fight, is shown through the tree or wall it is behind.
      unit.figure.setSilhouette(this.seeThrough ? (w.through ?? null) : null);
      // Arrows stay in until the one they hit goes down, or the fight is over.
      if (fell || w.hp === undefined) this.clearArrows(unit);

      if (w.ring && !unit.ring) {
        unit.ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.44, 6), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        unit.ring.rotation.x = -Math.PI / 2;
        this.unitGroup.add(unit.ring);
      }
      if (unit.ring) {
        unit.ring.visible = !!w.ring;
        if (w.ring) (unit.ring.material as THREE.MeshBasicMaterial).color.set(w.ring);
      }
      if (w.pulse) this.pulsing.add(id);

      unit.nameless = !!w.nameless;
      unit.labelWant = { label: w.label, plate: w.plate, size: w.size, asleep: w.asleep, stack: w.stack };
      this.applyLabel(unit);

      if (w.hp !== undefined && !unit.hpBack) {
        unit.hpBack = new THREE.Sprite(new THREE.SpriteMaterial({ color: "#1b1830", depthTest: false }));
        unit.hpFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: "#6ee06e", depthTest: false }));
        unit.hpBack.center.set(0, 0.5);
        unit.hpFill.center.set(0, 0.5);
        unit.hpBack.renderOrder = 5;
        unit.hpFill.renderOrder = 6;
        unit.hpBack.layers.set(OVERLAY_LAYER);
        unit.hpFill.layers.set(OVERLAY_LAYER);
        this.unitGroup.add(unit.hpBack, unit.hpFill);
      }
      if (unit.hpBack && unit.hpFill) {
        const show = w.hp !== undefined && !w.down;
        unit.hpBack.visible = unit.hpFill.visible = show;
        if (show) {
          unit.hpBack.scale.set(1.2, 0.16, 1);
          unit.hpFill.scale.set(Math.max(0.001, 1.14 * w.hp!), 0.1, 1);
          unit.hpFill.material.color.set(w.hp! > 0.5 ? "#6ee06e" : w.hp! > 0.25 ? "#ffd23f" : "#ff6b6b");
          unit.hpBack.userData.lift = unit.hpFill.userData.lift = w.size + 0.25;
        }
      }
      // What it is under, badged over its head until each wears off. Redrawn only when the list or a count changes.
      const effects = w.down ? [] : (w.effects ?? []);
      const key = badgesKey(effects);
      if (key !== (unit.badgesKey ?? "")) {
        unit.badgesKey = key;
        if (unit.badges) {
          unit.badges.material.map?.dispose();
          unit.badges.material.dispose();
          this.unitGroup.remove(unit.badges);
          unit.badges = null;
        }
        if (effects.length > 0) {
          const { texture, aspect } = badgeTexture(effects);
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
          sprite.renderOrder = 7;
          sprite.layers.set(OVERLAY_LAYER);
          sprite.userData.aspect = aspect;
          unit.badges = sprite;
          this.unitGroup.add(sprite);
        }
      }
    }
  }

  /** Where the top of a unit's plate is, in world height, as it is drawn now. Null without a plate. */
  private plateTop(unit: Unit): number | null {
    const label = unit.label;
    if (!label) return null;
    const rows = label.userData.rows as number;
    const stack = unit.labelWant?.stack ?? 0;
    // An unattenuated sprite's size scales with its distance in front of the camera.
    const depth = -this.plateSpot.copy(label.position).applyMatrix4(this.camera.matrixWorldInverse).z;
    const row = (this.fine * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.renderer.domElement.height;
    if (!(depth > 0) || !(rows > 0)) return null;
    // The plate is offset straight up the screen; a world-height rise looks shorter by the camera's tilt.
    const tilt = Math.max(0.3, Math.cos(this.pitch));
    return label.position.y + ((5 + stack * (rows + 2) + rows) * row * depth) / tilt;
  }

  /** Draw (or redraw) a unit's name tag or plate: on a change, and as an XP glow on its bar starts and ends. */
  private applyLabel(unit: Unit) {
    const lw = unit.labelWant;
    if (!lw) return;
    unit.glowing = this.clock < unit.glowUntil;
    const plate = lw.plate && unit.glowing ? { ...lw.plate, glow: true } : lw.plate;
    // A dead enemy, fallen, goes without its name.
    const label = unit.nameless && unit.down && unit.lying ? undefined : lw.label;
    const labelKey = label ? plateKey(label, plate) : "";
    if (labelKey !== unit.labelText) {
      this.dropLabel(unit);
      unit.labelText = labelKey;
      if (label) {
        const { texture, aspect } = labelTexture(label, plate);
        // A fixed size on screen, whatever the zoom: each pixel of the label lands on exactly one pixel of the view.
        unit.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: false }));
        unit.label.layers.set(OVERLAY_LAYER);
        unit.label.userData.aspect = aspect;
        unit.label.userData.rows = texture.image.height;
        unit.label.userData.lift = lw.asleep ? lw.size * LYING + 0.3 : lw.size + 0.3;
        unit.label.renderOrder = 7;
        this.unitGroup.add(unit.label);
      }
    }
    if (unit.label) {
      // Held five of its own pixels clear of the head, at any zoom, however tall the plate;
      // a second hero on the same hex has theirs a plate higher, so neither hides the other.
      const rows = unit.label.userData.rows as number;
      unit.label.center.set(0.5, -(5 + (lw.stack ?? 0) * (rows + 2)) / rows);
    }
  }

  private dropLabel(unit: Unit) {
    if (!unit.label) return;
    this.unitGroup.remove(unit.label);
    unit.label.material.map?.dispose();
    unit.label.material.dispose();
    unit.label = null;
  }

  // ---------- hover and path ----------

  /**
   * The hover marker's parts. All of it is light: drawn additively and never written to the depth buffer, so
   * it lies over the ground and glows through whatever stands on the hex.
   */
  private buildHoverMarker(): THREE.Group {
    const group = new THREE.Group();
    const light = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide } as const;
    const flat = (mesh: THREE.Mesh) => {
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = Math.PI / 6;
      return mesh;
    };
    // The outline: a fine line just inside the hex's edge.
    const line = new THREE.MeshBasicMaterial({ color: "#f4fbff", ...light });
    group.add(flat(new THREE.Mesh(new THREE.RingGeometry(0.9, 0.955, 6), line)));
    // The glow: brightest against the outline, thinning to nothing toward the middle.
    const glowTex = gradientTexture((ctx, n) => {
      const g = ctx.createRadialGradient(n / 2, n / 2, n * 0.12, n / 2, n / 2, n / 2);
      g.addColorStop(0, "rgba(255, 255, 255, 0)");
      g.addColorStop(0.7, "rgba(255, 255, 255, 0.16)");
      g.addColorStop(1, "rgba(255, 255, 255, 0.85)");
      return g;
    });
    const glow = new THREE.MeshBasicMaterial({ color: "#bfe6ff", map: glowTex, ...light });
    group.add(flat(new THREE.Mesh(new THREE.CircleGeometry(0.9, 6), glow)));
    // The column: the hex's own outline drawn up into the air, bright at the ground and gone a little way up.
    const beamTex = gradientTexture((ctx, n) => {
      const g = ctx.createLinearGradient(0, n, 0, 0);
      g.addColorStop(0, "rgba(255, 255, 255, 0.7)");
      g.addColorStop(0.35, "rgba(255, 255, 255, 0.2)");
      g.addColorStop(1, "rgba(255, 255, 255, 0)");
      return g;
    });
    const beam = new THREE.MeshBasicMaterial({ color: "#a9dcff", map: beamTex, ...light });
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, HOVER_BEAM, 6, 1, true), beam);
    column.position.y = HOVER_BEAM / 2;
    group.add(column);
    // Motes: a few specks of light drifting up through the column, each at its own pace.
    const count = 14;
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const turn = Math.random() * Math.PI * 2;
      const out = 0.15 + Math.random() * 0.6;
      seeds.set([Math.cos(turn) * out, Math.sin(turn) * out, Math.random(), 0.25 + Math.random() * 0.4], i * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const moteTex = gradientTexture((ctx, n) => {
      const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      g.addColorStop(0, "rgba(255, 255, 255, 1)");
      g.addColorStop(0.4, "rgba(255, 255, 255, 0.45)");
      g.addColorStop(1, "rgba(255, 255, 255, 0)");
      return g;
    });
    const motes = new THREE.Points(geo, new THREE.PointsMaterial({ color: "#eaf6ff", map: moteTex, size: 0.16, sizeAttenuation: true, ...light }));
    motes.frustumCulled = false;
    group.add(motes);
    this.hoverParts = { line, glow, beam, motes, seeds };
    return group;
  }

  /** Each frame: the marker blooms up where it lands, breathes slowly while it rests, and its motes climb. */
  private animateHover() {
    if (!this.hoverRing.visible) return;
    const { line, glow, beam, motes, seeds } = this.hoverParts;
    // Up from nothing over a fifth of a second on a new hex.
    const arrive = Math.min(1, (this.clock - this.hoverBorn) / 0.2);
    const bloom = arrive * arrive * (3 - 2 * arrive);
    const breath = 0.5 + 0.5 * Math.sin(this.clock * 2.1);
    const live = this.hoverLive;
    line.color.set(live ? "#f4fbff" : "#5a6788");
    line.opacity = bloom * (live ? 0.5 + 0.18 * breath : 0.45);
    glow.opacity = bloom * (live ? 0.26 + 0.14 * breath : 0.1);
    beam.opacity = live ? bloom * (0.22 + 0.1 * breath) : 0;
    this.hoverRing.scale.setScalar(0.94 + 0.06 * bloom);
    motes.visible = live;
    if (!live) return;
    const at = motes.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < at.count; i++) {
      const rise = (seeds[i * 4 + 2] + this.clock * seeds[i * 4 + 3] * 0.35) % 1;
      // A slow sway as it climbs.
      const sway = Math.sin(this.clock * 1.3 + i * 2.4) * 0.05;
      at.setXYZ(i, seeds[i * 4] + sway, 0.05 + rise * HOVER_BEAM * 0.9, seeds[i * 4 + 1] + sway);
    }
    at.needsUpdate = true;
    (motes.material as THREE.PointsMaterial).opacity = bloom * (0.4 + 0.25 * breath);
  }

  private updatePath() {
    this.pathGroup.clear();
    const state = this.state;
    const hovered = this.hovered;
    this.hoverRing.visible = false;
    // While carrying a piece the ghost shows where it would go; no walking route.
    if (!state || !hovered || state.holding) return;
    const at = this.standAt(hovered);
    if (this.hoverRing.position.distanceToSquared(new THREE.Vector3(at.x, at.y + 0.04, at.z)) > 1e-6) this.hoverBorn = this.clock;
    this.hoverRing.position.set(at.x, at.y + 0.04, at.z);
    this.hoverRing.visible = true;
    const reach = this.reach.get(key(hovered));
    const me = state.heroes.find((h) => h.id === state.you);
    this.hoverLive = !!reach && reach.cost > 0;
    if (!reach || reach.cost === 0 || !me || (!state.freeRoam && !state.reach)) return;
    // The reach carries its own way back to the start, whether it was handed in or found over the terrain.
    // Reckoned with a course charted (Chart a Course), the way is carried whole: the hexes before may be best reached another way.
    const steps: HexPos[] = reach.way ? [...reach.way] : [];
    if (!reach.way) for (let at: typeof reach | undefined = reach; at && at.prev !== null; at = this.reach.get(at.prev)) steps.unshift(at.pos);
    for (const step of steps) {
      // The way there: small lights, glowing rather than solid.
      const dot = new THREE.Mesh(this.pathDot.geometry, this.pathDot.material);
      const p = this.standAt(step);
      dot.position.set(p.x, p.y + 0.2, p.z);
      this.pathGroup.add(dot);
    }
  }

  /** The place whose model the last `pick` landed on, if it landed on one. */
  private pickedPlace: string | null = null;
  /** The figure the last `pick` landed on, if it landed on one. */
  private pickedUnit: string | null = null;
  /**
   * Where the last `pick`'s ray met the ground (undefined: nowhere), and the ground it was tried against: null when
   * the pick was settled before the ground was tried. For the frame loop, which wants the same hit for the hero's gaze.
   */
  private pickedGround: THREE.Intersection | undefined;
  private pickedOn: THREE.InstancedMesh | null = null;

  private pick(): HexPos | null {
    this.pickedPlace = null;
    this.pickedOn = null;
    this.pickedGround = undefined;
    if (!this.terrain) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((this.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.pointer.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // A figure stands up out of its hex, so a click on it (or on the plate over its head) would
    // otherwise land on the ground behind. Clicking someone (other than yourself) means the hex they stand on.
    {
      this.pickedUnit = null;
      const entries = [...this.units.entries()].filter(([id]) => id !== this.state?.you);
      const others = entries.map(([, u]) => u);
      const onFigure = this.raycaster.intersectObjects(others.flatMap((u) => (u.label ? [u.root, u.label] : [u.root])), true)[0];
      const within = (root: THREE.Object3D, o: THREE.Object3D | null): boolean => !!o && (o === root || within(root, o.parent));
      const unit = onFigure && others.find((u) => u.label === onFigure.object || within(u.root, onFigure.object));
      if (unit) {
        this.pickedUnit = entries.find(([, u]) => u === unit)?.[0] ?? null;
        let best: Tile | null = null;
        let bestD = Infinity;
        for (const t of this.tiles) {
          const w = hexToWorld(t);
          const d = (w.x - unit.goal.x) ** 2 + (w.z - unit.goal.z) ** 2;
          if (d < bestD) [best, bestD] = [t, d];
        }
        if (best) return { q: best.q, r: best.r };
      }
    }
    const hit = this.raycaster.intersectObject(this.terrain)[0];
    this.pickedOn = this.terrain;
    this.pickedGround = hit;
    // A building stands up out of several hexes: pointing at it means its door, not the ground behind its roof.
    {
      const places = this.poiGroup.children.filter((g) => g.userData.door && g.visible);
      const onPlace = this.raycaster.intersectObjects(places, true)[0];
      if (onPlace && (!hit || onPlace.distance < hit.distance)) {
        let o: THREE.Object3D | null = onPlace.object;
        while (o && !o.userData.door) o = o.parent;
        if (o) {
          this.pickedPlace = (o.userData.poiId as string | undefined) ?? null;
          return { ...(o.userData.door as HexPos) };
        }
      }
    }
    // A waygate on a map hangs taller than a hero over its hex: pointing anywhere on it means that hex, not the
    // ground seen through or behind it (zoneScenery.ts keeps an unseen column for each to be hit).
    if (this.scenery && this.scenery.picks.length > 0) {
      const onGate = this.raycaster.intersectObjects(this.scenery.picks, false)[0];
      if (onGate && (!hit || onGate.distance < hit.distance)) {
        const at = onGate.object.getWorldPosition(new THREE.Vector3());
        let best: Tile | null = null;
        let bestD = Infinity;
        for (const t of this.tiles) {
          const w = hexToWorld(t);
          const d = (w.x - at.x) ** 2 + (w.z - at.z) ** 2;
          if (d < bestD) [best, bestD] = [t, d];
        }
        if (best) return { q: best.q, r: best.r };
      }
    }
    if (!hit || hit.instanceId === undefined) return null;
    const t = this.tiles[hit.instanceId];
    return { q: t.q, r: t.r };
  }

  // Pointer handling covers mouse and touch. One pointer pans (or taps a
  // hex if it barely moves); two pointers pinch to zoom and pan together.

  private onPointerDown = (e: PointerEvent) => {
    const canvas = this.renderer.domElement;
    if (this.minigame) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.minigame.game.press?.(ndc, this.camera);
      return;
    }
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety (keeps a drag alive off the canvas); carry on without it.
    }
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A tap on a touch screen comes with no move before it, so the press itself says the pointer is over the canvas.
    // Without this, placing a carried piece by tapping (aim() needs it) did nothing on a phone.
    this.pointer.inside = true;
    if (this.touches.size === 1) {
      // Right button, or Shift or Alt with the left, turns the view instead of sliding it.
      this.rotating = e.button === 2 || e.shiftKey || e.altKey;
      this.pointer.down = true;
      this.pointer.dragged = false;
      this.pointer.downX = this.pointer.x = e.clientX;
      this.pointer.downY = this.pointer.y = e.clientY;
    } else if (this.touches.size === 2) {
      // A second finger: this is a pinch, never a tap.
      this.pointer.dragged = true;
      this.rotating = false;
      this.pinch = { ...this.pinchState(), zoom: this.userDist };
      this.panFrom = { x: this.pinch.x, y: this.pinch.y };
    }
  };

  /** Distance between the two touches and their midpoint. */
  /** Distance between the two touches, their midpoint, and the angle of the line between them. */
  private pinchState(): { dist: number; x: number; y: number; angle: number } {
    const [a, b] = [...this.touches.values()];
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  /** Turn the view freely by an angle. */
  private turn(radians: number) {
    this.userYaw += radians;
    this.yaw = this.yawGoal = this.userYaw;
  }

  /** Tip the view up or down by an angle; `ease` glides there instead of jumping. */
  tiltBy(radians: number, ease = false) {
    this.userPitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.userPitch + radians));
    this.pitchGoal = this.pitchWanted();
    if (!ease) this.pitch = this.pitchGoal;
  }

  /**
   * How steeply the camera should look down: as the player has it; and, in a fight with the combat view on, a
   * little more steeply than that (COMBAT_LIFT), so more of the ground shows over what stands on it. The lift is
   * laid on top of the player's own tilt and never set against it: every tip of theirs still moves the view by
   * as much, the lift dwindles to nothing as they bring the camera down toward the horizon, and it is gone with
   * the fight (or the combat view), leaving the camera where they had it. None for whoever asked for less motion.
   */
  private pitchWanted(): number {
    if (!this.combat.enabled || !this.combat.on || !this.combat.fighting || this.still) return this.userPitch;
    const share = Math.max(0, Math.min(1, (this.userPitch - MIN_PITCH) / (DEFAULT_PITCH - MIN_PITCH)));
    return Math.min(MAX_PITCH, this.userPitch + COMBAT_LIFT * share);
  }

  /**
   * For a battle map's view, once it knows and whenever it changes: whether your hero is in a fight, and which
   * map this is. Having been told, the view has the combat view (cutaway.ts): on by itself while a fight lasts,
   * and the player's to switch with its button or V at any time.
   */
  setCombat(fighting: boolean, map: string) {
    this.combat.setFight(fighting, map);
  }

  /** How far on the combat view is, 0 to 1, for what a view draws itself and would have give way with the rest. */
  get cutaway(): number {
    return this.combat.shown;
  }

  /**
   * The places the combat view keeps clear, the most important first: whoever's turn it is and your own hero,
   * widely; the hex under the pointer; then everyone else in the fight (out of one, the rest of the party),
   * nearest the middle of the view first.
   */
  private combatSpots(): CutSpot[] {
    const state = this.state;
    if (!state) return [];
    const first: CutSpot[] = [];
    const rest: CutSpot[] = [];
    const add = (id: string, wide: boolean) => {
      const unit = this.units.get(id);
      if (!unit || !unit.root.visible) return;
      // On your own turn in a fight, as far round your hero as this turn's walk reaches: every hex they could go to is seen.
      let r = wide ? 3.4 : 2;
      if (id === state.you && !state.freeRoam && this.reach.size > 1) {
        if (this.combatReach.of !== this.reach) {
          let far = 0;
          for (const step of this.reach.values()) {
            const at = hexToWorld(step.pos);
            far = Math.max(far, Math.hypot(at.x - unit.feet.x, at.z - unit.feet.z));
          }
          this.combatReach = { of: this.reach, far };
        }
        r = Math.max(r, Math.min(7.5, this.combatReach.far + 0.9));
      }
      (wide ? first : rest).push({ id, x: unit.feet.x, y: unit.feet.y, z: unit.feet.z, r });
    };
    for (const h of state.heroes) if (!h.down) add(h.id, h.id === state.you || !!h.active);
    for (const u of state.units ?? []) if (u.hostile && !u.down) add(u.id, !!u.active);
    if (this.hovered && this.pointer.inside) {
      const at = this.standAt(this.hovered);
      first.push({ id: "hover", x: at.x, y: at.y, z: at.z, r: 1.7 });
    }
    const far = (s: CutSpot) => (s.x - this.target.x) ** 2 + (s.z - this.target.z) ** 2;
    return [...first, ...rest.sort((a, b) => far(a) - far(b))];
  }

  /** Turn the view by whole hex sides (60°), easing there. */
  rotateBy(steps: number) {
    const step = Math.PI / 3;
    // Snap to the nearest side first (counted from the turn the map opened at), so repeated presses land on
    // clean angles and six of them come back to where the view began.
    this.userYaw = (Math.round((this.userYaw - this.homeYaw) / step) + steps) * step + this.homeYaw;
    this.yawGoal = this.userYaw;
  }

  private onContextMenu = (e: Event) => e.preventDefault();

  private onKeyDown = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return;
    if (this.minigame) {
      if (this.minigame.game.key?.(e)) e.preventDefault();
      return;
    }
    if (e.key === "q" || e.key === "Q") this.rotateBy(-1);
    else if (e.key === "e" || e.key === "E") this.rotateBy(1);
    else if (e.key === "r" || e.key === "R") this.tiltBy(0.18, true);
    else if (e.key === "f" || e.key === "F") this.tiltBy(-0.18, true);
    else if (e.key === "c" || e.key === "C") this.setFollow(!this.follow || this.followHeld);
    else if ((e.key === "v" || e.key === "V") && this.combat.enabled && !e.repeat) this.combat.toggle();
    else if (import.meta.env.DEV && (e.key === "p" || e.key === "P")) this.setPost(!this.post);
    else if (PAN_KEYS[e.key.toLowerCase()]) {
      this.heldKeys.add(e.key.toLowerCase());
      // Arrow keys would otherwise scroll whatever panel has focus.
      if (e.key.startsWith("Arrow")) e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.heldKeys.delete(e.key.toLowerCase());
  };

  /** A key released while the window is elsewhere never sends keyup; do not keep sliding. */
  private onBlur = () => this.heldKeys.clear();

  /** True while a touch is still within the slack of where a pinch began (see `panFrom`): it does not pan. */
  private holdPan(x: number, y: number): boolean {
    if (!this.panFrom) return false;
    if (this.follow && !this.followHeld && Math.hypot(x - this.panFrom.x, y - this.panFrom.y) < PINCH_PAN_SLACK) return true;
    this.panFrom = null;
    return false;
  }

  private panBy(dx: number, dy: number) {
    if (dx === 0 && dy === 0) return;
    // Looking around is the player taking the camera: stop following until they ask again.
    if (this.follow) this.setFollow(false);
    const k = (this.dist / this.container.clientHeight) * 0.75;
    // Slide along the screen's own right and up, whichever way the camera is turned.
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    // The ground is foreshortened by the tilt, so a drag up or down covers more of it the lower the camera is.
    const deep = Math.min(2.4, 0.96 / Math.sin(this.pitch));
    this.targetGoal.x -= dx * k * cos + dy * k * deep * sin;
    this.targetGoal.z -= -dx * k * sin + dy * k * deep * cos;
    this.target.copy(this.targetGoal);
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.minigame) {
      if (this.minigame.game.hover) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.minigame.game.hover(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), this.camera);
      }
      return;
    }
    const touch = this.touches.get(e.pointerId);
    if (touch) {
      touch.x = e.clientX;
      touch.y = e.clientY;
    }
    if (this.pinch && this.touches.size >= 2) {
      const now = this.pinchState();
      // Fingers apart zooms in: the camera distance shrinks as the spread grows.
      // Damped: doubling the spread zooms by about a half, not by two.
      this.userDist = Math.max(MIN_ZOOM, Math.min(this.maxZoom, this.pinch.zoom * Math.pow(this.pinch.dist / now.dist, PINCH_DAMPING)));
      this.dist = this.userDist;
      // While following, a pinch only zooms: the little drift of spreading fingers is not a pan.
      if (!this.holdPan(now.x, now.y)) this.panBy(now.x - this.pinch.x, now.y - this.pinch.y);
      // Twisting the two fingers turns the view with them.
      let twist = now.angle - this.pinch.angle;
      if (twist > Math.PI) twist -= 2 * Math.PI;
      if (twist < -Math.PI) twist += 2 * Math.PI;
      this.turn(-twist);
      this.pinch.x = now.x;
      this.pinch.y = now.y;
      this.pinch.angle = now.angle;
      return;
    }
    const dx = e.clientX - this.pointer.x;
    const dy = e.clientY - this.pointer.y;
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.inside = true;
    if (this.pointer.down) {
      if (Math.hypot(e.clientX - this.pointer.downX, e.clientY - this.pointer.downY) > 6) this.pointer.dragged = true;
      if (this.pointer.dragged) {
        if (this.rotating) {
          this.turn(-dx * 0.008);
          // Dragging down lifts the camera to look more steeply; up drops it toward the horizon.
          this.tiltBy(dy * 0.006);
        }
        else if (!this.holdPan(e.clientX, e.clientY)) this.panBy(dx, dy);
      }
    } else {
      this.pointer.dirty = true;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const canvas = this.renderer.domElement;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (this.minigame) {
      this.touches.delete(e.pointerId);
      return;
    }
    this.touches.delete(e.pointerId);
    if (this.touches.size >= 1) {
      // One finger of a pinch lifted: carry on panning with the other, without a jump.
      this.pinch = null;
      const [rest] = [...this.touches.values()];
      this.pointer.x = rest.x;
      this.pointer.y = rest.y;
      if (this.panFrom) this.panFrom = { x: rest.x, y: rest.y };
      return;
    }
    this.pinch = null;
    this.panFrom = null;
    // A right-click, or a Shift/Alt click, is the start of a turn, not an order to walk.
    const wasClick = this.pointer.down && !this.pointer.dragged && !this.rotating && e.type === "pointerup";
    this.pointer.down = false;
    if (!wasClick) return;
    if (this.state?.holding && this.callbacks.onPlace) {
      const target = this.aim();
      if (target) this.callbacks.onPlace(target);
      return;
    }
    if (this.callbacks.onPropClick) {
      const prop = this.pickProp();
      if (prop !== null && this.callbacks.onPropClick(prop)) return;
    }
    const pos = this.pick();
    if (pos) this.callbacks.onHexClick(pos, this.pickedPlace ?? undefined, this.pickedUnit ?? undefined);
  };

  private onPointerLeave = () => {
    if (this.touches.size > 0) return;
    this.pointer.inside = false;
    this.setHovered(null);
    this.setHoveredPlace(null);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.minigame) return;
    // Shift and the wheel turn whatever is being carried: a notch at a time, or (snapping off) as far as the wheel moves.
    if (e.shiftKey && this.state?.holding && this.callbacks.onTurnHeld) {
      const delta = e.deltaY || e.deltaX;
      if (delta !== 0) this.callbacks.onTurnHeld(delta > 0 ? 1 : -1, Math.min(1, Math.abs(delta) / 100), e.altKey);
      return;
    }
    // Proportional to how far the wheel moved, capped so one notch is about 6%.
    // A trackpad sends many small deltas and a mouse wheel a few big ones; both end up gentle.
    const step = Math.max(-50, Math.min(50, e.deltaY)) * 0.0012;
    this.userDist = Math.max(MIN_ZOOM, Math.min(this.maxZoom, this.userDist * Math.exp(step)));
    this.dist = this.userDist;
  };

  private setHovered(pos: HexPos | null) {
    if ((pos && this.hovered && key(pos) === key(this.hovered)) || (!pos && !this.hovered)) return;
    this.hovered = pos;
    this.updatePath();
    this.callbacks.onHover(pos);
  }

  private setHoveredPlace(place: string | null) {
    if (place === this.hoveredPlace) return;
    this.hoveredPlace = place;
    this.callbacks.onHoverPlace?.(place);
  }

  // ---------- frame loop ----------

  /**
   * The element a minigame keeps its controls in, over the view (null when there is none): the camera frames the
   * game in what it leaves clear, above it when it lies along the bottom, or left of it down the right side.
   */
  setCover(el: HTMLElement | null) {
    if (el === this.coverEl) return;
    if (this.coverEl) this.coverObserver?.unobserve(this.coverEl);
    this.coverEl = el;
    if (el) {
      this.coverObserver ??= new ResizeObserver(() => this.measureCover());
      this.coverObserver.observe(el);
    }
    this.measureCover();
  }

  private measureCover() {
    const el = this.coverEl;
    const box = this.container.getBoundingClientRect();
    const r = el?.isConnected ? el.getBoundingClientRect() : null;
    if (!r || !r.width || !r.height || !box.width || !box.height) {
      this.coverGoal = { bottom: 0, right: 0 };
      return;
    }
    // Whichever way round leaves more of the view clear: a dock along the bottom, or one down the right side.
    const bottom = Math.max(0, (box.bottom - r.top) / box.height);
    const right = Math.max(0, (box.right - r.left) / box.width);
    this.coverGoal = bottom <= right ? { bottom: Math.min(bottom, 0.6), right: 0 } : { bottom: 0, right: Math.min(right, 0.6) };
  }

  private resize() {
    this.measureCover();
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.ambience.fine = this.fine;
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // A view offset for a minigame's cover is set again next frame, in the new size.
    if (this.coverShift) this.coverShift = "resized";
  }

  /** A clap of thunder for a spell: a thunder take heard and the sky lit with it, whatever the weather (Storm.clap). */
  thunderclap() {
    this.storm.clap();
  }

  /** Jolt the camera, `by` world units at first and dying away over `seconds`: a thunderclap, a great blow. Not with reduced motion. */
  shake(by: number, seconds: number) {
    // A stronger jolt still running is not cut short by a smaller one.
    if (this.still || this.shakeBy * (this.shakeLeft / this.shakeFor) ** 2 > by) return;
    this.shakeBy = by;
    this.shakeFor = this.shakeLeft = seconds;
  }
  private shakeBy = 0;
  private shakeFor = 1;
  private shakeLeft = 0;

  /** Dev server only: a lightning strike now, whatever the weather, for trying thunder takes against the flash. */
  strike() {
    if (import.meta.env.DEV) this.storm.strikeNow(this.camera, this.target);
  }

  /** Turns the finishing pass on or off in this view. The setting players keep is "Fancy graphics" (fancy.ts). */
  setPost(on: boolean) {
    if (on === !!this.post) return;
    if (on) {
      this.post = new PostFx(this.renderer);
      this.resize();
    } else {
      this.post!.dispose();
      this.post = null;
      this.renderer.setRenderTarget(null);
    }
  }

  private camDist = 24;
  /** Seconds left of coming in from an opening view (see swoop). */
  private swooping = 0;

  /**
   * Open on the map from somewhere else and come slowly in to the usual view: from `dist` away (as zoom is
   * counted), tipped to `pitch` (radians above the horizon) and turned `turn` off the map's own bearing.
   * Not for anyone who asked for less motion.
   */
  swoop(dist: number, pitch: number, turn = 0, seconds = 4) {
    if (this.still) return;
    this.camDist = dist;
    this.pitch = Math.max(MIN_PITCH, Math.min(1.5, pitch));
    this.yaw = this.yawGoal + turn;
    this.swooping = seconds;
  }

  /** Whether the map has been shown yet: false while it is still being made behind the veil. */
  get revealed(): boolean {
    return this.settling < 0;
  }

  /** The direction to the sun or moon, for things a view draws itself that should be lit as the map is. */
  get sun(): THREE.Vector3 {
    return this.ambience.sunDir;
  }

  /** The mist the distance is lost in under the open sky (its colour, and where it begins and is whole), or null where there is none. */
  get mist(): THREE.Fog | null {
    return this.scene.fog as THREE.Fog | null;
  }

  private frame = (now: number) => {
    if (!this.opts.backdrop) this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    this.animateHover();
    const ease = 1 - Math.exp(-dt * 6);

    if (this.pointer.dirty && this.pointer.inside && !this.minigame) {
      this.pointer.dirty = false;
      this.setHovered(this.pick());
      this.setHoveredPlace(this.pickedPlace);
      // Where on the ground the pointer is, for your hero to look toward: what the pick found along the same ray,
      // if it got as far as trying the ground.
      const ground = !this.terrain ? undefined : this.pickedOn === this.terrain ? this.pickedGround : this.raycaster.intersectObject(this.terrain)[0];
      if (ground) this.gaze = (this.gaze ?? new THREE.Vector3()).copy(ground.point);
      if (this.state?.holding) this.placeGhost();
      if (this.callbacks.onPropHover) {
        const prop = this.pickProp();
        if (prop !== this.hoverProp) this.callbacks.onPropHover((this.hoverProp = prop));
      }
    }

    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at <= this.clock) this.pending.splice(i, 1)[0].run();
    }

    // Held movement keys slide the view, at a speed that covers the screen in about a second and a half.
    if (this.heldKeys.size > 0) {
      let x = 0;
      let y = 0;
      for (const key of this.heldKeys) {
        x += PAN_KEYS[key]?.[0] ?? 0;
        y += PAN_KEYS[key]?.[1] ?? 0;
      }
      const speed = this.container.clientHeight * 0.7 * dt;
      // panBy takes a drag: dragging left moves the view right, so the signs are flipped.
      if (x || y) this.panBy(-x * speed, y * speed);
    }

    // Following: the camera's goal is your hero's feet (the middle of the hex they stand on), wherever they have got to.
    const mine = this.follow && this.state?.you ? this.units.get(this.state.you) : undefined;
    if (mine) {
      if (this.followHeld && mine.path.length > 0) {
        this.followHeld = false;
        this.showFollow();
      }
      if (!this.followHeld) this.targetGoal.set(mine.feet.x, mine.feet.y, mine.feet.z - 0.25);
    }

    this.target.lerp(this.targetGoal, ease);
    // Coming in from an opening view (see swoop), the camera takes its time coming down and round, and does not
    // start until the map is there to be seen.
    const settle = this.swooping > 0 ? (this.revealed ? 1 - Math.exp(-dt * 1.7) : 0) : ease;
    if (this.revealed) this.swooping = Math.max(0, this.swooping - dt);
    // (On a battle map the combat view may have the camera a little steeper while a fight lasts: see pitchWanted.)
    if (this.combat.enabled) this.pitchGoal = this.pitchWanted();
    this.camDist += (this.dist - this.camDist) * settle;
    this.yaw += (this.yawGoal - this.yaw) * settle;
    this.pitch += (this.pitchGoal - this.pitch) * settle;
    const reach = this.camDist * CAMERA_REACH;
    const flat = reach * Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * flat,
      this.target.y + reach * Math.sin(this.pitch),
      this.target.z + Math.cos(this.yaw) * flat,
    );
    this.camera.lookAt(this.target);
    // Shaken (see shake): rocked about where it should be, less and less, and back.
    if (this.shakeLeft > 0) {
      this.shakeLeft = Math.max(0, this.shakeLeft - dt);
      const k = this.shakeBy * (this.shakeLeft / this.shakeFor) ** 2;
      this.camera.position.x += Math.sin(this.clock * 57) * k;
      this.camera.position.y += Math.sin(this.clock * 43 + 1.3) * k * 0.6;
      this.camera.position.z += Math.sin(this.clock * 51 + 2.1) * k;
    }
    // A backdrop is seen from one fixed spot, as through a window, not from the roving camera.
    if (this.vantage) {
      this.camera.position.copy(this.vantage.from);
      this.camera.lookAt(this.vantage.to);
      this.target.copy(this.vantage.to);
    }
    // A game in the world swings the camera from the usual view round and down into its own: the bearing, distance
    // and height about the game's look point all ease over together, so it orbits in rather than sliding.
    let focus = this.camera.position.distanceTo(this.target);
    if (this.minigame) {
      // The game's controls cover part of the view: it is framed in the rest, as if that were the whole window.
      const ease = 1 - Math.exp(-dt * 6);
      this.cover.bottom += (this.coverGoal.bottom - this.cover.bottom) * ease;
      this.cover.right += (this.coverGoal.right - this.cover.right) * ease;
      const v = this.minigame.game.frame(dt, now, (this.camera.aspect * (1 - this.cover.right)) / (1 - this.cover.bottom));
      const b = Math.max(0, Math.min(1, v.blend));
      // Nothing of the woods (a tree, a boulder off a heap) may stand between the game's eye and what it looks at.
      // Cleared again whenever the eye moves on (a window turned from wide to tall stands it further back).
      const m = this.minigame;
      if (this.woods && (!m.sight || m.sight.distanceToSquared(v.eye) > 0.01)) {
        m.sight = v.eye.clone();
        m.felled = true;
        this.woods.clearAlong(v.eye.x, v.eye.z, v.look.x, v.look.z, 0.35);
      }
      if (b > 0) {
        const rel0 = this.camera.position.clone().sub(v.look);
        const rel1 = v.eye.clone().sub(v.look);
        const a0 = Math.atan2(rel0.x, rel0.z);
        let turn = Math.atan2(rel1.x, rel1.z) - a0;
        while (turn > Math.PI) turn -= 2 * Math.PI;
        while (turn < -Math.PI) turn += 2 * Math.PI;
        const bearing = a0 + turn * b;
        const flat = THREE.MathUtils.lerp(Math.hypot(rel0.x, rel0.z), Math.hypot(rel1.x, rel1.z), b);
        const look = this.target.clone().lerp(v.look, b);
        this.camera.position.set(v.look.x + Math.sin(bearing) * flat, v.look.y + THREE.MathUtils.lerp(rel0.y, rel1.y, b), v.look.z + Math.cos(bearing) * flat);
        this.camera.lookAt(look);
        focus = this.camera.position.distanceTo(look);
      }
      // The lens is opened so the game's own field of view spans the clear part of the height, and the view is
      // shifted so the look point sits in the middle of that part (up from a dock along the bottom, left of one on the right).
      const lb = this.cover.bottom * b;
      const lr = this.cover.right * b;
      const want = THREE.MathUtils.lerp(this.baseFov, v.fov ?? this.baseFov, b);
      const fov = lb > 0.001 ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(want) / 2) / (1 - lb))) : want;
      const shift = lb > 0.001 || lr > 0.001 ? `${lr.toFixed(4)},${lb.toFixed(4)}` : "";
      if (Math.abs(fov - this.camera.fov) > 0.01 || shift !== this.coverShift) {
        this.camera.fov = fov;
        // In the view's own pixels: setViewOffset also sets the camera's aspect from them (fullWidth / fullHeight).
        const w = Math.max(1, this.container.clientWidth);
        const h = Math.max(1, this.container.clientHeight);
        if (shift) this.camera.setViewOffset(w, h, (lr * w) / 2, (lb * h) / 2, w, h);
        else this.camera.clearViewOffset();
        this.coverShift = shift;
        this.camera.updateProjectionMatrix();
      }
      this.hideOwnHero();
      // Unless the game is still waiting for your hero to walk up: till then the room draws them as ever.
      const mine = this.state?.you ? this.units.get(this.state.you) : undefined;
      if (mine && this.minigame.game.ownHero?.()) for (const obj of [mine.root, mine.label, mine.ring]) if (obj) obj.visible = true;
    }
    // The combat view: now the camera is where it will draw from, the scenery's shaders are told how far on the
    // view is and what to keep clear (cutaway.ts), until this frame is drawn. Wisps and rain thin out with it.
    if (this.combat.enabled) this.combat.frame(dt, this.camera.position, this.combat.on || this.combat.shown > 0 ? this.combatSpots() : []);
    this.ambience.cutaway = this.combat.shown;
    // The table lanterns burn brighter over a table someone is standing at.
    const heroes = this.state?.heroes;
    this.tableLamps.update(dt, (hex) => !!heroes?.some((h) => h.pos.q === hex.q && h.pos.r === hex.r));
    this.ambience.update(this.clock, this.yaw, this.target, this.state?.you ? this.units.get(this.state.you)?.root.position : undefined);
    // Whoever walks through the woods pushes the trees aside.
    // Everyone on their feet on the map: the trees they brush past bend aside, and the grass they wade through parts.
    const walkers = this.walkerSpots;
    walkers.length = 0;
    for (const u of this.units.values()) if (u.root.visible) walkers.push(u.root.position);
    this.woods?.update(dt, walkers);
    if (!this.opts.backdrop) setFieldWalkers(walkers, this.target, dt);
    // Sounds are heard from where your hero stands, or from the middle of the view without one.
    const ear = (this.state?.you ? this.units.get(this.state.you)?.root.position : undefined) ?? this.target;
    this.ear.listener(ear.x, ear.z, this.yaw);
    // Under a roof there is no sky to hear, and a pool is not the sea.
    const roofed = this.roofed;
    const openSky = this.ambience.openSky && !roofed;
    const underground = this.ambience.underground || roofed;
    this.ear.sky(roofed ? ROOF_SKY : this.ambience.sky());
    // Where the sea lies changes slowly: work it out a few times a second.
    if (this.frames++ % 8 === 0) {
      this.ear.sea(roofed ? null : nearWater(ear.x, ear.z, this.water));
      this.ear.ground(this.state ? (tileAt(this.state.map, worldToHex(ear.x, ear.z - 0.25))?.biome ?? null) : null);
    }
    // In the caverns the lights follow the heroes who carry a torch as they walk, and a torch thrown down lights
    // where it lies. Nearest the view first: there are only so many lights.
    if (this.state?.kind === "caverns") {
      const torches: THREE.Vector3[] = [];
      for (const h of this.state.heroes) {
        const unit = this.units.get(h.id);
        if (unit && h.torch) torches.push(unit.root.position);
      }
      // A torch on the ground lights from just over its flame.
      this.groundTorches.children.forEach((t, i) => torches.push((this.torchSpots[i] ??= new THREE.Vector3()).copy(t.position).setY(t.position.y + 0.55 - TORCH_LIFT)));
      torches.sort((a, b) => a.distanceToSquared(this.target) - b.distanceToSquared(this.target));
      this.ambience.setTorches(torches);
    }
    // Torch flames flicker, in a hand or lying on the ground. One no longer on the map is let go.
    if (this.liveFlames.size > 0) {
      const now = performance.now() / 1000;
      for (const f of this.liveFlames) {
        let top: THREE.Object3D = f;
        while (top.parent) top = top.parent;
        if (top !== this.scene) this.liveFlames.delete(f);
        else flickerFlame(f, now);
      }
    }
    // Night reaches the open sea too, not just the lit ground.
    const night = this.ambience.night;
    (this.sea.material as THREE.MeshLambertMaterial).color.copy(this.seaBase).lerp(NIGHT_SEA, night * 0.8);
    // Night life and the night sky on the water: out under an open sky as the light goes, and hidden by cloud.
    // Rain on the land: the ground wets in a few seconds and takes most of a minute to dry.
    const raining = openSky ? this.ambience.raining : 0;
    // Wind: a breeze on a clear day, stronger in rain, and a gale in a storm. None indoors or underground.
    updateWind(this.clock, fancy.get() && openSky ? 0.35 + 0.45 * raining + 0.6 * this.ambience.storming : 0);
    this.wet += (raining - this.wet) * Math.min(1, dt * (raining > this.wet ? 0.3 : 0.04));
    if (this.terrain) setGroundWet(this.terrain.material as THREE.Material, this.wet);
    // And lightning, in a storm only: a downpour has none. The thunder is heard either way; the flash and
    // the bolt are fancy graphics.
    // Indoors the storm is still going on outside: the thunder comes through the walls and the flash
    // through the windows. Underground there is neither.
    const inRoom = !openSky && !underground;
    // A backdrop has no storm of its own (the thunder would be heard twice): it is lent the flash of the view showing it.
    if (!this.opts.backdrop) this.storm.update(dt, underground ? 0 : this.ambience.sky().storm, this.camera, this.target, inRoom);
    this.showOutlook();
    this.storm.bolt.visible &&= fancy.get();
    const lively = fancy.get() && openSky ? night : 0;
    this.nightLife.setLamps(this.ambience.lampSpots());
    this.nightLife.update(this.clock, lively);
    // Gulls keep to fair daylight: they are gone by night and in a storm.
    this.gulls.update(dt, walkers, openSky ? (1 - night) * (1 - this.ambience.storming) : 0);
    const clearSky = lively * (1 - this.ambience.overcast);
    // The moon's reflection lies on the sea off the island's shore, on the side the moon is on.
    const moon = this.ambience.sunDir;
    const across = Math.hypot(moon.x, moon.z) || 1;
    const offshore = this.land.reach + 4;
    setWaterNight(clearSky, this.land.x + (moon.x / across) * offshore, this.land.z + (moon.z / across) * offshore, Math.max(0, (clearSky - 0.55) / 0.45));
    this.ambience.smoothSea = fancy.get();
    // The sea goes with the camera, so it has no edge to come to, and the distance is lost in mist the colour of the sky.
    this.sea.position.x = Math.round(this.target.x);
    this.sea.position.z = Math.round(this.target.z);
    const mist = this.scene.fog as THREE.Fog | null;
    if (mist) {
      const sky = this.scene.background as THREE.Color;
      // Over a map of the world the sky itself is mist: the land goes on into it and is never seen to stop.
      if (this.state?.far) sky.lerp(FAR_MIST, 0.82);
      mist.color.copy(sky);
      const [from, to] = this.state?.far ? MIST.far : MIST.open;
      const reach = this.camDist * CAMERA_REACH;
      mist.near = reach + from;
      mist.far = reach + to;
    }
    // A map floating over a void has that void's sky and haze in place of these, and its cast on the day's light.
    this.voidBackdrop?.frame(this.clock, this.target, this.camDist * CAMERA_REACH, night, this.scene.background as THREE.Color, mist, this.scene, openSky);
    // Fire shows by how dark it is: at night, underground, or in a place the void keeps dim.
    this.scenery?.update(this.clock, dt, this.target, Math.max(night, underground ? 1 : 0, this.voidBackdrop && openSky ? this.voidBackdrop.gloom : 0));
    // The HUD's trim and the health orb are lit by the same sun or moon, from wherever the camera stands.
    reportEnv(this.ambience.sunDir, this.yaw, this.ambience.sunGlint(this.litRim), this.scene.background as THREE.Color);
    updateWater(fancy.get(), this.clock, this.ambience.sunDir, this.ambience.sunGlint(this.litRim), (this.sea.material as THREE.MeshLambertMaterial).color, this.scene.background as THREE.Color, this.ambience.raining);
    const step = Math.round(night * 10);
    if (step !== this.paintedNight) {
      this.paintedNight = step;
      this.paintTiles();
    }
    if (this.state?.indoors) this.lowerNearWalls();

    // The height of one view pixel, in the units an unattenuated sprite is sized in.
    const labelRow = (this.fine * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.renderer.domElement.height;
    for (const [id, unit] of this.units) {
      const p = unit.root.position;
      // The hop is drawn on top of where the unit really is, and a boat sits it lower: take both off before moving.
      p.y -= unit.bob;
      p.y += unit.sunk ?? 0;
      unit.sunk = 0;
      let landed = 0;
      let touched = false;
      // A jump whose landing place is no longer the next on the way (knocked aside, sent elsewhere) is off.
      if (unit.leap && unit.leap.to !== unit.path[0]) unit.leap = undefined;
      if (unit.path.length === 0 && unit.leaps?.size) unit.leaps.clear();
      if (unit.path.length > 0) {
        const next = this.stepSpot.copy(unit.path[0]);
        next.z += 0.25;
        // The last step onto a stool goes to the stool itself, wherever in its hex it stands.
        if (unit.seated && unit.path.length === 1 && Math.hypot(unit.goal.x - next.x, unit.goal.z - next.z) < 1) next.copy(unit.goal);
        const acted = unit.rush ? undefined : unit.leaps?.get(unit.path[0]);
        if (acted !== undefined && !unit.leap) {
          // It begins: turned to where it is going, and crouched to spring. The further, the longer and higher.
          const far = Math.hypot(next.x - p.x, next.z - p.z);
          const air = Math.min(LEAP.longest, LEAP.air + LEAP.airPer * far);
          unit.leap = { to: unit.path[0], from: p.clone(), at: this.clock + unit.figure.jump(air), air, high: Math.max(LEAP.high + LEAP.highPer * far, next.y - p.y + LEAP.clear) };
          if (far > 1e-4) unit.turnGoal = Math.atan2(next.x - p.x, next.z - p.z);
          unit.stride = 0;
          // The Jump action is heard, so that its thud falls as the feet come down (the sound's own is LEAP.thud into it).
          const spot = { x: p.x, z: p.z };
          const land = unit.leap.at + air;
          if (acted) this.pending.push({ at: Math.max(this.clock, land - LEAP.thud), run: () => sounds.zone("jump", spot) });
        }
        const leap = unit.leap;
        const step = 4.2 * (unit.rush ?? 1) * dt;
        if (leap) {
          const k = (this.clock - leap.at) / leap.air;
          if (k >= 1) {
            p.copy(next);
            unit.leaps?.delete(unit.path[0]);
            unit.path.shift();
            unit.leap = undefined;
            unit.bob = 0;
            // The Jump action lands hard; a step up or down on a walk lands as a footstep does.
            if (acted) touched = true;
            else landed = 1;
          } else if (k > 0) {
            // Straight across from where it sprang to where it lands, and over the top between.
            p.lerpVectors(leap.from, next, k);
            unit.bob = 4 * leap.high * k * (1 - k);
          } else {
            unit.bob *= Math.exp(-dt * 18);
          }
        } else if (!unit.rush) {
          landed = footfalls(unit.stride, unit.stride + step);
          unit.stride += step;
          // They turn to face the way they are walking.
          if (Math.hypot(next.x - p.x, next.z - p.z) > 1e-4) unit.turnGoal = Math.atan2(next.x - p.x, next.z - p.z);
        }
        if (leap) {
          // Carried by the jump, above.
        } else if (p.distanceTo(next) <= step) {
          p.copy(next);
          unit.path.shift();
          if (unit.path.length === 0) unit.rush = undefined;
        } else {
          p.add(next.sub(p).setLength(step));
        }
        // Two steps per hex, with a little bounce in each, landing as each hex is reached.
        if (!unit.rush && !leap) unit.bob = Math.abs(Math.sin(unit.stride * 3.6)) * 0.07;
      } else {
        unit.bob *= Math.exp(-dt * 18);
        unit.stride = 0;
        const goal = this.restSpot.copy(unit.goal).add(unit.kick);
        // Put somewhere else with no walk to get there (sent back to its post when a fight ends, set down at the
        // spawn): it is simply there, not dragged across the map in a streak.
        if (Math.hypot(goal.x - p.x, goal.z - p.z) > 3.5) p.copy(goal);
        else p.lerp(goal, 1 - Math.exp(-dt * 14));
        unit.kick.multiplyScalar(Math.exp(-dt * 9));
      }
      // At a stool: up onto it once they have walked to it, and off it again as they leave.
      const atSeat = !!unit.seated && unit.path.length === 0 && !unit.lying && Math.hypot(unit.goal.x - p.x, unit.goal.z - p.z) < 0.08;
      if (atSeat || unit.sit) unit.sit = atSeat ? Math.min(1, (unit.sit ?? 0) + dt / SIT_S) : Math.max(0, (unit.sit ?? 0) - dt / STAND_S);
      unit.lean *= Math.exp(-dt * 8);
      /** On the ground: lying down, or knocked off their feet for now. */
      const flat = unit.lying || this.clock < (unit.floored ?? 0);
      // Your own hero, standing idle, looks toward the pointer; with the bag open they turn to face you.
      if (id === this.state?.you && unit.path.length === 0 && !unit.asleep && !flat && !this.minigame) {
        if (this.faceFront) unit.turnGoal = this.yaw;
        else if (this.gaze && this.pointer.inside) {
          const dx = this.gaze.x - p.x;
          const dz = this.gaze.z - p.z;
          if (dx * dx + dz * dz > 0.09) {
            unit.turnGoal = Math.atan2(dx, dz);
            // And so everyone else here sees them look that way too.
            const step = lookStep(unit.turnGoal);
            if (step !== this.lookSent && this.clock - this.lookSentAt > LOOK_SEND_S) {
              this.lookSent = step;
              this.lookSentAt = this.clock;
              gaze.look(step);
            }
          }
        }
      } else if (id === this.state?.you) {
        // Walking, seated or asleep: whatever they look at next is told afresh.
        this.lookSent = -1;
      } else if (this.looks.has(id)) {
        // Someone else's hero looks where their player's pointer is, while they stand idle. Walking off, they face the way they go.
        if (unit.path.length > 0) this.looks.delete(id);
        else if (!unit.asleep && !flat) unit.turnGoal = this.looks.get(id)!;
      }
      // A sleeper lies with their head toward the left of the view, as the bedrolls are laid.
      if (unit.asleep) unit.turnGoal = this.yaw + Math.PI / 2;
      // Fallen in a heap, they are not turned about on the ground (a sleeper is still laid along the bedroll).
      if (!flat || unit.asleep) unit.turn += turnBy(unit.turn, unit.turnGoal) * (1 - Math.exp(-dt * 12));
      unit.root.rotation.y = unit.turn;
      if (unit.dying !== undefined && this.clock >= unit.dying) this.topple(id);
      const rowing = this.rowingPose(unit, p, dt);
      if (rowing === undefined) unit.oarPull = undefined;
      unit.figure.update({ time: this.clock, stride: unit.stride, walking: unit.path.length > 0 && !unit.rush && !unit.leap, lean: unit.lean, lying: flat, rowing, sitting: unit.boatKind === "rowboat" && unit.boat?.visible ? 1 : unit.sit || undefined });
      const ground = p.y;
      unit.feet.set(p.x, ground, p.z);
      if (touched) this.touchdown(unit);
      else if (landed) this.footfall(id, unit);
      this.rideBoat(unit, p, dt);
      // On a stool: the figure's origin as far below the seat's top as a seated figure's is, with a small hop on the way up.
      let perch = 0;
      if (unit.sit) {
        perch = ((unit.seatTop ?? 0) - SITTING_DROP * unit.size) * THREE.MathUtils.smootherstep(unit.sit, 0, 1) + Math.sin(unit.sit * Math.PI) * 0.1;
        unit.sunk = (unit.sunk ?? 0) - perch;
        p.y += perch;
      }
      p.y += unit.bob;
      // Indoors the shadow maps are drawn only when something changes: a hero that moved, turned, lay down or
      // stood up asks the lights in reach of where it was and where it is now to redraw.
      const size = unit.lying ? -unit.size : unit.size;
      if (unit.shadowAt.distanceToSquared(p) > 1e-6 || Math.abs(unit.shadowTurn - unit.turn) > 0.02 || unit.shadowSize !== size) {
        this.ambience.stir(unit.shadowAt);
        this.ambience.stir(p);
        unit.shadowAt.copy(p);
        unit.shadowTurn = unit.turn;
        unit.shadowSize = size;
      }
      if (unit.ring) {
        unit.ring.position.set(p.x, ground + 0.04, p.z);
        const s = this.pulsing.has(id) ? 1.25 + Math.sin(this.clock * 6) * 0.2 : 1;
        unit.ring.scale.set(s, s, 1);
      }
      if (unit.label) {
        // A plate waits for the ground under it to come up.
        if (this.rise) unit.label.visible = unit.root.visible && this.rise.reached(p.x, p.z);
        unit.label.position.set(p.x, ground + unit.label.userData.lift + perch, p.z);
        const tall = unit.label.userData.rows * labelRow;
        unit.label.scale.set(tall * unit.label.userData.aspect, tall, 1);
      }
      if (unit.arrows) {
        for (const a of unit.arrows) {
          a.sprite.position.set(p.x + a.off.x, ground + a.off.y, p.z + a.off.z);
          a.sprite.material.rotation = a.rot + unit.lean;
        }
      }
      if (unit.hpBack && unit.hpFill) {
        const lift = unit.hpBack.userData.lift ?? 2;
        unit.hpBack.position.set(p.x - 0.6, ground + lift, p.z);
        unit.hpFill.position.set(p.x - 0.57, ground + lift, p.z);
      }
      if (unit.badges) {
        // Over the name tag or plate, clear of the health bar too.
        const bar = unit.hpBack?.visible ? ground + (unit.hpBack.userData.lift ?? 2) + 0.26 : ground + unit.head + 0.4;
        const tag = this.plateTop(unit);
        const over = tag !== null ? Math.max(bar, tag + 0.2) : bar;
        const tall = 0.3;
        unit.badges.position.set(p.x, over, p.z);
        unit.badges.scale.set(tall * (unit.badges.userData.aspect as number), tall, 1);
      }
    }

    this.placeBubbles(dt, labelRow);

    // An XP glow on a plate has run its course: draw the bar plain again.
    for (const unit of this.units.values()) if (unit.glowing && this.clock >= unit.glowUntil) this.applyLabel(unit);

    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.age += dt;
      const t = Math.min(1, f.age / f.life);
      f.sprite.position.lerpVectors(f.from, f.to, t);
      if (f.arc) f.sprite.position.y += f.arc * 4 * t * (1 - t);
      const size = f.size[0] + (f.size[1] - f.size[0]) * t;
      f.sprite.scale.set(size, size, 1);
      f.sprite.material.rotation = f.spin * t;
      if (f.fade) f.sprite.material.opacity = 1 - t * t;
      if (t >= 1) {
        this.fxGroup.remove(f.sprite);
        f.sprite.material.dispose();
        this.fx.splice(i, 1);
        f.onEnd?.();
      }
    }

    for (const puff of this.puffs) {
      if (!puff.mesh.visible) continue;
      puff.age += dt;
      const t = puff.age / puff.life;
      if (t >= 1) {
        puff.mesh.visible = false;
        continue;
      }
      const at = puff.mesh.position;
      at.x += puff.vx * dt;
      at.y += puff.vy * dt;
      at.z += puff.vz * dt;
      let s: number;
      if (puff.kind === "dust") {
        // Slowing as it spreads; swelling as it thins, then gone.
        puff.vx *= Math.exp(-dt * 5);
        puff.vz *= Math.exp(-dt * 5);
        puff.vy *= Math.exp(-dt * 3);
        s = puff.size * (0.55 + t * 1.1) * Math.min(1, t * 9) * (1 - t * t * t);
      } else {
        // Falling: thrown up, and down again to the ground it came from, where it stays.
        puff.vy -= 9 * dt;
        if (at.y < puff.floor + puff.size * 0.3) {
          at.y = puff.floor + puff.size * 0.3;
          puff.vx *= Math.exp(-dt * 14);
          puff.vz *= Math.exp(-dt * 14);
        }
        s = puff.size * Math.min(1, t * 12) * (1 - t * t * t);
      }
      puff.mesh.rotation.x += puff.spin.x * dt;
      puff.mesh.rotation.y += puff.spin.y * dt;
      puff.mesh.rotation.z += puff.spin.z * dt;
      puff.mesh.scale.setScalar(Math.max(s, 1e-4));
    }

    // Sleepers breathe out a z now and then: small, small, then a big one.
    for (const unit of this.units.values()) {
      if (!unit.asleep || this.clock < unit.nextZ) continue;
      unit.nextZ = this.clock + 0.85;
      unit.zCount += 1;
      const big = unit.zCount % 3 === 0;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sleepZTexture(), transparent: true, depthTest: false }));
      sprite.renderOrder = 10;
      const p = unit.root.position;
      this.fxGroup.add(sprite);
      this.sleepZs.push({ sprite, age: 0, x: p.x - 0.35, z: p.z, y: p.y + 0.25, size: big ? 0.42 : 0.26, sway: unit.zCount * 1.7 });
    }
    for (let i = this.sleepZs.length - 1; i >= 0; i--) {
      const z = this.sleepZs[i];
      z.age += dt;
      const t = z.age / Z_LIFE;
      z.sprite.position.set(z.x + t * 0.5 + Math.sin(z.sway + z.age * 2.4) * 0.12, z.y + t * 1.3, z.z);
      const s = z.size * (0.7 + t * 0.6);
      z.sprite.scale.set(s, s, 1);
      z.sprite.material.opacity = Math.min(1, z.age / 0.25) * (1 - Math.max(0, (t - 0.6) / 0.4));
      if (t >= 1) {
        this.fxGroup.remove(z.sprite);
        z.sprite.material.dispose();
        this.sleepZs.splice(i, 1);
      }
    }

    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.age += dt;
      const life = f.life ?? 1.0;
      f.sprite.position.y += dt * (f.rise ?? 1.4);
      // Holds solid for the first part of its life, then fades.
      f.sprite.material.opacity = Math.max(0, Math.min(1, (1 - f.age / life) * 1.6));
      if (f.age >= life) {
        this.fxGroup.remove(f.sprite);
        f.sprite.material.map?.dispose();
        f.sprite.material.dispose();
        this.floaters.splice(i, 1);
      }
    }

    this.movePois();
    for (const tick of this.tickers) tick(dt, this.camera, this.clock);
    this.ambience.settleShadows();
    // Until the veil starts to clear, the place is all down but the hex you stand on (or the middle of the view).
    if (this.rise) {
      if (this.settling >= 0) {
        const mine = this.state?.you ? this.units.get(this.state.you) : undefined;
        const at = mine?.root.position ?? this.target;
        this.rise.from(at.x, at.z - (mine ? 0.25 : 0));
      }
      this.rise.apply();
    }
    if (this.post) {
      this.air.outdoors = this.ambience.openSky && !this.roofed;
      this.air.clock = this.clock;
      this.air.sunDir = this.ambience.sunDir;
      this.ambience.sunGlint(this.air.sun);
      this.air.sky = this.scene.background as THREE.Color;
      this.air.overcast = this.ambience.overcast;
      this.air.sunHeight = this.ambience.sunHeight;
      // In a room the flash is only what comes in at the windows.
      this.air.flash = this.opts.backdrop ? this.lentFlash : this.storm.flash * (this.ambience.openSky ? 1 : 0.4);
      // (Under a roof the fires glow as they do at night.)
      this.post.render(this.scene, this.camera, focus, this.roofed ? ROOF_GLOW : this.ambience.night, this.air, !!this.state?.far);
    }
    else this.renderer.render(this.scene, this.camera);
    // The glow round whatever structure the pointer is on, over the finished frame. (A place built again since it
    // was lit is found again here; with nothing lit this is two comparisons.)
    if (this.glowWhat !== null && !this.hoverGlow.lit) this.hoverGlow.set(this.glowRoot());
    if (!this.minigame) this.hoverGlow.draw(this.renderer, this.camera, dt, this.clock);
    this.combat.clear();
    this.rise?.clear();
    this.reveal(dt);
  };

  /**
   * Arriving. The veil is whole, with the game's mark on it, until the place is built and has been drawn a few
   * times. Then it clears, and under it the place grows up from the hex you stand on (see rise.ts).
   */
  private reveal(dt: number) {
    if (this.settling >= 0 && this.terrain && ++this.settling >= REVEAL_FRAMES) {
      this.settling = -1;
      this.openedAt = this.clock;
    }
    // The ring sets out once the veil is half gone, so the growing is seen rather than done behind it.
    if (this.rise && this.settling < 0 && this.clock - this.openedAt > VEIL_CLEAR_S * 0.5) {
      // As far as the furthest of the land from where it began, and a hex or two of shore beyond.
      this.rise.step(dt, Math.hypot(this.land.x - this.rise.centre.x, this.land.z - this.rise.centre.y) + this.land.reach + 4);
      if (!this.rise.active) {
        this.rise = null;
        for (const unit of this.units.values()) if (unit.label && unit.root.visible) unit.label.visible = true;
      }
    }
    if (!this.veil) return;
    const cover = this.settling >= 0 ? 1 : 1 - (this.clock - this.openedAt) / VEIL_CLEAR_S;
    if (cover <= 0) {
      this.veil.dispose();
      this.veil = null;
      return;
    }
    // Four screen pixels to one of the veil's, however finely the world is drawn.
    this.veil.draw(this.renderer, cover, this.clock, this.fine * 2);
  }
}
