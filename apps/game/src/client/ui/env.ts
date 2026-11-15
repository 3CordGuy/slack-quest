// What the scene's light is doing, for the HUD to answer to: which way the
// sun or moon lies as the camera sees it, what colour its light is and how
// bright the hour. The world renderer reports it every frame; the bottom
// bar's trim and the health orb read it, so brass that was lit from the left
// is lit from the right once the camera has swung round, warms at dusk and
// dims and cools at night.
//
// Listeners are only told when it has changed enough to see.

export interface Env {
  /** The light's direction on the screen: x to the right, y down, as a unit vector pointing toward the light. */
  lx: number;
  ly: number;
  /** The light's colour, each part 0 to 1, with white at noon. */
  tint: [number, number, number];
  /** How bright the hour is: 1 at noon, about half on a dark night. */
  level: number;
}

/** Until a scene says otherwise: noon, lit from the upper left. */
export const env: Env = { lx: -0.7071, ly: -0.7071, tint: [1, 1, 1], level: 1 };

const listeners = new Set<() => void>();
let told: Env = { ...env, tint: [...env.tint] };

export function onEnv(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Report the scene's light. `sun` is the direction to the sun or moon in the world, `yaw` the camera's turn
 * about the scene (the camera stands at sin(yaw), cos(yaw) from what it looks at), `glint` the colour of that
 * light and `sky` the colour of the sky behind everything, both with parts from 0 to 1.
 */
export function reportEnv(sun: { x: number; y: number; z: number }, yaw: number, glint: { r: number; g: number; b: number }, sky: { r: number; g: number; b: number }) {
  // Across the screen: the light's sideways part as the camera sees it. Up the screen: its height.
  const across = sun.x * Math.cos(yaw) - sun.z * Math.sin(yaw);
  const up = sun.y;
  const len = Math.hypot(across, up) || 1;
  env.lx = across / len;
  env.ly = -up / len;
  // The hour's brightness from the sky's own: a night sky is nearly black.
  const lum = 0.3 * sky.r + 0.6 * sky.g + 0.1 * sky.b;
  env.level = 0.56 + 0.44 * Math.min(1, lum * 2.4);
  // The light's hue without its strength, washed toward white so the HUD is tinted, not dyed.
  const peak = Math.max(glint.r, glint.g, glint.b, 0.001);
  const wash = 0.45;
  env.tint = [1 - wash + (wash * glint.r) / peak, 1 - wash + (wash * glint.g) / peak, 1 - wash + (wash * glint.b) / peak];

  const moved = Math.abs(env.lx - told.lx) + Math.abs(env.ly - told.ly) > 0.06 || Math.abs(env.level - told.level) > 0.02 || env.tint.some((c, i) => Math.abs(c - told.tint[i]) > 0.02);
  if (!moved) return;
  told = { ...env, tint: [...env.tint] };
  // For the stylesheet: the bottom bar's timber dims with the hour.
  document.documentElement.style.setProperty("--env-level", env.level.toFixed(2));
  for (const fn of listeners) fn();
}
