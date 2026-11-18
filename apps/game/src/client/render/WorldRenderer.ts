// Three.js view of an island: low-poly hex terrain with pixel sprites
// standing on it. Imperative on purpose. React owns the HUD; this class owns
// the canvas and is told about state (setState) and things that just
// happened (playEvents).
//
// Fights are played on the map itself: enemies stand on their own hexes like the heroes do.

import * as THREE from "three";
import { flamesIn, flickerFlame, torchFlame } from "./torchFlame";
import { MOUTH_FACE, SHAFT_HEIGHT, buildCaveDressing, caveMouth, caveRope, glowcapCluster, mouthRope, mouthTorch } from "./caveDressing";
import { makeModelShip } from "./modelShip";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { reportEnv } from "../ui/env";
import { makeRenderer } from "./graphics";
import { apothecaryWallTexture, galleyWallTexture, panelTexture, smithyWallTexture } from "./groundArt";
import { Ambience, type RoomLight, TILE_FILLET, TILE_RADIUS, TORCH_LIFT, beaconShine, dryPatch, hexTop, meadowAt, pixelTexture, stamp, tallGrass, type BuildingGlow } from "./ambience";
import "./camera.css";
import { PINCH_PAN_SLACK, followIconSvg, readFollow, writeFollow } from "./cameraFollow";
import type { HexPos } from "@gantt-quest/core";
import { hexDistance } from "@gantt-quest/core";
import { lookStep, lookYaw, BASE_HEIGHT, BATTLE_JOIN_RANGE, BIG_REACH, ENEMIES, HEX_DIRS, SEATS, TRAIT_BY_ID, tileCost, WALL_FACE_HALF, WALL_ITEM_BOTTOM, WALL_ITEM_TOP, hexAt, xpProgress, reachable, tileAt, wallFace, wallFaces, type ClientState, type Outfit, type Phase, type Poi, type Tile, type WorldEvent, type WorldMap } from "@gantt-quest/world";
import { fancy, fancyGrass } from "./fancy";
import { NightLife } from "./nightlife";
import { Storm } from "./storm";
import { setFieldWalkers, updateWind } from "./wind";
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
import { GROUND_KIND, addFancyWater, addWaterRipple, setGroundWet, setWaterNight, setWaterStanding, shoreSide, updateWater, waterAttribute, type Standing } from "./water";
import { ghostModel, propModel, tintGhost, type LightKind } from "./props";
import { LAMP_TABLES, TableLamps } from "./tableLamps";
import { LID_OPEN, chestMouth, chestModel, crateMiddle, crateModel, restingLid } from "./caveProps";
import { nearWater, openEar, sounds } from "../audio/gameSounds";
import type { AttackStyle, Fighter } from "../audio/names";
import { PUFFS, footfalls, stepGround, worldToHex, type PuffLook } from "./footsteps";
import { badgeTexture, badgesKey, bubbleTexture, fxTexture, labelTexture, lookFor, plateKey, sleepZTexture, spriteKey, textTexture, type Badge, type FxKind, type PlateStats } from "./sprites";

/** Spells fly as a coloured bolt; these are their colours, by ability name. */
const SPELL_COLOR: Record<string, string> = {
  Firebolt: "#ff9a3c",
  "Chain Spark": "#7fe3ff",
  "Hex Bolt": "#c084fc",
  "Dark Bolt": "#b06cff",
  Immolate: "#ff6a3c",
};
const ARROW_ABILITIES = new Set(["Aimed Shot", "Pin Down", "Volley", "Barbed Arrow"]);
/** Thrown things: a rock lobbed in an arc, tumbling, that bursts into dust where it lands. */
const THROWN: Record<string, string> = { "Hurl Rock": "#77726a" };
/** Melee blows heavy enough to knock the target back and raise dust at its feet. */
const SMASHES = new Set(["Club Smash"]);
/**
 * Melee blows struck as the figure's heavy strike (see Figure.strike), a great two-handed sweep or with a blade
 * in each hand both tossed and jabbed down: the smashes, and the other all-or-nothing swings.
 */
const HEAVY_SWINGS = new Set([...SMASHES, "Heavy Blow", "Cleave", "Crushing Maul", "Crushing Strike", "Sweeping Ruin", "Stone Fist", "Flurry", "Shockwave"]);
/** A ground-pound (the ogre's Stomp, the guardian's Quake): no step in; the ground shakes out from the attacker's feet and jolts whoever it reaches. */
const QUAKES = new Set(["Stomp", "Quake"]);
/** Heals that are an enemy growing back (a troll's Regenerate), drawn as moss creeping over it, not a sparkle. */
const REGROWTH = new Set(Object.values(ENEMIES).flatMap((e) => (e.regen ? [e.regen.name] : [])));
const MOSS = "#9fe07a";
/** How an attack travels, for its sound: the same split the effects above are drawn by. */
const attackStyle = (ability: string): AttackStyle => (SPELL_COLOR[ability] ? "magic" : ARROW_ABILITIES.has(ability) || THROWN[ability] ? "ranged" : "melee");
const isBoss = (kind: string) => !!ENEMIES[kind]?.boss;
/** Rank-and-file drawn a size up: the heavy hitters. */
const isBig = (kind: string) => kind === "brute" || kind === "bear" || kind === "ogre" || kind === "troll";
/** How much of a battle line a figure takes, as a share of an ordinary one's: an ogre is half as wide again. */
const roomOf = (kind: string) => (kind === "ogre" ? 1.5 : 1);

/**
 * What the renderer needs to draw a scene. An island's ClientState satisfies
 * this as it is; the Harbor builds one by hand with `freeRoam` set.
 */
/** Seconds between one pickup told over a hero's head and the next. */
const PICKUP_GAP = 0.55;

export interface RenderState {
  /** Identifies the map; the terrain is rebuilt when it changes. */
  code: string;
  /** A voyage's island, or the Haunted Caverns: the caverns' mouth shows no moored ship, and its heroes carry torches. */
  kind?: "voyage" | "caverns" | "pub";
  you: string;
  phase: Phase;
  round: number;
  map: WorldMap;
  /** `asleep`: lying down with eyes shut, z's rising, as on a bedroll in the Harbor. */
  heroes: RenderHero[];
  turn: { heroId: string; mp: number } | null;
  story: { npcs: { id: string; poi: string }[] } | null;
  npcs: Record<string, { hostile: boolean }>;
  /** Enemy bands in sight on the map. */
  roamers?: { id: string; kinds: string[]; pos: HexPos }[];
  /** A zone's enemies: each stands on its own hex, with a bar of what it has left once it is in a fight. */
  units?: RenderUnit[];
  /**
   * Torches lying lit on the ground, underground. With this set (a zone in the caves), only heroes holding
   * a torch carry light, and these light where they lie; without it every hero in the caverns has one.
   */
  lights?: HexPos[];
  /**
   * Where the viewer can walk, worked out by the caller (a zone's rules know about cliffs, bodies in the way
   * and what is left of a turn's movement). When set it is used as it stands: the tiles lit, the marker
   * under the pointer and the dots along the way all come from it.
   */
  reach?: Map<string, { cost: number; prev: string | null; pos: HexPos }>;
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
  /** How a room's walls are dressed inside: the pub's oak and plaster, the smithy's stone and sooted timber, the apothecary's green wainscot and paper, the galley's oxblood boards, tiles and limewash. The pub's is the default for the pub; other rooms have bare walls without it. */
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
}

/** The ways a room's walls can be dressed inside (see RenderState.walls). */
export type WallDressing = "pub" | "smithy" | "apothecary" | "galley";
const WALL_DRESSINGS: Record<WallDressing, () => THREE.CanvasTexture> = { pub: panelTexture, smithy: smithyWallTexture, apothecary: apothecaryWallTexture, galley: galleyWallTexture };

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
 * on a voyage, `hp`), which puts a plate over their head: the level, the
 * name, an HP bar and an XP bar. Without `level` it is a plain name tag.
 */
export interface RenderHero {
  id: string;
  classId: string;
  pos: HexPos;
  /** The name tag. A voyage's heroes have none set, so their `name` is used once they have a plate. */
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
  /** Absent off a voyage, where every hero is at full health. */
  hp?: number;
  maxHp?: number;
  /** Knocked down in a fight: drawn lying where they fell. */
  down?: boolean;
  /** Knocked flat (Prone) but still in the fight: lying, not dimmed. */
  prone?: boolean;
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
  return { level: h.level, hp, xp: xpProgress(h.level, h.xp ?? 0) };
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

const SQRT3 = Math.sqrt(3);
/**
 * The world is drawn at full resolution and smoothed. What is read (plates, speech) is still drawn in chunky
 * pixels, PIXEL screen pixels each, so it keeps its size.
 */
const PIXEL = 2;
/** Nearest and farthest the camera may sit from what it looks at. */
const MIN_ZOOM = 7;
const MAX_ZOOM = 40;
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
/** The turn, about y, from `from` to `to` by the shorter way round. */
const turnBy = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
/** The camera's usual tilt (about 47° above the horizon) and how far it may be tipped. */
const DEFAULT_PITCH = Math.atan2(0.78, 0.72);
const MIN_PITCH = 0.42;
const MAX_PITCH = 1.25;
/** Camera distance per unit of zoom, kept from when the tilt was fixed. */
const CAMERA_REACH = Math.hypot(0.72, 0.78);
const PLAYER_COLORS = ["#ffd23f", "#5ce1e6", "#ff7ab6", "#9dff6b"];
const BIOME_COLOR: Record<string, string> = { plains: "#7cb856", forest: "#4c9a52", hills: "#a39672", water: "#3f86dc", dock: "#9a7748", cobble: "#6f7279", mud: "#5f5140", rampart: "#6c6f55", floor: "#b08a5c", wall: "#6e5a48", cave: "#4a4552", rock: "#2a2730", gate: "#4a4552", fog: "#2b3140" };
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
const BUILDINGS = new Set<Poi["kind"]>(["hut", "plot", "pub", "shop", "works", "lighthouse", "apothecary", "smithy", "galley", "fishing"]);
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
/** Window glass that warms with the dusk: `unlit` by day, `lit` by night (the ambience moves it between the two; see `setGlows`). */
function warmPane(unlit: string, lit: string): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: lit });
  m.userData = { unlit, lit };
  return m;
}
/** The open sea at the dead of night, and the fog by day and by night. */
const NIGHT_SEA = new THREE.Color("#0f1a33");
const FOG_DAY = new THREE.Color("#3a4358");
const FOG_NIGHT = new THREE.Color("#141824");
/** And the sea there: cold and grey-green. */
const GREY_SEA = new THREE.Color("#2f4a5f");

export function hexToWorld(p: HexPos): { x: number; z: number } {
  return { x: SQRT3 * (p.q + p.r / 2), z: 1.5 * p.r };
}

export const tileTop = (t: Tile | undefined) => (!t ? 0.2 : t.biome === "water" ? 0.14 : 0.35 + t.h * 1.1);
/** A room's floor, which wall pieces' heights are measured from. */
const FLOOR_TOP = tileTop({ q: 0, r: 0, biome: "floor", h: BASE_HEIGHT.floor });
/** A turn in sixths plus radians, as Three.js turns a model about y. */
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

const yawOf = (facing: number, angle = 0) => -((facing * Math.PI) / 3 + angle);
/** A crew member's plot in the Harbor, at each stage: for sale, a building site, a hut. */
const HUT_KINDS = new Set<Poi["kind"]>(["lot", "site", "plot"]);
/** Straight up: the axis everything on the map turns about. */
const UP = new THREE.Vector3(0, 1, 0);
const key = (p: HexPos) => `${p.q},${p.r}`;

/**
 * How a point of interest's model stands against its hex. Every model is made to fit one hex, with its middle
 * `back` behind the hex's (0.28 unless said here). The Harbor's places are drawn bigger than that, so a hero
 * looks the right size beside them: `scale` times as big, and far enough back that the building stands on the
 * ground behind its door (see `footing` in the world's harbor.ts) with the hero on the doorstep in front.
 */
const PLACE: Partial<Record<Poi["kind"], { scale: number; back: number }>> = {
  pub: { scale: 2.2, back: 1.6 },
  lighthouse: { scale: 3, back: 3 },
  works: { scale: 2, back: 1.8 },
  shop: { scale: 2, back: 1.6 },
  apothecary: { scale: 2, back: 1.7 },
  smithy: { scale: 2, back: 1.7 },
  galley: { scale: 2, back: 1.7 },
  plot: { scale: 1.7, back: 1.4 },
  lot: { scale: 2, back: 1.6 },
  site: { scale: 2, back: 1.6 },
  fishing: { scale: 1.6, back: 0.8 },
  cave: { scale: 2.2, back: 1.3 },
  board: { scale: 1.6, back: 0.45 },
  ring: { scale: 1.5, back: 0.42 },
  felling: { scale: 1.5, back: 0.42 },
  quarry: { scale: 1.5, back: 0.42 },
  rocks: { scale: 1.6, back: 0.45 },
  wreck: { scale: 1.8, back: 0.5 },
  pier: { scale: 1.8, back: 1.25 },
};
const placeOf = (poi: Poi) => PLACE[poi.kind] ?? { scale: 1, back: 0.28 };
/** To the nearest thousandth, so offsets sent to the server stay short. */
const round = (n: number) => Math.round(n * 1000) / 1000;
/** Where the stools stand round a game table in the pub (its middle is at z = -0.3): four, as many as can play, clear of whoever stands at the front. */
const GAME_STOOLS = [[-0.54, 0.24], [0.54, 0.24], [-0.54, -0.84], [0.54, -0.84]];
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
  /** Knocked off its feet: drawn lying until the render clock passes this. */
  floored?: number;
  /** Down in a fight, as last told. */
  down?: boolean;
  /**
   * Just killed, and still on its feet until the blow that did it lands: it falls (a ragdoll, see topple) at its
   * "down" beat, or failing one, when the render clock passes this.
   */
  dying?: number;
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
  /** Knocked flat but not out: lying, in full colour. */
  prone?: boolean;
  asleep?: boolean;
  rod?: boolean | "gilded";
  /** Afloat: the boat drawn under them. */
  boat?: "barrel" | "rowboat";
  /** The way to face, about y: the two sides of a fight face each other. Otherwise a unit keeps the way it last walked. */
  face?: number;
  /** On a stool: how high its seat is off the floor. `pos` is then the stool's own spot. */
  seat?: number;
}

