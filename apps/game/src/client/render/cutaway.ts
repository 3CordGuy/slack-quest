// The combat view: what stands in the way of a fight stops hiding it.
//
// A battle map is full of tall things (trees, walls, the rock of a cave), and
// from any one side some of them stand between the camera and the hexes, the
// fighters and the marks on the ground that a turn is read from. While this
// view is on, they give way:
//
//   - Walls, towers, pillars and a cave's rock SINK to a low kerb: their foot
//     still stands, so the hex is still plainly blocked, and the room behind
//     can be seen over it.
//   - Trees, tents, arches and the like turn to GHOSTS: the foot stays solid
//     and the rest thins to a fine stipple that the ground shows through.
//   - Tall grass lies lower.
//
// It is done in the shaders of the scenery's own materials, from a few
// numbers shared by all of them: how far on the view is, where the eye is,
// and a handful of "spots" (the fighters, the hero whose turn it is with as
// much ground as their turn can cover, the hex under the pointer). Each
// corner of the scenery works out whether the line of sight from the eye
// through the thing it belongs to comes down near one of those spots, and
// gives way by that much: so it is what stands on the camera's side of the
// fight that goes, and what stands beyond it stays as a backdrop. A wall
// sinks only for that. Ghosts and grass also give way a little wherever
// they stand, so the whole map opens up somewhat while the view is on.
//
// Nothing is built again and nothing is sorted: a wall's corners are moved
// down in the vertex shader (each hex's piece as one thing, so a run of wall
// comes down in steps), and a ghost is made by leaving out pixels in a fixed
// pattern (so depth, shadows and the shapes of figures seen through things
// all go on working). Turning the camera only changes the eye. The cost is
// a short loop over the spots for each corner of scenery, on the graphics
// card, and nothing at all while the view is off.
//
// Shadows are left as they were: a wall cut down for the view still throws
// the shadow of the wall that is there, and a cave is lit as it really is.
//
// Like the rise (rise.ts), the numbers are one set shared by every material,
// so a view hands its own over before it draws (`CombatView.frame`) and takes
// them away after (`CombatView.clear`): any other view draws as it always did.

import * as THREE from "three";

/**
 * How a corner of marked scenery gives way: the second number of its `aCut`. The first is the height of the
 * ground it stands on, and the last two where on the map (x, z) the thing it is part of stands.
 */
export const CUT_NONE = 0;
export const CUT_SINK = 1;
export const CUT_GHOST = 2;

/** How many spots of play the shaders are told of. */
const SPOTS = 12;
/** What is left standing of something sunk, in world units above its foot; and how much of the rest (so a tower's stump is a little taller than a wall's). */
const SINK_H = 0.5;
const SINK_LEFT = 0.05;
/** How high a wall is taken to stand when working out what it hides. */
const SINK_REF = 2.7;
/** A ghost is whole up to the first height above its foot, and as thin as it gets by the second. */
const GHOST_FROM = 0.42;
const GHOST_FULL = 1.0;
/** The most of a ghost's pixels that are left out. */
const GHOST_MOST = 0.875;
/** How much less of a face is left out when it is seen edge on than when it is seen square on. */
const GHOST_RIM = 0.6;
/** What hides only the ground beyond a spot (further from the eye than whoever stands there) counts as this many times further off. */
const BEHIND = 2.4;
/** Past the edge of what a spot keeps clear, things give way less and less over this far (world units), and then not at all for its sake. */
const EDGE = 2.4;
/** How much everything that can give way does, wherever it stands, as a share of the most. */
const LITE = 0.25;
/** Seconds to come fully on or go fully off; hardly any for whoever asked for less motion. */
const EASE_S = 0.45;
const EASE_STILL_S = 0.08;

const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * `gqCut`: how far on the view is (0 to 1), and the share everything gets. `gqCutEye`: where the camera is.
 * `gqCutSpots`: each spot of play (x, y, z of the ground there) and in w how far round it is kept clear (0: unused).
 */
