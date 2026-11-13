// Character sprites face the camera squarely, so with the camera looking down
// they lean back from their feet, and a leaning card would sink its head into
// whatever stands just behind (a hut's front wall, a hill). This keeps the
// picture as it is but gives every pixel the depth it would have on an upright
// card standing at the sprite's anchor, turned to face the camera. Buildings
// in front then hide a hero, and buildings behind stay behind.

import type * as THREE from "three";

/*
 * View space: the camera sits at the origin, so a pixel's ray runs along its vertex position. The card is the
 * vertical plane through the anchor that contains the camera's (level) right-hand axis. Depth is affine across
 * the screen on any plane, so setting it at the four corners is exact for every pixel between.
 */
const UPRIGHT = /* glsl */ `
{
  vec3 uprightAnchor = modelViewMatrix[ 3 ].xyz;
  vec3 uprightUp = ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz;
  vec3 uprightNormal = cross( vec3( 1.0, 0.0, 0.0 ), uprightUp );
  float uprightAlong = dot( uprightNormal, mvPosition.xyz );
  if ( abs( uprightAlong ) > 1e-6 ) {
    vec4 uprightClip = projectionMatrix * vec4( mvPosition.xyz * ( dot( uprightNormal, uprightAnchor ) / uprightAlong ), 1.0 );
    gl_Position.z = clamp( uprightClip.z / uprightClip.w, -1.0, 1.0 ) * gl_Position.w;
  }
}
#include <logdepthbuf_vertex>`;

/** Gives a sprite the depth of an upright card at its anchor (see above), keeping any shader changes it already has. */
export function standUpright(material: THREE.SpriteMaterial) {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    before.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace("#include <logdepthbuf_vertex>", UPRIGHT);
  };
}