interface Floater {
  sprite: THREE.Sprite;
  age: number;
  /** Seconds before it has faded out; 1 unless set. */
  life?: number;
  /** World units it rises per second; 1.4 unless set. */
  rise?: number;
}

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
  onHexClick(pos: HexPos): void;
  onHover(pos: HexPos | null): void;
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
  /** Units set to face a given way by the view, which the pointer leaves alone. */
  private posed = new Set<string>();
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
  private poiGroup = new THREE.Group();
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
  /** Where the carried piece would go if the pointer clicked now. */
  private aimedAt: PlaceTarget | null = null;
  /** The prop under the pointer, for its tooltip. */
  private hoverProp: string | number | null = null;
  private sea: THREE.Mesh;
  private unitGroup = new THREE.Group();
  private fxGroup = new THREE.Group();
  /** Torches lying burning on the ground, and which hexes they are on. */
  private groundTorches = new THREE.Group();
  private groundTorchKey = "";
  /** Every torch flame on the map, in a hand or on the ground, to flicker each frame. */
  private liveFlames = new Set<THREE.Object3D>();
  private pathGroup = new THREE.Group();
  /** Red outlines around the hexes close enough to join a fight at each camp or lair. */
  private rangeGroup = new THREE.Group();
  private rangeSig = "";
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
  private reach = new Map<string, { cost: number; prev: string | null; pos: HexPos }>();
  private hovered: HexPos | null = null;
  private turnKey = "";

  private target = new THREE.Vector3();
  private targetGoal = new THREE.Vector3();
  private dist = 24;
  private userDist = 24;
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
  /** How many hexes were out of the fog when the ground was last drawn. */
  private lifted = -1;
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

    const sea = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshLambertMaterial({ color: "#3577cf" }));
    addFancyWater(sea.material);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = 0.1;
    sea.receiveShadow = true;
    this.scene.add(sea);
    this.sea = sea;

    this.hoverRing = this.buildHoverMarker();
    this.hoverRing.visible = false;

    this.scene.add(this.decor, this.poiGroup, this.propGroup, this.rangeGroup, this.pathGroup, this.hoverRing, this.unitGroup, this.fxGroup, this.groundTorches);

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
    // "Fancy grass" changes what the ground is grown with: the map's ground is drawn again, as when fog lifts.
    this.unwatchGrass = fancyGrass.subscribe(() => {
      if (!this.state) return;
      this.lifted = -1;
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
    this.ambience.dispose();
    this.tableLamps.clear();
    this.endMinigame();
    this.post?.dispose();
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
    if (first || lifted !== this.lifted) this.buildTerrain(state, first);
    if (first) this.buildPanes(state);
    if (first) this.buildWallPanels(state);
    this.lifted = lifted;
    this.state = state;
    this.ambience.setGloom(!!state.gloom);
    this.ambience.setLampOn(!state.lampOff);
    this.buildGroundTorches(state);
    this.buildPois(state);
    this.buildProps(state);
    this.updateGhost();
    this.buildJoinRanges(state);
    if (first) {
      // A new map opens at its own turn.
      this.homeYaw = state.homeYaw ?? 0;
      this.userYaw = this.yaw = this.yawGoal = this.homeYaw;
      // No sea under a hut's floor, nor in the caverns.
      this.sea.visible = !state.indoors && state.kind !== "caverns";
      (this.scene.background as THREE.Color).set(state.indoors ? "#1d1a2b" : "#a9dcf7");
      // A room is framed whole: closer for a hut, further back for the pub.
      if (state.indoors) this.userDist = this.camDist = state.map.grid.cols > 10 ? 21 : 15;
    }

    const me = state.heroes.find((h) => h.id === state.you);
    const myTurn = !!me && (state.freeRoam || (state.phase === "overworld" && state.turn?.heroId === state.you));
    this.reach = state.reach ?? (myTurn ? reachable(state.map, me!.pos, state.freeRoam ? FREE_ROAM_REACH : state.turn!.mp, this.stepCost(state)) : new Map());
    if (!state.reach && myTurn) this.reachSeats(state);
    this.paintTiles();
    this.syncUnits(state);
    this.updatePath();

    this.dist = this.userDist;
    this.yawGoal = nearestTurn(this.yaw, this.userYaw);
    this.pitchGoal = this.userPitch;
    for (const b of this.turnButtons) b.hidden = false;
    const turnKey = `${state.phase}:${state.round}:${state.turn?.heroId ?? ""}`;
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
      } else if (ev.t === "chat") {
        const line = ev.line;
        if (line.who === "npc") this.say(`npc:${line.npcId}`, line.text);
        else if (line.who === "hero") {
          const id = line.heroId ?? this.state?.heroes.find((h) => h.name === line.name)?.id;
          if (id) this.say(id, line.text);
        }
      } else if (ev.t === "battle") {
        const b = ev.ev;
        // Sounds are asked for inside each beat, so they land with the picture, not when the message arrived.
        if (b.t === "hit") struck.set(b.target, b.actor);
        if (b.t === "hit") this.later(beat++, () => this.attack(b.actor, b.target, b.ability, b.perfect, () => { sounds.impact(b.ability, attackStyle(b.ability), b.perfect, this.fighter(b.target), this.spot(b.target)); this.float(b.target, `-${b.amount}`, b.perfect ? "#ffd23f" : "#ff6b6b"); }, true));
        else if (b.t === "miss" && b.heal) this.later(beat++, () => { sounds.healFailed(this.spot(b.actor)); this.float(b.actor, "fails", "#c9d1e0"); });
        else if (b.t === "miss") this.later(beat++, () => this.attack(b.actor, b.target, b.ability, false, () => { sounds.miss(b.ability, attackStyle(b.ability), this.spot(b.target)); this.float(b.target, "miss", "#c9d1e0"); }));
        else if (b.t === "heal") this.later(beat++, () => {
          sounds.heal(b.ability, this.spot(b.target));
          if (REGROWTH.has(b.ability)) this.regrow(b.target);
          else this.sparkle(b.target, "#7dff9a");
          this.float(b.target, `+${b.amount}`, "#7dff9a");
        });
        else if (b.t === "tick") {
          // A troll on fire: the burn, and its wounds failing to close.
          const kind = this.state?.units?.find((u) => u.id === b.target)?.kind;
          const blocked = kind !== undefined && ENEMIES[kind]?.regen?.unless === b.effect;
          this.later(beat++, () => {
            sounds.tick(b.effect, this.spot(b.target));
            this.float(b.target, `-${b.amount}`, "#ffa94d");
            if (blocked) this.regrowthBlocked(b.target);
          });
        }
        else if (b.t === "turn" && b.id === this.state?.you) myTurnAt = beat;
        // A class trait kicking in gets its name over the hero.
        else if (b.t === "trait") this.later(beat++, () => { const name = TRAIT_BY_ID[b.trait]?.name ?? b.trait; sounds.trait(name, this.spot(b.id)); this.float(b.id, name, "#facc15"); });
        // These ride on the blow before them rather than taking a beat of their own.
        else if (b.t === "effect") { this.later(Math.max(startBeat, beat - 1) + 0.4, () => sounds.effect(b.effect, this.spot(b.target))); }
        else if (b.t === "down") {
          const who = this.fighter(b.id);
          const by = struck.get(b.id);
          const at = Math.max(startBeat, beat - 1) + 0.6;
          // Held up until then (the fallback is only for a fall no beat brings).
          const dying = this.units.get(b.id);
          if (dying?.dying !== undefined) dying.dying = this.clock + at * 0.38 + 2;
          this.later(at, () => { sounds.down(who, this.spot(b.id)); this.topple(b.id, by); });
        }
        else if (b.t === "flee") this.later(beat, () => sounds.flee(b.ok, this.spot(b.actor)));
      } else if (this.state) {
        // After the blows queued so far, so a fight's closing sting does not cut across its last hit.
        const you = this.state.you;
        this.later(beat, () => sounds.world(ev, you));
      }
    }
    // After the last blow has landed.
    for (const [heroId, got] of xp) this.later(beat, () => this.xpGain(heroId, got.amount, got.levelUp));
    // Your turn coming round in a fight gets a soft tick (the closing sting comes from the battle's end event).
    if (!ending && myTurnAt !== null) this.later(myTurnAt, () => sounds.yourTurn(), 0.1);
  }

  /**
   * Show a line of chat in a speech bubble over a unit (a hero's id, or `npc:<id>`)
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
    unit.path = [this.standAt(to)];
    unit.rush = 3.2;
    unit.bob = 0.22;
    if (fall) unit.floored = this.clock + 1;
  }

  /** A unit knocked off its feet where it stands. */
  floor(id: string, seconds = 1) {
    const unit = this.units.get(id);
    if (unit) unit.floored = this.clock + seconds;
  }

  /** The top of a unit's head in the world, wherever it has got to: for something drawn over it. Null if it is not on the map. */
  unitHead(id: string): THREE.Vector3 | null {
    const unit = this.units.get(id);
    if (!unit) return null;
    const at = unit.root.position.clone();
    at.y += unit.head - unit.bob;
    return at;
  }

  /** One blow or shot from one unit at another, named for its look and sound. `onImpact` runs as it lands (or flies wide). */
  blow(actorId: string, targetId: string, name: string, opts: { crit?: boolean; landed?: boolean; onImpact?: () => void } = {}) {
    const style = attackStyle(name);
    this.attack(actorId, targetId, name, !!opts.crit, () => {
      if (opts.landed) {
        sounds.impact(name, style, !!opts.crit, this.fighter(targetId), this.spot(targetId));
        this.recoil(targetId, actorId, opts.crit ? 0.6 : 0.38);
      } else sounds.miss(name, style, this.spot(targetId));
      opts.onImpact?.();
    }, !!opts.landed);
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
    if (wait > 0) this.later(0, then, wait);
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
    if (wait > 0) this.later(0, then, wait);
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

  /** Where a unit stands in the world, for a sound's distance. */
  whereIs(id: string): { x: number; z: number } | undefined {
    return this.spot(id);
  }

  /** Run `run` on beat `beat` of what is being played out, `extra` seconds after it. */
  /**
   * One just killed falls where it stands, limp (see Figure.fall): knocked away from `by`, who struck the blow.
   * Only for one held up for it (see Unit.dying); anyone else is already lying as they should.
   */
  private topple(id: string, by?: string) {
    const unit = this.units.get(id);
    if (!unit || unit.dying === undefined) return;
    unit.dying = undefined;
    unit.lying = true;
    unit.head = unit.size * LYING + 0.3;
    unit.path = [];
    unit.figure.setDim(true);
    this.clearArrows(unit);
    const from = by ? this.units.get(by) : undefined;
    const away = from ? unit.goal.clone().sub(from.goal).setY(0) : undefined;
    unit.figure.fall(away && away.lengthSq() > 1e-6 ? away : undefined);
  }

  private later(beat: number, run: () => void, extra = 0) {
    this.pending.push({ at: this.clock + beat * 0.38 + extra, run });
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
  private attack(actorId: string, targetId: string, ability: string, perfect: boolean, onImpact: () => void, landed = false) {
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
      if (wait > 0) this.later(0, hurl, wait);
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
      if (wait > 0) this.later(0, fly, wait);
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
      this.spawnFx("slash", perfect ? "#ffd23f" : "#dfe9ff", flip, { from: hitAt, to: hitAt, life: heavy ? 0.3 : 0.26, size: heavy ? [1.7, 3] : [1.3, 2.3], spin: -dir * (heavy ? 1.6 : 0.9), fade: true });
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
    this.later(0, land, wait);
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

  /** A troll growing back: flecks of moss creeping up over it. */
  private regrow(unitId: string) {
    const unit = this.units.get(unitId);
    if (!unit) return;
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * unit.size * 0.13;
      const from = unit.goal.clone().add(new THREE.Vector3(x, unit.size * (0.15 + 0.12 * (i % 3)), 0.08));
      this.spawnFx("fleck", MOSS, i % 2 === 0, { from, to: from.clone().add(new THREE.Vector3(x * 0.3, unit.size * 0.35, 0)), life: 0.7, size: [0.7, 0.95], spin: 0, fade: true });
    }
  }

  /** Fire keeping a troll's wounds open: a wisp of smoke and a word saying so, over the burn. */
  private regrowthBlocked(unitId: string) {
    const unit = this.units.get(unitId);
    if (!unit) return;
    for (const [x, rise, flip] of [[-0.2, 0.9, false], [0.15, 1.1, true], [0.4, 0.8, false]] as const) {
      const from = unit.goal.clone().add(new THREE.Vector3(x, unit.size * 0.55, 0.05));
      this.spawnFx("dust", "#a39ca8", flip, { from, to: from.clone().add(new THREE.Vector3(x * 0.4, rise, 0)), life: 0.9, size: [0.9, 1.7], spin: 0, fade: true });
    }
    this.float(unitId, "can't regrow", "#c9c1d6", { height: 0.32, lift: 0.4 });
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

  private float(unitId: string, text: string, color: string, opts: { life?: number; rise?: number; height?: number; lift?: number; at?: THREE.Vector3 } = {}) {
    const unit = this.units.get(unitId);
    if (!unit) return;
    const map = textTexture(text, color);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
    const height = opts.height ?? 0.45;
    // The texture is 24 rows tall and as wide as the text needs: keep its pixels square.
    sprite.scale.set((height * map.image.width) / 24, height, 1);
    sprite.position.copy(opts.at ?? unit.root.position.clone().add(new THREE.Vector3(0, unit.size + 0.5, 0))).add(new THREE.Vector3(0, opts.lift ?? 0, 0));
    sprite.renderOrder = 10;
    this.fxGroup.add(sprite);
    this.floaters.push({ sprite, age: 0, life: opts.life, rise: opts.rise });
  }

  /**
   * A hero earned XP: a short burst of gold and pale-blue pixel motes rising
   * off their head and fading, a crisp "+N XP", and their plate's XP bar lit
   * up for a moment. `levelUp` adds a bigger flourish: more motes, a gold
   * burst, a ring of motes thrown outward and "LEVEL UP" over the top.
   */
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
    this.seaBase.set(this.sodden ? "#2b4558" : "#3577cf");
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
          // A map that is all sea (the crossing to an island) is drawn whole.
          if (land.length === 0) return false;
          const near = Math.min(...land.map((l) => hexDistance(l, t)));
          return near > 2 || (near === 2 && noise(t.q, t.r, 31) < 0.45);
        })
        .map(key),
    );
    // For the fancy water: which hexes are water, how near the shore, and which of their sides touch land.
    addFancyWater(terrain.material as THREE.MeshLambertMaterial, true);
    const water = waterAttribute(this.tiles.length);
    const byKey = new Map(this.tiles.map((t) => [key(t), t]));
    const isLand = (t: Tile | undefined) => !!t && t.biome !== "water" && t.biome !== "fog";
    this.tiles.forEach((t, i) => {
      const { x, z } = hexToWorld(t);
      const shown = this.deep.has(key(t)) ? 0 : 1;
      m.compose(new THREE.Vector3(x, tileTop(t), z), new THREE.Quaternion(), new THREE.Vector3(shown, shown ? 1 : 0, shown));
      terrain.setMatrixAt(i, m);
      if (t.biome !== "water") {
        water.setXYZ(i, 0, 0, GROUND_KIND[t.biome] ?? 0);
        return;
      }
      let sides = 0;
      for (const dir of HEX_DIRS) {
        const next = { q: t.q + dir.q, r: t.r + dir.r };
        if (!isLand(byKey.get(key(next)))) continue;
        const to = hexToWorld(next);
        sides |= 1 << shoreSide(to.x - x, to.z - z);
      }
      water.setXYZ(i, 1, sides, 0);
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

    // Trees on forest, the thickets and boulder heaps that cannot be walked through, and the boulders that
    // bound the Harbor. POI hexes stay clear. Rocks on open hills, grass and waves come from the ambience.
    const poiKeys = new Set(state.map.pois.map((p) => key(p.pos)));
    const trees: TreeSpot[] = [];
    const boulders: BoulderSpot[] = [];
    const setOaks = this.tiles.filter((t) => t.blocker === "oak");
    for (const t of this.tiles) {
      if (poiKeys.has(key(t))) continue;
      const { x, z } = hexToWorld(t);
      const top = tileTop(t);
      const n = (salt: number) => noise(t.q, t.r, salt);
      const tree = (dx: number, dz: number, size: number, salt: number, pine = n(salt + 1) < 0.68) =>
        trees.push({ x: x + dx, y: top, z: z + dz, size, kind: pine ? "pine" : "broad", yaw: n(salt + 2) * Math.PI * 2, tint: tintOf(n(salt + 3), n(salt + 4)) });
      const rock = (dx: number, dz: number, size: number, tall: number, salt: number) =>
        boulders.push({ x: x + dx, y: top, z: z + dz, size, tall, yaw: n(salt) * Math.PI * 2, tilt: (n(salt + 1) - 0.5) * 0.5, shape: Math.floor(n(salt + 2) * 3.99), tint: tintOf(n(salt + 3), n(salt + 4)) });
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
        const ox = x - this.land.x, oz = z - this.land.z;
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
        const dry = dryPatch(t, x, z) >= 0;
        if (n(800) >= (dry ? 0.45 : 0.2)) continue;
        // Where the map has set an oak down, it stands alone: no wild one within a few hexes of it.
        if (setOaks.some((o) => hexDistance(o, t) <= 5)) continue;
        const corner = Math.floor(n(801) * 5.99);
        const beside = [HEX_DIRS[corner], HEX_DIRS[(corner + 1) % 6]].map((d) => byKey.get(key({ q: t.q + d.q, r: t.r + d.r })));
        if (beside.some((b) => !b || b.biome === "water" || b.biome === "dock" || b.path)) continue;
        const taken = (h: Tile | undefined) => !!h && (!!h.built || !!h.blocker || poiKeys.has(key(h)));
        if ([t, ...beside].some((h) => taken(h) || HEX_DIRS.some((d) => taken(byKey.get(key({ q: h!.q + d.q, r: h!.r + d.r })))))) continue;
        const a = ((-30 + 60 * corner) * Math.PI) / 180;
        const ox = x + Math.cos(a) * 0.8, oz = z + Math.sin(a) * 0.8;
        // Old trees keep their distance: none within a couple of hexes of another, so their crowns do not run together.
        if (trees.some((o) => (o.kind === "oak" || o.kind === "snag") && Math.hypot(o.x - ox, o.z - oz) < 3.6)) continue;
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
    if (!state.indoors && state.kind !== "caverns" && !this.opts.backdrop && !this.still && this.tiles.some((t) => t.biome === "water")) {
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
      this.tiles.filter((t) => !this.deep.has(key(t))),
      // Nothing grows or lies about where a place stands, under a building, or in a thicket or a boulder heap.
      // The Harbor's gaps of rubble have their boulders from the woods, not the ambience's hill rocks.
      // (Grass does grow round the foot of a lone oak.)
      (t) => poiKeys.has(key(t)) || !!t.built || (!!t.blocker && t.blocker !== "oak") || (this.sodden && t.biome === "hills"),
      (t) => ({ ...hexToWorld(t), y: tileTop(t) }),
    );
    // The trees bend in the wind (fancy graphics), and aside as anyone walks through them.
    this.woods?.dispose();
    // The caverns' entrance is cut into the rampart behind its hex (its model stands back into it): none of the
    // rampart's rubble stands in the way in, or just in front of it, where it would block the arch from view.
    const ways = state.map.pois.filter((p) => p.kind === "cave").map((p) => ({ ...hexToWorld(p.pos), back: placeOf(p).back }));
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

    // Start centred on the island. Fog lifting redraws the ground but leaves the camera where the player put it.
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

  private paintTiles() {
    if (!this.terrain) return;
    const c = new THREE.Color();
    const white = new THREE.Color("#ffffff");
    // A place's hex keeps its green: the ambience lays no dry grass there, so it would be parched for nothing.
    const places = new Set(this.state?.map.pois.map((p) => key(p.pos)) ?? []);
    this.tiles.forEach((t, i) => {
      c.set(BIOME_COLOR[t.biome]);
      // Fog is a pale mist by day and all but black by night.
      if (t.biome === "fog") c.set(FOG_DAY).lerp(FOG_NIGHT, Math.max(0, this.paintedNight) / 10);
      // In a wet, walled port the green is tired.
      if (this.sodden && (t.biome === "plains" || t.biome === "forest")) c.lerp(DRAB, 0.5);
      if (t.biome === "plains" && !t.built && !places.has(key(t))) {
        const { x, z } = hexToWorld(t);
        const dry = dryPatch(t, x, z);
        if (dry >= 0) c.lerp(dry === 2 ? DUSTY : PARCHED, dry === 2 ? 0.62 : 0.45);
        // Under tall grass the ground is in its shade.
        else if (tallGrass(t, x, z)) c.multiplyScalar(0.82);
      }
      if (this.sodden && t.biome === "water") c.lerp(GREY_SEA, 0.65);
      if (t.biome === "water") c.lerp(NIGHT_SEA, (Math.max(0, this.paintedNight) / 10) * 0.7);
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

  /** Centre the camera over a point on the map, in world units; `snap` puts it there at once instead of easing. */
  focusAt(x: number, z: number, snap = false) {
    this.targetGoal.set(x, 0.14, z);
    if (snap) this.target.copy(this.targetGoal);
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

  /** A point of interest's model, by id, for a scene that moves one about itself (the crew's ship at sea). */
  poiObject(id: string): THREE.Object3D | undefined {
    return this.poiGroup.children.find((g) => g.userData.poiId === id);
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

  /** Whether the finishing pass (glow and the rest) is on in this view. */
  get glowing(): boolean {
    return !!this.post;
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
    this.poiTops.clear();
    this.twinkles = [];
    this.tableLamps.clear();
    this.poiGroup.add(this.tableLamps.group);
    // What stands in the water, for the fancy sea to foam round. Each model sits a little back from its hex's middle.
    const standing: Standing[] = [];
    for (const poi of state.map.pois) {
      const { x, z } = hexToWorld(poi.pos);
      const { scale, back } = placeOf(poi);
      /** Something in the model, by where it is modelled: where it stands in the world, and how big. */
      const stands = (mx: number, mz: number, half: number, radius: number) => standing.push({ x: x + mx * scale, z: z + mz * scale - back, half: half * scale, radius: radius * scale });
      if (poi.kind === "rocks") stands(-0.05, 0.08, 0.25, 0.5);
      else if (poi.kind === "wreck") stands(0.2, 0.08, 0.75, 0.45);
      // A moored ship lies off the end of its pier.
      else if (poi.kind === "pier") stands(0, 1.75, 0.72, 0.36);
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
      const { scale, back } = placeOf(poi);
      if (BUILDINGS.has(poi.kind)) inkBuilding(g, scale);
      // A building turned to front a road (see `facing`) is turned about its door: it stands back from the door
      // the way it faces away from it.
      // A hut is not set out with a surveyor's chain: each stands a few degrees askew of its lane, its own way
      // (the same for a plot staked out, its building site and the hut that goes up on it).
      const askew = HUT_KINDS.has(poi.kind) ? (noise(poi.pos.q, poi.pos.r, 77) - 0.5) * 0.3 : 0;
      const yaw = yawOf(poi.facing ?? 0) + askew;
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
        // Edge i runs between corners i and i+1; the neighbour across it lies along the bisector (as in buildJoinRanges).
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
    this.aimedAt = target;
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
   * Outline, in red, the area around a place with enemies still in it: a
   * hero standing inside the line when a fight starts there is pulled in.
   * Shown only when it matters: while the pointer is over the place or its
   * surroundings, or while a hero is standing inside the area.
   */
  private buildJoinRanges(state: RenderState) {
    const near = (p: HexPos, poi: Poi) => hexDistance(p, poi.pos) <= BATTLE_JOIN_RANGE;
    const hostile = state.map.pois.filter(
      (poi) => !poi.cleared && poi.enemies.length > 0 && ((this.hovered && near(this.hovered, poi)) || state.heroes.some((h) => near(h.pos, poi))),
    );
    const sig = `${state.code}|${hostile.map((p) => p.id).join(",")}`;
    if (sig === this.rangeSig) return;
    this.rangeSig = sig;
    for (const child of this.rangeGroup.children) (child as THREE.LineSegments).geometry.dispose();
    this.rangeGroup.clear();

    const points: number[] = [];
    for (const poi of hostile) {
      const inside = (p: HexPos) => hexDistance(p, poi.pos) <= BATTLE_JOIN_RANGE;
      for (const t of this.tiles) {
        if (!inside(t)) continue;
        const { x, z } = hexToWorld(t);
        const y = tileTop(t) + 0.05;
        for (let i = 0; i < 6; i++) {
          // Edge i runs between corners i and i+1; the neighbour across it lies along the bisector.
          const a = (i * Math.PI) / 3;
          const b = ((i + 1) * Math.PI) / 3;
          const mid = (a + b) / 2;
          const nx = x + Math.sin(mid) * SQRT3;
          const nz = z + Math.cos(mid) * SQRT3;
          const nr = Math.round(nz / 1.5);
          const nq = Math.round(nx / SQRT3 - nr / 2);
          const neighbour = { q: nq, r: nr };
          // Draw only the edges on the boundary; the map's own edge counts as boundary.
          if (inside(neighbour) && tileAt(state.map, neighbour)) continue;
          points.push(x + Math.sin(a), y, z + Math.cos(a), x + Math.sin(b), y, z + Math.cos(b));
        }
      }
    }
    if (points.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: "#ff3b3b", transparent: true, opacity: 0.9, depthTest: false }));
    lines.renderOrder = 2;
    this.rangeGroup.add(lines);
  }

  /**
   * A point out in the world, in the space of `poi`'s model (as the loop over places sets each model down: moved
   * back, turned to face, and scaled).
   */
  private inModel(poi: Poi, x: number, z: number): THREE.Vector2 {
    const { scale, back } = placeOf(poi);
    const yaw = yawOf(poi.facing ?? 0);
    const at = hexToWorld(poi.pos);
    const behind = new THREE.Vector3(0, 0, -back).applyAxisAngle(UP, yaw);
    const p = new THREE.Vector3(x - at.x - behind.x, 0, z - at.z - behind.z).applyAxisAngle(UP, -yaw).divideScalar(scale);
    return new THREE.Vector2(p.x, p.z);
  }

  private poiModel(poi: Poi): THREE.Group {
    const g = new THREE.Group();
    const lambert = (color: string) => new THREE.MeshLambertMaterial({ color, flatShading: true });
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rotY = 0) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.rotation.y = rotY;
      g.add(mesh);
      return mesh;
    };
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

    switch (poi.kind) {
      case "landing": {
        if (this.state?.kind === "caverns") {
          // The way back out of the caverns: a rope let down into the light from above (see caveRope).
          g.add(caveRope(SHAFT_HEIGHT));
          // And daylight falling in through it from above: a pale shaft, brightest at the floor and fading as it
          // rises, a pool of light where it lands, and real light round it, so the way out shows from across the dark.
          const sky = new THREE.Color("#d8ecff");
          const glowing = (geometry: THREE.BufferGeometry, k: (x: number, y: number, z: number) => number) => {
            const pos = geometry.getAttribute("position");
            const colors: number[] = [];
            for (let i = 0; i < pos.count; i++) {
              const v = k(pos.getX(i), pos.getY(i), pos.getZ(i));
              colors.push(sky.r * v, sky.g * v, sky.b * v);
            }
            geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
            const mesh = add(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), 0, 0, 0);
            mesh.userData.glow = true;
            return mesh;
          };
          const SHAFT = SHAFT_HEIGHT;
          const shaft = glowing(new THREE.CylinderGeometry(0.42, 0.78, SHAFT, 18, 6, true), (_x, y) => 0.32 * Math.pow(1 - (y + SHAFT / 2) / SHAFT, 1.6));
          shaft.position.y = SHAFT / 2;
          const pool = glowing(new THREE.CircleGeometry(0.95, 24).rotateX(-Math.PI / 2), (x, _y, z) => 0.55 * Math.pow(Math.max(0, 1 - Math.hypot(x, z) / 0.95), 1.3));
          pool.position.y = 0.02;
          const daylight = new THREE.PointLight("#d8e8ff", 2.6, 4.5, 1.4);
          daylight.position.set(0, 1.6, 0);
          g.add(daylight);
          break;
        }
        add(box(1.0, 0.08, 0.5), lambert("#8a6a44"), 0, 0.05, 0.1);
        // The party's ship, moored just offshore to the west. Named, so the landfall can hide it while she is still coming in.
        add(box(1.1, 0.32, 0.5), lambert("#6b4a2b"), -1.5, -0.05, 0.3).name = "moored";
        add(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 5), lambert("#4a3520"), -1.5, 0.6, 0.3).name = "moored";
        add(box(0.05, 0.6, 0.55), lambert("#f4efe1"), -1.42, 0.75, 0.3).name = "moored";
        break;
      }
      case "hut":
        add(box(0.75, 0.45, 0.6), lambert("#b98b5a"), 0, 0.225, 0);
        add(new THREE.ConeGeometry(0.66, 0.42, 4), lambert("#8c3b2f"), 0, 0.66, 0, Math.PI / 4);
        break;
      case "lair":
        add(new THREE.ConeGeometry(0.6, 1.0, 5), lambert("#3a3340"), -0.1, 0.5, 0);
        add(new THREE.ConeGeometry(0.38, 0.65, 5), lambert("#2a2430"), 0.45, 0.32, 0.1);
        add(new THREE.OctahedronGeometry(0.16), new THREE.MeshBasicMaterial({ color: poi.cleared ? "#6a6a6a" : "#e04fd0" }), 0.1, 1.15, 0.15);
        break;
      case "shrine":
        add(new THREE.CylinderGeometry(0.3, 0.34, 0.12, 6), lambert("#d8d8d8"), 0, 0.06, 0);
        add(new THREE.CylinderGeometry(0.1, 0.12, 0.7, 6), lambert("#efefef"), 0, 0.45, 0);
        add(new THREE.OctahedronGeometry(0.15), new THREE.MeshBasicMaterial({ color: "#ffd23f" }), 0, 0.98, 0);
        break;
      case "pickup": {
        // Taken: nothing left to draw.
        if (poi.cleared) break;
        // Drawn at 1.7x into its own group, and lit a little from within so it still reads at night and under trees.
        const pile = new THREE.Group();
        pile.scale.setScalar(1.7);
        g.add(pile);
        const lit = (color: string, glow = 0.35) =>
          new THREE.MeshLambertMaterial({ color, flatShading: true, emissive: new THREE.Color(color).multiplyScalar(glow) });
        const put = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rotY = 0) => {
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(x, y, z);
          mesh.rotation.y = rotY;
          pile.add(mesh);
          return mesh;
        };
        // A soft pale disc on the ground marks it as something to pick up.
        const halo = new THREE.Mesh(
          new THREE.CircleGeometry(0.3, 16),
          new THREE.MeshBasicMaterial({ color: "#fff4c2", transparent: true, opacity: 0.18, depthWrite: false }),
        );
        halo.rotation.x = -Math.PI / 2;
        halo.position.set(0, 0.01, 0.08);
        pile.add(halo);
        if (poi.find === "herbs") {
          for (const [x, z, k] of [[-0.14, 0.1, 1], [0.04, 0.2, 0.85], [0.16, 0.05, 0.95], [-0.02, -0.03, 0.75]]) {
            put(new THREE.ConeGeometry(0.08 * k, 0.26 * k, 5), lit("#6fc24a"), x, 0.13 * k, z);
            put(new THREE.ConeGeometry(0.06 * k, 0.2 * k, 5), lit("#9be06a"), x + 0.05, 0.1 * k, z + 0.03, 0.6);
          }
          for (const [x, z] of [[-0.14, 0.1], [0.16, 0.05], [0.04, 0.2], [-0.02, -0.03]]) put(new THREE.BoxGeometry(0.06, 0.06, 0.06), lit("#e2b8ff", 0.6), x, 0.28, z);
        } else if (poi.find === "mushrooms") {
          for (const [x, z, k] of [[-0.12, 0.12, 1], [0.12, 0.18, 0.8], [0.06, -0.02, 0.65]]) {
            put(new THREE.CylinderGeometry(0.035 * k, 0.045 * k, 0.16 * k, 6), lit("#fbf3e2", 0.4), x, 0.08 * k, z);
            put(new THREE.SphereGeometry(0.11 * k, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), lit("#e2412a", 0.45), x, 0.15 * k, z);
            for (const [dx, dz] of [[0.04, 0.04], [-0.04, 0.03], [0.0, -0.05]]) put(new THREE.BoxGeometry(0.025, 0.02, 0.025), lit("#ffffff", 0.8), x + dx * k, 0.15 * k + 0.085 * k, z + dz * k);
          }
        } else if (poi.find === "wood") {
          // A small stack of cut logs, pale cut ends toward the camera.
          const log = new THREE.CylinderGeometry(0.07, 0.07, 0.42, 7);
          const end = new THREE.CircleGeometry(0.06, 7);
          for (const [x, y] of [[-0.15, 0.07], [0, 0.07], [0.15, 0.07], [-0.075, 0.2], [0.075, 0.2]]) {
            put(log, lit("#a8713a", 0.3), x, y, 0.08).rotation.x = Math.PI / 2;
            put(end, lit("#e8c890", 0.4), x, y, 0.295);
          }
        } else {
          for (const [x, z, k, y] of [[-0.12, 0.1, 1, 0], [0.13, 0.15, 0.8, 0], [0.02, -0.05, 0.7, 0], [0.0, 0.12, 0.6, 0.12]]) {
            put(new THREE.DodecahedronGeometry(0.11 * k), lit(k > 0.75 ? "#b4bcc8" : "#d0d6de", 0.3), x, 0.09 * k + y, z);
          }
        }
        break;
      }
      case "cache": {
        if (this.state?.kind === "caverns" && poi.loot) {
          // An old chest, an iron-bound strongbox, or the hoard (caveProps.ts). Its lid may be swinging open right now.
          const model = chestModel(poi, this.lidNow(poi));
          g.add(model);
          g.userData.lid = model.userData.lid;
          // Pointing anywhere on it means its hex, not the ground behind it.
          g.userData.door = poi.pos;
          break;
        }
        add(box(0.38, 0.24, 0.26), lambert(poi.cleared ? "#6b6b6b" : "#9a6b2f"), 0, 0.12, 0.2);
        if (!poi.cleared) add(box(0.4, 0.05, 0.28), lambert("#e0b12e"), 0, 0.26, 0.2);
        break;
      }
      case "gate": {
        // A heavy timber door across a cave tunnel, in a frame of old beams. Swung back against the rock once it is open.
        const frame = new THREE.Group();
        // Centred on its hex (places are drawn a little toward the camera), and turned to stand across the passage.
        frame.position.z = 0.28;
        if (poi.into) {
          const a = hexToWorld(poi.pos);
          const b = hexToWorld({ q: poi.pos.q + poi.into.q, r: poi.pos.r + poi.into.r });
          frame.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
        }
        g.add(frame);
        const beam = lambert("#4a3420");
        const put = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(x, y, z);
          frame.add(mesh);
          return mesh;
        };
        for (const x of [-0.72, 0.72]) put(box(0.18, 1.25, 0.2), beam, x, 0.62, 0);
        put(box(1.66, 0.18, 0.24), beam, 0, 1.3, 0);
        // The door hangs from its left post.
        const hinge = new THREE.Group();
        hinge.position.set(-0.62, 0, 0);
        hinge.rotation.y = poi.cleared ? -1.45 : 0;
        frame.add(hinge);
        const plank = lambert(poi.cleared ? "#5b4632" : "#6b4a2b");
        const band = lambert("#30333a");
        for (let i = 0; i < 4; i++) {
          const m = new THREE.Mesh(box(0.3, 1.1, 0.1), plank);
          m.position.set(0.16 + i * 0.31, 0.56, 0);
          hinge.add(m);
        }
        for (const y of [0.25, 0.85]) {
          const m = new THREE.Mesh(box(1.26, 0.07, 0.13), band);
          m.position.set(0.62, y, 0);
          hinge.add(m);
        }
        if (!poi.cleared) {
          // A brass lock plate that catches the torchlight.
          const lock = new THREE.Mesh(box(0.12, 0.16, 0.04), new THREE.MeshBasicMaterial({ color: "#d8b45a" }));
          lock.position.set(1.05, 0.56, 0.07);
          lock.userData.glow = true;
          hinge.add(lock);
        }
        break;
      }
      case "pier": {
        // A crew ship moored off the end of the pier, toward the open sea.
        add(box(1.5, 0.4, 0.62), lambert("#6b4a2b"), 0, -0.02, 1.75);
        add(box(0.5, 0.22, 0.5), lambert("#5a3d22"), 0.5, 0.28, 1.75);
        add(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 5), lambert("#4a3520"), -0.1, 0.9, 1.75);
        add(box(0.75, 0.75, 0.05), lambert("#f4efe1"), -0.1, 1.15, 1.7);
        add(box(0.3, 0.06, 0.9), lambert("#8a6a44"), 0, 0.02, 0.95);
        break;
      }
      case "ship": {
        // The crew's ship under sail, seen from the beam: hull, deckhouse, a mast with a full square sail, and a white curl at the bow.
        add(box(1.6, 0.42, 0.66), lambert("#6b4a2b"), 0, 0.02, 0.28);
        add(box(1.7, 0.06, 0.72), lambert("#4a3520"), 0, 0.25, 0.28);
        add(box(0.5, 0.24, 0.5), lambert("#5a3d22"), -0.5, 0.4, 0.28);
        add(new THREE.CylinderGeometry(0.05, 0.06, 1.7, 5), lambert("#4a3520"), 0.1, 1.1, 0.28);
        // The sail is drawn side on, like the hull, so it shows its face while she runs left to right.
        add(box(0.95, 0.95, 0.06), lambert("#f4efe1"), 0.22, 1.25, 0.28);
        add(box(1.05, 0.07, 0.07), lambert("#4a3520"), 0.22, 1.74, 0.28);
        add(box(0.3, 0.16, 0.03), lambert("#b9433d"), 0.1, 2.0, 0.28);
        add(box(0.3, 0.06, 0.8), new THREE.MeshBasicMaterial({ color: "#f2f9ff" }), 0.95, -0.12, 0.28);
        add(box(0.6, 0.04, 0.5), new THREE.MeshBasicMaterial({ color: "#cfe6fb" }), -1.1, -0.14, 0.28);
        break;
      }
      case "lot": {
        // A plot for sale: four corner stakes, a line of twine, and a board on a post.
        const stake = lambert("#7a5230");
        for (const [x, z] of [[-0.5, -0.15], [0.5, -0.15], [-0.5, 0.65], [0.5, 0.65]]) add(box(0.06, 0.3, 0.06), stake, x, 0.15, z);
        add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, -0.15);
        add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, 0.65);
        add(box(0.05, 0.55, 0.05), stake, 0, 0.27, 0.0);
        add(box(0.42, 0.24, 0.04), lambert("#c9a877"), 0, 0.55, 0.0);
        break;
      }
      case "site": {
        // A bought plot with no shack yet: the stakes and twine, and an open wooden bin that fills with planks and stones.
        const stake = lambert("#7a5230");
        for (const [x, z] of [[-0.5, -0.15], [0.5, -0.15], [-0.5, 0.65], [0.5, 0.65]]) add(box(0.06, 0.3, 0.06), stake, x, 0.15, z);
        add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, -0.15);
        add(box(1.0, 0.02, 0.02), lambert("#d8d2c0"), 0, 0.26, 0.65);
        const boards = lambert("#8a5f36");
        const W = 0.56, D = 0.4, H = 0.3, T = 0.04;
        add(box(W, 0.03, D), lambert("#5e4026"), 0, 0.015, 0.25);
        add(box(W, H, T), boards, 0, H / 2, 0.25 - D / 2);
        add(box(W, H, T), boards, 0, H / 2, 0.25 + D / 2);
        add(box(T, H, D), boards, -W / 2, H / 2, 0.25);
        add(box(T, H, D), boards, W / 2, H / 2, 0.25);
        // A darker band round the rim so the bin reads as a box, not a block.
        add(box(W + 0.02, 0.04, T + 0.01), lambert("#5e4026"), 0, H - 0.02, 0.25 + D / 2);
        const fill = Math.max(0, Math.min(1, poi.fill ?? 0));
        // The shack itself rises behind the bin as it fills: a slab, then the frame, then walls, then rafters.
        if (fill >= 0.2) {
          const frame = lambert("#7a5230");
          const wall = lambert("#c9a877");
          const late = fill >= 0.8;
          const ph = late ? 0.62 : 0.4;
          const wh = late ? 0.52 : 0.3;
          add(box(0.8, 0.05, 0.4), lambert("#9a958a"), 0, 0.025, -0.1);
          const posts: [number, number][] = [[-0.38, -0.28], [0.38, -0.28], [-0.38, 0.08], [0.38, 0.08]];
          if (fill >= 0.4) for (const [x, z] of posts) add(box(0.06, ph, 0.06), frame, x, 0.05 + ph / 2, z);
          if (fill >= 0.6) {
            add(box(0.7, wh, 0.04), wall, 0, 0.05 + wh / 2, -0.28);
            for (const x of [-0.38, 0.38]) add(box(0.04, wh, 0.32), wall, x, 0.05 + wh / 2, -0.1);
          }
          if (late) for (const x of [-0.25, 0, 0.25]) {
            add(box(0.04, 0.04, 0.26), frame, x, 0.78, -0.2).rotation.x = -0.7;
            add(box(0.04, 0.04, 0.26), frame, x, 0.78, -0.02).rotation.x = 0.7;
          }
        }
        if (fill > 0) {
          // Planks on the left, stones on the right, rising together; full, they heap over the rim.
          const top = 0.03 + fill * (H + 0.06);
          const plank = lambert("#c9a877");
          const stone = lambert("#8b8f96");
          for (let i = 0; i < 3; i++) add(box(0.22, 0.04, 0.07), plank, -0.12, Math.max(0.05, top - 0.03 - i * 0.05), 0.15 + i * 0.09);
          for (const [x, z, s] of [[0.13, 0.17, 0.09], [0.18, 0.31, 0.08], [0.08, 0.33, 0.07]]) add(box(s, s * 0.8, s), stone, x, Math.max(0.05, top - s / 2), z, 0.5);
        }
        break;
      }
      case "plot": {
        // Roof colour is picked from the owner's id so each hut is recognisable.
        const roofs = ["#8c3b2f", "#2f6f8c", "#6b8c2f", "#8c6a2f", "#6a2f8c", "#2f8c7a"];
        let hash = 0;
        for (const ch of poi.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        // Each tier is its own building, not a bigger copy: a Shack of rough planks under a shingled roof, a Cottage
        // of stone, plaster and timber with a chimney and flower boxes, a Lodge with a porch, dormers, a wing and a banner.
        const tier = Math.max(1, Math.min(3, poi.tier ?? 1));
        const roofHex = roofs[hash % roofs.length];
        const roofMat = lambert(roofHex);
        const roofDark = lambert("#" + new THREE.Color(roofHex).multiplyScalar(0.7).getHexString());
        const timber = lambert("#4a2f22");
        const plank = lambert("#a9835a");
        const plaster = lambert("#e8d9b5");
        const stone = lambert("#a8977a");
        const footing = lambert("#7b8494");
        const iron = lambert("#2b2a33");
        const wood = lambert("#7a5230");
        const doorMat = lambert("#5a3d22");
        const brass = lambert("#e0b12e");
        const glows: BuildingGlow[] = [];
        const panes: THREE.MeshBasicMaterial[] = [];
        const pane = (unlit: string, lit: string) => {
          const m = warmPane(unlit, lit);
          panes.push(m);
          return m;
        };
        const glass = pane("#c99a52", "#ffd98a");
        /** A framed window on a front wall at `z`, with glazing bars, optional shutters in the roof's colour, and a halo at dusk. */
        const framed = (x: number, y: number, w: number, h: number, z: number, shutters = false) => {
          add(box(w + 0.04, h + 0.04, 0.012), timber, x, y, z);
          add(box(w, h, 0.01), glass, x, y, z + 0.008).userData.glow = true;
          add(box(0.015, h, 0.012), timber, x, y, z + 0.014);
          add(box(w, 0.015, 0.012), timber, x, y, z + 0.014);
          if (shutters) for (const s of [-1, 1]) add(box(0.045, h + 0.02, 0.014), roofMat, x + s * (w / 2 + 0.045), y, z + 0.008);
          glows.push({ pos: new THREE.Vector3(x, y, z + 0.14), size: w * 2.2 });
        };
        /** A gabled roof: a prism of `wall` `len` long, `half` out to each eave and `rise` high, under two overhanging slabs. The ridge runs along x, or along z with `alongZ`. */
        const gable = (cx: number, cy: number, cz: number, len: number, half: number, rise: number, alongZ: boolean, wall: THREE.Material) => {
          const shape = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]);
          const prism = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false }).translate(0, 0, -len / 2);
          if (!alongZ) prism.rotateY(Math.PI / 2);
          add(prism, wall, cx, cy, cz);
          const pitch = Math.atan2(rise, half);
          const slope = Math.hypot(rise, half) * 1.08;
          for (const side of [1, -1]) {
            const along = slope / 2;
            const out = side * (along * Math.cos(pitch) + 0.03 * Math.sin(pitch));
            const y = cy + rise - along * Math.sin(pitch) + 0.03 * Math.cos(pitch);
            if (alongZ) add(box(slope, 0.06, len + 0.1), roofMat, cx + out, y, cz).rotation.z = -side * pitch;
            else add(box(len + 0.12, 0.06, slope), roofMat, cx, y, cz + out).rotation.x = side * pitch;
          }
          return pitch;
        };
        /** A darker course of shingles part way down each slope of a roof whose ridge runs along x, and a ridge cap. */
        const shingles = (cx: number, cy: number, len: number, half: number, rise: number, d: number) => {
          const pitch = Math.atan2(rise, half);
          for (const side of [1, -1]) {
            add(box(len + 0.16, 0.065, 0.05), roofDark, cx, cy + rise - d * Math.sin(pitch) + 0.035 * Math.cos(pitch), side * (d * Math.cos(pitch) + 0.035 * Math.sin(pitch))).rotation.x = side * pitch;
          }
          add(box(len + 0.2, 0.06, 0.08), roofDark, cx, cy + rise + 0.03, 0);
        };
        /** A chimney of stone with a cap and a pot; its smoke is drawn by the ambience. */
        const chimney = (x: number, z: number, from: number, top: number, w: number) => {
          add(box(w, top - from, w), stone, x, (from + top) / 2, z);
          add(box(w + 0.05, 0.05, w + 0.05), footing, x, top + 0.02, z);
          add(new THREE.CylinderGeometry(0.04, 0.05, 0.07, 6), lambert("#b8643a"), x, top + 0.075, z);
          g.userData.smoke = new THREE.Vector3(x, top + 0.14, z);
        };
        /** A lantern with its cage, cap and flame at (x, y, z), lit at dusk. */
        const lantern = (x: number, y: number, z: number) => {
          add(box(0.05, 0.065, 0.05), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), x, y, z).userData.glow = true;
          for (const [dx, dz] of [[-0.03, -0.03], [0.03, -0.03], [-0.03, 0.03], [0.03, 0.03]]) add(box(0.01, 0.08, 0.01), iron, x + dx, y, z + dz);
          add(box(0.08, 0.015, 0.08), iron, x, y - 0.045, z);
          add(new THREE.ConeGeometry(0.06, 0.05, 4), iron, x, y + 0.06, z, Math.PI / 4);
          glows.push({ pos: new THREE.Vector3(x, y, z + 0.1), size: 0.34 });
        };
        const barrel = (x: number, z: number, r = 0.08, h = 0.18) => {
          add(new THREE.CylinderGeometry(r, r, h, 8), wood, x, h / 2, z);
          for (const y of [h * 0.25, h * 0.75]) add(new THREE.CylinderGeometry(r + 0.004, r + 0.004, 0.02, 8), timber, x, y, z);
        };
        /** A stack of logs with their ends to the front, `rows` high, `rows` across at the bottom. */
        const logs = (x: number, z: number, rows: number) => {
          for (let r = 0; r < rows; r++) {
            const n = rows - r;
            for (let i = 0; i < n; i++) add(new THREE.CylinderGeometry(0.034, 0.034, 0.2, 6), lambert((i + r) % 2 ? "#8a5f36" : "#9a6a3c"), x + (i - (n - 1) / 2) * 0.072, 0.036 + r * 0.062, z).rotation.x = Math.PI / 2;
          }
        };
        const flowerBox = (x: number, y: number, z: number, w: number, bloom: string) => {
          add(box(w, 0.055, 0.075), wood, x, y, z);
          add(box(w - 0.04, 0.035, 0.055), lambert("#4f8a3a"), x, y + 0.04, z);
          for (let i = 0; i < 3; i++) add(box(0.04, 0.04, 0.04), lambert(bloom), x + (i - 1) * (w / 3.4), y + 0.07, z + 0.008);
        };

        if (tier === 1) {
          // The Shack: rough planks on a stone footing, a plank door, one shuttered window, a stovepipe through the roof,
          // a lantern by the door, a woodpile and a barrel.
          add(box(0.84, 0.07, 0.64), footing, 0, 0.035, 0);
          add(box(0.76, 0.44, 0.56), plank, 0, 0.29, 0);
          for (let i = -3; i <= 3; i++) add(box(0.012, 0.42, 0.01), timber, i * 0.11, 0.29, 0.282);
          for (const x of [-0.385, 0.385]) for (const z of [-0.285, 0.285]) add(box(0.05, 0.46, 0.05), timber, x, 0.3, z);
          add(box(0.8, 0.03, 0.6), timber, 0, 0.515, 0);
          gable(0, 0.51, 0, 0.76, 0.4, 0.26, false, plank);
          shingles(0, 0.51, 0.76, 0.4, 0.26, 0.15);
          add(box(0.2, 0.36, 0.02), timber, -0.16, 0.25, 0.288);
          add(box(0.16, 0.32, 0.02), doorMat, -0.16, 0.23, 0.298);
          add(box(0.14, 0.012, 0.01), iron, -0.16, 0.34, 0.31);
          add(box(0.14, 0.012, 0.01), iron, -0.16, 0.16, 0.31);
          add(box(0.03, 0.03, 0.02), brass, -0.1, 0.23, 0.312);
          add(box(0.26, 0.04, 0.1), footing, -0.16, 0.02, 0.35);
          framed(0.2, 0.34, 0.14, 0.14, 0.286, true);
          add(box(0.2, 0.025, 0.07), wood, 0.2, 0.25, 0.31);
          add(new THREE.CylinderGeometry(0.03, 0.03, 0.24, 6), iron, 0.24, 0.76, -0.08);
          add(new THREE.ConeGeometry(0.05, 0.04, 6), iron, 0.24, 0.9, -0.08);
          g.userData.smoke = new THREE.Vector3(0.24, 0.96, -0.08);
          add(box(0.03, 0.02, 0.1), iron, -0.34, 0.42, 0.34);
          lantern(-0.34, 0.37, 0.38);
          logs(-0.56, 0.1, 3);
          barrel(0.54, 0.22);
        } else if (tier === 2) {
          // The Cottage: a stone ground course under plaster and dark timbers, a steep shingled roof with a dormer over
          // the door, a stone chimney, shuttered windows with flower boxes, a lantern, a path and a woodpile.
          add(box(1.06, 0.08, 0.78), footing, 0, 0.04, 0);
          add(box(1.0, 0.2, 0.72), stone, 0, 0.18, 0);
          add(box(1.02, 0.04, 0.74), timber, 0, 0.28, 0);
          add(box(0.98, 0.34, 0.7), plaster, 0, 0.47, 0);
          add(box(1.04, 0.04, 0.76), timber, 0, 0.65, 0);
          for (const x of [-0.49, 0.49]) for (const z of [-0.35, 0.35]) add(box(0.06, 0.58, 0.06), timber, x, 0.37, z);
          for (const x of [-0.16, 0.16]) for (const z of [-0.355, 0.355]) add(box(0.04, 0.34, 0.015), timber, x, 0.47, z);
          for (const x of [-0.505, 0.505]) for (const tilt of [-0.5, 0.5]) add(box(0.015, 0.04, 0.42), timber, x, 0.47, 0).rotation.x = tilt;
          // The door in a timber frame, a step, and a stepping-stone path.
          add(box(0.26, 0.5, 0.03), timber, 0, 0.33, 0.358);
          add(box(0.2, 0.44, 0.03), doorMat, 0, 0.3, 0.366);
          add(box(0.2, 0.012, 0.012), iron, 0, 0.44, 0.384);
          add(box(0.2, 0.012, 0.012), iron, 0, 0.2, 0.384);
          add(box(0.03, 0.03, 0.02), brass, 0.06, 0.3, 0.386);
          add(box(0.36, 0.04, 0.12), footing, 0, 0.02, 0.45);
          for (const [x, z, w] of [[0.02, 0.58, 0.2], [-0.03, 0.72, 0.18]] as [number, number, number][]) add(box(w, 0.02, 0.1), footing, x, 0.01, z);
          for (const x of [-0.32, 0.32]) {
            framed(x, 0.5, 0.2, 0.18, 0.355, true);
            flowerBox(x, 0.35, 0.39, 0.26, x < 0 ? "#d0473a" : "#e8c53a");
          }
          // The roof, with a gabled dormer standing out of the front slope and a window in it.
          gable(0, 0.65, 0, 0.98, 0.46, 0.32, false, plaster);
          shingles(0, 0.65, 0.98, 0.46, 0.32, 0.2);
          gable(0, 0.65, 0.24, 0.4, 0.17, 0.17, true, plaster);
          add(box(0.07, 0.06, 0.46), roofDark, 0, 0.65 + 0.19, 0.24);
          framed(0, 0.74, 0.1, 0.09, 0.446);
          for (const x of [-0.49, 0.49]) {
            add(box(0.014, 0.12, 0.12), timber, x * 1.02, 0.78, 0);
            add(box(0.012, 0.09, 0.09), glass, x * 1.02 + Math.sign(x) * 0.006, 0.78, 0).userData.glow = true;
          }
          chimney(0.33, -0.12, 0.6, 1.14, 0.17);
          lantern(0.47, 0.36, 0.43);
          add(box(0.03, 0.02, 0.08), iron, 0.47, 0.42, 0.4);
          logs(-0.66, 0.1, 3);
          barrel(0.66, 0.2);
          barrel(0.6, 0.34, 0.07, 0.15);
        } else {
          // The Lodge: a long hall of stone and timbered plaster under a tall roof, a gabled porch on posts, two dormers,
          // a big stone chimney, a lower wing to the west with a window in its gable, a picket fence, barrels, lanterns,
          // and a banner in the roof's colour flying from the ridge.
          const ox = 0.24;
          add(box(1.28, 0.08, 0.86), footing, ox, 0.04, 0);
          add(box(1.22, 0.26, 0.8), stone, ox, 0.21, 0);
          add(box(1.24, 0.04, 0.82), timber, ox, 0.34, 0);
          add(box(1.2, 0.32, 0.78), plaster, ox, 0.52, 0);
          add(box(1.26, 0.04, 0.84), timber, ox, 0.68, 0);
          for (const dx of [-0.6, 0.6]) for (const z of [-0.39, 0.39]) add(box(0.07, 0.6, 0.07), timber, ox + dx, 0.38, z);
          for (const dx of [-0.38, -0.12, 0.38]) for (const z of [-0.395, 0.395]) add(box(0.045, 0.32, 0.015), timber, ox + dx, 0.52, z);
          for (const tilt of [-0.55, 0.55]) add(box(0.015, 0.04, 0.44), timber, ox + 0.615, 0.52, 0).rotation.x = tilt;
          // The door under the porch, and a window either side of it, shuttered, with flower boxes.
          add(box(0.28, 0.46, 0.03), timber, ox, 0.31, 0.398);
          add(box(0.22, 0.4, 0.03), doorMat, ox, 0.28, 0.406);
          add(box(0.22, 0.012, 0.012), iron, ox, 0.4, 0.424);
          add(box(0.22, 0.012, 0.012), iron, ox, 0.18, 0.424);
          add(box(0.03, 0.03, 0.02), brass, ox + 0.07, 0.28, 0.426);
          for (const [dx, bloom] of [[-0.4, "#d0473a"], [0.4, "#e8c53a"]] as [number, string][]) {
            framed(ox + dx, 0.5, 0.2, 0.17, 0.395, true);
            flowerBox(ox + dx, 0.37, 0.43, 0.26, bloom);
          }
          // The porch: a plank floor, two posts, and a little gabled roof of its own, with a lantern under it.
          add(box(0.52, 0.03, 0.4), lambert("#8a6a44"), ox, 0.095, 0.6);
          for (const dx of [-0.21, 0.21]) add(box(0.05, 0.36, 0.05), timber, ox + dx, 0.28, 0.76);
          gable(ox, 0.46, 0.58, 0.4, 0.27, 0.15, true, plaster);
          add(box(0.06, 0.05, 0.42), roofDark, ox, 0.46 + 0.16, 0.58);
          add(box(0.46, 0.05, 0.06), timber, ox, 0.44, 0.77);
          add(box(0.03, 0.04, 0.1), iron, ox + 0.14, 0.4, 0.72);
          lantern(ox + 0.14, 0.34, 0.74);
          add(box(0.38, 0.04, 0.14), footing, ox, 0.03, 0.88);
          // The main roof, with two dormers.
          gable(ox, 0.68, 0, 1.2, 0.52, 0.46, false, plaster);
          shingles(ox, 0.68, 1.2, 0.52, 0.46, 0.26);
          for (const dx of [-0.34, 0.34]) {
            gable(ox + dx, 0.68, 0.28, 0.4, 0.18, 0.18, true, plaster);
            add(box(0.06, 0.05, 0.44), roofDark, ox + dx, 0.68 + 0.2, 0.28);
            framed(ox + dx, 0.76, 0.12, 0.1, 0.486);
          }
          add(box(0.014, 0.14, 0.14), timber, ox + 0.61, 0.82, 0);
          add(box(0.012, 0.1, 0.1), glass, ox + 0.616, 0.82, 0).userData.glow = true;
          glows.push({ pos: new THREE.Vector3(ox + 0.75, 0.82, 0), size: 0.34 });
          chimney(ox + 0.4, -0.16, 0.7, 1.46, 0.2);
          // The banner: a pole on the ridge's end and a pennant in the roof's colour.
          add(new THREE.CylinderGeometry(0.014, 0.014, 0.4, 5), iron, ox + 0.5, 1.3, 0.02);
          add(box(0.22, 0.11, 0.012), roofMat, ox + 0.61, 1.4, 0.02);
          add(box(0.06, 0.11, 0.012), brass, ox + 0.73, 1.4, 0.02);
          // The wing: a lower, gabled hall to the west, end on to the front, with its own window.
          const wx = -0.62;
          add(box(0.56, 0.08, 0.66), footing, wx, 0.04, 0);
          add(box(0.5, 0.26, 0.6), stone, wx, 0.21, 0);
          add(box(0.52, 0.04, 0.62), timber, wx, 0.34, 0);
          add(box(0.48, 0.2, 0.58), plaster, wx, 0.45, 0);
          add(box(0.52, 0.04, 0.62), timber, wx, 0.56, 0);
          for (const x of [-0.25, 0.25]) for (const z of [-0.3, 0.3]) add(box(0.06, 0.48, 0.06), timber, wx + x, 0.32, z);
          framed(wx, 0.45, 0.2, 0.13, 0.292, true);
          gable(wx, 0.56, 0, 0.62, 0.27, 0.3, true, plaster);
          add(box(0.06, 0.05, 0.66), roofDark, wx, 0.56 + 0.31, 0);
          framed(wx, 0.7, 0.1, 0.1, 0.316);
          // A picket fence round a little garden in front of the wing.
          for (let i = 0; i < 6; i++) add(box(0.03, 0.12, 0.02), lambert("#e8dcc0"), wx - 0.25 + i * 0.1, 0.06, 0.6);
          add(box(0.56, 0.02, 0.015), lambert("#e8dcc0"), wx, 0.09, 0.6);
          for (const [dx, bloom] of [[-0.14, "#d0473a"], [0.0, "#e8c53a"], [0.14, "#c46bd0"]] as [number, string][]) {
            add(box(0.05, 0.05, 0.05), lambert("#4f8a3a"), wx + dx, 0.025, 0.46);
            add(box(0.04, 0.04, 0.04), lambert(bloom), wx + dx, 0.07, 0.46);
          }
          barrel(ox + 0.5, 0.58);
          barrel(ox + 0.64, 0.52, 0.07, 0.15);
          logs(wx - 0.02, -0.4, 3);
        }
        g.userData.glows = glows;
        g.userData.panes = panes;
        foldByLook(g);
        break;
      }
      case "pub": {
        // The pub: the warm heart of the town. A two-storey inn, bigger than any hut: a stone ground floor, a jettied
        // upper floor of cream plaster and dark timbers under a steep gabled roof, windows that warm and glow as the
        // light goes, a painted sign on a bracket, a lantern, and barrels and a bench out front.
        const timber = lambert("#4a2f22");
        const plaster = lambert("#e8d9b5");
        const stone = lambert("#a8977a");
        const roofMat = lambert("#7a3a2c");
        const glows: BuildingGlow[] = [];
        const panes: THREE.MeshBasicMaterial[] = [];
        /** A window's glass: dim amber by day, lamplit by night. */
        const pane = (unlit: string, lit: string) => {
          const m = warmPane(unlit, lit);
          panes.push(m);
          return m;
        };
        const lowerGlass = pane("#c99a52", "#ffd98a");
        const upperGlass = pane("#b98a4a", "#ffc870");
        /** A framed window on the front, with a cross of glazing bars. */
        const framed = (x: number, y: number, w: number, h: number, z: number, glass: THREE.Material) => {
          add(box(w + 0.05, h + 0.05, 0.012), timber, x, y, z);
          add(box(w, h, 0.01), glass, x, y, z + 0.008).userData.glow = true;
          add(box(0.02, h, 0.012), timber, x, y, z + 0.014);
          add(box(w, 0.02, 0.012), timber, x, y, z + 0.014);
          glows.push({ pos: new THREE.Vector3(x, y, z + 0.18), size: w * 2.2 });
        };

        // The ground floor: a stone plinth and stone walls.
        add(box(1.6, 0.08, 1.0), lambert("#7b8494"), 0, 0.04, 0);
        add(box(1.5, 0.46, 0.92), stone, 0, 0.31, 0);
        for (const x of [-0.48, 0.48]) {
          framed(x, 0.31, 0.26, 0.2, 0.46, lowerGlass);
          add(box(0.32, 0.03, 0.06), timber, x, 0.19, 0.48);
        }
        // The door: a red door in a timber frame, a lit fanlight over it, a brass handle and a stone step.
        add(box(0.3, 0.42, 0.02), timber, 0, 0.29, 0.465);
        add(box(0.22, 0.35, 0.03), lambert("#7a3a24"), 0, 0.255, 0.47);
        add(box(0.2, 0.035, 0.02), lowerGlass, 0, 0.472, 0.475).userData.glow = true;
        add(box(0.03, 0.03, 0.02), lambert("#e0b12e"), 0.07, 0.25, 0.49);
        add(box(0.4, 0.04, 0.12), lambert("#8b8f96"), 0, 0.02, 0.56);
        // A little gabled hood over the door on two brackets.
        const hood = add(box(0.46, 0.035, 0.24), roofMat, 0, 0.53, 0.57);
        hood.rotation.x = 0.35;
        for (const x of [-0.19, 0.19]) add(box(0.03, 0.03, 0.16), timber, x, 0.47, 0.52).rotation.x = -0.75;

        // The jettied upper floor: a beam, cream plaster, and a frame of dark timbers.
        add(box(1.62, 0.07, 1.04), timber, 0, 0.575, 0);
        add(box(1.58, 0.38, 1.0), plaster, 0, 0.8, 0);
        add(box(1.64, 0.05, 1.04), timber, 0, 1.0, 0);
        for (const x of [-0.79, 0.79]) for (const z of [-0.5, 0.5]) add(box(0.06, 0.38, 0.06), timber, x, 0.8, z);
        for (const x of [-0.25, 0.25]) for (const z of [-0.505, 0.505]) add(box(0.05, 0.38, 0.02), timber, x, 0.8, z);
        for (const x of [-0.795, 0.795]) add(box(0.02, 0.38, 0.05), timber, x, 0.8, 0);
        // A cross brace in the middle bay, front and back.
        for (const z of [-0.507, 0.507]) for (const tilt of [-0.66, 0.66]) add(box(0.56, 0.04, 0.015), timber, 0, 0.8, z).rotation.z = tilt;
        // Two windows upstairs, each with a box of flowers under it.
        for (const [x, bloom] of [[-0.52, "#d0473a"], [0.52, "#e8c53a"]] as [number, string][]) {
          framed(x, 0.82, 0.22, 0.18, 0.5, upperGlass);
          add(box(0.28, 0.06, 0.08), lambert("#6b4a2b"), x, 0.68, 0.54);
          add(box(0.24, 0.04, 0.06), lambert("#4f8a3a"), x, 0.725, 0.54);
          for (const dx of [-0.08, 0, 0.08]) add(box(0.04, 0.04, 0.04), lambert(bloom), x + dx, 0.755, 0.55 + (dx === 0 ? 0.01 : 0));
        }

        // The roof: a long gabled roof with eaves that overhang all round, and a smaller gable over the door,
        // standing out of the front slab, with a lit window in it.
        const eaves = 1.02;
        /** A gabled roof: a plaster prism `len` long, `half` out to each eave and `rise` high, under two overhanging slabs. Its ridge runs along x, or along z with `alongZ`. */
        const gabled = (cx: number, cz: number, len: number, half: number, rise: number, alongZ: boolean) => {
          const shape = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]);
          const prism = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false }).translate(0, 0, -len / 2);
          if (!alongZ) prism.rotateY(Math.PI / 2);
          add(prism, plaster, cx, eaves, cz);
          const pitch = Math.atan2(rise, half);
          const slope = Math.hypot(rise, half) * 1.18;
          for (const side of [1, -1]) {
            // Half way down the slope, lifted half a slab's thickness off the gable.
            const along = slope / 2;
            const out = side * (along * Math.cos(pitch) + 0.03 * Math.sin(pitch));
            const y = eaves + rise - along * Math.sin(pitch) + 0.03 * Math.cos(pitch);
            if (alongZ) add(box(slope, 0.06, len + 0.1), roofMat, cx + out, y, cz).rotation.z = -side * pitch;
            else add(box(len + 0.2, 0.06, slope), roofMat, cx, y, cz + out).rotation.x = side * pitch;
          }
          return pitch;
        };
        const rise = 0.44;
        const pitch = gabled(0, 0, 1.56, 0.5, rise, false);
        // A darker course of shingles part way down each slope, and a ridge cap.
        for (const side of [1, -1]) {
          const d = 0.24;
          add(box(1.77, 0.065, 0.06), lambert("#5d2a20"), 0, eaves + rise - d * Math.sin(pitch) + 0.035 * Math.cos(pitch), side * (d * Math.cos(pitch) + 0.035 * Math.sin(pitch))).rotation.x = side * pitch;
        }
        add(box(1.82, 0.07, 0.1), lambert("#4a2018"), 0, eaves + rise + 0.03, 0);
        gabled(0, 0.32, 0.48, 0.32, 0.34, true);
        add(box(0.08, 0.06, 0.58), lambert("#4a2018"), 0, eaves + 0.37, 0.32);
        framed(0, eaves + 0.13, 0.16, 0.13, 0.565, upperGlass);
        // A small window in each end gable, under the peak.
        for (const x of [-0.785, 0.785]) {
          add(box(0.015, 0.14, 0.14), timber, x, eaves + 0.15, 0);
          add(box(0.012, 0.1, 0.1), upperGlass, x + Math.sign(x) * 0.006, eaves + 0.15, 0).userData.glow = true;
        }

        // The chimney stands proud of the roof, with a pot on top; its smoke is drawn by the ambience.
        add(box(0.22, 0.92, 0.22), lambert("#8b8f96"), 0.52, 1.36, -0.24);
        add(box(0.28, 0.06, 0.28), lambert("#6f737a"), 0.52, 1.83, -0.24);
        add(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 6), lambert("#b8643a"), 0.52, 1.9, -0.24);
        g.userData.smoke = new THREE.Vector3(0.52, 1.96, -0.24);

        // The sign: an iron bracket off the front corner, under the eaves, and a painted board hanging from it, face on to the street.
        const iron = lambert("#2b2a33");
        add(box(0.32, 0.03, 0.03), iron, 0.94, 0.6, 0.47);
        add(box(0.2, 0.025, 0.025), iron, 0.85, 0.54, 0.47).rotation.z = 0.6;
        for (const x of [0.84, 1.04]) add(box(0.012, 0.05, 0.012), iron, x, 0.565, 0.47);
        add(box(0.32, 0.28, 0.025), lambert("#3a2c22"), 0.94, 0.4, 0.47);
        const face = new THREE.MeshLambertMaterial({ map: pubSign() });
        add(new THREE.PlaneGeometry(0.3, 0.26), face, 0.94, 0.4, 0.484);
        add(new THREE.PlaneGeometry(0.3, 0.26), face, 0.94, 0.4, 0.456, Math.PI);

        // A lantern on a bracket by the door, lit at dusk.
        add(box(0.03, 0.03, 0.14), iron, -0.66, 0.5, 0.53);
        add(box(0.08, 0.02, 0.08), iron, -0.66, 0.485, 0.6);
        const flame = add(box(0.05, 0.07, 0.05), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), -0.66, 0.44, 0.6);
        flame.userData.glow = true;
        for (const [dx, dz] of [[-0.035, -0.035], [0.035, -0.035], [-0.035, 0.035], [0.035, 0.035]]) add(box(0.012, 0.09, 0.012), iron, -0.66 + dx, 0.44, 0.6 + dz);
        add(new THREE.ConeGeometry(0.06, 0.05, 4), iron, -0.66, 0.51, 0.6, Math.PI / 4);
        glows.push({ pos: new THREE.Vector3(-0.66, 0.44, 0.72), size: 0.42, light: "candle" });
        // The lamplight spilling out of the front, onto the street: held high and well out, so a hero at the door
        // is lit evenly rather than with a hot spot.
        glows.push({ pos: new THREE.Vector3(0, 1.1, 1.4), size: 0, light: "lamp" });

        // Barrels by the lantern, and a bench under the sign with a tankard left on it.
        for (const [x, z] of [[-0.62, 0.68], [-0.42, 0.74]]) {
          add(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 8), lambert("#7a5230"), x, 0.11, z);
          for (const y of [0.05, 0.17]) add(new THREE.CylinderGeometry(0.104, 0.104, 0.02, 8), timber, x, y, z);
        }
        add(box(0.4, 0.035, 0.11), lambert("#8a6a44"), 0.52, 0.15, 0.62);
        for (const x of [0.36, 0.68]) add(box(0.04, 0.13, 0.08), timber, x, 0.065, 0.62);
        add(new THREE.CylinderGeometry(0.025, 0.025, 0.05, 6), lambert("#d08a3a"), 0.6, 0.193, 0.62);
        add(new THREE.CylinderGeometry(0.026, 0.026, 0.012, 6), lambert("#f4efe1"), 0.6, 0.223, 0.62);
        g.userData.glows = glows;
        g.userData.panes = panes;
        foldByLook(g);
        break;
      }
      case "shoals": {
        // The Shoals table: a low square table under a sea-blue cloth, with a few markers on it and a stool for each of the four who can play.
        add(box(0.7, 0.36, 0.7), lambert("#6b4a2b"), 0, 0.18, -0.3, Math.PI / 4);
        add(box(0.82, 0.05, 0.82), lambert("#2f6f8c"), 0, 0.385, -0.3, Math.PI / 4);
        for (const [x, z] of GAME_STOOLS) add(new THREE.CylinderGeometry(0.14, 0.12, 0.24, 6), lambert("#5a3d22"), x, 0.12, z);
        add(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 8), lambert("#7db6f2"), -0.16, 0.43, -0.28);
        add(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 8), lambert("#d9b45a"), 0.14, 0.43, -0.4);
        add(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 8), lambert("#6b4a2b"), 0.04, 0.45, -0.16);
        break;
      }
      case "cave": {
        // The Haunted Caverns' mouth in the back wall: a heap of dark rock with a way in cut into it, framed in stone,
        // and a torch burning either side.
        const rock = lambert("#3d4048");
        const pale = lambert("#565a63");
        const stone = lambert("#4a4d55");
        // The heap, set back behind the entrance so none of it stands in the way in.
        add(new THREE.DodecahedronGeometry(0.74, 0), rock, 0, 0.46, -1.0, 0.3);
        add(new THREE.ConeGeometry(0.44, 1.15, 5), pale, -0.76, 0.5, -0.42, 0.8);
        add(new THREE.ConeGeometry(0.38, 1.0, 5), rock, 0.76, 0.44, -0.46, 1.7);
        // The way in (caveDressing.ts): an arched tunnel going back into the rock, dark, darkest at its back.
        g.add(caveMouth(MOUTH_FACE));
        // Framed in the stone, so it is a hole in the rock from any side: rough jambs either side, a lintel over it.
        for (const side of [-1, 1]) {
          // Stood square to the face (turned, a long stone would swing across the way in).
          const jamb = add(new THREE.DodecahedronGeometry(0.24, 0), side < 0 ? stone : rock, side * 0.45, 0.3, 0.08, side * 0.12);
          jamb.scale.set(0.8, 1.55, 1.3);
          // And a stone at each foot, half sunk.
          add(new THREE.DodecahedronGeometry(0.1, 0), pale, side * 0.48, 0.03, 0.38, side * 1.3).scale.set(1.2, 0.7, 1);
        }
        const lintel = add(new THREE.DodecahedronGeometry(0.26, 0), stone, 0, 0.7, 0.06, 0.08);
        lintel.scale.set(1.85, 0.7, 1.3);
        // A torch burning on a stake either side, clear of the frame (real flames, flickered with the others), and a
        // halo and warm light round each at dusk.
        const glows: BuildingGlow[] = [];
        for (const x of [-0.6, 0.6]) {
          const torch = mouthTorch();
          torch.position.set(x, 0, MOUTH_FACE + 0.12);
          g.add(torch);
          glows.push({ pos: new THREE.Vector3(x, 0.66, MOUTH_FACE + 0.12), size: 0.3, light: "candle" });
        }
        g.userData.glows = glows;
        // And the rope out of the dark: the far end of the one that hangs down inside, tied round a boulder out front.
        g.add(mouthRope(MOUTH_FACE));
        break;
      }
      case "rocks": {
        // Black rocks standing out of the sea, wet and sharp.
        const rock = lambert("#3d4048");
        const pale = lambert("#565a63");
        add(new THREE.ConeGeometry(0.42, 0.9, 5), rock, -0.15, 0.3, 0.05, 0.4);
        add(new THREE.ConeGeometry(0.3, 0.6, 4), pale, 0.4, 0.18, -0.2, 1.1);
        add(new THREE.DodecahedronGeometry(0.26, 0), rock, 0.15, 0.02, 0.45, 0.7);
        add(new THREE.ConeGeometry(0.18, 0.4, 4), pale, -0.55, 0.08, -0.3, 2);
        break;
      }
      case "wreck": {
        // A ship that did not make the harbour: the hull broken-backed on the rocks, ribs showing, the mast gone over the side.
        const hull = lambert("#4a3526");
        const dark = lambert("#33241a");
        const stern = add(box(1.1, 0.5, 0.62), hull, -0.35, 0.16, 0.0);
        stern.rotation.set(0.1, 0.25, -0.32);
        const bow = add(box(0.9, 0.42, 0.56), hull, 0.75, 0.02, 0.22);
        bow.rotation.set(-0.12, -0.3, 0.38);
        const deck = add(box(1.0, 0.05, 0.5), lambert("#6b5138"), -0.36, 0.44, 0.0);
        deck.rotation.copy(stern.rotation);
        for (let i = 0; i < 4; i++) add(box(0.05, 0.42, 0.05), dark, 0.18 + i * 0.13, 0.18 + i * 0.02, -0.26 + (i % 2) * 0.5).rotation.z = 0.2 + i * 0.12;
        const mast = add(new THREE.CylinderGeometry(0.045, 0.06, 1.7, 5), dark, -0.5, 0.75, 0.05);
        mast.rotation.z = -0.95;
        const yard = add(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 4), dark, -1.0, 1.02, 0.05);
        yard.rotation.x = Math.PI / 2;
        const rag = add(box(0.03, 0.4, 0.55), lambert("#b9b3a3"), -1.0, 0.82, 0.05);
        rag.rotation.z = 0.25;
        add(new THREE.ConeGeometry(0.34, 0.7, 5), lambert("#3d4048"), 0.25, 0.18, -0.55, 0.6);
        add(new THREE.DodecahedronGeometry(0.24, 0), lambert("#565a63"), -0.9, 0.0, 0.5, 0.3);
        break;
      }
      case "trader": {
        // Where a customer stands to trade with a traveling salesman: a mat of wares laid out toward the corner.
        add(box(0.34, 0.03, 0.62), lambert("#7a3a5a"), 0.52, 0.015, 0);
        add(box(0.34, 0.01, 0.06), lambert("#e0b12e"), 0.52, 0.035, 0.26);
        add(box(0.1, 0.1, 0.1), lambert("#b98b5a"), 0.48, 0.08, -0.16, 0.5);
        add(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 6), lambert("#3f7fb8"), 0.58, 0.1, 0.08);
        add(box(0.12, 0.03, 0.08), lambert("#e8dcc0"), 0.46, 0.05, 0.14, 0.3);
        break;
      }
      case "counter": {
        // The menu board, on a post where customers stand to order.
        add(box(0.05, 0.7, 0.05), lambert("#5a3d22"), 0.55, 0.35, -0.1);
        add(box(0.5, 0.36, 0.04), lambert("#2c2a3a"), 0.55, 0.78, -0.1);
        for (let i = 0; i < 4; i++) add(box(0.34, 0.03, 0.01), new THREE.MeshBasicMaterial({ color: "#e8dcc0" }), 0.55, 0.9 - i * 0.08, -0.075);
        break;
      }
      case "shop": {
        // The market stall: a plank platform, a counter with a cloth runner and the day's goods on it (a crate of apples,
        // a balance and a stack of coin, a sack of grain), a shelved back wall of jars and bolts of cloth, a striped
        // awning with a scalloped edge on four poles, lanterns, a coin sign, and crates and a barrel stacked at the sides.
        const timber = lambert("#4a2f22");
        const wood = lambert("#7a5230");
        const plank = lambert("#a07a4c");
        const brass = lambert("#e0b12e");
        const iron = lambert("#2b2a33");
        const red = lambert("#b9433d");
        const cream = lambert("#f4efe1");
        const glows: BuildingGlow[] = [];
        add(box(1.5, 0.04, 0.95), lambert("#6b5138"), 0, 0.02, 0.05);
        for (let i = -3; i <= 3; i++) add(box(0.012, 0.006, 0.95), timber, i * 0.2, 0.043, 0.05);
        // The counter: a plank front, a top slab, and a red cloth runner down the middle.
        add(box(1.0, 0.3, 0.36), wood, 0, 0.19, 0.18);
        for (let i = -4; i <= 4; i++) add(box(0.01, 0.28, 0.01), timber, i * 0.11, 0.19, 0.364);
        add(box(1.06, 0.04, 0.42), plank, 0, 0.36, 0.18);
        add(box(0.9, 0.01, 0.3), red, 0, 0.385, 0.18);
        add(box(0.9, 0.12, 0.012), red, 0, 0.27, 0.372);
        for (let i = 0; i < 9; i++) add(new THREE.ConeGeometry(0.05, 0.06, 4), red, -0.4 + i * 0.1, 0.18, 0.372, Math.PI / 4).rotation.x = Math.PI;
        // Four poles, the back two taller so the awning slopes down to the front.
        for (const x of [-0.52, 0.52]) {
          add(new THREE.CylinderGeometry(0.03, 0.03, 0.96, 6), timber, x, 0.52, 0.38);
          add(new THREE.CylinderGeometry(0.03, 0.03, 1.12, 6), timber, x, 0.6, -0.2);
        }
        // The back wall and its two shelves.
        add(box(1.04, 0.6, 0.03), lambert("#5e4026"), 0, 0.72, -0.2);
        add(box(1.1, 0.04, 0.05), timber, 0, 1.1, -0.2);
        for (const y of [0.5, 0.78]) add(box(0.96, 0.025, 0.16), plank, 0, y, -0.12);
        const jar = (x: number, y: number, c: string) => {
          add(new THREE.CylinderGeometry(0.034, 0.034, 0.09, 6), lambert(c), x, y + 0.05, -0.12);
          add(new THREE.CylinderGeometry(0.036, 0.036, 0.016, 6), lambert("#c9a877"), x, y + 0.104, -0.12);
        };
        ["#c4473a", "#e0b12e", "#5f9e4a", "#3f7fb8", "#d9843a", "#8a5fb0", "#c4473a", "#5f9e4a"].forEach((c, i) => jar(-0.4 + i * 0.115, 0.5125, c));
        // Bolts of cloth lying on the top shelf, and a few more jars.
        [["#3f6fa8", -0.38], ["#b9433d", -0.2], ["#e8dcc0", -0.02]].forEach(([c, x], i) => add(box(0.16, 0.06 + (i % 2) * 0.02, 0.1), lambert(c as string), x as number, 0.8 + (0.06 + (i % 2) * 0.02) / 2, -0.12));
        for (let i = 0; i < 3; i++) jar(0.16 + i * 0.12, 0.7925, ["#e0b12e", "#5f9e4a", "#c4473a"][i]);
        // The striped awning, sloping forward, with a scalloped edge of diamonds along the front.
        const pitch = Math.atan2(0.14, 0.58);
        for (let i = 0; i < 6; i++) {
          const c = i % 2 ? cream : red;
          add(box(0.18, 0.04, 0.66), c, -0.45 + i * 0.18, 1.06, 0.09).rotation.x = pitch;
          add(box(0.12, 0.12, 0.02), c, -0.45 + i * 0.18, 0.94, 0.41).rotation.z = Math.PI / 4;
        }
        add(box(1.12, 0.025, 0.025), timber, 0, 0.98, 0.39);
        // The goods on the counter: a crate of apples, a balance and a stack of coin, and a sack of grain.
        add(box(0.28, 0.09, 0.2), wood, -0.32, 0.43, 0.2);
        add(box(0.24, 0.02, 0.16), lambert("#6b4a2b"), -0.32, 0.47, 0.2);
        for (const [dx, dz, c] of [[-0.07, -0.04, "#c4473a"], [0.0, 0.03, "#d9843a"], [0.07, -0.03, "#c4473a"], [-0.02, -0.07, "#7ab04a"], [0.08, 0.05, "#c4473a"], [-0.08, 0.05, "#d9b45a"]] as [number, number, string][]) add(new THREE.SphereGeometry(0.036, 6, 5), lambert(c), -0.32 + dx, 0.5, 0.2 + dz);
        add(box(0.1, 0.02, 0.07), brass, 0.0, 0.405, 0.2);
        add(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 5), brass, 0.0, 0.49, 0.2);
        add(box(0.22, 0.012, 0.012), brass, 0.0, 0.57, 0.2).rotation.z = 0.12;
        for (const [x, y] of [[-0.11, 0.55], [0.11, 0.59]]) {
          add(new THREE.CylinderGeometry(0.045, 0.04, 0.01, 7), brass, x, y - 0.06, 0.2);
          add(box(0.006, 0.06, 0.006), iron, x, y - 0.03, 0.2);
        }
        for (let i = 0; i < 4; i++) add(new THREE.CylinderGeometry(0.03, 0.03, 0.012, 7), brass, 0.2, 0.395 + i * 0.013, 0.28);
        add(new THREE.CylinderGeometry(0.1, 0.12, 0.17, 7), lambert("#d8c7a0"), 0.36, 0.47, 0.2);
        add(new THREE.CylinderGeometry(0.075, 0.1, 0.03, 7), lambert("#d9b45a"), 0.36, 0.565, 0.2);
        // Lanterns on the front poles, lit at dusk.
        for (const x of [-0.58, 0.58]) {
          add(box(0.07, 0.02, 0.02), iron, x * 0.95, 0.86, 0.38);
          add(box(0.05, 0.065, 0.05), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), x, 0.78, 0.38).userData.glow = true;
          add(box(0.08, 0.015, 0.08), iron, x, 0.735, 0.38);
          add(new THREE.ConeGeometry(0.06, 0.05, 4), iron, x, 0.84, 0.38, Math.PI / 4);
          glows.push({ pos: new THREE.Vector3(x, 0.78, 0.46), size: 0.4 });
        }
        // A coin sign on a post to the right, facing the lane.
        add(box(0.04, 0.9, 0.04), timber, 0.74, 0.47, 0.34);
        add(box(0.04, 0.3, 0.28), timber, 0.74, 0.8, 0.34);
        add(box(0.045, 0.25, 0.23), lambert("#2c3a4a"), 0.74, 0.8, 0.34);
        add(new THREE.CylinderGeometry(0.075, 0.075, 0.012, 10), brass, 0.768, 0.8, 0.34).rotation.z = Math.PI / 2;
        // Crates stacked at the left, and a barrel and a leaning sack at the right.
        add(box(0.26, 0.2, 0.26), wood, -0.72, 0.14, 0.26);
        add(box(0.22, 0.16, 0.22), plank, -0.72, 0.32, 0.26, 0.4);
        add(box(0.2, 0.14, 0.2), wood, -0.7, 0.12, -0.06, 0.2);
        for (const [dx, dz] of [[-0.04, 0.02], [0.05, -0.03], [0.04, 0.05]]) add(new THREE.SphereGeometry(0.04, 6, 5), lambert("#7ab04a"), -0.7 + dx, 0.22, -0.06 + dz);
        add(new THREE.CylinderGeometry(0.09, 0.09, 0.2, 8), wood, 0.72, 0.14, -0.02);
        for (const y of [0.08, 0.2]) add(new THREE.CylinderGeometry(0.094, 0.094, 0.02, 8), timber, 0.72, y, -0.02);
        add(box(0.12, 0.17, 0.1), lambert("#d8c7a0"), 0.68, 0.125, -0.22, 0.4);
        g.userData.glows = glows;
        foldByLook(g);
        break;
      }
      case "ring": {
        // Sparring ring: four posts, a rope, and a straw dummy.
        for (const [x, z] of [[-0.55, -0.2], [0.55, -0.2], [-0.55, 0.6], [0.55, 0.6]]) add(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 5), lambert("#5a3d22"), x, 0.27, z);
        add(box(1.1, 0.04, 0.04), lambert("#e8dcc0"), 0, 0.45, -0.2);
        add(box(1.1, 0.04, 0.04), lambert("#e8dcc0"), 0, 0.45, 0.6);
        add(box(0.04, 0.04, 0.8), lambert("#e8dcc0"), -0.55, 0.45, 0.2);
        add(box(0.04, 0.04, 0.8), lambert("#e8dcc0"), 0.55, 0.45, 0.2);
        add(new THREE.CylinderGeometry(0.14, 0.18, 0.5, 6), lambert("#d9b45a"), 0.2, 0.3, 0.1);
        add(new THREE.SphereGeometry(0.13, 6, 5), lambert("#d9b45a"), 0.2, 0.66, 0.1);
        add(box(0.5, 0.06, 0.06), lambert("#7a5230"), 0.2, 0.45, 0.1);
        break;
      }
      case "fishing": {
        // The fish shack by the shore, kept to its own hex. A seafoam plank shack on a stone footing under a cedar-shingle roof, with a
        // carved fish for a sign on the ridge, a gull beside it and a smoking stovepipe. Its front is a serving hatch:
        // a counter of ice with the day's catch laid out, a striped awning on poles, a lantern, and the board where the
        // day's prices are chalked up. Fish dry on a line at one side over a brine barrel; crab pots under a net sit at the other, and buoys hang by the hatch.
        // A boardwalk runs from the hatch out to a jetty over the water, with a rod propped on it and a bucket.
        const timber = lambert("#4a2f22");
        const wood = lambert("#7a5230");
        const plank = lambert("#8a6a44");
        const deck = lambert("#9a7a52");
        const wall = lambert("#86a89d");
        const seam = lambert("#6a8b82");
        const trim = lambert("#f4efe1");
        const roofA = lambert("#7a4f3a");
        const roofB = lambert("#8f5f44");
        const stone = lambert("#8b95a5");
        const iron = lambert("#2b2a33");
        const rope = lambert("#c9a877");
        const blue = lambert("#3f6fa8");
        const red = lambert("#b9433d");
        const glows: BuildingGlow[] = [];
        const panes: THREE.MeshBasicMaterial[] = [];
        /** A fish lying along x: a flattened body, a tail fin and an eye-side belly stripe. */
        const fish = (x: number, y: number, z: number, c: string, len = 0.16, turn = 0) => {
          const body = add(new THREE.SphereGeometry(len / 2, 7, 5), lambert(c), x, y, z, turn);
          body.scale.set(1, 0.34, 0.42);
          const tail = add(new THREE.ConeGeometry(len * 0.2, len * 0.3, 4), lambert(c), x - Math.cos(turn) * len * 0.56, y, z + Math.sin(turn) * len * 0.56, turn);
          tail.rotation.z = -Math.PI / 2;
          tail.scale.set(1, 1, 0.3);
        };
        /** A fish hung by its tail from a line at `y`. */
        const hung = (x: number, y: number, z: number, c: string, len = 0.15) => {
          add(box(0.006, 0.04, 0.006), rope, x, y - 0.02, z);
          add(new THREE.ConeGeometry(len * 0.2, len * 0.28, 4), lambert(c), x, y - 0.06, z).scale.set(1, 1, 0.3);
          add(new THREE.SphereGeometry(len / 2, 6, 5), lambert(c), x, y - 0.06 - len * 0.55, z).scale.set(0.4, 1, 0.3);
        };

        // The shack: footing, plank walls with seams and corner posts, a cream trim board under the eaves.
        const sx = 0, sz = -0.4, sw = 0.9, sd = 0.44, top = 0.72;
        const front = sz + sd / 2;
        add(box(sw + 0.08, 0.1, sd + 0.08), stone, sx, 0.05, sz);
        add(box(sw, top - 0.1, sd), wall, sx, 0.1 + (top - 0.1) / 2, sz);
        for (let i = 0; i <= 10; i++) {
          const x = sx - sw / 2 + 0.04 + i * 0.082;
          // No seams across the hatch.
          if (Math.abs(x - sx) > 0.27) add(box(0.012, top - 0.12, 0.01), seam, x, 0.1 + (top - 0.1) / 2, front + 0.002);
        }
        for (let i = 0; i < 5; i++) for (const s of [-1, 1]) add(box(0.01, top - 0.12, 0.012), seam, sx + s * (sw / 2 + 0.002), 0.1 + (top - 0.1) / 2, sz - 0.16 + i * 0.08);
        for (const x of [-1, 1]) for (const z of [-1, 1]) add(box(0.05, top - 0.08, 0.05), trim, sx + x * (sw / 2), 0.1 + (top - 0.1) / 2, sz + z * (sd / 2));
        add(box(sw + 0.06, 0.04, sd + 0.06), trim, sx, top, sz);
        // The gabled roof, its ridge running along the front: plank gable ends, rows of shingles, a ridge board.
        const rise = 0.28, half = sd / 2 + 0.1;
        const gableShape = new THREE.Shape([new THREE.Vector2(-sd / 2, 0), new THREE.Vector2(sd / 2, 0), new THREE.Vector2(0, rise * (sd / 2) / half)]);
        const gable = add(new THREE.ExtrudeGeometry(gableShape, { depth: sw, bevelEnabled: false }), wall, sx - sw / 2, top + 0.02, sz, Math.PI / 2);
        gable.position.x = sx - sw / 2;
        const slope = Math.atan2(rise, half);
        const run = Math.hypot(rise, half);
        for (const s of [-1, 1]) {
          for (let row = 0; row < 4; row++) {
            const t = (row + 0.5) / 4;
            add(box(sw + 0.16, 0.035, run / 4 + 0.03), row % 2 ? roofA : roofB, sx, top + 0.04 + rise * (1 - t) + row * 0.004, sz + s * half * t).rotation.x = s * slope;
          }
        }
        add(box(sw + 0.18, 0.04, 0.06), timber, sx, top + 0.06 + rise, sz);
        // The stovepipe of the smoker, at the back.
        add(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 6), iron, sx + 0.3, top + 0.32, sz - 0.12);
        add(new THREE.ConeGeometry(0.06, 0.05, 6), iron, sx + 0.3, top + 0.5, sz - 0.12);
        g.userData.smoke = new THREE.Vector3(sx + 0.3, top + 0.56, sz - 0.12);
        // The sign on the ridge: a carved fish on two iron stays.
        for (const x of [-0.34, -0.1]) add(box(0.015, 0.1, 0.015), iron, sx + x, top + rise + 0.12, sz);
        const signFish = add(new THREE.SphereGeometry(0.2, 8, 6), lambert("#e08a3c"), sx - 0.22, top + rise + 0.25, sz);
        signFish.scale.set(1, 0.42, 0.16);
        const signTail = add(new THREE.ConeGeometry(0.1, 0.14, 4), lambert("#e08a3c"), sx - 0.46, top + rise + 0.25, sz);
        signTail.rotation.z = -Math.PI / 2;
        signTail.scale.set(1, 1, 0.16);
        add(box(0.1, 0.012, 0.07), lambert("#f2c14e"), sx - 0.2, top + rise + 0.25, sz).rotation.z = 0.1;
        add(new THREE.SphereGeometry(0.018, 5, 4), iron, sx - 0.09, top + rise + 0.275, sz + 0.03);
        // A gull on the ridge.
        add(new THREE.SphereGeometry(0.05, 6, 5), trim, sx + 0.14, top + rise + 0.13, sz).scale.set(1.3, 0.8, 0.8);
        add(new THREE.SphereGeometry(0.03, 6, 5), trim, sx + 0.2, top + rise + 0.18, sz);
        add(box(0.08, 0.02, 0.085), lambert("#a9b4ba"), sx + 0.11, top + rise + 0.145, sz);
        add(new THREE.ConeGeometry(0.01, 0.035, 4), lambert("#e0b12e"), sx + 0.24, top + rise + 0.175, sz).rotation.z = -Math.PI / 2;
        for (const z of [-0.015, 0.015]) add(box(0.006, 0.05, 0.006), lambert("#e0b12e"), sx + 0.14, top + rise + 0.09, sz + z);

        // The serving hatch: a dark opening that glows with lamplight at dusk, a cream frame, shelves of jars inside.
        const hx = sx, hw = 0.46;
        const inside = warmPane("#2a211c", "#f0b866");
        panes.push(inside);
        add(box(hw, 0.34, 0.012), inside, hx, 0.5, front + 0.002).userData.glow = true;
        add(box(hw + 0.06, 0.03, 0.03), trim, hx, 0.685, front + 0.01);
        for (const s of [-1, 1]) add(box(0.03, 0.36, 0.03), trim, hx + s * (hw / 2 + 0.015), 0.5, front + 0.01);
        add(box(hw - 0.06, 0.015, 0.02), timber, hx, 0.56, front + 0.012);
        ["#c4473a", "#e0b12e", "#dfeef2", "#5f9e4a", "#d9843a"].forEach((c, i) => add(new THREE.CylinderGeometry(0.022, 0.022, 0.06, 6), lambert(c), hx - 0.16 + i * 0.08, 0.6, front + 0.014));
        glows.push({ pos: new THREE.Vector3(hx, 0.5, front + 0.16), size: 0.7 });
        // The counter under it: a plank front, a top, a bed of ice, and the catch laid out with a crab among it.
        const cz = front + 0.11;
        add(box(hw + 0.12, 0.3, 0.2), wood, hx, 0.17, cz);
        for (let i = -3; i <= 3; i++) add(box(0.01, 0.28, 0.01), timber, hx + i * 0.085, 0.17, cz + 0.102);
        add(box(hw + 0.18, 0.035, 0.25), deck, hx, 0.335, cz);
        add(box(hw + 0.06, 0.03, 0.19), lambert("#dfeef2"), hx, 0.365, cz);
        for (const [dx, dz] of [[-0.2, 0.06], [-0.05, -0.06], [0.13, 0.07], [0.22, -0.05]]) add(new THREE.OctahedronGeometry(0.03), lambert("#f3fbfd"), hx + dx, 0.385, cz + dz, dx * 5);
        fish(hx - 0.16, 0.395, cz - 0.03, "#9fb3c4", 0.16, 0.25);
        fish(hx - 0.01, 0.395, cz + 0.04, "#c4473a", 0.15, -0.3);
        fish(hx + 0.12, 0.395, cz - 0.04, "#3d7a7a", 0.16, 0.15);
        fish(hx - 0.15, 0.395, cz + 0.06, "#d9b45a", 0.11, -0.1);
        add(new THREE.SphereGeometry(0.035, 6, 4), lambert("#d9643a"), hx + 0.21, 0.395, cz + 0.03).scale.set(1.2, 0.5, 1);
        for (const s of [-1, 1]) add(box(0.03, 0.012, 0.012), lambert("#d9643a"), hx + 0.21 + s * 0.05, 0.395, cz + 0.06, s * 0.6);
        // The awning: blue and cream stripes sloping out over the counter on two poles, with a scalloped edge.
        const pitch = Math.atan2(0.12, 0.32);
        for (const s of [-1, 1]) add(new THREE.CylinderGeometry(0.02, 0.02, 0.74, 5), timber, hx + s * (hw / 2 + 0.07), 0.37, front + 0.29);
        for (let i = 0; i < 6; i++) {
          const c = i % 2 ? trim : blue;
          const x = hx - 0.25 + i * 0.1;
          add(box(0.1, 0.025, 0.34), c, x, 0.8, front + 0.15).rotation.x = pitch;
          add(box(0.07, 0.07, 0.015), c, x, 0.725, front + 0.31).rotation.z = Math.PI / 4;
        }
        add(box(hw + 0.2, 0.02, 0.02), timber, hx, 0.75, front + 0.3);
        // A lantern hung from the awning's corner.
        const lx = hx + hw / 2 + 0.07, lz = front + 0.33;
        add(box(0.006, 0.07, 0.006), iron, lx, 0.69, lz);
        add(new THREE.ConeGeometry(0.045, 0.04, 4), iron, lx, 0.655, lz, Math.PI / 4);
        add(box(0.045, 0.06, 0.045), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), lx, 0.605, lz).userData.glow = true;
        add(box(0.06, 0.012, 0.06), iron, lx, 0.57, lz);
        glows.push({ pos: new THREE.Vector3(lx, 0.605, lz + 0.08), size: 0.4 });
        // The price board on the wall beside the hatch: slate in a frame, three chalked lines and a chalked fish.
        const bx = sx + 0.355;
        add(box(0.17, 0.34, 0.02), timber, bx, 0.46, front + 0.012);
        add(box(0.14, 0.3, 0.02), lambert("#22302a"), bx, 0.46, front + 0.018);
        for (let i = 0; i < 3; i++) add(box(0.1 - i * 0.02, 0.016, 0.01), lambert("#e8e4d8"), bx - 0.01 * i, 0.47 - i * 0.055, front + 0.03);
        add(new THREE.SphereGeometry(0.03, 6, 4), lambert("#e8e4d8"), bx + 0.01, 0.56, front + 0.026).scale.set(1, 0.45, 0.1);
        add(box(0.03, 0.03, 0.006), lambert("#e8e4d8"), bx - 0.03, 0.56, front + 0.03).rotation.z = Math.PI / 4;

        // The drying line at the east end: two posts, a rope, and the catch hung up by the tail.
        const dx0 = sx + sw / 2 + 0.07, dx1 = dx0 + 0.3, dz = sz + 0.18;
        for (const x of [dx0, dx1]) add(new THREE.CylinderGeometry(0.022, 0.028, 0.7, 5), timber, x, 0.35, dz);
        add(box(dx1 - dx0, 0.01, 0.01), rope, (dx0 + dx1) / 2, 0.66, dz);
        hung(dx0 + 0.05, 0.66, dz, "#9fb3c4", 0.16);
        hung(dx0 + 0.12, 0.66, dz, "#c98a5a", 0.13);
        hung(dx0 + 0.19, 0.66, dz, "#a9b4ba", 0.17);
        hung(dx0 + 0.25, 0.66, dz, "#c98a5a", 0.12);
        // A brine barrel and a coil of rope beneath it.
        add(new THREE.CylinderGeometry(0.1, 0.09, 0.24, 8), wood, dx0 + 0.13, 0.12, dz + 0.24);
        for (const y of [0.06, 0.19]) add(new THREE.CylinderGeometry(0.104, 0.104, 0.02, 8), iron, dx0 + 0.13, y, dz + 0.24);
        add(new THREE.CylinderGeometry(0.085, 0.085, 0.01, 8), lambert("#4f7f8c"), dx0 + 0.13, 0.243, dz + 0.24);
        for (const [r, y] of [[0.085, 0.02], [0.075, 0.05]]) add(new THREE.TorusGeometry(r, 0.02, 4, 10), rope, dx0 + 0.22, y, dz + 0.46).rotation.x = Math.PI / 2;

        // The west end: crab pots stacked with a net thrown over them and its cork floats, and buoys hung on the front
        // wall beside the hatch.
        const px = sx - sw / 2 - 0.17;
        const pot = (x: number, y: number, z: number, turn: number) => {
          add(box(0.22, 0.14, 0.18), lambert("#5e4630"), x, y, z, turn);
          add(box(0.23, 0.02, 0.19), rope, x, y + 0.07, z, turn);
          add(box(0.23, 0.02, 0.19), rope, x, y - 0.06, z, turn);
          for (const s of [-1, 0, 1]) add(box(0.015, 0.14, 0.185), plank, x + s * 0.085 * Math.cos(turn), y, z - s * 0.085 * Math.sin(turn), turn);
        };
        pot(px, 0.08, sz + 0.26, 0.15);
        pot(px + 0.02, 0.23, sz + 0.26, -0.2);
        pot(px - 0.01, 0.08, sz + 0.04, -0.1);
        const net = lambert("#4f6b62");
        add(box(0.2, 0.012, 0.2), net, px - 0.01, 0.158, sz + 0.04, 0.5);
        add(box(0.012, 0.15, 0.2), net, px - 0.125, 0.085, sz + 0.04, -0.1).rotation.z = -0.12;
        for (let i = 0; i < 4; i++) add(new THREE.SphereGeometry(0.02, 5, 4), lambert("#d9a066"), px - 0.1 + i * 0.06, 0.17, sz + 0.13 - i * 0.02);
        [["#c4473a", 0.5], ["#f2c14e", 0.4], ["#3f6fa8", 0.47]].forEach(([c, y], i) => {
          const x = sx - 0.4 + i * 0.065;
          add(box(0.006, 0.64 - (y as number), 0.006), rope, x, (0.64 + (y as number)) / 2, front + 0.02);
          add(new THREE.SphereGeometry(0.036, 6, 5), lambert(c as string), x, (y as number) - 0.03, front + 0.035).scale.set(0.8, 1.3, 0.8);
          add(new THREE.CylinderGeometry(0.03, 0.03, 0.018, 6), trim, x, (y as number) - 0.03, front + 0.035);
        });
        add(box(0.2, 0.02, 0.02), timber, sx - 0.335, 0.65, front + 0.02);

        // The boardwalk from the hatch to the jetty, and the jetty out over the water on four posts with rope collars.
        add(box(0.66, 0.03, 0.46), plank, 0, 0.015, 0.04);
        for (let i = 0; i < 5; i++) add(box(0.66, 0.006, 0.012), timber, 0, 0.032, -0.14 + i * 0.09);
        add(box(0.56, 0.06, 1.04), plank, 0, 0.03, 0.77);
        for (let i = 0; i < 10; i++) add(box(0.56, 0.006, 0.012), timber, 0, 0.062, 0.3 + i * 0.1);
        for (const z of [0.75, 1.24]) for (const x of [-0.26, 0.26]) {
          add(new THREE.CylinderGeometry(0.045, 0.045, 0.72, 6), timber, x, -0.14, z);
          add(new THREE.CylinderGeometry(0.052, 0.052, 0.04, 6), rope, x, 0.13, z);
          add(new THREE.CylinderGeometry(0.03, 0.045, 0.03, 6), lambert("#6b5138"), x, 0.235, z);
        }
        // A lantern on the far post, to fish by after dark.
        add(box(0.045, 0.06, 0.045), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), -0.26, 0.285, 1.24).userData.glow = true;
        add(new THREE.ConeGeometry(0.045, 0.035, 4), iron, -0.26, 0.332, 1.24, Math.PI / 4);
        glows.push({ pos: new THREE.Vector3(-0.26, 0.285, 1.3), size: 0.4 });
        // The rod propped on a forked rest with its line in the sea and a red float, a bucket with a fish in it, and a tackle box.
        add(box(0.02, 0.2, 0.02), timber, 0.1, 0.16, 1.02);
        add(new THREE.CylinderGeometry(0.02, 0.03, 1.2, 5), rope, 0.1, 0.5, 1.3).rotation.x = Math.PI / 4;
        add(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 6), lambert("#e0b12e"), 0.13, 0.25, 1.02).rotation.z = Math.PI / 2;
        add(box(0.012, 0.95, 0.012), trim, 0.1, 0.44, 1.72);
        add(new THREE.OctahedronGeometry(0.06), red, 0.1, -0.02, 1.72);
        add(new THREE.CylinderGeometry(0.11, 0.09, 0.18, 7), lambert("#6f7f95"), -0.14, 0.15, 0.62);
        add(new THREE.TorusGeometry(0.1, 0.008, 4, 10, Math.PI), iron, -0.14, 0.24, 0.62);
        add(new THREE.CylinderGeometry(0.095, 0.095, 0.01, 7), lambert("#4f7f8c"), -0.14, 0.225, 0.62);
        add(new THREE.ConeGeometry(0.03, 0.05, 4), lambert("#9fb3c4"), -0.12, 0.25, 0.63).scale.set(1, 1, 0.3);
        add(box(0.16, 0.08, 0.1), lambert("#3d7a5a"), 0.16, 0.1, 0.5, 0.3);
        add(box(0.165, 0.015, 0.105), iron, 0.16, 0.145, 0.5, 0.3);
        add(box(0.05, 0.02, 0.012), lambert("#e0b12e"), 0.16, 0.165, 0.5, 0.3);
        g.userData.glows = glows;
        g.userData.panes = panes;
        foldByLook(g);
        break;
      }
      case "felling": {
        // A stump with an axe in it, and a stack of cut logs.
        add(new THREE.CylinderGeometry(0.2, 0.24, 0.24, 7), lambert("#7a5230"), -0.3, 0.12, 0.35);
        add(new THREE.CylinderGeometry(0.19, 0.19, 0.02, 7), lambert("#d9b45a"), -0.3, 0.25, 0.35);
        add(box(0.04, 0.42, 0.04), lambert("#5a3d22"), -0.3, 0.46, 0.35).rotation.z = -0.5;
        add(box(0.16, 0.12, 0.03), lambert("#c9d1dc"), -0.36, 0.33, 0.35).rotation.z = -0.5;
        for (const [x, y] of [[0.2, 0.08], [0.38, 0.08], [0.56, 0.08], [0.29, 0.23], [0.47, 0.23]]) {
          add(new THREE.CylinderGeometry(0.085, 0.085, 0.6, 6), lambert("#8a5a2b"), x, y, 0.4).rotation.x = Math.PI / 2;
          add(new THREE.CylinderGeometry(0.06, 0.06, 0.61, 6), lambert("#d9b45a"), x, y, 0.4).rotation.x = Math.PI / 2;
        }
        break;
      }
      case "quarry": {
        // A cut rock face with squared blocks at its foot and a pick leaning on them.
        add(box(0.95, 0.6, 0.3), lambert("#8b95a5"), 0, 0.3, -0.05);
        add(box(0.5, 0.3, 0.28), lambert("#7b8494"), -0.2, 0.75, -0.05);
        add(box(0.14, 0.1, 0.02), lambert("#c8743a"), 0.25, 0.4, 0.11);
        add(box(0.1, 0.08, 0.02), lambert("#c9d1dc"), -0.25, 0.3, 0.11);
        add(box(0.28, 0.2, 0.24), lambert("#a3acba"), -0.3, 0.1, 0.45);
        add(box(0.22, 0.16, 0.2), lambert("#959eac"), 0.0, 0.08, 0.55);
        add(box(0.04, 0.5, 0.04), lambert("#5a3d22"), 0.35, 0.25, 0.4).rotation.z = 0.35;
        add(box(0.34, 0.05, 0.05), lambert("#4a4f5a"), 0.27, 0.49, 0.4).rotation.z = 0.35;
        break;
      }
      case "crew": {
        // Cargo and Krakens: a broad round table under a tarred-rope rim, a stool for each of the six who can play,
        // a model ship in full sail in the middle, and the dice cup beside it with a die spilled out.
        add(new THREE.CylinderGeometry(0.2, 0.26, 0.4, 8), lambert("#5a3d22"), 0, 0.2, -0.3);
        add(new THREE.CylinderGeometry(0.56, 0.56, 0.07, 10), lambert("#8a6a44"), 0, 0.43, -0.3);
        add(new THREE.TorusGeometry(0.55, 0.025, 4, 20), lambert("#3a2a1a"), 0, 0.465, -0.3).rotation.x = Math.PI / 2;
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 6 + (i * Math.PI) / 3;
          add(new THREE.CylinderGeometry(0.13, 0.11, 0.24, 6), lambert("#5a3d22"), Math.cos(a) * 0.74, 0.12, -0.3 + Math.sin(a) * 0.62);
        }
        const ship = makeModelShip(1.15);
        ship.position.set(-0.02, 0.465, -0.36);
        ship.rotation.y = 0.5;
        g.add(ship);
        add(new THREE.CylinderGeometry(0.07, 0.06, 0.13, 8), lambert("#3a2414"), 0.32, 0.53, -0.18);
        add(box(0.08, 0.08, 0.08), lambert("#f4efe1"), 0.2, 0.505, -0.06, 0.6);
        break;
      }
      case "tide": {
        // Turn the Tide: a round card table under an indigo cloth, a stool for each of the five who can play, the deck
        // with a card turned up beside it, and a candle to read them by.
        add(new THREE.CylinderGeometry(0.16, 0.22, 0.4, 8), lambert("#5a3d22"), 0, 0.2, -0.3);
        add(new THREE.CylinderGeometry(0.54, 0.54, 0.06, 10), lambert("#8a6a44"), 0, 0.43, -0.3);
        add(new THREE.CylinderGeometry(0.47, 0.47, 0.012, 10), lambert("#3a3570"), 0, 0.466, -0.3);
        for (let i = 0; i < 5; i++) {
          const a = Math.PI / 2 + (i * Math.PI * 2) / 5;
          add(new THREE.CylinderGeometry(0.13, 0.11, 0.24, 6), lambert("#5a3d22"), Math.cos(a) * 0.74, 0.12, -0.3 + Math.sin(a) * 0.62);
        }
        add(box(0.13, 0.05, 0.18), lambert("#22304f"), -0.12, 0.497, -0.32, 0.2);
        add(box(0.13, 0.008, 0.18), lambert("#f4efe1"), 0.08, 0.476, -0.36, -0.5);
        add(box(0.13, 0.008, 0.18), lambert("#f4efe1"), 0.18, 0.48, -0.26, 0.3);
        add(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 6), lambert("#f4efe1"), -0.02, 0.52, -0.12);
        add(box(0.03, 0.05, 0.03), new THREE.MeshBasicMaterial({ color: "#ffb347" }), -0.02, 0.595, -0.12).userData.glow = true;
        break;
      }
      case "dice": {
        // Dice table: a round top on a barrel, a stool for each of the four who can play, and a pair of dice. Set back so whoever stands here is seen to sit at it.
        add(new THREE.CylinderGeometry(0.18, 0.22, 0.4, 7), lambert("#6b4a2b"), 0, 0.2, -0.3);
        add(new THREE.CylinderGeometry(0.5, 0.5, 0.07, 8), lambert("#a07a4c"), 0, 0.43, -0.3);
        for (const [x, z] of GAME_STOOLS) add(new THREE.CylinderGeometry(0.14, 0.12, 0.24, 6), lambert("#5a3d22"), x, 0.12, z);
        add(box(0.13, 0.13, 0.13), lambert("#f4efe1"), -0.12, 0.53, -0.25, 0.4);
        add(box(0.13, 0.13, 0.13), lambert("#b9433d"), 0.14, 0.53, -0.38, 1.1);
        break;
      }
      case "works": {
        // The works: the builders' yard where the crew's projects are paid for. Kept low, as it stands in the plaza: a
        // trestle table with the plans weighted down on it, an inkpot and quill, a mug and a candle lantern; a stool; a
        // slate of pledges on an easel; a sawhorse with a plank half sawn; stone on a pallet; strapped planks; a wheelbarrow
        // of stone; a toolbox; a bucket of nails; and a coil of rope.
        const wood = lambert("#7a5230");
        const timber = lambert("#4a2f22");
        const plank = lambert("#a07a4c");
        const boards = lambert("#8a6a44");
        const iron = lambert("#2b2a33");
        const steel = lambert("#8b95a5");
        const stone = lambert("#a3acba");
        const glows: BuildingGlow[] = [];
        for (const x of [-0.32, 0.32]) {
          for (const z of [-0.14, 0.14]) add(box(0.05, 0.36, 0.05), wood, x, 0.18, z - 0.12).rotation.z = x < 0 ? 0.12 : -0.12;
          add(box(0.05, 0.03, 0.34), wood, x, 0.1, -0.12);
        }
        add(box(0.84, 0.05, 0.44), plank, 0, 0.38, -0.12);
        add(box(0.86, 0.012, 0.46), boards, 0, 0.352, -0.12);
        // The plans: a sheet of blue paper with white lines, a rolled plan, and a stone on the corner.
        add(box(0.42, 0.012, 0.3), lambert("#3f6fa8"), -0.08, 0.41, -0.1, 0.12);
        for (const dz of [-0.06, 0.0, 0.06]) add(box(0.3, 0.014, 0.012), lambert("#dce8f5"), -0.08, 0.416, -0.1 + dz, 0.12);
        add(box(0.06, 0.014, 0.2), lambert("#dce8f5"), -0.02, 0.416, -0.1, 0.12);
        add(new THREE.CylinderGeometry(0.035, 0.035, 0.36, 6), lambert("#e8dcc0"), 0.28, 0.44, -0.16).rotation.x = Math.PI / 2;
        add(new THREE.DodecahedronGeometry(0.05), stone, -0.26, 0.44, -0.2);
        // An inkpot with a quill in it, a mug, and a candle lantern that glows at dusk.
        add(new THREE.CylinderGeometry(0.022, 0.026, 0.035, 6), lambert("#22232b"), 0.16, 0.423, -0.02);
        add(box(0.006, 0.11, 0.006), lambert("#f4efe1"), 0.18, 0.47, -0.02).rotation.z = -0.3;
        add(box(0.02, 0.05, 0.004), lambert("#f4efe1"), 0.195, 0.5, -0.02).rotation.z = -0.3;
        add(new THREE.CylinderGeometry(0.03, 0.028, 0.06, 7), lambert("#8a5a3a"), -0.33, 0.435, 0.0);
        add(box(0.01, 0.035, 0.02), lambert("#8a5a3a"), -0.3, 0.435, 0.0);
        add(box(0.07, 0.012, 0.07), iron, -0.33, 0.411, -0.27);
        add(box(0.045, 0.06, 0.045), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), -0.33, 0.447, -0.27).userData.glow = true;
        for (const [dx, dz] of [[-0.028, -0.028], [0.028, -0.028], [-0.028, 0.028], [0.028, 0.028]]) add(box(0.008, 0.07, 0.008), iron, -0.33 + dx, 0.447, -0.27 + dz);
        add(new THREE.ConeGeometry(0.05, 0.04, 4), iron, -0.33, 0.5, -0.27, Math.PI / 4);
        glows.push({ pos: new THREE.Vector3(-0.33, 0.45, -0.15), size: 0.32 });
        // A stool pulled up to the table.
        add(new THREE.CylinderGeometry(0.08, 0.08, 0.03, 8), plank, -0.05, 0.22, 0.2);
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          add(box(0.02, 0.21, 0.02), wood, -0.05 + Math.cos(a) * 0.05, 0.1, 0.2 + Math.sin(a) * 0.05);
        }
        // A slate on an easel, chalked with the tally.
        add(box(0.04, 0.6, 0.04), wood, 0.58, 0.3, -0.28).rotation.z = 0.15;
        for (const s of [-1, 1]) add(box(0.03, 0.5, 0.03), wood, 0.54 + s * 0.12, 0.24, -0.2, -0.3).rotation.x = -0.12;
        add(box(0.3, 0.24, 0.03), lambert("#2e3138"), 0.54, 0.44, -0.24, -0.3);
        add(box(0.33, 0.27, 0.02), timber, 0.54, 0.44, -0.255, -0.3);
        for (const dy of [-0.05, 0.0, 0.05]) add(box(0.18, 0.015, 0.032), lambert("#e8e4da"), 0.54, 0.44 + dy, -0.236, -0.3);
        add(box(0.36, 0.025, 0.04), timber, 0.54, 0.3, -0.23, -0.3);
        // A sawhorse with a plank across it, half sawn, the saw left in the cut and sawdust underneath.
        const sx = 0.42, sz = 0.26;
        add(box(0.4, 0.04, 0.05), wood, sx, 0.26, sz);
        for (const dx of [-0.15, 0.15]) for (const s of [-1, 1]) add(box(0.03, 0.28, 0.03), wood, sx + dx, 0.13, sz + s * 0.05).rotation.x = s * 0.3;
        add(box(0.14, 0.03, 0.62), plank, sx + 0.02, 0.295, sz + 0.06, 0.1);
        add(box(0.006, 0.07, 0.2), steel, sx + 0.04, 0.33, sz + 0.28, 0.1);
        add(box(0.025, 0.05, 0.07), wood, sx + 0.05, 0.36, sz + 0.41, 0.1);
        add(box(0.24, 0.006, 0.18), lambert("#e0cfa0"), sx + 0.04, 0.003, sz + 0.24);
        // Squared stone on a pallet, and a wheelbarrow with two more in it.
        add(box(0.4, 0.04, 0.32), boards, -0.56, 0.02, 0.36, 0.3);
        for (const [x, y, z] of [[-0.64, 0.11, 0.3], [-0.5, 0.11, 0.26], [-0.62, 0.11, 0.46], [-0.48, 0.11, 0.42], [-0.56, 0.25, 0.36]]) add(box(0.14, 0.14, 0.14), stone, x, y, z, 0.3 + x);
        const wx = -0.2, wz = 0.56;
        add(box(0.22, 0.08, 0.16), wood, wx, 0.15, wz).rotation.x = 0.1;
        add(new THREE.CylinderGeometry(0.05, 0.05, 0.025, 8), iron, wx, 0.05, wz + 0.12).rotation.z = Math.PI / 2;
        for (const dx of [-0.08, 0.08]) {
          add(box(0.02, 0.02, 0.26), wood, wx + dx, 0.13, wz - 0.12).rotation.x = -0.25;
          add(box(0.02, 0.08, 0.02), wood, wx + dx, 0.04, wz - 0.04);
        }
        for (const [dx, dz] of [[-0.04, 0.02], [0.05, -0.02]]) add(box(0.09, 0.07, 0.09), stone, wx + dx, 0.22, wz + dz, dx * 8);
        // Planks strapped in a stack.
        for (let i = 0; i < 3; i++) add(box(0.5, 0.05, 0.12), i % 2 ? lambert("#c9a877") : boards, 0.3, 0.03 + i * 0.05, 0.62, 0.2 + 0.04 * i);
        for (const d of [-0.15, 0.15]) add(box(0.02, 0.17, 0.13), iron, 0.3 + d * Math.cos(0.24), 0.08, 0.62 - d * Math.sin(0.24), 0.24);
        // A toolbox with a mallet and a square in it, a bucket of nails, and a coil of rope.
        add(box(0.24, 0.08, 0.13), wood, -0.62, 0.04, -0.24, 0.2);
        add(box(0.025, 0.1, 0.025), timber, -0.62, 0.12, -0.24, 0.2);
        add(box(0.22, 0.02, 0.02), timber, -0.62, 0.17, -0.24, 0.2);
        add(box(0.06, 0.05, 0.05), lambert("#8a5a3a"), -0.7, 0.12, -0.22, 0.2);
        add(box(0.012, 0.12, 0.012), wood, -0.7, 0.1, -0.22);
        add(box(0.1, 0.012, 0.03), steel, -0.54, 0.105, -0.27, 0.2);
        add(box(0.012, 0.08, 0.03), steel, -0.5, 0.11, -0.28, 0.2);
        add(new THREE.CylinderGeometry(0.06, 0.05, 0.11, 7), steel, -0.36, 0.055, 0.14);
        add(new THREE.CylinderGeometry(0.052, 0.052, 0.01, 7), lambert("#5d6168"), -0.36, 0.105, 0.14);
        add(new THREE.TorusGeometry(0.07, 0.022, 4, 10), lambert("#c9a877"), 0.66, 0.025, 0.02).rotation.x = Math.PI / 2;
        g.userData.glows = glows;
        foldByLook(g);
        break;
      }
      case "lighthouse": {
        // The lighthouse, on the rocks at the end of the east spit. Every stage stands on the same rocky base, with weed at
        // the waterline and a rowboat drawn up on the rocks: it is how the stone comes out, and how the keeper goes ashore.
        const rock = lambert("#5d6270");
        const pale = lambert("#7b8291");
        add(new THREE.DodecahedronGeometry(0.42, 0), rock, -0.05, 0.02, 0.02, 0.3).scale.y = 0.55;
        add(new THREE.DodecahedronGeometry(0.3, 0), pale, 0.36, 0.0, 0.22, 1.2).scale.y = 0.6;
        add(new THREE.DodecahedronGeometry(0.26, 0), rock, -0.42, -0.02, 0.3, 0.8).scale.y = 0.5;
        add(new THREE.DodecahedronGeometry(0.2, 0), pale, 0.3, 0.0, -0.36, 2.1).scale.y = 0.6;
        for (const [x, z, s] of [[-0.62, -0.12, 0.13], [0.12, 0.62, 0.1], [-0.2, -0.5, 0.12]] as [number, number, number][]) add(new THREE.DodecahedronGeometry(s, 0), x < 0 ? pale : rock, x, 0.0, z, x * 4).scale.y = 0.6;
        const weed = lambert("#3f5a3a");
        for (const [x, z, s] of [[-0.3, 0.5, 0.14], [0.6, 0.05, 0.12], [-0.62, 0.15, 0.1], [0.05, -0.55, 0.12]] as [number, number, number][]) add(new THREE.DodecahedronGeometry(s, 0), weed, x, 0.0, z, z * 5).scale.y = 0.2;
        const base = 0.2;
        const fill = Math.max(0, Math.min(1, poi.fill ?? 0));
        const white = lambert("#f1ece0");
        const red = lambert("#b9433d");
        const masonry = lambert("#9a958a");
        const block = lambert("#a3acba");
        const iron = lambert("#2b2a33");
        const timber = lambert("#4a2f22");
        const wood = lambert("#7a5230");
        const plank = lambert("#8a6a44");
        const rope = lambert("#c9a877");
        const brass = lambert("#e0b12e");
        const glows: BuildingGlow[] = [];
        const panes: THREE.MeshBasicMaterial[] = [];
        /** The tower is octagonal, turned so a flat face looks down the spit. */
        const TURN = Math.PI / 8;
        /** One band of the striped tower: radius at the bottom and top, height, and the course it starts on. */
        const course = (r0: number, r1: number, h: number, y: number, m: THREE.Material) => add(new THREE.CylinderGeometry(r1, r0, h, 8), m, 0, y + h / 2, 0, TURN);
        // The tower in four bands, tapering, alternately white and red.
        const BANDS = [0.34, 0.31, 0.28, 0.25, 0.22];
        const BAND_H = 0.36;
        const TOWER_FOOT = base + 0.14;
        /** How far out the tower's flat face is at height `y`. */
        const faceAt = (y: number) => (BANDS[0] - ((y - TOWER_FOOT) / (BAND_H * 4)) * (BANDS[0] - BANDS[4])) * Math.cos(Math.PI / 8);
        /** Something standing at a distance `d` from the tower's axis at angle `a` (0 is the front), turned to face out. */
        const onFace = (geo: THREE.BufferGeometry, m: THREE.Material, a: number, d: number, y: number) => add(geo, m, Math.sin(a) * d, y, Math.cos(a) * d, a);
        /** A ring of `n` straight pieces at radius `r`, height `y`, like a rail or a builder's line round the tower. */
        const ring = (r: number, y: number, n: number, m: THREE.Material, thick: number, phase = 0, glow = false) => {
          const side = 2 * r * Math.sin(Math.PI / n);
          for (let i = 0; i < n; i++) {
            const b = phase + ((i + 0.5) / n) * Math.PI * 2;
            const length = add(box(side, thick, thick), m, Math.cos(b) * r * Math.cos(Math.PI / n), y, Math.sin(b) * r * Math.cos(Math.PI / n), -b - Math.PI / 2);
            if (glow) length.userData.glow = true;
          }
        };
        const plinth = () => {
          add(new THREE.CylinderGeometry(0.4, 0.44, 0.14, 8), masonry, 0, base + 0.07, 0, TURN);
          add(new THREE.CylinderGeometry(0.41, 0.41, 0.025, 8), lambert("#7d786e"), 0, base + 0.14, 0, TURN);
        };
        const blocks = (spots: [number, number][]) => {
          for (const [x, z] of spots) add(box(0.14, 0.12, 0.14), block, x, base + 0.06, z, 0.4 + x);
        };
        // The rowboat, drawn up on the rocks with its oars across it.
        {
          const bx = 0.6, bz = 0.42, turn = 1.1;
          const part = (geo: THREE.BufferGeometry, m: THREE.Material, lx: number, y: number, lz: number) =>
            add(geo, m, bx + lx * Math.cos(turn) + lz * Math.sin(turn), y, bz - lx * Math.sin(turn) + lz * Math.cos(turn), turn);
          part(box(0.2, 0.08, 0.42), lambert("#6b4a2b"), 0, 0.08, 0);
          part(new THREE.ConeGeometry(0.1, 0.12, 4), lambert("#6b4a2b"), 0, 0.08, 0.26).rotation.set(Math.PI / 2, turn, 0, "YXZ");
          part(box(0.16, 0.02, 0.38), plank, 0, 0.115, 0);
          part(box(0.2, 0.02, 0.04), wood, 0, 0.13, 0.04);
          for (const s of [-1, 1]) part(box(0.02, 0.015, 0.5), lambert("#c9a877"), s * 0.04, 0.145, -0.02).rotation.y = turn + s * 0.15;
        }
        /** The scaffold round the tower: corner poles, ledgers and planks on every side at each lift, a brace across the front, and a ladder up to the first lift. */
        const scaffold = (height: number) => {
          for (const [x, z] of [[-0.42, -0.36], [0.42, -0.36], [-0.42, 0.36], [0.42, 0.36]]) add(new THREE.CylinderGeometry(0.03, 0.03, height, 5), wood, x, base + height / 2, z);
          for (let y = base + 0.35; y < base + height - 0.05; y += 0.4) {
            for (const z of [-0.36, 0.36]) {
              add(box(0.88, 0.035, 0.05), plank, 0, y, z);
              add(box(0.88, 0.02, 0.02), wood, 0, y - 0.03, z + Math.sign(z) * 0.03);
            }
            for (const x of [-0.42, 0.42]) add(box(0.05, 0.035, 0.76), plank, x, y, 0);
          }
          const rise = Math.min(height - 0.1, 0.8);
          add(box(Math.hypot(0.84, rise), 0.02, 0.02), wood, 0, base + rise / 2, 0.4).rotation.z = Math.atan2(rise, 0.84);
          const lean = 0.2;
          for (const x of [-0.3, -0.2]) add(box(0.02, 0.44, 0.02), wood, x, base + 0.2, 0.46).rotation.x = -lean;
          for (let i = 0; i < 3; i++) {
            const y = base + 0.06 + i * 0.12;
            add(box(0.1, 0.015, 0.015), wood, -0.25, y, 0.46 - (y - base - 0.2) * Math.tan(lean));
          }
        };
        /** A windlass on the rocks: two A-frames and a drum wound with rope. */
        const windlass = (x: number, z: number) => {
          for (const dz of [-0.1, 0.1]) for (const s of [-1, 1]) add(box(0.025, 0.24, 0.025), wood, x + s * 0.04, base + 0.1, z + dz).rotation.z = s * 0.3;
          add(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 7), wood, x, base + 0.2, z).rotation.x = Math.PI / 2;
          add(new THREE.CylinderGeometry(0.054, 0.054, 0.12, 7), rope, x, base + 0.2, z).rotation.x = Math.PI / 2;
          add(box(0.12, 0.02, 0.02), iron, x + 0.06, base + 0.2, z + 0.11);
        };
        if (poi.cleared) {
          // Built: a striped stone tower on a plinth with a coping, picked out at each course; a door up a flight of steps
          // with a lantern by it; windows that glow at dusk climbing the tower; the gallery on its corbels with a double rail;
          // the lantern room of glass on a red parapet, and a red cap with a vane. A keeper's cottage leans on the rocks
          // beside it with its chimney smoking, a fog bell hangs on a frame, and oil stands by the cottage door. The
          // ambience turns the beam and lights the glow.
          plinth();
          let y = TOWER_FOOT;
          for (let i = 0; i < 4; i++) {
            course(BANDS[i], BANDS[i + 1], BAND_H, y, i % 2 ? red : white);
            y += BAND_H;
            if (i < 3) add(new THREE.CylinderGeometry(BANDS[i + 1] + 0.012, BANDS[i + 1] + 0.012, 0.025, 8), i % 2 ? lambert("#8c3b2f") : lambert("#d9d1bf"), 0, y, 0, TURN);
          }
          // The door, framed in stone, up three steps; a lantern beside it.
          const d0 = faceAt(TOWER_FOOT + 0.14);
          onFace(box(0.17, 0.3, 0.03), masonry, 0, d0 + 0.005, TOWER_FOOT + 0.15);
          onFace(box(0.12, 0.25, 0.03), lambert("#4a3a2a"), 0, d0 + 0.015, TOWER_FOOT + 0.125);
          for (const dy of [0.06, 0.18]) onFace(box(0.12, 0.012, 0.012), iron, 0, d0 + 0.033, TOWER_FOOT + dy);
          onFace(box(0.025, 0.025, 0.02), brass, 0, d0 + 0.035, TOWER_FOOT + 0.12).position.x += 0.04;
          for (let i = 0; i < 3; i++) {
            const top = TOWER_FOOT - 0.05 * (i + 1);
            add(box(0.26, top - 0.02, 0.1), masonry, 0, (top + 0.02) / 2, 0.47 + i * 0.09);
          }
          add(box(0.02, 0.02, 0.07), iron, 0.13, TOWER_FOOT + 0.3, d0 + 0.035);
          add(box(0.045, 0.06, 0.045), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), 0.13, TOWER_FOOT + 0.24, d0 + 0.07).userData.glow = true;
          add(new THREE.ConeGeometry(0.05, 0.04, 4), iron, 0.13, TOWER_FOOT + 0.29, d0 + 0.07, Math.PI / 4);
          add(box(0.06, 0.012, 0.06), iron, 0.13, TOWER_FOOT + 0.205, d0 + 0.07);
          glows.push({ pos: new THREE.Vector3(0.13, TOWER_FOOT + 0.24, d0 + 0.16), size: 0.3 });
          // Windows climbing the tower, each in a stone frame with a sill, glowing at dusk.
          const glass = warmPane("#c99a52", "#ffd98a");
          panes.push(glass);
          for (const [a, wy] of [[0, TOWER_FOOT + 0.62], [-Math.PI / 4, TOWER_FOOT + 0.98], [Math.PI / 4, TOWER_FOOT + 1.3]]) {
            const d = faceAt(wy);
            onFace(box(0.1, 0.14, 0.02), masonry, a, d + 0.004, wy);
            onFace(box(0.064, 0.1, 0.02), glass, a, d + 0.01, wy).userData.glow = true;
            onFace(box(0.12, 0.02, 0.04), masonry, a, d + 0.01, wy - 0.08);
            glows.push({ pos: new THREE.Vector3(Math.sin(a) * (d + 0.12), wy, Math.cos(a) * (d + 0.12)), size: 0.22 });
          }
          // The gallery: corbels under a broad slab, eight posts, and a top rail and a middle rail round it.
          const gy = y;
          for (let i = 0; i < 8; i++) onFace(box(0.05, 0.08, 0.08), masonry, (i / 8) * Math.PI * 2, 0.24, gy - 0.03);
          add(new THREE.CylinderGeometry(0.33, 0.27, 0.07, 8), lambert("#4a4458"), 0, gy + 0.035, 0, TURN);
          /**
           * Ironwork the lamp shines on as its beam comes round: a thin skin of light over each bar, post and rail,
           * dark until a beam points its way. All of it is one material, which lights each part by where it lies
           * round the lamp, so the shine runs along a rail rather than switching on a length at a time (the
           * ambience turns it with the beam; see `setBeacon`).
           */
          const shine = beaconShine();
          const glint = (w: number, h: number, r: number, y: number, a: number) => (add(box(w, h, w), shine, Math.cos(a) * r, y, Math.sin(a) * r).userData.glow = true);
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
            add(box(0.02, 0.14, 0.02), iron, Math.cos(a) * 0.3, gy + 0.14, Math.sin(a) * 0.3);
            glint(0.028, 0.15, 0.3, gy + 0.14, a);
          }
          ring(0.31, gy + 0.21, 8, iron, 0.022, Math.PI / 8);
          ring(0.31, gy + 0.14, 8, iron, 0.014, Math.PI / 8);
          // The same two rails again, a little fatter, as their skin of light.
          ring(0.31, gy + 0.21, 8, shine, 0.03, Math.PI / 8, true);
          ring(0.31, gy + 0.14, 8, shine, 0.022, Math.PI / 8, true);
          // The lantern room: a red parapet, a warm core behind glass, and eight dark glazing bars.
          const ly = gy + 0.07;
          add(new THREE.CylinderGeometry(0.19, 0.2, 0.08, 8), lambert("#8c3b2f"), 0, ly + 0.04, 0, TURN);
          add(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 6), new THREE.MeshBasicMaterial({ color: "#ffe9a8" }), 0, ly + 0.17, 0).userData.glow = true;
          add(new THREE.CylinderGeometry(0.17, 0.17, 0.22, 8), new THREE.MeshBasicMaterial({ color: "#ffd77a", transparent: true, opacity: 0.45, depthWrite: false }), 0, ly + 0.19, 0).userData.glow = true;
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            add(box(0.018, 0.22, 0.018), iron, Math.cos(a) * 0.17, ly + 0.19, Math.sin(a) * 0.17);
            glint(0.026, 0.22, 0.17, ly + 0.19, a);
          }
          g.userData.shine = shine;
          // The cap: a dark red cone on a ring, a ball, a rod and a vane with an arrow.
          add(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 8), iron, 0, ly + 0.315, 0);
          add(new THREE.ConeGeometry(0.21, 0.2, 8), lambert("#8c3b2f"), 0, ly + 0.43, 0, TURN);
          add(new THREE.SphereGeometry(0.035, 6, 4), iron, 0, ly + 0.54, 0);
          add(box(0.012, 0.14, 0.012), iron, 0, ly + 0.61, 0);
          add(box(0.12, 0.012, 0.008), iron, 0.03, ly + 0.63, 0);
          add(new THREE.ConeGeometry(0.02, 0.04, 4), iron, 0.1, ly + 0.63, 0).rotation.z = -Math.PI / 2;
          add(box(0.04, 0.04, 0.008), iron, -0.04, ly + 0.63, 0, Math.PI / 4);
          // Where the beam turns from: the middle of the lantern.
          g.userData.beacon = new THREE.Vector3(0, ly + 0.17, 0);
          // The keeper's cottage on the rocks to the west: whitewashed, under a red roof, its window lit and its chimney smoking.
          const kx = -0.58, kz = 0.06, kb = 0.16;
          add(box(0.32, 0.04, 0.38), masonry, kx, kb - 0.02, kz);
          add(box(0.3, 0.22, 0.34), white, kx, kb + 0.11, kz);
          for (const x of [-0.15, 0.15]) for (const z of [-0.17, 0.17]) add(box(0.03, 0.22, 0.03), timber, kx + x, kb + 0.11, kz + z);
          const half = 0.19, rise = 0.14, len = 0.4;
          add(new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]), { depth: len - 0.04, bevelEnabled: false }).translate(0, 0, -(len - 0.04) / 2), white, kx, kb + 0.22, kz);
          const pitch = Math.atan2(rise, half), slope = Math.hypot(rise, half) * 1.1;
          for (const side of [1, -1]) {
            const along = slope / 2;
            add(box(slope, 0.04, len + 0.04), lambert("#8c3b2f"), kx + side * (along * Math.cos(pitch) + 0.02 * Math.sin(pitch)), kb + 0.22 + rise - along * Math.sin(pitch) + 0.02 * Math.cos(pitch), kz).rotation.z = -side * pitch;
          }
          add(box(0.06, 0.04, len + 0.08), lambert("#6e2e25"), kx, kb + 0.22 + rise + 0.02, kz);
          add(box(0.09, 0.15, 0.02), lambert("#4a3a2a"), kx - 0.06, kb + 0.075, kz + 0.175);
          add(box(0.09, 0.09, 0.012), timber, kx + 0.08, kb + 0.13, kz + 0.172);
          add(box(0.065, 0.065, 0.01), glass, kx + 0.08, kb + 0.13, kz + 0.178).userData.glow = true;
          glows.push({ pos: new THREE.Vector3(kx + 0.08, kb + 0.13, kz + 0.3), size: 0.22 });
          add(box(0.08, 0.24, 0.08), masonry, kx + 0.06, kb + 0.36, kz - 0.08);
          add(box(0.1, 0.03, 0.1), lambert("#7d786e"), kx + 0.06, kb + 0.49, kz - 0.08);
          g.userData.smoke = new THREE.Vector3(kx + 0.06, kb + 0.55, kz - 0.08);
          for (const [x, z, r] of [[kx + 0.2, kz + 0.28, 0.06], [kx + 0.08, kz + 0.33, 0.05]]) {
            add(new THREE.CylinderGeometry(r, r, 0.13, 7), wood, x, kb + 0.065, z);
            add(new THREE.CylinderGeometry(r + 0.004, r + 0.004, 0.015, 7), iron, x, kb + 0.1, z);
          }
          // The fog bell on its frame, on the rocks to the east.
          for (const x of [0.36, 0.56]) add(box(0.03, 0.38, 0.03), timber, x, 0.29, -0.3);
          add(box(0.26, 0.035, 0.04), timber, 0.46, 0.48, -0.3);
          add(new THREE.CylinderGeometry(0.035, 0.07, 0.11, 8), brass, 0.46, 0.4, -0.3);
          add(box(0.008, 0.08, 0.008), rope, 0.46, 0.3, -0.3);
          // A coil of rope by the boat.
          add(new THREE.TorusGeometry(0.06, 0.02, 4, 10), rope, 0.3, 0.22, 0.56).rotation.x = Math.PI / 2;
        } else if (fill >= 0.5) {
          // More than half paid for: the lower half of the tower is up inside its scaffold, the next course going on, a hoist
          // lifting a bucket of mortar, a windlass on the rocks, and a canvas lean-to where the masons shelter.
          plinth();
          course(BANDS[0], BANDS[1], BAND_H, TOWER_FOOT, white);
          course(BANDS[1], BANDS[2], BAND_H * 0.6, TOWER_FOOT + BAND_H, lambert("#c9c3b5"));
          for (let i = 0; i < 3; i++) onFace(box(0.12, 0.1, 0.1), lambert("#c9c3b5"), (i / 8) * Math.PI * 2 + 0.6, faceAt(TOWER_FOOT + BAND_H * 1.6) - 0.04, TOWER_FOOT + BAND_H * 1.6 + 0.05);
          scaffold(1.1);
          add(box(0.04, 0.04, 0.5), wood, 0.42, base + 1.12, 0.12);
          add(box(0.008, 0.5, 0.008), rope, 0.42, base + 0.86, 0.34);
          add(new THREE.CylinderGeometry(0.05, 0.04, 0.07, 6), lambert("#5a3d22"), 0.42, base + 0.6, 0.34);
          blocks([[-0.5, 0.42], [-0.34, 0.5]]);
          windlass(0.56, -0.12);
          for (const z of [-0.12, 0.24]) add(box(0.03, 0.34, 0.03), wood, -0.66, base + 0.17, z);
          add(box(0.24, 0.015, 0.44), lambert("#e8dcc0"), -0.58, base + 0.28, 0.06).rotation.z = 0.5;
          add(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 7), wood, -0.6, base + 0.06, 0.06);
        } else if (fill > 0) {
          // Begun: the plinth and the first course inside the scaffold's lower lift, stone stacked ready, planks, a tub of
          // mortar with a trowel, and a windlass to haul with.
          plinth();
          course(BANDS[0], 0.33, 0.12, TOWER_FOOT, lambert("#c9c3b5"));
          scaffold(0.7);
          blocks([[-0.5, 0.42], [-0.34, 0.5], [-0.46, 0.56]]);
          for (let i = 0; i < 3; i++) add(box(0.46, 0.04, 0.1), lambert(i % 2 ? "#c9a877" : "#8a6a44"), 0.12, base + 0.02 + i * 0.04, 0.6, 0.1 * i);
          add(box(0.18, 0.07, 0.13), wood, 0.58, base + 0.035, -0.2);
          add(box(0.15, 0.012, 0.1), lambert("#cfc8b8"), 0.58, base + 0.072, -0.2);
          add(box(0.07, 0.008, 0.035), iron, 0.6, base + 0.082, -0.18, 0.5);
          windlass(-0.6, -0.18);
        } else {
          // Not begun: the point is only surveyed. A ring of stakes marks where the tower will stand, strung with a line,
          // with a flag on one; the first stones and a crate of tools have come out by boat.
          const stake = lambert("#a07a4c");
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            add(box(0.035, 0.22, 0.035), stake, Math.cos(a) * 0.34, base + 0.08, Math.sin(a) * 0.34);
          }
          ring(0.34, base + 0.16, 6, lambert("#efe6cf"), 0.008);
          add(box(0.025, 0.5, 0.025), stake, 0.34, base + 0.22, 0);
          add(box(0.012, 0.12, 0.16), lambert("#b9433d"), 0.34, base + 0.4, 0.08);
          add(box(0.32, 0.03, 0.24), wood, -0.46, base + 0.015, 0.46);
          blocks([[-0.53, 0.42], [-0.39, 0.5]]);
          add(box(0.16, 0.12, 0.12), plank, -0.12, base + 0.06, 0.56, 0.3);
          add(box(0.17, 0.02, 0.13), wood, -0.12, base + 0.13, 0.56, 0.3);
        }
        g.userData.glows = glows;
        if (panes.length) g.userData.panes = panes;
        foldByLook(g);
        break;
      }
      case "apothecary":
      case "smithy":
      case "galley": {
        // The crew's three workshops share a kit with the huts and the pub: dark timbers, dressed stone, ironwork, glass
        // that warms at dusk, and gabled roofs with darker courses of shingle. Each trade has its own roof and trim colour.
        const kind = poi.kind;
        const timber = lambert("#4a2f22");
        const plaster = lambert("#e6dcc0");
        const stone = lambert("#a8977a");
        const footing = lambert("#7b8494");
        const iron = lambert("#2b2a33");
        const wood = lambert("#7a5230");
        const plank = lambert("#a07a4c");
        const boards = lambert("#8a6a44");
        const brass = lambert("#e0b12e");
        const copper = lambert("#c8743a");
        const steel = lambert("#3a3d44");
        const sacking = lambert("#d8c7a0");
        const roofHex = kind === "apothecary" ? "#2f5a3a" : kind === "galley" ? "#a0522d" : "#4a4f5a";
        const roofMat = lambert(roofHex);
        const roofDark = lambert("#" + new THREE.Color(roofHex).multiplyScalar(0.72).getHexString());
        const trim = lambert(kind === "apothecary" ? "#3e6a44" : kind === "galley" ? "#7a3a22" : "#3a3d44");
        /** What the trade's walls are made of: plaster for the apothecary, dressed stone for the smithy, planks for the galley. */
        const wallMat = kind === "apothecary" ? plaster : kind === "galley" ? boards : lambert("#9a958a");
        const glows: BuildingGlow[] = [];
        const panes: THREE.MeshBasicMaterial[] = [];
        const glass = warmPane(kind === "apothecary" ? "#b9a064" : "#c99a52", kind === "apothecary" ? "#ffe2a0" : "#ffd08a");
        const finish = () => {
          g.userData.glows = glows;
          if (panes.length) g.userData.panes = panes;
          foldByLook(g);
        };
        /** A framed window on a front wall at `z`, with glazing bars, shutters in the trade's colour, and a halo at dusk. */
        const framed = (x: number, y: number, w: number, h: number, z: number, shutters = true) => {
          if (!panes.length) panes.push(glass);
          add(box(w + 0.04, h + 0.04, 0.012), timber, x, y, z);
          add(box(w, h, 0.01), glass, x, y, z + 0.008).userData.glow = true;
          add(box(0.015, h, 0.012), timber, x, y, z + 0.014);
          add(box(w, 0.015, 0.012), timber, x, y, z + 0.014);
          if (shutters) for (const s of [-1, 1]) add(box(0.045, h + 0.02, 0.014), trim, x + s * (w / 2 + 0.045), y, z + 0.008);
          glows.push({ pos: new THREE.Vector3(x, y, z + 0.14), size: w * 2.2 });
        };
        /** A gabled roof with its ridge along x (or along z with `alongZ`): a prism of `end` under two overhanging slabs, darker shingle courses `bands` down from the ridge, and a ridge cap. */
        const roof = (cx: number, cy: number, cz: number, len: number, half: number, rise: number, end: THREE.Material, bands: number[], alongZ = false) => {
          const shape = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]);
          const prism = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false }).translate(0, 0, -len / 2);
          add(alongZ ? prism : prism.rotateY(Math.PI / 2), end, cx, cy, cz);
          const pitch = Math.atan2(rise, half);
          const slope = Math.hypot(rise, half) * 1.08;
          for (const side of [1, -1]) {
            /** A slab `depth` long down the slope, its middle `along` from the ridge. */
            const slab = (along: number, depth: number, m: THREE.Material, thick: number) => {
              const out = side * (along * Math.cos(pitch) + 0.03 * Math.sin(pitch));
              const y = cy + rise - along * Math.sin(pitch) + 0.03 * Math.cos(pitch);
              if (alongZ) add(box(depth, thick, len + 0.12), m, cx + out, y, cz).rotation.z = -side * pitch;
              else add(box(len + 0.12, thick, depth), m, cx, y, cz + out).rotation.x = side * pitch;
            };
            slab(slope / 2, slope, roofMat, 0.06);
            for (const d of bands) slab(d, 0.05, roofDark, 0.065);
          }
          add(alongZ ? box(0.08, 0.06, len + 0.2) : box(len + 0.2, 0.06, 0.08), roofDark, cx, cy + rise + 0.03, cz);
        };
        /** A lantern on a bracket from the wall behind it, lit at dusk. */
        const lantern = (x: number, y: number, z: number) => {
          add(box(0.03, 0.02, 0.08), iron, x, y + 0.07, z - 0.04);
          add(box(0.05, 0.065, 0.05), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), x, y, z).userData.glow = true;
          for (const [dx, dz] of [[-0.03, -0.03], [0.03, -0.03], [-0.03, 0.03], [0.03, 0.03]]) add(box(0.01, 0.08, 0.01), iron, x + dx, y, z + dz);
          add(box(0.08, 0.015, 0.08), iron, x, y - 0.045, z);
          add(new THREE.ConeGeometry(0.06, 0.05, 4), iron, x, y + 0.06, z, Math.PI / 4);
          glows.push({ pos: new THREE.Vector3(x, y, z + 0.1), size: 0.34 });
        };
        const barrel = (x: number, z: number, r = 0.08, h = 0.18, y = 0) => {
          add(new THREE.CylinderGeometry(r, r, h, 8), wood, x, y + h / 2, z);
          for (const t of [0.25, 0.75]) add(new THREE.CylinderGeometry(r + 0.004, r + 0.004, 0.02, 8), timber, x, y + h * t, z);
        };
        const sack = (x: number, z: number, turn: number, y = 0) => {
          add(box(0.12, 0.14, 0.1), sacking, x, y + 0.07, z, turn);
          add(box(0.06, 0.03, 0.05), boards, x, y + 0.155, z, turn);
        };
        /** The trade's mark, in pale relief on a board: a cross for the apothecary, an anvil for the smithy, a fish for the galley. Faces ±x with `faceX`, else ±z. */
        const emblem = (x: number, y: number, z: number, faceX: boolean) => {
          const mark = lambert(kind === "apothecary" ? "#f0ead0" : "#d6dce4");
          const at = (u: number, v: number, w: number, h: number) => add(faceX ? box(0.054, h, w) : box(w, h, 0.04), mark, faceX ? x : x + u, y + v, faceX ? z + u : z);
          if (kind === "apothecary") {
            at(0, 0, 0.034, 0.1);
            at(0, 0, 0.1, 0.034);
          } else if (kind === "smithy") {
            at(0.01, 0.035, 0.12, 0.03);
            at(-0.07, 0.04, 0.04, 0.018);
            at(0.01, 0, 0.05, 0.04);
            at(0.01, -0.04, 0.1, 0.03);
          } else {
            at(-0.015, 0, 0.11, 0.05);
            at(0.06, 0, 0.03, 0.075);
          }
        };
        /** A sign swinging from an iron bracket out of the wall at `zWall`, its face to the side so it reads from the lane. */
        const sign = (x: number, y: number, zWall: number) => {
          add(box(0.03, 0.03, 0.28), iron, x, y, zWall + 0.14);
          for (const dz of [0.09, 0.25]) add(box(0.008, 0.07, 0.008), iron, x, y - 0.035, zWall + dz);
          add(box(0.04, 0.24, 0.24), timber, x, y - 0.16, zWall + 0.17);
          add(box(0.046, 0.2, 0.2), kind === "apothecary" ? lambert("#3f8a46") : kind === "galley" ? lambert("#7a3a22") : lambert("#2c2a2e"), x, y - 0.16, zWall + 0.17);
          emblem(x, y - 0.16, zWall + 0.17, true);
        };
        const planks = (x: number, z: number, n: number) => {
          for (let i = 0; i < n; i++) add(box(0.5, 0.05, 0.12), i % 2 ? plank : boards, x, 0.03 + i * 0.05, z + i * 0.01, 0.15 * i);
          if (n > 1) for (const dx of [-0.14, 0.14]) add(box(0.02, n * 0.05 + 0.01, 0.13), iron, x + dx, 0.005 + n * 0.025, z + 0.01 * (n - 1) / 2, 0.15 * (n - 1) / 2);
        };
        const stones = (spots: [number, number, number][]) => {
          for (const [x, y, z] of spots) add(box(0.14, 0.12, 0.14), lambert("#959eac"), x, y, z, 0.3 + x);
        };
        /** The trade's own makings, waiting to go in: sacks of herbs, iron bars, or furs and bones. */
        const makings = (x: number, z: number) => {
          if (kind === "galley") {
            for (const [dx, dz, c] of [[-0.12, -0.03, "#7a5a3a"], [0.1, 0.03, "#9a7a55"]] as [number, number, string][]) add(box(0.22, 0.12, 0.16), lambert(c), x + dx, 0.06, z + dz, 0.3);
            for (let i = 0; i < 4; i++) add(new THREE.CylinderGeometry(0.025, 0.025, 0.26, 4), lambert("#ece4cf"), x + 0.3 + (i % 2) * 0.06, 0.04 + Math.floor(i / 2) * 0.04, z + 0.02).rotation.z = Math.PI / 2 + i * 0.5;
          } else if (kind === "apothecary") {
            for (const [dx, dz] of [[-0.15, 0], [0.15, 0.05]]) {
              add(new THREE.CylinderGeometry(0.11, 0.13, 0.22, 6), lambert("#c9b37a"), x + dx, 0.11, z + dz);
              add(new THREE.SphereGeometry(0.09, 5, 4), lambert("#5f9e4a"), x + dx, 0.25, z + dz);
            }
          } else {
            for (let i = 0; i < 4; i++) add(box(0.32, 0.05, 0.07), lambert(i < 2 ? "#6f737a" : "#c8743a"), x + (i % 2) * 0.08, 0.03 + Math.floor(i / 2) * 0.05, z, 0.2);
          }
        };

        const siteFill = Math.max(0, Math.min(1, poi.fill ?? 0));
        if (!poi.cleared && siteFill > 0) {
          // Under construction: the building rises as the crew pays in, in the trade's own walls and roof. First the
          // footing is laid out with stakes and a builder's line and the first stones go down; then the frame goes up with
          // the walls half built and a scaffold behind; then the walls reach the eaves with the window holes left open,
          // the rafters are on, the back slope is part covered, and a hoist lifts the rest of the roof up.
          const stage = siteFill >= 0.67 ? 3 : siteFill >= 0.34 ? 2 : 1;
          add(box(1.04, 0.08, 0.76), footing, 0, 0.04, 0);
          const corners: [number, number][] = [[-0.46, -0.32], [0.46, -0.32], [-0.46, 0.32], [0.46, 0.32]];
          const plate = () => {
            for (const z of [-0.32, 0.32]) add(box(0.98, 0.05, 0.06), timber, 0, 0.68, z);
            for (const x of [-0.46, 0.46]) add(box(0.06, 0.05, 0.7), timber, x, 0.68, 0);
          };
          if (stage === 1) {
            // The first course of stone: the back and the west side, the east side begun.
            add(box(0.94, 0.1, 0.08), stone, 0, 0.13, -0.32);
            add(box(0.08, 0.1, 0.6), stone, -0.46, 0.13, 0);
            add(box(0.08, 0.1, 0.3), stone, 0.46, 0.13, -0.17);
            add(box(0.4, 0.08, 0.08), stone, -0.24, 0.22, -0.32);
            // Stakes at the corners with a builder's line strung round them.
            for (const [x, z] of corners) add(box(0.04, 0.34, 0.04), timber, x, 0.25, z);
            const line = lambert("#efe6cf");
            for (const z of [-0.32, 0.32]) add(box(0.92, 0.008, 0.008), line, 0, 0.36, z);
            for (const x of [-0.46, 0.46]) add(box(0.008, 0.008, 0.64), line, x, 0.36, 0);
            // A tub of mortar with a trowel in it.
            add(box(0.2, 0.07, 0.14), wood, 0.22, 0.115, 0.06);
            add(box(0.17, 0.012, 0.11), lambert("#cfc8b8"), 0.22, 0.152, 0.06);
            add(box(0.08, 0.008, 0.04), iron, 0.24, 0.165, 0.08, 0.5);
            add(box(0.015, 0.015, 0.07), wood, 0.19, 0.17, 0.1, 0.5);
          } else {
            // The stone course all round, leaving the doorway; corner posts to full height, braced, under a wall plate.
            add(box(0.94, 0.14, 0.08), stone, 0, 0.15, -0.32);
            for (const x of [-0.46, 0.46]) add(box(0.08, 0.14, 0.6), stone, x, 0.15, 0);
            for (const x of [-0.31, 0.31]) add(box(0.32, 0.14, 0.08), stone, x, 0.15, 0.32);
            for (const [x, z] of [...corners, [0, -0.32] as [number, number]]) add(box(0.06, 0.6, 0.06), timber, x, 0.38, z);
            plate();
            for (const x of [-0.475, 0.475]) for (const s of [-1, 1]) add(box(0.025, 0.03, 0.36), timber, x, 0.48, s * 0.15).rotation.x = s * 0.75;
          }
          if (stage === 2) {
            // The walls half up, and a scaffold behind the back wall with a plank walk on it, and a ladder at the front.
            add(box(0.9, 0.22, 0.05), wallMat, 0, 0.33, -0.32);
            for (const x of [-0.46, 0.46]) add(box(0.05, 0.22, 0.6), wallMat, x, 0.33, 0);
            for (const x of [-0.42, 0.42]) add(box(0.03, 0.8, 0.03), timber, x, 0.4, -0.5);
            add(box(0.9, 0.025, 0.025), timber, 0, 0.4, -0.52);
            add(box(0.9, 0.02, 0.12), plank, 0, 0.42, -0.46);
            const lean = 0.25;
            for (const x of [0.53, 0.63]) add(box(0.02, 0.66, 0.02), wood, x, 0.33, 0.44).rotation.x = -lean;
            for (let i = 0; i < 4; i++) {
              const y = 0.12 + i * 0.15;
              add(box(0.1, 0.015, 0.015), wood, 0.58, y, 0.44 - (y - 0.33) * Math.tan(lean));
            }
          }
          if (stage === 3) {
            // Walls to the eaves, the doorway framed with a lintel, and the window holes left open with their sills in.
            add(box(0.9, 0.46, 0.05), wallMat, 0, 0.45, -0.32);
            for (const x of [-0.46, 0.46]) add(box(0.05, 0.46, 0.6), wallMat, x, 0.45, 0);
            for (const x of [-0.31, 0.31]) {
              add(box(0.3, 0.46, 0.05), wallMat, x, 0.45, 0.32);
              add(box(0.14, 0.12, 0.01), lambert("#2a221c"), x, 0.47, 0.346);
              add(box(0.18, 0.02, 0.04), timber, x, 0.4, 0.35);
            }
            add(box(0.34, 0.06, 0.06), timber, 0, 0.62, 0.32);
            // Rafters and a ridge beam, with the top of the back slope already slabbed in the trade's roof.
            const half = 0.42, rise = 0.3, pitch = Math.atan2(rise, half), raft = Math.hypot(rise, half);
            for (let i = 0; i < 5; i++) for (const s of [-1, 1]) add(box(0.035, 0.035, raft), timber, -0.4 + i * 0.2, 0.7 + rise / 2, s * half / 2).rotation.x = s * pitch;
            add(box(0.98, 0.04, 0.04), timber, 0, 0.7 + rise, 0);
            for (const d of [0.11, 0.31]) add(box(0.98, 0.04, 0.2), roofMat, 0, 0.7 + rise - d * Math.sin(pitch) + 0.03 * Math.cos(pitch), -(d * Math.cos(pitch) + 0.03 * Math.sin(pitch))).rotation.x = -pitch;
            // A scaffold up the west wall, and a hoist on the east side lifting a bucket, with roof slabs stacked ready.
            for (const z of [-0.26, 0.26]) add(box(0.03, 0.72, 0.03), timber, -0.62, 0.36, z);
            add(box(0.025, 0.025, 0.6), timber, -0.64, 0.48, 0);
            add(box(0.12, 0.02, 0.6), plank, -0.58, 0.5, 0);
            add(box(0.035, 1.1, 0.035), timber, 0.64, 0.55, -0.12);
            add(box(0.03, 0.03, 0.3), timber, 0.64, 1.08, 0.0);
            add(box(0.006, 0.52, 0.006), lambert("#efe6cf"), 0.64, 0.82, 0.13);
            add(new THREE.CylinderGeometry(0.05, 0.04, 0.08, 7), wood, 0.64, 0.54, 0.13);
            for (let i = 0; i < 3; i++) add(box(0.3, 0.03, 0.14), roofMat, 0.38, 0.015 + i * 0.03, 0.56, 0.1 * i);
          }
          // Materials waiting by the door: planks and squared stone, thinner the nearer it is to done.
          planks(-0.28, 0.5, stage === 3 ? 1 : 3);
          stones(stage === 3 ? [[0.62, 0.06, 0.5]] : [[0.3, 0.06, 0.5], [0.44, 0.06, 0.55], [0.37, 0.18, 0.52]]);
          finish();
          break;
        }
        if (!poi.cleared) {
          // Still a crew project: a fenced building site with the materials stacked inside it.
          const post = lambert("#7a5230");
          const rail = lambert("#a07a4c");
          for (const [x, z] of [[-0.55, -0.3], [0.55, -0.3], [-0.55, 0.55], [0.55, 0.55], [0, -0.3]]) add(box(0.06, 0.4, 0.06), post, x, 0.2, z);
          for (const y of [0.16, 0.32]) {
            add(box(1.1, 0.04, 0.03), rail, 0, y, -0.3);
            add(box(0.03, 0.04, 0.85), rail, -0.55, y, 0.125);
            add(box(0.03, 0.04, 0.85), rail, 0.55, y, 0.125);
          }
          // The front is left open, with a board on a post saying what is coming: the trade's colour and its mark.
          add(box(0.04, 0.5, 0.04), post, 0.4, 0.25, 0.62);
          add(box(0.34, 0.22, 0.025), timber, 0.4, 0.46, 0.64);
          add(box(0.3, 0.18, 0.03), roofMat, 0.4, 0.46, 0.645);
          emblem(0.4, 0.46, 0.65, false);
          // A pile of planks, squared stones, the trade's own makings, and a wheelbarrow.
          planks(-0.2, -0.05, 3);
          stones([[0.25, 0.08, -0.05], [0.38, 0.08, 0.1], [0.3, 0.22, 0.02]]);
          makings(-0.1, 0.32);
          add(box(0.2, 0.07, 0.15), wood, 0.32, 0.13, 0.36).rotation.x = 0.12;
          add(new THREE.CylinderGeometry(0.05, 0.05, 0.025, 8), iron, 0.32, 0.05, 0.47).rotation.z = Math.PI / 2;
          for (const x of [0.25, 0.39]) {
            add(box(0.02, 0.02, 0.24), wood, x, 0.12, 0.26).rotation.x = -0.25;
            add(box(0.02, 0.08, 0.02), wood, x, 0.04, 0.3);
          }
          finish();
          break;
        }
        if (kind === "galley") {
          // The galley: a low cookhouse of planks on a stone course under a russet roof, a broad stone chimney stack up the
          // west end, a plank door and a shuttered window, and a serving hatch with its flap propped up over a shelf of
          // bowls. Outside, a cauldron hangs from a tripod over a fire, fish dry on a rack, and provisions stand ready.
          add(box(1.06, 0.08, 0.78), footing, 0, 0.04, 0);
          add(box(1.0, 0.14, 0.72), stone, 0, 0.15, 0);
          add(box(1.02, 0.03, 0.74), timber, 0, 0.235, 0);
          add(box(0.98, 0.34, 0.7), boards, 0, 0.42, 0);
          for (let i = -4; i <= 4; i++) add(box(0.012, 0.34, 0.01), timber, i * 0.11, 0.42, 0.352);
          for (const x of [-0.49, 0.49]) for (const z of [-0.35, 0.35]) add(box(0.06, 0.36, 0.06), timber, x, 0.42, z);
          add(box(1.04, 0.04, 0.76), timber, 0, 0.61, 0);
          roof(0, 0.63, 0, 1.0, 0.48, 0.3, boards, [0.18, 0.36]);
          // The door, and a step.
          add(box(0.24, 0.44, 0.03), timber, 0, 0.3, 0.36);
          add(box(0.18, 0.4, 0.03), trim, 0, 0.28, 0.368);
          for (const y of [0.42, 0.16]) add(box(0.18, 0.012, 0.012), iron, 0, y, 0.387);
          add(box(0.03, 0.03, 0.02), brass, 0.06, 0.28, 0.389);
          add(box(0.3, 0.05, 0.12), footing, 0, 0.025, 0.45);
          framed(-0.32, 0.43, 0.14, 0.14, 0.352);
          // The serving hatch: a warm opening, a shelf of bowls and a loaf under it, and the flap propped open above.
          add(box(0.3, 0.2, 0.012), timber, 0.3, 0.42, 0.352);
          add(box(0.26, 0.16, 0.01), glass, 0.3, 0.42, 0.36).userData.glow = true;
          glows.push({ pos: new THREE.Vector3(0.3, 0.42, 0.5), size: 0.5 });
          add(box(0.34, 0.03, 0.1), wood, 0.3, 0.315, 0.4);
          for (const [x, c] of [[0.2, "#efe6cf"], [0.3, "#b98b5a"]] as [number, string][]) add(new THREE.CylinderGeometry(0.035, 0.025, 0.03, 7), lambert(c), x, 0.345, 0.405);
          add(new THREE.SphereGeometry(0.04, 6, 4), lambert("#c9934a"), 0.4, 0.345, 0.405).scale.set(1.3, 0.7, 1);
          add(box(0.32, 0.02, 0.18), plank, 0.3, 0.54, 0.43).rotation.x = -0.5;
          for (const x of [0.16, 0.44]) add(box(0.012, 0.2, 0.012), wood, x, 0.43, 0.44);
          // The chimney stack, broad and stepped, up the west end; the ambience draws its smoke.
          add(box(0.26, 1.0, 0.32), stone, -0.6, 0.5, -0.05);
          add(box(0.2, 0.42, 0.24), stone, -0.6, 1.2, -0.05);
          add(box(0.26, 0.05, 0.3), footing, -0.6, 1.43, -0.05);
          for (const z of [-0.1, 0.0]) add(new THREE.CylinderGeometry(0.035, 0.045, 0.08, 6), lambert("#b8643a"), -0.6, 1.49, z);
          g.userData.smoke = new THREE.Vector3(-0.6, 1.56, -0.05);
          lantern(-0.55, 0.47, 0.43);
          // The cauldron, hung from a tripod over a fire of crossed logs; its fire throws flickering light over the quay.
          const cx = 0.7, cz = 0.52;
          for (const a of [0.3, 2.4, 4.5]) {
            const dx = Math.cos(a), dz = Math.sin(a);
            const leg = add(new THREE.CylinderGeometry(0.012, 0.014, 0.56, 4), wood, cx + dx * 0.13, 0.26, cz + dz * 0.13);
            leg.rotation.set(-dz * 0.45, 0, dx * 0.45);
          }
          add(box(0.008, 0.12, 0.008), iron, cx, 0.43, cz);
          add(new THREE.SphereGeometry(0.1, 8, 6), lambert("#2e2a2a"), cx, 0.26, cz).scale.y = 0.85;
          add(new THREE.CylinderGeometry(0.085, 0.085, 0.015, 8), lambert("#b98b3a"), cx, 0.32, cz);
          for (const r of [0.5, -0.5]) add(box(0.24, 0.04, 0.04), boards, cx, 0.03, cz, r);
          add(new THREE.ConeGeometry(0.07, 0.12, 5), new THREE.MeshBasicMaterial({ color: "#ff9a3c" }), cx, 0.1, cz).userData.glow = true;
          glows.push({ pos: new THREE.Vector3(cx, 0.12, cz + 0.18), size: 0.36, light: "fire" });
          // A chopping block with a cleaver in it.
          add(new THREE.CylinderGeometry(0.07, 0.08, 0.14, 7), lambert("#6b4a2b"), 0.4, 0.07, 0.62);
          add(box(0.1, 0.06, 0.012), steel, 0.4, 0.17, 0.62, 0.6);
          add(box(0.02, 0.02, 0.08), wood, 0.37, 0.19, 0.66, 0.6);
          // Fish hung to dry on a rack out front.
          for (const x of [-0.44, -0.12]) add(box(0.03, 0.42, 0.03), timber, x, 0.21, 0.6);
          add(box(0.36, 0.025, 0.025), timber, -0.28, 0.41, 0.6);
          for (const [x, c] of [[-0.37, "#9fb3c2"], [-0.28, "#a9b4ba"], [-0.19, "#c4a07a"]] as [number, string][]) {
            add(box(0.008, 0.05, 0.008), lambert("#efe6cf"), x, 0.38, 0.6);
            add(new THREE.ConeGeometry(0.035, 0.15, 4), lambert(c), x, 0.28, 0.6).rotation.x = Math.PI;
            add(box(0.06, 0.03, 0.012), lambert(c), x, 0.36, 0.6);
          }
          // Provisions: barrels and a crate along the east wall, and sacks and crates by the chimney.
          barrel(0.64, -0.06);
          barrel(0.62, -0.26, 0.07, 0.15);
          add(box(0.16, 0.12, 0.16), boards, 0.64, 0.06, 0.16, 0.3);
          add(box(0.22, 0.16, 0.2), boards, -0.62, 0.08, 0.36, 0.2);
          add(box(0.18, 0.12, 0.16), plank, -0.62, 0.22, 0.36, -0.2);
          sack(-0.42, 0.42, 0.4);
          finish();
          break;
        }
        if (kind === "apothecary") {
          // The apothecary: a plastered two-storey shop with a jettied upper floor, dark timbers and a green door and shutters,
          // under a steep green roof with a stone chimney. Bottles glow in the shop window, a green sign swings from a bracket,
          // herbs dry on a rack, a copper still bubbles by the wall, and a little herb bed sits at the door.
          const bottle = (x: number, y: number, z: number, c: string, lit = false) => {
            const m = lit ? new THREE.MeshBasicMaterial({ color: c }) : lambert(c);
            const body = add(new THREE.CylinderGeometry(0.024, 0.026, 0.06, 6), m, x, y + 0.03, z);
            add(new THREE.CylinderGeometry(0.01, 0.012, 0.03, 5), m, x, y + 0.075, z);
            if (lit) body.userData.glow = true;
          };
          const herbs = (x: number, y: number, z: number, c: string) => {
            add(box(0.012, 0.07, 0.012), wood, x, y + 0.035, z);
            add(new THREE.ConeGeometry(0.045, 0.13, 5), lambert(c), x, y - 0.05, z).rotation.x = Math.PI;
          };
          // Footing, stone course, plaster ground floor, the jetty beam, the overhanging upper floor, and the eave beam.
          add(box(1.04, 0.08, 0.78), footing, 0, 0.04, 0);
          add(box(0.96, 0.1, 0.7), stone, 0, 0.13, 0);
          add(box(0.94, 0.28, 0.68), plaster, 0, 0.32, 0);
          add(box(1.0, 0.04, 0.74), timber, 0, 0.47, 0);
          add(box(0.98, 0.3, 0.72), plaster, 0, 0.64, 0);
          add(box(1.02, 0.04, 0.76), timber, 0, 0.81, 0);
          for (const x of [-0.47, 0.47]) for (const z of [-0.34, 0.34]) add(box(0.05, 0.28, 0.05), timber, x, 0.32, z);
          for (const x of [-0.49, 0.49]) for (const z of [-0.36, 0.36]) add(box(0.05, 0.3, 0.05), timber, x, 0.64, z);
          add(box(0.04, 0.3, 0.015), timber, 0, 0.64, 0.37);
          for (const x of [-0.505, 0.505]) for (const tilt of [-0.5, 0.5]) add(box(0.015, 0.04, 0.4), timber, x, 0.64, 0).rotation.x = tilt;
          // The door in a timber frame, a step and stepping stones; the shop window beside it, with a shelf of bottles.
          add(box(0.24, 0.36, 0.03), timber, -0.24, 0.26, 0.345);
          add(box(0.18, 0.32, 0.03), trim, -0.24, 0.25, 0.355);
          add(box(0.18, 0.012, 0.012), iron, -0.24, 0.35, 0.374);
          add(box(0.18, 0.012, 0.012), iron, -0.24, 0.16, 0.374);
          add(box(0.03, 0.03, 0.02), brass, -0.18, 0.25, 0.376);
          add(box(0.3, 0.06, 0.12), footing, -0.24, 0.03, 0.45);
          for (const [x, z, w] of [[-0.24, 0.62, 0.2], [-0.2, 0.76, 0.18]] as [number, number, number][]) add(box(w, 0.02, 0.1), footing, x, 0.01, z);
          framed(0.2, 0.31, 0.3, 0.2, 0.343);
          add(box(0.4, 0.03, 0.09), timber, 0.2, 0.19, 0.385);
          ["#5f9e4a", "#c4473a", "#3f7fb8", "#d9b45a", "#8a5fb0"].forEach((c, i) => bottle(0.06 + i * 0.07, 0.205, 0.385, c, i === 0));
          // Two upper windows, one with a planter of herbs and one of white blooms.
          for (const x of [-0.22, 0.22]) {
            framed(x, 0.65, 0.18, 0.16, 0.362);
            add(box(0.26, 0.055, 0.075), wood, x, 0.53, 0.4);
            add(box(0.22, 0.035, 0.055), lambert("#4f8a3a"), x, 0.57, 0.4);
            for (let i = 0; i < 3; i++) add(box(0.04, x < 0 ? 0.04 : 0.07, 0.04), lambert(x < 0 ? "#f4efe1" : "#6aa34f"), x + (i - 1) * 0.07, x < 0 ? 0.605 : 0.62, 0.4);
          }
          // The roof: a steep gable of plaster under two slabs of green, with darker courses of shingle and a ridge cap.
          roof(0, 0.83, 0, 1.04, 0.46, 0.36, plaster, [0.22, 0.44]);
          // A round window in each gable end, glowing at dusk.
          for (const x of [-0.5, 0.5]) {
            add(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 8), timber, x * 1.03, 0.96, 0).rotation.z = Math.PI / 2;
            add(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 8), glass, x * 1.04, 0.96, 0).rotation.z = Math.PI / 2;
          }
          // The chimney, up the back; the ambience draws its smoke.
          add(box(0.15, 0.5, 0.15), stone, 0.3, 1.05, -0.14);
          add(box(0.2, 0.05, 0.2), footing, 0.3, 1.32, -0.14);
          add(new THREE.CylinderGeometry(0.035, 0.045, 0.07, 6), lambert("#b8643a"), 0.3, 1.385, -0.14);
          g.userData.smoke = new THREE.Vector3(0.3, 1.46, -0.14);
          sign(0.47, 0.76, 0.36);
          lantern(-0.43, 0.37, 0.4);
          // The herb bed in front: a low wooden frame of soil, leafy plants and a few blooms.
          add(box(0.42, 0.07, 0.17), wood, 0.2, 0.035, 0.6);
          add(box(0.38, 0.03, 0.13), lambert("#4a3a2a"), 0.2, 0.075, 0.6);
          for (let i = 0; i < 5; i++) add(box(0.05, 0.05 + (i % 2) * 0.03, 0.05), lambert(["#6aa34f", "#8fb84f", "#5f8f3f"][i % 3]), 0.06 + i * 0.07, 0.1 + (i % 2) * 0.015, 0.6);
          for (const [x, c] of [[0.1, "#c46bd0"], [0.24, "#f4efe1"], [0.31, "#e8c53a"]] as [number, string][]) add(box(0.035, 0.035, 0.035), lambert(c), x, 0.17, 0.6);
          // The drying rack along the west wall, its bundles of herbs hanging from the rail.
          for (const z of [0.22, -0.28]) add(box(0.04, 0.5, 0.04), timber, -0.66, 0.25, z);
          add(box(0.04, 0.04, 0.54), timber, -0.66, 0.5, -0.03);
          for (const [c, z] of [["#6aa34f", 0.16], ["#8fb84f", 0.04], ["#5f8f3f", -0.08], ["#a8b84f", -0.2]] as [string, number][]) herbs(-0.66, 0.44, z, c);
          // A copper still on a stone stand at the front corner: a pot, a dome, a neck to a collecting bottle.
          add(box(0.2, 0.08, 0.2), footing, -0.6, 0.04, 0.5);
          add(new THREE.CylinderGeometry(0.09, 0.1, 0.16, 8), copper, -0.6, 0.16, 0.5);
          add(new THREE.SphereGeometry(0.07, 7, 5), copper, -0.6, 0.27, 0.5);
          add(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 5), copper, -0.5, 0.31, 0.5).rotation.z = Math.PI / 2 - 0.5;
          add(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 5), copper, -0.43, 0.23, 0.5);
          bottle(-0.43, 0.08, 0.5, "#5f9e4a", true);
          add(new THREE.CylinderGeometry(0.095, 0.105, 0.015, 8), brass, -0.6, 0.245, 0.5);
          // A barrel and a sack of ingredients by the east wall.
          barrel(0.64, 0.05, 0.08, 0.18, 0.04);
          sack(0.62, 0.24, 0.3, 0.04);
          finish();
          break;
        }
        // The smithy: an open-fronted forge on a flagged floor, a stone wall on the forge side and a plank half wall on the
        // other, under a slate roof. A stone hearth glows at the back under a hood and a tall chimney, with bellows beside
        // it and tools on the wall; out front an anvil on its block with a glowing bar on it, a quench trough, a
        // grindstone, iron stock, a coal bin, a lantern and a sign with an anvil on it.
        add(box(1.16, 0.06, 0.86), footing, 0, 0.03, 0);
        for (const [x, z, w, d] of [[-0.2, 0.2, 0.3, 0.22], [0.25, -0.05, 0.26, 0.3], [-0.05, 0.3, 0.2, 0.18]] as [number, number, number, number][]) add(box(w, 0.006, d), lambert("#6f7a88"), x, 0.062, z);
        add(box(1.08, 0.3, 0.08), stone, 0, 0.21, -0.36);
        add(box(1.06, 0.34, 0.06), boards, 0, 0.53, -0.36);
        for (let i = -4; i <= 4; i++) add(box(0.012, 0.34, 0.01), timber, i * 0.12, 0.53, -0.326);
        add(box(0.08, 0.64, 0.8), stone, -0.54, 0.38, -0.02);
        add(box(0.05, 0.26, 0.62), plank, 0.54, 0.19, -0.06);
        for (const x of [-0.54, 0.54]) add(box(0.08, 0.66, 0.08), timber, x, 0.39, 0.38);
        add(box(0.08, 0.66, 0.08), timber, 0.54, 0.39, -0.36);
        for (const z of [0.38, -0.36]) add(box(1.16, 0.06, 0.07), timber, 0, 0.72, z);
        for (const s of [-1, 1]) add(box(0.22, 0.04, 0.04), timber, s * 0.44, 0.63, 0.38).rotation.z = s * 0.8;
        roof(0, 0.75, 0.01, 0.86, 0.64, 0.36, boards, [0.2, 0.42], true);
        // The forge: a stone hearth with a lip, coals and flames, a glow, a hood over it, and the chimney up through the roof.
        add(box(0.46, 0.32, 0.4), stone, -0.26, 0.22, -0.14);
        add(box(0.5, 0.04, 0.44), footing, -0.26, 0.4, -0.14);
        add(box(0.3, 0.03, 0.24), new THREE.MeshBasicMaterial({ color: "#ff7a2a" }), -0.26, 0.425, -0.1);
        add(new THREE.ConeGeometry(0.07, 0.14, 5), new THREE.MeshBasicMaterial({ color: "#ffc04a" }), -0.3, 0.5, -0.1);
        add(new THREE.ConeGeometry(0.05, 0.1, 5), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), -0.19, 0.48, -0.06);
        add(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial({ color: "#ff8a3a", transparent: true, opacity: 0.22, depthWrite: false }), -0.26, 0.48, -0.08).userData.glow = true;
        // After dark the coals glow out of the open front and their firelight fills the shed.
        glows.push({ pos: new THREE.Vector3(-0.26, 0.5, 0.14), size: 0.62, light: "fire" });
        add(new THREE.CylinderGeometry(0.1, 0.26, 0.3, 4), stone, -0.26, 0.66, -0.18, Math.PI / 4);
        add(box(0.2, 0.62, 0.2), stone, -0.26, 1.11, -0.22);
        add(box(0.26, 0.06, 0.26), footing, -0.26, 1.45, -0.22);
        g.userData.smoke = new THREE.Vector3(-0.26, 1.54, -0.22);
        // The bellows beside the hearth, its nozzle in the fire.
        add(box(0.04, 0.28, 0.04), timber, 0.14, 0.2, -0.2);
        add(box(0.24, 0.08, 0.18), lambert("#5a3a26"), 0.04, 0.36, -0.2).rotation.z = 0.2;
        for (const dy of [0.05, -0.05]) add(box(0.26, 0.015, 0.2), wood, 0.04, 0.36 + dy, -0.2).rotation.z = 0.2 + dy;
        add(box(0.12, 0.025, 0.025), iron, -0.07, 0.34, -0.2);
        // Tools on the back wall: tongs and hammers on a rail, and horseshoes on pegs.
        add(box(0.34, 0.03, 0.03), timber, 0.3, 0.6, -0.31);
        for (let i = 0; i < 5; i++) {
          add(box(0.015, 0.18, 0.015), steel, 0.18 + i * 0.06, 0.5, -0.3);
          if (i % 2) add(box(0.05, 0.03, 0.03), steel, 0.18 + i * 0.06, 0.42, -0.3);
        }
        for (const x of [0.22, 0.32, 0.42]) add(new THREE.TorusGeometry(0.03, 0.009, 4, 8, Math.PI * 1.4), steel, x, 0.7, -0.31).rotation.z = -Math.PI * 0.2;
        // A bin of coal by the hearth.
        add(box(0.22, 0.1, 0.18), wood, -0.38, 0.11, 0.26);
        for (const [dx, dz, s] of [[-0.04, 0, 0.05], [0.04, 0.03, 0.045], [0.02, -0.04, 0.04], [-0.05, 0.05, 0.035]]) add(new THREE.DodecahedronGeometry(s, 0), lambert("#26242a"), -0.38 + dx, 0.17, 0.26 + dz, dx * 9);
        // The anvil on its block, a hammer on it and a glowing bar.
        add(new THREE.CylinderGeometry(0.11, 0.13, 0.2, 7), lambert("#6b4a2b"), 0.18, 0.16, 0.18);
        add(box(0.14, 0.05, 0.1), steel, 0.18, 0.285, 0.18);
        add(box(0.08, 0.06, 0.07), steel, 0.18, 0.34, 0.18);
        add(box(0.28, 0.06, 0.11), steel, 0.18, 0.4, 0.18);
        add(new THREE.ConeGeometry(0.05, 0.13, 6), steel, 0.385, 0.41, 0.18).rotation.z = -Math.PI / 2;
        add(box(0.1, 0.015, 0.022), new THREE.MeshBasicMaterial({ color: "#ff8a3a" }), 0.22, 0.44, 0.16).userData.glow = true;
        add(box(0.02, 0.02, 0.16), wood, 0.1, 0.44, 0.24, 0.4);
        add(box(0.05, 0.045, 0.045), steel, 0.07, 0.445, 0.17, 0.4);
        // The quench trough and the grindstone on the open side, and iron bars leaning on the half wall.
        add(box(0.3, 0.13, 0.16), boards, 0.74, 0.065, 0.22);
        add(box(0.26, 0.02, 0.12), lambert("#3f7fb8"), 0.74, 0.125, 0.22);
        for (const x of [0.69, 0.79]) add(box(0.03, 0.2, 0.03), wood, x, 0.1, -0.16);
        add(new THREE.CylinderGeometry(0.11, 0.11, 0.045, 10), lambert("#b8b0a0"), 0.74, 0.21, -0.16).rotation.z = Math.PI / 2;
        add(box(0.16, 0.02, 0.02), iron, 0.74, 0.21, -0.16);
        add(box(0.02, 0.08, 0.02), iron, 0.83, 0.17, -0.16);
        for (const [z, c] of [[-0.3, "#6f737a"], [-0.26, "#c8743a"], [-0.22, "#6f737a"]] as [number, string][]) add(box(0.025, 0.42, 0.025), lambert(c), 0.6, 0.24, z).rotation.z = -0.22;
        sign(0.54, 0.66, 0.38);
        lantern(-0.48, 0.5, 0.44);
        finish();
        break;
      }
      case "door":
        // A doormat in the gap, and a post either side of it.
        add(box(0.9, 0.04, 0.5), lambert("#8c3b2f"), 0, 0.02, 0.28);
        for (const x of [-0.8, 0.8]) add(box(0.14, 0.9, 0.14), lambert("#5a3d22"), x, 0.45, 0.28);
        break;
      case "board": {
        // The notice board: a framed back of planks between two squared posts on stone feet, under a little
        // shingled roof to keep the rain off the paper. Notices are pinned all over it, no two alike or quite
        // straight: lines of writing, a wax seal and its ribbon, a wanted sheet, one hanging by a corner. A lantern
        // on a bracket lights it after dark, and a pail of rolled notices stands at its foot.
        const timber = lambert("#5a3d22");
        const dark = lambert("#46301c");
        const stone = lambert("#8b8f96");
        const iron = lambert("#2e2a28");
        const ink = lambert("#4a3a2a");
        const glows: BuildingGlow[] = [];
        // Posts on their feet, capped, braced to the ground behind.
        for (const x of [-0.46, 0.46]) {
          add(box(0.16, 0.07, 0.16), stone, x, 0.035, 0, x * 0.4);
          add(box(0.085, 1.0, 0.085), timber, x, 0.55, 0);
          add(box(0.12, 0.03, 0.12), dark, x, 1.06, 0);
          add(box(0.04, 0.42, 0.04), dark, x, 0.2, -0.13).rotation.x = -0.62;
        }
        // The back: five planks, no two the same brown, in a frame of darker timber.
        const planks = ["#8a6a44", "#7d5f3c", "#927048", "#80623f", "#8c6c46"];
        planks.forEach((tone, i) => add(box(0.158, 0.54, 0.035), lambert(tone), -0.316 + i * 0.158, 0.68, 0));
        for (const y of [0.4, 0.96]) add(box(0.9, 0.05, 0.06), dark, 0, y, 0.005);
        for (const x of [-0.42, 0.42]) add(box(0.05, 0.6, 0.06), dark, x, 0.68, 0.005);
        // The roof: two pitches of shingles in courses, and a ridge board.
        for (const side of [1, -1]) {
          for (let course = 0; course < 2; course++) {
            const out = 0.055 + course * 0.1;
            add(box(1.14 - course * 0.02, 0.022, 0.115), lambert(course ? "#7a4a36" : "#8a5540"), 0, 1.2 - out * 0.62, side * out * 0.86).rotation.x = side * 0.62;
          }
        }
        add(box(1.18, 0.035, 0.05), lambert("#5c3626"), 0, 1.215, 0);
        // The notices: where each is pinned, how big, how far askew, and its paper.
        const front = 0.022;
        const sheet = (x: number, y: number, w: number, h: number, turn: number, paper: string, pin = "#b0392b") => {
          const page = add(box(w, h, 0.006), lambert(paper), x, y, front);
          page.rotation.z = turn;
          // Its pin, at the top; a sheet askew hangs from it.
          add(box(0.022, 0.022, 0.014), lambert(pin), x - Math.sin(turn) * (h / 2 - 0.025), y + Math.cos(turn) * (h / 2 - 0.025), front + 0.008);
          return page;
        };
        /** Lines of writing down a sheet, each a little shorter or longer than the last. */
        const written = (x: number, y: number, w: number, lines: number, turn: number) => {
          for (let i = 0; i < lines; i++) {
            const dy = -i * 0.034;
            add(box(w * (0.72 + ((i * 7) % 3) * 0.1), 0.01, 0.004), ink, x - Math.sin(turn) * dy, y + Math.cos(turn) * dy, front + 0.005).rotation.z = turn;
          }
        };
        sheet(-0.24, 0.76, 0.2, 0.26, 0.05, "#efe4c4");
        written(-0.24, 0.8, 0.15, 4, 0.05);
        // A proclamation, with a red seal and the tail of its ribbon.
        sheet(0.02, 0.74, 0.18, 0.3, -0.03, "#f4efe1", "#c9a227");
        written(0.02, 0.83, 0.13, 3, -0.03);
        add(new THREE.CylinderGeometry(0.026, 0.026, 0.012, 7), lambert("#a02c22"), 0.03, 0.66, front + 0.008).rotation.x = Math.PI / 2;
        add(box(0.018, 0.07, 0.004), lambert("#8c2a22"), 0.045, 0.615, front + 0.006).rotation.z = -0.2;
        // Wanted: a face in a box, a price under it.
        sheet(0.26, 0.79, 0.17, 0.22, 0.08, "#e2d3a8");
        add(box(0.09, 0.09, 0.004), ink, 0.257, 0.815, front + 0.005).rotation.z = 0.08;
        add(box(0.11, 0.012, 0.004), ink, 0.268, 0.725, front + 0.005).rotation.z = 0.08;
        // Small ones crowded in under them, one come loose and hanging by a corner.
        sheet(-0.3, 0.52, 0.12, 0.13, -0.1, "#e8dcc0", "#3f6f8f");
        written(-0.3, 0.545, 0.08, 2, -0.1);
        sheet(0.27, 0.535, 0.13, 0.14, 0.42, "#efe4c4");
        sheet(-0.1, 0.5, 0.1, 0.1, 0.12, "#d9c99a", "#c9a227");
        // The lantern, hung from a bracket off the east post.
        add(box(0.2, 0.022, 0.022), iron, 0.6, 1.0, 0.02);
        add(box(0.012, 0.06, 0.012), iron, 0.68, 0.965, 0.02);
        add(box(0.06, 0.075, 0.06), new THREE.MeshBasicMaterial({ color: "#ffd77a" }), 0.68, 0.895, 0.02).userData.glow = true;
        for (const [dx, dz] of [[-0.035, -0.035], [0.035, -0.035], [-0.035, 0.035], [0.035, 0.035]]) add(box(0.012, 0.09, 0.012), iron, 0.68 + dx, 0.895, 0.02 + dz);
        add(box(0.095, 0.016, 0.095), iron, 0.68, 0.845, 0.02);
        add(new THREE.ConeGeometry(0.07, 0.05, 4), iron, 0.68, 0.96, 0.02, Math.PI / 4);
        glows.push({ pos: new THREE.Vector3(0.68, 0.895, 0.12), size: 0.4 });
        // The pail of rolled notices, and one dropped beside it.
        add(new THREE.CylinderGeometry(0.075, 0.06, 0.13, 8), lambert("#6b4a2b"), -0.5, 0.065, 0.2);
        add(new THREE.CylinderGeometry(0.078, 0.078, 0.016, 8), iron, -0.5, 0.11, 0.2);
        for (const [dx, dz, lean, turn] of [[-0.02, 0.0, 0.2, 0.4], [0.025, 0.015, -0.16, 2.2], [0.0, -0.025, 0.1, 4.0]]) {
          const roll = add(new THREE.CylinderGeometry(0.018, 0.018, 0.22, 6), lambert("#efe4c4"), -0.5 + dx, 0.2, 0.2 + dz, turn);
          roll.rotation.z = lean;
        }
        add(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 6), lambert("#e2d3a8"), -0.3, 0.02, 0.26, 0.5).rotation.z = Math.PI / 2;
        g.userData.glows = glows;
        break;
      }
      case "camp":
        if (this.state?.kind === "caverns") {
          // What lurks in a cave chamber: a heap of old bones and rubble, and (until it is beaten) eyes in the dark.
          const lead = poi.enemies[0];
          for (const [x, z, s] of [[-0.25, 0.05, 0.3], [0.2, 0.15, 0.24], [0.02, -0.12, 0.2]]) add(new THREE.DodecahedronGeometry(s, 0), lambert("#3a3640"), x, s * 0.6, z, x * 5);
          for (const [x, z, r] of [[-0.05, 0.38, 0.4], [0.28, 0.42, -0.7], [-0.32, 0.4, 1.2]]) add(box(0.3, 0.04, 0.05), lambert("#d6cfbd"), x, 0.03, z, r);
          if (lead === "slime" && !poi.cleared) add(new THREE.SphereGeometry(0.26, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), lambert("#5fbf4a"), 0.05, 0.02, 0.3);
          // A troll's den: a gnawed bone the size of a leg, and a boulder it keeps to hand.
          if (lead === "troll" && !poi.cleared) {
            add(new THREE.CylinderGeometry(0.05, 0.06, 0.55, 5), lambert("#e8dcc0"), 0.3, 0.05, 0.3, 1.1).rotation.z = Math.PI / 2;
            add(new THREE.DodecahedronGeometry(0.2, 0), lambert("#6e6a5e"), -0.35, 0.15, 0.3);
          }
          if (lead === "bat" && !poi.cleared) for (const x of [-0.2, 0.2]) add(new THREE.ConeGeometry(0.12, 0.28, 3), lambert("#2a2430"), x, 0.95, -0.1, Math.PI);
          if (!poi.cleared) {
            const eye = new THREE.MeshBasicMaterial({ color: { bat: "#ff4d3a", skeleton: "#9fd8ff", slime: "#b8ff6a", shade: "#c79bff", troll: "#ffc23a" }[lead] ?? "#ff4d3a" });
            for (const x of [-0.07, 0.07]) add(box(0.05, 0.04, 0.02), eye, x, lead === "bat" ? 0.82 : 0.42, 0.12).userData.glow = true;
          }
          break;
        }
        add(new THREE.ConeGeometry(0.48, 0.6, 4), lambert(poi.cleared ? "#777777" : "#b9433d"), -0.2, 0.3, 0, Math.PI / 4);
        if (!poi.cleared) add(new THREE.ConeGeometry(0.1, 0.22, 4), new THREE.MeshBasicMaterial({ color: "#ff9a3c" }), 0.4, 0.11, 0.25);
        break;
      case "crate": {
        // A crate in a delve (caveProps.ts): whole, knocked about, or splinters.
        const model = crateModel(poi);
        g.add(model);
        g.userData.body = model.userData.body;
        if (!poi.cleared) g.userData.door = poi.pos;
        break;
      }
      case "glowcap": {
        // Glowing mushrooms (caveDressing.ts), grown at the foot of the rock: set over toward the wall, off the
        // middle of the hex where a hero stands to pick them.
        const cluster = glowcapCluster(poi.pos.q, poi.pos.r, !!poi.cleared);
        const map = this.state?.map;
        const at = hexToWorld(poi.pos);
        const toward = new THREE.Vector2();
        for (const dir of HEX_DIRS) {
          if (map && tileAt(map, { q: poi.pos.q + dir.q, r: poi.pos.r + dir.r })?.biome !== "rock") continue;
          const w = hexToWorld({ q: poi.pos.q + dir.q, r: poi.pos.r + dir.r });
          toward.add(new THREE.Vector2(w.x - at.x, w.z - at.z));
        }
        if (toward.lengthSq() > 0) toward.normalize().multiplyScalar(0.42);
        const spot = this.inModel(poi, at.x + toward.x, at.z + toward.y);
        cluster.position.set(spot.x, 0, spot.y);
        g.add(cluster);
        // Their light (the ambience's): a little over the caps.
        g.userData.glowAt = new THREE.Vector3(spot.x, 0.45, spot.y);
        // Pointing anywhere on them means their hex.
        g.userData.door = poi.pos;
        break;
      }
    }
    return g;
  }

  // ---------- chests and crates moving ----------

  /** How long a chest's lid takes to swing open, in seconds. */
  private static readonly LID_SWING = 0.5;

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
    if (wait > 0) return this.later(0, land, wait);
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

  /** Each frame: lids swinging, crates rocking, glints twinkling. */
  private movePois() {
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

        const stacks = new Map<string, number>();
    for (const h of state.heroes) stacks.set(key(h.pos), (stacks.get(key(h.pos)) ?? 0) + 1);
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
      want.set(h.id, { kind: h.classId, outfit: h.outfit, pos, size: 1.5, label, plate: label ? plate : undefined, stack: i, ring: colorOf(h.id), through: colorOf(h.id), pulse: state.turn?.heroId === h.id || !!h.active, asleep: h.asleep, rod: h.rod, boat: h.boat, down: h.down, falls: true, prone: h.prone, effects: h.effects, seat: seat?.top });
    }
    for (const npc of state.story?.npcs ?? []) {
      const poi = state.map.pois.find((p) => p.id === npc.poi);
      if (!poi || state.npcs[npc.id]?.hostile) continue;
      const pos = this.standAt(poi.pos);
      pos.x += 0.62;
      want.set(`npc:${npc.id}`, { kind: "npc", pos, size: 1.4 });
    }
    // Bands loose on the island, drawn where they stand while a hero can see them.
    for (const band of state.roamers ?? []) {
      band.kinds.forEach((kind, i) => {
        const pos = this.standAt(band.pos);
        pos.x += (i - (band.kinds.length - 1) / 2) * 0.55;
        pos.z += 0.15;
        want.set(`roam:${band.id}:${i}`, { kind, pos, size: isBig(kind) ? 1.5 : 1.3, ring: i === 0 ? "#ff3b3b" : undefined, pulse: i === 0 });
      });
    }
    // A zone's enemies, each on its own hex.
    for (const u of state.units ?? []) {
      const pos = this.standAt(u.pos);
      pos.z += 0.25;
      want.set(u.id, { kind: u.kind, pos, size: isBoss(u.kind) ? 1.9 : isBig(u.kind) ? 1.6 : 1.4, label: u.name, ring: u.hostile ? ENEMY_RED : undefined, through: u.hostile ? ENEMY_RED : undefined, pulse: !!u.active, hp: u.hp, down: u.down, falls: true, prone: u.prone, effects: u.effects });
    }
    for (const poi of state.map.pois) {
      if (poi.cleared || poi.enemies.length === 0) continue;
      poi.enemies.forEach((kind, i) => {
        const pos = this.standAt(poi.pos);
        pos.x += (i - (poi.enemies.length - 1) / 2) * 0.6 + 0.2;
        pos.z += 0.05;
        want.set(`poi:${poi.id}:${i}`, { kind, pos, size: isBoss(kind) ? 1.7 : isBig(kind) ? 1.5 : 1.3 });
      });
    }

    const turned = new Map<string, number>();
    for (const [id, unit] of this.units) {
      const w = want.get(id);
      // A change of gear is a different model, so the unit is rebuilt, facing the way it was.
      if (w && spriteKey(w.kind, w.outfit, w.asleep, w.rod) === unit.kind) continue;
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
        const figure = makeFigure(w.kind, lookFor(w.kind), w.outfit, { asleep: w.asleep, rod: w.rod });
        for (const f of flamesIn(figure.root)) this.liveFlames.add(f);
        figure.root.position.copy(w.pos);
        this.unitGroup.add(figure.root);
        // New arrivals face the camera, turned a little so what they carry shows.
        const turn = turned.get(id) ?? w.face ?? this.yaw + 0.35;
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
      if (w.down && !unit.down && seen && w.falls) unit.dying = this.clock + 2;
      if (!w.down) unit.dying = undefined;
      unit.down = !!w.down;
      const fell = !!w.down && unit.dying === undefined;
      // Down or asleep: on their back, low to the ground.
      unit.lying = fell || !!w.asleep || !!w.prone;
      unit.head = unit.lying ? w.size * LYING + 0.3 : w.size + 0.3;
      unit.stack = w.stack ?? 0;
      unit.size = w.size;
      unit.figure.setSize(w.size);
      unit.figure.setDim(fell);
      // A hero always, and an enemy once it is in a fight, is shown through the tree or wall it is behind.
      unit.figure.setSilhouette(this.seeThrough ? (w.through ?? null) : null);
      if (w.face !== undefined) unit.turnGoal = w.face;
      // Someone set to face a given way (seated, casting a line, lined up for a fight) is not turned by the pointer.
      if (w.face !== undefined) this.posed.add(id);
      else this.posed.delete(id);
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
    const depth = -label.position.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
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
    const labelKey = lw.label ? plateKey(lw.label, plate) : "";
    if (labelKey !== unit.labelText) {
      this.dropLabel(unit);
      unit.labelText = labelKey;
      if (lw.label) {
        const { texture, aspect } = labelTexture(lw.label, plate);
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
    const budget = state.freeRoam ? FREE_ROAM_REACH : state.turn?.mp;
    if (!reach || reach.cost === 0 || !me || (budget === undefined && !state.reach)) return;
    // The reach carries its own way back to the start, whether it was handed in or found over the terrain.
    const steps: HexPos[] = [];
    for (let at: typeof reach | undefined = reach; at && at.prev !== null; at = this.reach.get(at.prev)) steps.unshift(at.pos);
    for (const step of steps) {
      // The way there: small lights, glowing rather than solid.
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: "#eaf6ff", transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      const p = this.standAt(step);
      dot.position.set(p.x, p.y + 0.2, p.z);
      this.pathGroup.add(dot);
    }
  }

  private pick(): HexPos | null {
    if (!this.terrain) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((this.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.pointer.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // A figure stands up out of its hex, so a click on it (or on the plate over its head) would
    // otherwise land on the ground behind. Clicking someone (other than yourself) means the hex they stand on.
    {
      const others = [...this.units.entries()].filter(([id]) => id !== this.state?.you).map(([, u]) => u);
      const onFigure = this.raycaster.intersectObjects(others.flatMap((u) => (u.label ? [u.root, u.label] : [u.root])), true)[0];
      const within = (root: THREE.Object3D, o: THREE.Object3D | null): boolean => !!o && (o === root || within(root, o.parent));
      const unit = onFigure && others.find((u) => u.label === onFigure.object || within(u.root, onFigure.object));
      if (unit) {
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
    // A building stands up out of several hexes: pointing at it means its door, not the ground behind its roof.
    if (this.poiGroup.visible) {
      const places = this.poiGroup.children.filter((g) => g.userData.door && g.visible);
      const onPlace = this.raycaster.intersectObjects(places, true)[0];
      if (onPlace && (!hit || onPlace.distance < hit.distance)) {
        let o: THREE.Object3D | null = onPlace.object;
        while (o && !o.userData.door) o = o.parent;
        if (o) return { ...(o.userData.door as HexPos) };
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
    this.pitchGoal = this.userPitch;
    if (!ease) this.pitch = this.userPitch;
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
      this.userDist = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.pinch.zoom * Math.pow(this.pinch.dist / now.dist, PINCH_DAMPING)));
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
    // Nobody walks during a fight, and a practice bout borrows the Harbor's view.
    if (pos) this.callbacks.onHexClick(pos);
  };

  private onPointerLeave = () => {
    if (this.touches.size > 0) return;
    this.pointer.inside = false;
    this.setHovered(null);
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
    this.userDist = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.userDist * Math.exp(step)));
    this.dist = this.userDist;
  };

  private setHovered(pos: HexPos | null) {
    if ((pos && this.hovered && key(pos) === key(this.hovered)) || (!pos && !this.hovered)) return;
    this.hovered = pos;
    this.updatePath();
    if (this.state) this.buildJoinRanges(this.state);
    this.callbacks.onHover(pos);
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
      // Where on the ground the pointer is, for your hero to look toward.
      const ground = this.terrain ? this.raycaster.intersectObject(this.terrain)[0] : undefined;
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
    this.camDist += (this.dist - this.camDist) * ease;
    this.yaw += (this.yawGoal - this.yaw) * ease;
    this.pitch += (this.pitchGoal - this.pitch) * ease;
    const reach = this.camDist * CAMERA_REACH;
    const flat = reach * Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * flat,
      this.target.y + reach * Math.sin(this.pitch),
      this.target.z + Math.cos(this.yaw) * flat,
    );
    this.camera.lookAt(this.target);
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
    // The table lanterns burn brighter over a table someone is standing at.
    const heroes = this.state?.heroes;
    this.tableLamps.update(dt, (hex) => !!heroes?.some((h) => h.pos.q === hex.q && h.pos.r === hex.r));
    this.ambience.update(this.clock, this.yaw, this.target, this.state?.you ? this.units.get(this.state.you)?.root.position : undefined);
    // Whoever walks through the woods pushes the trees aside.
    // Everyone on their feet on the map: the trees they brush past bend aside, and the grass they wade through parts.
    const walkers = [...this.units.values()].filter((u) => u.root.visible).map((u) => u.root.position);
    this.woods?.update(dt, walkers);
    if (!this.opts.backdrop) setFieldWalkers(walkers, this.target, dt);
    // Sounds are heard from where your hero stands, or from the middle of the view without one.
    const ear = (this.state?.you ? this.units.get(this.state.you)?.root.position : undefined) ?? this.target;
    this.ear.listener(ear.x, ear.z, this.yaw);
    this.ear.sky(this.ambience.sky());
    // Where the sea lies changes slowly: work it out a few times a second.
    if (this.frames++ % 8 === 0) {
      this.ear.sea(nearWater(ear.x, ear.z, this.water));
      this.ear.ground(this.state ? (tileAt(this.state.map, worldToHex(ear.x, ear.z - 0.25))?.biome ?? null) : null);
    }
    // In the caverns the lights follow the heroes who carry a torch as they walk (in the old delves, every hero),
    // and a torch thrown down lights where it lies. Nearest the view first: there are only so many lights.
    if (this.state?.kind === "caverns") {
      const torches: THREE.Vector3[] = [];
      const lit = this.state.lights !== undefined;
      for (const h of this.state.heroes) {
        const unit = this.units.get(h.id);
        if (unit && (!lit || h.torch)) torches.push(unit.root.position);
      }
      // A torch on the ground lights from just over its flame.
      for (const t of this.groundTorches.children) torches.push(t.position.clone().setY(t.position.y + 0.55 - TORCH_LIFT));
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
    // Night reaches the open sea and the fog too, not just the lit ground.
    const night = this.ambience.night;
    (this.sea.material as THREE.MeshLambertMaterial).color.copy(this.seaBase).lerp(NIGHT_SEA, night * 0.8);
    // Night life and the night sky on the water: out under an open sky as the light goes, and hidden by cloud.
    // Rain on the land: the ground wets in a few seconds and takes most of a minute to dry.
    const raining = this.ambience.openSky ? this.ambience.raining : 0;
    // Wind: a breeze on a clear day, stronger in rain, and a gale in a storm. None indoors or underground.
    updateWind(this.clock, fancy.get() && this.ambience.openSky ? 0.35 + 0.45 * raining + 0.6 * this.ambience.storming : 0);
    this.wet += (raining - this.wet) * Math.min(1, dt * (raining > this.wet ? 0.3 : 0.04));
    if (this.terrain) setGroundWet(this.terrain.material as THREE.Material, this.wet);
    // And lightning, in a storm only: a downpour has none. The thunder is heard either way; the flash and
    // the bolt are fancy graphics.
    // Indoors the storm is still going on outside: the thunder comes through the walls and the flash
    // through the windows. Underground there is neither.
    const inRoom = !this.ambience.openSky && !this.ambience.underground;
    // A backdrop has no storm of its own (the thunder would be heard twice): it is lent the flash of the view showing it.
    if (!this.opts.backdrop) this.storm.update(dt, this.ambience.underground ? 0 : this.ambience.sky().storm, this.camera, this.target, inRoom);
    this.showOutlook();
    this.storm.bolt.visible &&= fancy.get();
    const lively = fancy.get() && this.ambience.openSky ? night : 0;
    this.nightLife.setLamps(this.ambience.lampSpots());
    this.nightLife.update(this.clock, lively);
    // Gulls keep to fair daylight: they are gone by night and in a storm.
    this.gulls.update(dt, walkers, this.ambience.openSky ? (1 - night) * (1 - this.ambience.storming) : 0);
    const clearSky = lively * (1 - this.ambience.overcast);
    // The moon's reflection lies on the sea off the island's shore, on the side the moon is on.
    const moon = this.ambience.sunDir;
    const across = Math.hypot(moon.x, moon.z) || 1;
    const offshore = this.land.reach + 4;
    setWaterNight(clearSky, this.land.x + (moon.x / across) * offshore, this.land.z + (moon.z / across) * offshore, Math.max(0, (clearSky - 0.55) / 0.45));
    this.ambience.smoothSea = fancy.get();
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
        const next = unit.path[0].clone();
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
        const goal = unit.goal.clone().add(unit.kick);
        p.lerp(goal, 1 - Math.exp(-dt * 14));
        unit.kick.multiplyScalar(Math.exp(-dt * 9));
      }
      // At a stool: up onto it once they have walked to it, and off it again as they leave.
      const atSeat = !!unit.seated && unit.path.length === 0 && !unit.lying && Math.hypot(unit.goal.x - p.x, unit.goal.z - p.z) < 0.08;
      if (atSeat || unit.sit) unit.sit = atSeat ? Math.min(1, (unit.sit ?? 0) + dt / SIT_S) : Math.max(0, (unit.sit ?? 0) - dt / STAND_S);
      unit.lean *= Math.exp(-dt * 8);
      // Your own hero, standing idle, looks toward the pointer; with the bag open they turn to face you.
      if (id === this.state?.you && unit.path.length === 0 && !unit.asleep && !unit.lying && !this.minigame && !this.posed.has(id)) {
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
        else if (!unit.asleep && !unit.lying && !this.posed.has(id)) unit.turnGoal = this.looks.get(id)!;
      }
      // A sleeper lies with their head toward the left of the view, as the bedrolls are laid.
      if (unit.asleep) unit.turnGoal = this.yaw + Math.PI / 2;
      unit.turn += turnBy(unit.turn, unit.turnGoal) * (1 - Math.exp(-dt * 12));
      unit.root.rotation.y = unit.turn;
      if (unit.dying !== undefined && this.clock >= unit.dying) this.topple(id);
      const rowing = this.rowingPose(unit, p, dt);
      if (rowing === undefined) unit.oarPull = undefined;
      unit.figure.update({ time: this.clock, stride: unit.stride, walking: unit.path.length > 0 && !unit.rush && !unit.leap, lean: unit.lean, lying: unit.lying || this.clock < (unit.floored ?? 0), rowing, sitting: unit.boatKind === "rowboat" && unit.boat?.visible ? 1 : unit.sit || undefined });
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
      for (const a of unit.arrows ?? []) {
        a.sprite.position.set(p.x + a.off.x, ground + a.off.y, p.z + a.off.z);
        a.sprite.material.rotation = a.rot + unit.lean;
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
      this.air.outdoors = this.ambience.openSky;
      this.air.clock = this.clock;
      this.air.sunDir = this.ambience.sunDir;
      this.ambience.sunGlint(this.air.sun);
      this.air.sky = this.scene.background as THREE.Color;
      this.air.overcast = this.ambience.overcast;
      this.air.sunHeight = this.ambience.sunHeight;
      // In a room the flash is only what comes in at the windows.
      this.air.flash = this.opts.backdrop ? this.lentFlash : this.storm.flash * (this.ambience.openSky ? 1 : 0.4);
      this.post.render(this.scene, this.camera, focus, this.ambience.night, this.air);
    }
    else this.renderer.render(this.scene, this.camera);
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