const UNIFORMS = {
  gqCut: { value: new THREE.Vector4(0, LITE, 0, 0) },
  gqCutEye: { value: new THREE.Vector3() },
  gqCutSpots: { value: Array.from({ length: SPOTS }, () => new THREE.Vector4()) },
};

const f = (n: number) => n.toFixed(4);

const HEAD = /* glsl */ `
uniform vec4 gqCut;
uniform vec3 gqCutEye;
uniform vec4 gqCutSpots[${SPOTS}];
varying float vGqGhost;
// How surely something at (x, z) of the ground, anywhere between two heights, stands between the eye and a spot
// of play: the line of sight through each height comes down to the spot's own ground somewhere, and the stretch
// of ground between those two places is what the thing hides. It gives way if that stretch comes near the spot;
// much nearer, if all of it lies beyond the spot, where it hides only what is behind whoever stands there.
float gqCutShare( vec2 at, float y0, float y1 ) {
	vec2 away = at - gqCutEye.xz;
	float reach = max( length( away ), 1e-4 );
	vec2 way = away / reach;
	float most = 0.0;
	for ( int i = 0; i < ${SPOTS}; i++ ) {
		vec4 spot = gqCutSpots[ i ];
		if ( spot.w <= 0.0 ) continue;
		float drop = gqCutEye.y - spot.y;
		vec2 eye = gqCutEye.xz - spot.xz;
		float from = dot( eye, way );
		float hither = from + reach * max( 1.0, drop / max( gqCutEye.y - y0, 0.05 ) );
		float yonder = from + reach * max( 1.0, drop / max( gqCutEye.y - y1, 0.05 ) );
		float along = clamp( 0.0, hither, yonder );
		if ( along > 0.0 ) along *= ${f(BEHIND)};
		float aside = eye.x * way.y - eye.y * way.x;
		most = max( most, 1.0 - smoothstep( spot.w, spot.w + min( ${f(EDGE)}, spot.w * 1.2 + 0.4 ), length( vec2( aside, along ) ) ) );
	}
	return most;
}
`;

const FRAGMENT_HEAD = /* glsl */ `
varying float vGqGhost;
// A fixed pattern of sixteen thresholds, four pixels by four: leaving out the pixels under a threshold thins a
// surface evenly, with no blending and nothing to sort.
float gqStipple( vec2 p ) {
	const float order[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
	ivec2 cell = ivec2( mod( p, 4.0 ) );
	return ( order[ cell.x + cell.y * 4 ] + 0.5 ) / 16.0;
}
void main() {
	if ( vGqGhost > 0.004 && gqStipple( gl_FragCoord.xy ) < vGqGhost * ${f(GHOST_MOST)} ) discard;
`;

export interface CutawayOptions {
  /**
   * Where each corner's foot and manner come from. "marked": the geometry carries `aCut` (the height of the ground
   * it stands on, in the world; CUT_NONE, CUT_SINK or CUT_GHOST; and where the thing it belongs to stands).
   * Otherwise it is an InstancedMesh of things standing upright, each on the point `foot` of its own geometry
   * (its y), and they all sink or all ghost.
   */
  how: "marked" | "sink" | "ghost";
  foot?: number;
  /** For "sink": each corner sinks by where it is itself, not the whole instance by where it stands (a patch of grass, blade by blade). */
  loose?: boolean;
  /** For "sink": what is left standing, how much of the rest, and how tall the thing is taken to be. A wall's, left out. */
  keep?: number;
  left?: number;
  tall?: number;
  /** For "sink": the share it gives way by wherever it stands (a wall's is none: only what is in the way sinks). */
  everywhere?: number;
}

/**
 * Makes a material take part in the combat view. It draws exactly as before while the view is off. Goes on top
 * of whatever the material already does to its shader (the wind in the trees and the grass).
 */
