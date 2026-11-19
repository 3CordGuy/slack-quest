import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { makeFigure } from "../src/client/render/figures";
import { LOOKS } from "../src/client/render/looks";

// Whatever stands on its feet falls down dead: onto its back or front, or (a beast) onto its side. Its body's pieces
// are boxes, and a box rests on any flat face, so a bear once stood on its four legs with only its head drooping,
// and an ogre sat up on the bottom of its body.
const STANDING = ["bear", "great_bear", "wolf", "alpha", "ogre", "troll", "skeleton", "dummy", "bandit", "brute"];
const BLOWS: [string, THREE.Vector3][] = [
  ["from the front", new THREE.Vector3(0, 0, -1)],
  ["from behind", new THREE.Vector3(0, 0, 1)],
  ["from the left", new THREE.Vector3(1, 0, 0)],
  ["from the right", new THREE.Vector3(-1, 0, 0)],
];

/** How upright the figure's body is once it has settled, as it stood (an ogre stoops): 1 standing, 0 lying along the ground. */
function uprightAfterFall(kind: string, push: THREE.Vector3): number {
  const figure = makeFigure(kind, LOOKS[kind] ?? LOOKS.npc);
  figure.setSize(1);
  figure.update({ time: 0.01, stride: 0, walking: false, lean: 0, lying: false });
  const body = figure.root.children[0].children[0];
  const standing = body.quaternion.clone().invert();
  figure.fall(push);
  let time = 0.01;
  for (let i = 0; i < 5 * 60; i++) figure.update({ time: (time += 1 / 60), stride: 0, walking: false, lean: 0, lying: true });
  return Math.abs(new THREE.Vector3(0, 1, 0).applyQuaternion(body.quaternion.clone().multiply(standing)).y);
}

describe("falling dead", () => {
  // The fall has chance in it (where each figure is in its breath as it dies, and which way a blow from the side
  // tips it). Each case plays out the same run of chance every time, so it passes or fails for what the fall does,
  // not for luck: a troll struck from the left once came to rest just over the line on one run in many.
  beforeEach(() => {
    let seed = 7;
    vi.spyOn(Math, "random").mockImplementation(() => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
  });
  afterEach(() => vi.restoreAllMocks());
  for (const kind of STANDING) {
    for (const [from, push] of BLOWS) {
      it(`a ${kind} struck ${from} ends up lying`, () => {
        expect(uprightAfterFall(kind, push)).toBeLessThan(0.65);
      });
    }
  }
});

// Knocked down and up again, it stands as it did: a rig sets only some of each joint's turn, and once kept the
// twist of how the body lay, so it got up with its legs crossed.
describe("getting up again", () => {
  afterEach(() => vi.restoreAllMocks());
  for (const kind of STANDING) {
    it(`a ${kind} knocked down stands as one never knocked down`, () => {
      // The same breathing beat for both.
      vi.spyOn(Math, "random").mockReturnValue(0.3);
      const pose = (figure: ReturnType<typeof makeFigure>, time: number, lying: boolean) => figure.update({ time, stride: 0, walking: false, lean: 0, lying });
      const [knocked, steady] = [kind, kind].map((k) => makeFigure(k, LOOKS[k] ?? LOOKS.npc));
      for (const figure of [knocked, steady]) figure.setSize(1);
      pose(knocked, 0.01, false);
      knocked.fall(new THREE.Vector3(1, 0, 0.3));
      let time = 0.01;
      for (; time < 3; time += 1 / 60) pose(knocked, time, true), pose(steady, time, false);
      for (; time < 6; time += 1 / 60) pose(knocked, time, false), pose(steady, time, false);
      const turns = (figure: ReturnType<typeof makeFigure>) => {
        const out: THREE.Quaternion[] = [];
        figure.root.traverse((o) => out.push(o.quaternion));
        return out;
      };
      const steadyTurns = turns(steady);
      const worst = Math.max(...turns(knocked).map((q, i) => q.angleTo(steadyTurns[i])));
      expect(worst).toBeLessThan(0.01);
    });
  }
});

// Getting up on two legs begins by rolling over onto the front along the ground, not by swinging the body up
// through standing and over onto the face.
describe("rolling over to get up", () => {
  for (const kind of ["bandit", "brute", "skeleton", "ogre", "troll"]) {
    for (const [from, push] of BLOWS) {
      it(`a ${kind} struck ${from} rolls onto its front`, () => {
        const figure = makeFigure(kind, LOOKS[kind] ?? LOOKS.npc);
        figure.setSize(1);
        const pose = (time: number, lying: boolean) => figure.update({ time, stride: 0, walking: false, lean: 0, lying });
        pose(0.01, false);
        const body = figure.root.children[0].children[0];
        const standing = body.quaternion.clone().invert();
        figure.fall(push);
        let time = 0.01;
        for (; time < 4; time += 1 / 60) pose(time, true);
        let most = 0;
        for (const end = time + 0.45; time < end; time += 1 / 60) {
          pose(time, false);
          most = Math.max(most, new THREE.Vector3(0, 1, 0).applyQuaternion(body.quaternion.clone().multiply(standing)).y);
        }
        expect(most).toBeLessThan(0.7);
      });
    }
  }
});
