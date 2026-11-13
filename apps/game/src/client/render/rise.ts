// A place rising out of the dark as you arrive: the hex you stand on is there
// first, and the rest grow up round it in a widening ring, each hex with
// everything on it (its ground, grass, trees, buildings, furniture, whoever
// stands there) coming up together as one piece.
//
// Nothing in the scene is touched to do it. Every mesh in three.js is placed
// by the same few lines of vertex shader (the `project_vertex` chunk); this
// replaces them with a version that, while a rise is under way, finds which
// hex a point is in and how far that hex is from the middle, and holds the
// point down toward sea level until the ring reaches it. The numbers it works
// from are one small array shared by every material, so a view sets them
// before it draws and clears them after: any other view (the Harbor behind
// the pub's windows, a portrait) draws as it always did.

import * as THREE from "three";

/** What the shader reads: the middle (x, z), how far out the ring has got, and 1 while a rise is under way. */
const RISE = ((globalThis as { __gqRise?: Float32Array }).__gqRise ??= new Float32Array(4));

/** How wide the ring is, in world units: a hex is this far behind the front when it has finished coming up. */
const BAND = 4.5;
/** How fast the front moves out, in world units a second. */
const SPEED = 11;
/** Nothing further than this from the middle takes part: the open sea and the sky are simply there. */
const REACH = 60;

const CHUNK = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
bool gqSunk = false;
if ( gqRise.w > 0.5 ) {
	vec4 gqAt = modelMatrix * mvPosition;
	// The hex this point is in (pointy hexes a unit to a corner, as the map lays them), and its middle.
	float gqR = gqAt.z / 1.5;
	float gqQ = gqAt.x / 1.7320508 - gqR * 0.5;
	vec3 gqCube = vec3( gqQ, -gqQ - gqR, gqR );
	vec3 gqNear = floor( gqCube + 0.5 );
	vec3 gqOff = abs( gqNear - gqCube );
	if ( gqOff.x > gqOff.y && gqOff.x > gqOff.z ) gqNear.x = -gqNear.y - gqNear.z;
	else if ( gqOff.y <= gqOff.z ) gqNear.z = -gqNear.x - gqNear.y;
	vec2 gqHex = vec2( 1.7320508 * ( gqNear.x + gqNear.z * 0.5 ), 1.5 * gqNear.z );
	float gqFar = distance( gqHex, gqRise.xy );
	if ( gqFar < ${REACH.toFixed(1)} ) {
		float gqUp = clamp( ( gqRise.z - gqFar ) / ${BAND.toFixed(1)}, 0.0, 1.0 );
		if ( gqUp <= 0.0 ) gqSunk = true;
		else if ( gqUp < 1.0 ) {
			// Up from just under the sea, a touch past its height and back: it lands rather than stops.
			float gqBack = gqUp - 1.0;
			float gqShare = 1.0 + 2.6 * gqBack * gqBack * gqBack + 1.6 * gqBack * gqBack;
			gqAt.y = mix( -0.6, gqAt.y, gqShare );
		}
	}
	mvPosition = viewMatrix * gqAt;
} else {
	mvPosition = modelViewMatrix * mvPosition;
}
gl_Position = projectionMatrix * mvPosition;
// Not reached yet: not drawn at all.
if ( gqSunk ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
`;

// Once, before any material is compiled: the chunk, and the array in every built-in material's uniforms.
// (A typed array is handed to each material as it is, not copied, so they all read the one.)
// The declaration is added only if it is not there yet: the dev server loads this file again whenever it is
// edited, and a second copy of the line would stop every shader compiling.
THREE.ShaderChunk.project_vertex = CHUNK;
if (!THREE.ShaderChunk.common.includes("gqRise")) THREE.ShaderChunk.common = `uniform vec4 gqRise;\n${THREE.ShaderChunk.common}`;
for (const lib of Object.values(THREE.ShaderLib)) (lib.uniforms as Record<string, THREE.IUniform>).gqRise = { value: RISE };

/** One view's rise: begun when its place is ready, stepped each frame, and done when the ring has passed everything. */
export class Rise {
  /** Where it spreads from. */
  readonly centre = new THREE.Vector2();
  private front = BAND;
  private going = true;

  /** Still under way: the view should call `apply` before it draws and `clear` after. */
  get active(): boolean {
    return this.going;
  }

  /** Where it spreads from: the hex you stand on. Until it is let go (`step`), only that hex is up. */
  from(x: number, z: number) {
    this.centre.set(x, z);
  }

  /** Let the ring move out by `dt` seconds. It is done once it has passed everything within `land` of the middle. */
  step(dt: number, land: number) {
    if (!this.going) return;
    this.front += dt * SPEED;
    if (this.front > Math.min(REACH, land) + BAND) this.going = false;
  }

  /** Whether the ring has passed a spot, so what hangs over it (a name plate) may be shown. */
  reached(x: number, z: number): boolean {
    return !this.going || Math.hypot(x - this.centre.x, z - this.centre.y) < this.front - BAND * 0.5;
  }

  /** Hand this view's rise to the shaders, for what is drawn next. */
  apply() {
    RISE[0] = this.centre.x;
    RISE[1] = this.centre.y;
    RISE[2] = this.front;
    RISE[3] = this.going ? 1 : 0;
  }

  /** And take it away again, so whatever draws next draws plainly. */
  clear() {
    RISE[3] = 0;
  }
}