export function addCutaway(material: THREE.Material, opts: CutawayOptions) {
  const marked = opts.how === "marked";
  const keep = opts.keep ?? SINK_H;
  const left = opts.left ?? SINK_LEFT;
  const tall = opts.tall ?? SINK_REF;
  const everywhere = opts.everywhere ?? 0;
  const foot = /* glsl */ `( modelMatrix * instanceMatrix * vec4( 0.0, ${f(opts.foot ?? 0)}, 0.0, 1.0 ) ).y`;
  // A ghost keeps more of itself where its faces turn away from the eye, so its outline is still drawn: the faces
  // seen square on go first. (Only where the material works out its normals: one that is lit.)
  const rim = (material as THREE.MeshLambertMaterial).isMeshLambertMaterial
    ? /* glsl */ ` * ( 1.0 - ${f(GHOST_RIM)} * pow( 1.0 - abs( dot( normalize( transformedNormal ), normalize( ( viewMatrix * vec4( gqCutEye - gqAt.xyz, 0.0 ) ).xyz ) ) ), 2.0 ) )`
    : "";
  const body = /* glsl */ `
	vGqGhost = 0.0;
	if ( gqCut.x > 0.0 ) {
		vec4 gqAt = modelMatrix * mvPosition;
		float gqFoot = ${marked ? "aCut.x" : foot};
		float gqHow = ${marked ? "aCut.y" : opts.how === "ghost" ? "2.0" : "1.0"};
		vec2 gqStands = ${marked ? "aCut.zw" : opts.loose ? "gqAt.xz" : "( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz"};
		float gqUp = gqAt.y - gqFoot;
		if ( gqHow > 1.5 ) {
			// A ghost: by where this very point is, so only the boughs that are in the way go.
			if ( gqUp > ${f(GHOST_FROM)} ) vGqGhost = gqCut.x * mix( gqCut.y, 1.0, gqCutShare( gqAt.xz, gqAt.y, gqAt.y ) ) * smoothstep( ${f(GHOST_FROM)}, ${f(GHOST_FULL)}, gqUp )${rim};
		} else if ( gqHow > 0.5 && gqUp > ${f(keep)} ) {
			// Sunk: by where the thing stands, the same for every corner of it, so it comes down in one piece and never folds.
			float gqBy = gqCut.x * mix( ${f(everywhere)}, 1.0, gqCutShare( gqStands, gqFoot + ${f(keep)}, gqFoot + ${f(tall)} ) );
			mvPosition.y -= ( gqUp - ${f(keep)} ) * ${f(1 - left)} * gqBy;
		}
	}
`;
  const before = material.onBeforeCompile;
  const beforeKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    before.call(this, shader, renderer);
    Object.assign(shader.uniforms, UNIFORMS);
    // The few lines every mesh is placed by (rise.ts's version of them): the cut goes in once a corner is where
    // its instance puts it, and before the camera has it.
    const placed = /(#ifdef USE_INSTANCING\s+mvPosition = instanceMatrix \* mvPosition;\s+#endif)/;
    const chunk = THREE.ShaderChunk.project_vertex;
    if (!placed.test(chunk) || !shader.vertexShader.includes("#include <project_vertex>")) return;
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", `${marked ? "attribute vec4 aCut;\n" : ""}${HEAD}\nvoid main() {`)
      .replace("#include <project_vertex>", chunk.replace(placed, `$1\n${body}`));
    shader.fragmentShader = shader.fragmentShader.replace("void main() {", FRAGMENT_HEAD);
  };
  material.customProgramCacheKey = function () {
    return `${beforeKey.call(this)}|gq-cut-${opts.how}-${opts.foot ?? 0}-${keep}-${left}-${tall}-${everywhere}-${!!opts.loose}`;
  };
  material.needsUpdate = true;
}

