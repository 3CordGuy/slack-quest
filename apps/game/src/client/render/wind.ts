// Wind, part of "Fancy graphics". Gusts cross the island in fronts, all going
// the way the sea's long swell goes, and the trees and the grass lean as each
// one passes: a ripple you can watch travel from one shore to the other. It
// blows harder in rain and hardest in a storm.
//
// The same gust is worked out in two places, and they must agree: here in
// JavaScript for the grass (whose tufts are placed one by one every frame),
// and in the shader below for the trees.

import * as THREE from "three";

/** The way the wind blows across the map (x, z): the same heading as the sea's longest waves. */
export const WIND_DIR = { x: 0.8, z: 0.6 };

const UNIFORMS = { windTime: { value: 0 }, windPower: { value: 0 } };

const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Once a frame.
 * @param power how hard it blows: 0 is no wind at all (fancy graphics off, or indoors), about 0.35 a calm day, over 1 a storm
 */
export function updateWind(clock: number, power: number) {
  UNIFORMS.windTime.value = clock;
  // Reduced motion: nothing sways.
  UNIFORMS.windPower.value = still ? 0 : power;
}

/** How hard it is blowing right now. */
export const windPower = () => UNIFORMS.windPower.value;

/**
 * How far something standing at (x, z) is pushed over at this moment, 0 upward (it scales with `windPower`).
 * A steady lean, plus the gust front that happens to be passing, which comes in patches so that the
 * fronts are not unbroken lines.
 */
export function gustAt(x: number, z: number): number {
  const t = UNIFORMS.windTime.value;
  const front = (x * WIND_DIR.x + z * WIND_DIR.z) * 0.42 - t * 1.3;
  const gust = (0.5 + 0.5 * Math.sin(front)) ** 2;
  const patchy = 0.6 + 0.4 * Math.sin((x * -WIND_DIR.z + z * WIND_DIR.x) * 0.23 + t * 0.21);
  return UNIFORMS.windPower.value * (0.25 + 0.75 * gust * patchy);
}

const GUST = /* glsl */ `
uniform float windTime;
uniform float windPower;
float windGust(vec2 at) {
  float front = dot(at, vec2(${WIND_DIR.x}, ${WIND_DIR.z})) * 0.42 - windTime * 1.3;
  float gust = pow(0.5 + 0.5 * sin(front), 2.0);
  float patchy = 0.6 + 0.4 * sin(dot(at, vec2(${-WIND_DIR.z}, ${WIND_DIR.x})) * 0.23 + windTime * 0.21);
  return windPower * (0.25 + 0.75 * gust * patchy);
}
void main() {`;

/**
 * Makes a material's trees sway. For an InstancedMesh of trees whose geometry stands upright about its own
 * middle, `height` tall: each bends from its foot, most at the tip, by the gust passing where it stands,
 * with a small shiver of its own on top.
 */
export function addWindSway(material: THREE.Material, height: number) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, UNIFORMS);
    shader.vertexShader = shader.vertexShader.replace("void main() {", GUST).replace(
      "#include <begin_vertex>",
      /* glsl */ `#include <begin_vertex>
      #ifdef USE_INSTANCING
      {
        vec2 root = instanceMatrix[3].xz;
        float up = clamp(position.y / ${height.toFixed(3)} + 0.5, 0.0, 1.0);
        float lean = windGust(root) * 0.2 + sin(windTime * 3.3 + root.x * 1.7 + root.y * 2.3) * 0.025 * windPower;
        transformed.xz += vec2(${WIND_DIR.x}, ${WIND_DIR.z}) * lean * up * up;
      }
      #endif`,
    );
  };
  material.customProgramCacheKey = () => `wind-sway-${height}`;
}
