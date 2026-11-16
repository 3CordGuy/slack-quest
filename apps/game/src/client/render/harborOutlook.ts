// The Harbor as seen from inside the pub. A second view of the real Harbor
// map is drawn off screen, from just outside the pub's wall looking down to
// the quay and the sea, and the pub shows it through its windows. It is the
// same island under the same sky: the same hour, the same weather, the same
// water. It has no heroes, ships or crew huts in it yet, and it makes no sound.

import * as THREE from "three";
import { HARBOR_LIGHTHOUSE, HARBOR_PUB, generateHarbor } from "@gantt-quest/world";
import { WorldRenderer, hexToWorld, type RenderState } from "./WorldRenderer";

/**
 * The picture's size on the page, in CSS pixels. The view is drawn at half that, like every other, and
 * shared out between the pub's windows side by side, so it is much wider than it is tall.
 */
const SIZE = { w: 960, h: 190 };

export interface Outlook {
  view: WorldRenderer;
  dispose(): void;
}

export function harborOutlook(): Outlook {
  // Kept off the edge of the page: it must have a size to be drawn, but nobody should see or click it.
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = `position:fixed;left:-${SIZE.w * 2}px;top:0;width:${SIZE.w}px;height:${SIZE.h}px;pointer-events:none;visibility:hidden;`;
  document.body.appendChild(holder);

  const view = new WorldRenderer(holder, { onHexClick() {}, onHover() {} }, { backdrop: true });
  const state: RenderState = {
    code: "harbor:outlook",
    you: "",
    phase: "overworld",
    round: 0,
    map: generateHarbor(),
    heroes: [],
    turn: null,
    battle: null,
    story: null,
    npcs: {},
    freeRoam: true,
  };
  view.setState(state);

  // From the pub's front, at about head height, looking out across the High Street and down past the quay to
  // the lighthouse's point and the sea (east of south, so the apothecary over the road stands to one side).
  const pub = hexToWorld(HARBOR_PUB);
  const point = hexToWorld(HARBOR_LIGHTHOUSE);
  const eye = new THREE.Vector3(pub.x, 1.6, pub.z + 1.5);
  const away = new THREE.Vector3(point.x - eye.x, 0, point.z - eye.z).normalize().multiplyScalar(7.5);
  view.setVantage(eye, new THREE.Vector3(eye.x + away.x, 0.5, eye.z + away.z), 26);
  // Seen through a small pane, the picture wants to be sharp from front to back and even to its corners:
  // no tilt-shift blur, no vignette, and only a little haze out at sea.
  if (view.post) Object.assign(view.post.params, { dof: 0, vignette: 0, haze: 0.3 });

  return {
    view,
    dispose() {
      view.dispose();
      holder.remove();
    },
  };
}