/** The same sum as the shaders', for what is moved by hand. */
function share(x: number, z: number, y0: number, y1: number): number {
  const eye = UNIFORMS.gqCutEye.value;
  const reach = Math.max(Math.hypot(x - eye.x, z - eye.z), 1e-4);
  const [wx, wz] = [(x - eye.x) / reach, (z - eye.z) / reach];
  let most = 0;
  for (const spot of UNIFORMS.gqCutSpots.value) {
    if (spot.w <= 0) continue;
    const drop = eye.y - spot.y;
    const [ex, ez] = [eye.x - spot.x, eye.z - spot.z];
    const from = ex * wx + ez * wz;
    const near = from + reach * Math.max(1, drop / Math.max(eye.y - y0, 0.05));
    const far = from + reach * Math.max(1, drop / Math.max(eye.y - y1, 0.05));
    let along = Math.min(Math.max(0, near), far);
    if (along > 0) along *= BEHIND;
    const k = Math.min(1, Math.max(0, (Math.hypot(ex * wz - ez * wx, along) - spot.w) / Math.min(EDGE, spot.w * 1.2 + 0.4)));
    most = Math.max(most, 1 - k * k * (3 - 2 * k));
  }
  return most;
}

/**
 * How high a point on something that sinks is drawn right now: `y` in the world, on a thing that stands at
 * (x, z) with its foot at `foot`. For what is fixed to a wall and is not part of its mesh (a torch's flame).
 * Only between a view's `frame` and its `clear`: at any other time nothing is sunk.
 */
export function sunkY(y: number, foot: number, x: number, z: number): number {
  const on = UNIFORMS.gqCut.value.x;
  const up = y - foot;
  if (on <= 0 || up <= SINK_H) return y;
  return y - (up - SINK_H) * (1 - SINK_LEFT) * on * share(x, z, foot + SINK_H, foot + SINK_REF);
}

/** A spot of play: the ground somebody stands on (or the hex under the pointer), and how far round it is kept clear. */
export interface CutSpot {
  id: string;
  x: number;
  y: number;
  z: number;
  r: number;
}

const KEY = "gq.combat.view";
const read = (k: string): string | null => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) sessionStorage.removeItem(k);
    else sessionStorage.setItem(k, v);
  } catch {
    // Blocked storage: the choice lasts as long as the view does.
  }
};

/**
 * One view's combat view: whether it is on, how far on it has got, and the spots it keeps clear.
 *
 * It comes on by itself when a fight starts and goes off when it ends. The player can switch it either way at any
 * time (`toggle`): out of a fight the choice is kept for the session, and is what the view goes back to when a
 * fight ends; in a fight it stands until that fight is over, and the next one turns the view on again.
 */
export class CombatView {
  /** Offered at all: a battle map's view says so (`setFight`), and no other view has it. */
  enabled = false;
  /** Asked for right now. */
  on = false;
  /** How far on it is, 0 to 1, eased. */
  shown = 0;
  /** In a fight right now, and on what map. */
  fighting = false;
  private map = "";
  private gone = 0;
  private live = new Map<string, { at: THREE.Vector3; r: number; w: number; want: boolean; rank: number }>();
  /** Called when `on` or `enabled` changes, for the button. */
  onChange: (() => void) | null = null;

  /**
   * Told by a battle map's view, whenever it changes: whether your hero is in a fight. `map` names the map, so a
   * view switched off in the middle of a fight stays off if the page is loaded again before the fight is over.
   */
  setFight(fighting: boolean, map: string) {
    const first = !this.enabled || map !== this.map;
    if (!first && fighting === this.fighting) return;
    this.enabled = true;
    this.map = map;
    if (first) {
      // Come upon as it stands: a fight already going is one it was (or was not) switched off in.
      this.on = fighting ? read(`${KEY}.off`) !== map : read(KEY) === "on";
    } else {
      // A fight starting turns it on whatever was chosen in the last one; a fight ending goes back to what is chosen for walking about.
      write(`${KEY}.off`, null);
      this.on = fighting ? true : read(KEY) === "on";
    }
    this.fighting = fighting;
    this.onChange?.();
  }

  toggle() {
    if (!this.enabled) return;
    this.on = !this.on;
    if (this.fighting) write(`${KEY}.off`, this.on ? null : this.map);
    else write(KEY, this.on ? "on" : null);
    this.onChange?.();
  }

  /**
   * Once a frame, before anything is drawn: ease on or off, and hand the shaders this view's numbers. `spots`
   * are the places to keep clear, the most important first (there is room for a dozen).
   */
  frame(dt: number, eye: THREE.Vector3, spots: CutSpot[]) {
    const goal = this.enabled && this.on ? 1 : 0;
    dt = Math.max(0, dt);
    const step = dt / (still ? EASE_STILL_S : EASE_S);
    this.gone = goal > this.gone ? Math.min(goal, this.gone + step) : Math.max(goal, this.gone - step);
    this.shown = this.gone * this.gone * (3 - 2 * this.gone);
    const slots = UNIFORMS.gqCutSpots.value;
    if (this.shown <= 0) {
      this.live.clear();
      UNIFORMS.gqCut.value.x = 0;
      return;
    }
    // Each spot comes in and goes out over a moment (it grows from nothing, and shrinks back), and follows whoever
    // it is under; the one under the pointer glides from hex to hex.
    for (const s of this.live.values()) s.want = false;
    spots.forEach((spot, rank) => {
      let s = this.live.get(spot.id);
      if (!s) this.live.set(spot.id, (s = { at: new THREE.Vector3(spot.x, spot.y, spot.z), r: spot.r, w: 0, want: true, rank }));
      s.want = true;
      s.rank = rank;
      s.r += (spot.r - s.r) * Math.min(1, dt * 6);
      if (still || spot.id !== "hover") s.at.set(spot.x, spot.y, spot.z);
      else s.at.lerp(_v.set(spot.x, spot.y, spot.z), Math.min(1, dt * 12));
    });
    const rate = still ? 1 : Math.min(1, dt * 5);
    for (const [id, s] of this.live) {
      s.w += ((s.want ? 1 : 0) - s.w) * rate;
      if (!s.want && s.w < 0.02) this.live.delete(id);
    }
    const shown = [...this.live.values()].sort((a, b) => Number(b.want) - Number(a.want) || a.rank - b.rank).slice(0, SPOTS);
    for (let i = 0; i < SPOTS; i++) {
      const s = shown[i];
      if (s) slots[i].set(s.at.x, s.at.y, s.at.z, s.r * s.w);
      else slots[i].set(0, 0, 0, 0);
    }
    UNIFORMS.gqCut.value.x = this.shown;
    UNIFORMS.gqCutEye.value.copy(eye);
  }

  /** After the view has drawn: whatever draws next draws plainly. */
  clear() {
    UNIFORMS.gqCut.value.x = 0;
  }
}

const _v = new THREE.Vector3();

/** The button's picture: a figure seen through the broken outline of what stood in front of it. */
const ICON = [
  "#.##.##.##.",
  "..........#",
  "#....#.....",
  "....###...#",
  "#...###....",
  ".....#....#",
  "#..#####...",
  ".....#....#",
  "#...#.#....",
  "....#.#...#",
  "###########",
];

/** The combat view's button, for the column of camera buttons: lit while the view is on. */
export function cutawayButton(view: CombatView): HTMLButtonElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${ICON[0].length} ${ICON.length}`);
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("pixel-glyph");
  ICON.forEach((row, y) =>
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
  const b = document.createElement("button");
  b.type = "button";
  b.className = "camera-cutaway";
  b.appendChild(svg);
  b.setAttribute("aria-label", "Combat view");
  b.addEventListener("click", () => view.toggle());
  const show = () => {
    b.hidden = !view.enabled;
    b.setAttribute("aria-pressed", String(view.on));
    b.title = view.on ? "Combat view is on: trees and walls in the way are cut away (V)" : "Combat view: see past the trees and walls in the way (V)";
  };
  view.onChange = show;
  show();
  return b;
}
