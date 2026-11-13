// The fish themselves: one low-poly model for every fish and creature in the
// catalogue, built from its `shape` (an outline, how thick it is, its fins
// and what else it has: whiskers, a bill, a lure) and coloured from its
// `palette` and `pattern`. The ray, the squid, the sunfish and the oarfish are
// built by hand.
//
// Every model is built side-on with the head toward +x, the back up (+y) and
// the flank facing the viewer (+z): about a unit from nose to tail. The
// sprite is drawn from it like that; a landed catch is turned head-up to
// hang from the line (catchArt.ts).

import * as THREE from "three";
import type { FishDef } from "@gantt-quest/world";
import { DARK, ball, box, cone, cyl, part, plate, type Paint } from "./meshKit";

type Tail = "fork" | "moon" | "round" | "fan" | "shark" | "none";
type Extra = "finlets" | "barbels" | "whiskers" | "bill" | "longbill" | "beak" | "lure" | "scutes" | "spines" | "gills" | "filament" | "wings" | "teeth";

interface Form {
  /** The side outline from the nose (t = 1) back to the root of the tail (t = 0): how far the back and the belly stand from the middle line, in body lengths. */
  profile: [number, number, number][];
  /** How thick the body is, against how deep. */
  girth: number;
  tail: Tail;
  /** Half the tail's span, in body lengths. */
  tailSize: number;
  /** Fins along the back, and under toward the tail: [from t, to t, height]. */
  dorsal: [number, number, number][];
  anal: [number, number, number][];
  pectoral: number;
  eye?: number;
  /** A flatfish: both eyes on the side that faces up (the viewer). */
  flat?: boolean;
  extras?: Extra[];
}

const FORMS: Record<string, Form> = {
  slim: { profile: [[1, 0, 0], [0.92, 0.05, 0.05], [0.75, 0.085, 0.085], [0.5, 0.09, 0.09], [0.25, 0.06, 0.055], [0.05, 0.025, 0.025], [0, 0.022, 0.022]], girth: 0.55, tail: "fork", tailSize: 0.13, dorsal: [[0.45, 0.6, 0.05]], anal: [[0.15, 0.28, 0.03]], pectoral: 0.06, eye: 0.024 },
  goby: { profile: [[1, 0, 0], [0.95, 0.06, 0.04], [0.85, 0.09, 0.07], [0.6, 0.085, 0.07], [0.3, 0.06, 0.05], [0, 0.035, 0.035]], girth: 0.9, tail: "round", tailSize: 0.11, dorsal: [[0.55, 0.7, 0.06], [0.2, 0.45, 0.06]], anal: [[0.2, 0.42, 0.05]], pectoral: 0.1, eye: 0.032 },
  flat: { profile: [[1, 0, 0], [0.95, 0.12, 0.08], [0.8, 0.25, 0.2], [0.5, 0.28, 0.24], [0.2, 0.16, 0.14], [0.05, 0.05, 0.05], [0, 0.04, 0.04]], girth: 0.12, tail: "round", tailSize: 0.14, dorsal: [[0.08, 0.92, 0.04]], anal: [[0.08, 0.72, 0.035]], pectoral: 0.05, eye: 0.026, flat: true },
  deep: { profile: [[1, 0, 0], [0.92, 0.1, 0.07], [0.75, 0.2, 0.16], [0.5, 0.22, 0.18], [0.25, 0.13, 0.1], [0.05, 0.045, 0.045], [0, 0.04, 0.04]], girth: 0.4, tail: "fan", tailSize: 0.15, dorsal: [[0.25, 0.75, 0.06]], anal: [[0.15, 0.4, 0.06]], pectoral: 0.09, extras: ["spines"] },
  torpedo: { profile: [[1, 0, 0], [0.9, 0.06, 0.055], [0.7, 0.1, 0.09], [0.45, 0.1, 0.09], [0.2, 0.05, 0.045], [0.03, 0.02, 0.02], [0, 0.02, 0.02]], girth: 0.75, tail: "fork", tailSize: 0.16, dorsal: [[0.55, 0.7, 0.07], [0.25, 0.4, 0.05]], anal: [[0.22, 0.38, 0.04]], pectoral: 0.07, extras: ["finlets"] },
  eel: { profile: [[1, 0, 0], [0.95, 0.035, 0.03], [0.85, 0.045, 0.04], [0.5, 0.045, 0.04], [0.2, 0.035, 0.03], [0, 0.01, 0.01]], girth: 0.8, tail: "none", tailSize: 0, dorsal: [[0, 0.7, 0.025]], anal: [[0, 0.5, 0.02]], pectoral: 0.04, eye: 0.016 },
  pike: { profile: [[1, 0, 0], [0.92, 0.035, 0.035], [0.8, 0.06, 0.06], [0.5, 0.07, 0.065], [0.2, 0.045, 0.04], [0, 0.025, 0.025]], girth: 0.75, tail: "fork", tailSize: 0.14, dorsal: [[0.18, 0.32, 0.06], [0.55, 0.62, 0.05]], anal: [[0.15, 0.28, 0.05]], pectoral: 0.06, eye: 0.02, extras: ["teeth"] },
  wels: { profile: [[1, 0, 0], [0.95, 0.08, 0.06], [0.85, 0.11, 0.09], [0.6, 0.1, 0.09], [0.3, 0.075, 0.07], [0, 0.03, 0.03]], girth: 1.1, tail: "round", tailSize: 0.1, dorsal: [[0.62, 0.68, 0.05]], anal: [[0.02, 0.55, 0.05]], pectoral: 0.08, eye: 0.014, extras: ["whiskers"] },
  cod: { profile: [[1, 0, 0], [0.92, 0.07, 0.06], [0.75, 0.12, 0.11], [0.5, 0.12, 0.1], [0.25, 0.07, 0.06], [0, 0.03, 0.03]], girth: 0.7, tail: "fan", tailSize: 0.13, dorsal: [[0.55, 0.7, 0.06], [0.32, 0.5, 0.05], [0.08, 0.28, 0.05]], anal: [[0.1, 0.3, 0.05], [0.32, 0.48, 0.05]], pectoral: 0.08, extras: ["barbels"] },
  bass: { profile: [[1, 0, 0], [0.9, 0.08, 0.06], [0.72, 0.15, 0.12], [0.48, 0.15, 0.12], [0.22, 0.08, 0.07], [0, 0.04, 0.04]], girth: 0.55, tail: "fan", tailSize: 0.15, dorsal: [[0.48, 0.72, 0.08], [0.22, 0.45, 0.06]], anal: [[0.18, 0.36, 0.06]], pectoral: 0.08, extras: ["spines"] },
  tuna: { profile: [[1, 0, 0], [0.9, 0.08, 0.075], [0.7, 0.14, 0.13], [0.45, 0.14, 0.13], [0.2, 0.06, 0.055], [0.03, 0.018, 0.018], [0, 0.018, 0.018]], girth: 0.85, tail: "moon", tailSize: 0.22, dorsal: [[0.55, 0.7, 0.09], [0.3, 0.4, 0.06]], anal: [[0.28, 0.38, 0.05]], pectoral: 0.1, extras: ["finlets"] },
  gar: { profile: [[1, 0, 0], [0.9, 0.03, 0.03], [0.75, 0.05, 0.05], [0.4, 0.055, 0.05], [0.15, 0.035, 0.03], [0, 0.02, 0.02]], girth: 0.8, tail: "fork", tailSize: 0.12, dorsal: [[0.12, 0.25, 0.05]], anal: [[0.1, 0.22, 0.04]], pectoral: 0.05, eye: 0.02, extras: ["beak"] },
  jack: { profile: [[1, 0, 0], [0.9, 0.08, 0.07], [0.72, 0.14, 0.12], [0.45, 0.14, 0.11], [0.2, 0.06, 0.05], [0, 0.02, 0.02]], girth: 0.65, tail: "fork", tailSize: 0.2, dorsal: [[0.25, 0.55, 0.07]], anal: [[0.18, 0.4, 0.05]], pectoral: 0.08 },
  tarpon: { profile: [[1, 0, 0], [0.92, 0.07, 0.08], [0.75, 0.14, 0.13], [0.5, 0.15, 0.13], [0.22, 0.08, 0.07], [0, 0.03, 0.03]], girth: 0.55, tail: "fork", tailSize: 0.22, dorsal: [[0.45, 0.55, 0.1]], anal: [[0.15, 0.3, 0.06]], pectoral: 0.09, extras: ["filament"] },
  sturgeon: { profile: [[1, 0, 0], [0.93, 0.04, 0.03], [0.8, 0.08, 0.07], [0.55, 0.1, 0.09], [0.3, 0.07, 0.06], [0.05, 0.03, 0.025], [0, 0.03, 0.02]], girth: 0.9, tail: "shark", tailSize: 0.17, dorsal: [[0.1, 0.2, 0.06]], anal: [[0.08, 0.17, 0.05]], pectoral: 0.08, eye: 0.015, extras: ["scutes", "barbels"] },
  scorpion: { profile: [[1, 0, 0], [0.92, 0.1, 0.07], [0.75, 0.15, 0.11], [0.5, 0.12, 0.09], [0.25, 0.07, 0.055], [0, 0.035, 0.035]], girth: 0.8, tail: "round", tailSize: 0.12, dorsal: [[0.3, 0.8, 0.09]], anal: [[0.18, 0.35, 0.06]], pectoral: 0.13, extras: ["spines"] },
  grouper: { profile: [[1, 0, 0], [0.92, 0.1, 0.09], [0.75, 0.17, 0.15], [0.5, 0.17, 0.14], [0.25, 0.1, 0.08], [0, 0.045, 0.045]], girth: 0.7, tail: "round", tailSize: 0.15, dorsal: [[0.25, 0.75, 0.07]], anal: [[0.15, 0.35, 0.07]], pectoral: 0.1, extras: ["spines"] },
  moon: { profile: [[1, 0, 0], [0.9, 0.15, 0.12], [0.7, 0.3, 0.26], [0.45, 0.3, 0.26], [0.2, 0.15, 0.12], [0, 0.04, 0.04]], girth: 0.35, tail: "fork", tailSize: 0.18, dorsal: [[0.45, 0.75, 0.2]], anal: [[0.15, 0.4, 0.06]], pectoral: 0.14 },
  shark: { profile: [[1, 0, 0], [0.93, 0.06, 0.05], [0.78, 0.11, 0.1], [0.55, 0.12, 0.1], [0.3, 0.08, 0.06], [0.05, 0.03, 0.025], [0, 0.03, 0.025]], girth: 0.75, tail: "shark", tailSize: 0.25, dorsal: [[0.48, 0.6, 0.16], [0.12, 0.17, 0.05]], anal: [[0.1, 0.15, 0.04]], pectoral: 0.16, eye: 0.018, extras: ["gills"] },
  flyer: { profile: [[1, 0, 0], [0.92, 0.05, 0.05], [0.75, 0.08, 0.075], [0.5, 0.085, 0.08], [0.25, 0.055, 0.05], [0, 0.022, 0.022]], girth: 0.7, tail: "fork", tailSize: 0.15, dorsal: [[0.2, 0.32, 0.04]], anal: [[0.15, 0.3, 0.03]], pectoral: 0.4, extras: ["wings"] },
  dorado: { profile: [[1, 0, 0], [0.97, 0.12, 0.04], [0.88, 0.18, 0.08], [0.6, 0.16, 0.1], [0.3, 0.09, 0.06], [0, 0.025, 0.025]], girth: 0.4, tail: "fork", tailSize: 0.2, dorsal: [[0.1, 0.92, 0.07]], anal: [[0.08, 0.45, 0.05]], pectoral: 0.08 },
  sail: { profile: [[1, 0, 0], [0.9, 0.05, 0.05], [0.75, 0.09, 0.08], [0.5, 0.09, 0.08], [0.25, 0.05, 0.045], [0, 0.02, 0.02]], girth: 0.7, tail: "moon", tailSize: 0.22, dorsal: [[0.25, 0.8, 0.32]], anal: [[0.15, 0.3, 0.06]], pectoral: 0.08, extras: ["bill"] },
  sword: { profile: [[1, 0, 0], [0.9, 0.05, 0.05], [0.75, 0.1, 0.09], [0.5, 0.1, 0.09], [0.25, 0.05, 0.045], [0, 0.02, 0.02]], girth: 0.8, tail: "moon", tailSize: 0.24, dorsal: [[0.65, 0.75, 0.13]], anal: [[0.2, 0.28, 0.05]], pectoral: 0.1, extras: ["longbill"] },
  angler: { profile: [[1, 0, 0], [0.97, 0.14, 0.12], [0.85, 0.2, 0.18], [0.6, 0.16, 0.14], [0.3, 0.09, 0.08], [0, 0.03, 0.03]], girth: 1.0, tail: "round", tailSize: 0.12, dorsal: [[0.2, 0.32, 0.06]], anal: [[0.15, 0.28, 0.05]], pectoral: 0.1, eye: 0.02, extras: ["lure", "teeth"] },
  ribbon: { profile: [[1, 0, 0], [0.97, 0.025, 0.022], [0.9, 0.035, 0.03], [0.5, 0.032, 0.028], [0.1, 0.018, 0.015], [0, 0.005, 0.005]], girth: 0.3, tail: "none", tailSize: 0, dorsal: [[0, 0.92, 0.045]], anal: [], pectoral: 0.03, eye: 0.018 },
};

/** The body runs from the root of the tail (x = TAIL_X) to the nose (x = NOSE_X); the tail fin carries on past it. */
const TAIL_X = -0.32;
const NOSE_X = 0.5;
const LEN = NOSE_X - TAIL_X;
const xAt = (t: number) => TAIL_X + LEN * t;

/** How far the back and the belly stand from the middle line at `t`. */
function outline(form: Form, t: number): [number, number] {
  const p = form.profile;
  for (let i = 0; i < p.length - 1; i++) {
    const [t0, a0, b0] = p[i];
    const [t1, a1, b1] = p[i + 1];
    if (t <= t0 && t >= t1) {
      const k = t0 === t1 ? 0 : (t - t1) / (t0 - t1);
      return [a1 + (a0 - a1) * k, b1 + (b0 - b1) * k];
    }
  }
  return t > p[0][0] ? [p[0][1], p[0][2]] : [p[p.length - 1][1], p[p.length - 1][2]];
}

/** The body: rings round the middle line from the nose to the root of the tail, each an egg shape (the back and the belly can differ). */
function bodyGeo(form: Form): THREE.BufferGeometry {
  const N = 16;
  const S = 10;
  const pos: number[] = [];
  const idx: number[] = [];
  pos.push(NOSE_X, 0, 0);
  for (let i = 1; i < N; i++) {
    const t = 1 - (i / (N - 1)) ** 0.9;
    const [top, bot] = outline(form, t);
    const half = form.girth * (top + bot) / 2;
    for (let k = 0; k < S; k++) {
      const a = (k / S) * Math.PI * 2;
      const s = Math.sin(a);
      pos.push(xAt(t), s >= 0 ? top * s : bot * s, half * Math.cos(a));
    }
  }
  const tail = pos.length / 3;
  pos.push(TAIL_X - 0.005, 0, 0);
  const ring = (i: number, k: number) => 1 + (i - 1) * S + (k % S);
  for (let k = 0; k < S; k++) idx.push(0, ring(1, k + 1), ring(1, k));
  for (let i = 1; i < N - 1; i++) {
    for (let k = 0; k < S; k++) {
      const a = ring(i, k);
      const b = ring(i, k + 1);
      const c = ring(i + 1, k);
      const d = ring(i + 1, k + 1);
      idx.push(a, b, d, a, d, c);
    }
  }
  for (let k = 0; k < S; k++) idx.push(tail, ring(N - 1, k), ring(N - 1, k + 1));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const fract = (v: number) => v - Math.floor(v);
const hash = (a: number, b: number, c: number) => fract(Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453);

/** The body's colours: the back, a paler belly, and the pattern on the flank. */
function bodyPaint(form: Form, def: FishDef): Paint {
  const back = new THREE.Color(def.palette[0]);
  const belly = new THREE.Color(def.palette[1]);
  // The moonfish is spotted white, with red only on its fins.
  const accent = new THREE.Color(def.shape === "moon" ? def.palette[1] : def.palette[2]);
  return (c) => {
    const t = Math.max(0, Math.min(1, (c.x - TAIL_X) / LEN));
    const [top, bot] = outline(form, t);
    // -1 at the belly, 1 at the back.
    const v = c.y >= 0 ? c.y / Math.max(0.001, top) : c.y / Math.max(0.001, bot);
    // A flatfish's up side is all back, its under side all belly.
    let col = form.flat ? (c.z >= 0 ? back : belly) : v > -0.12 ? back : v > -0.3 ? back.clone().lerp(belly, 0.6) : belly;
    const flank = form.flat ? c.z >= 0 : true;
    switch (def.pattern) {
      case "stripes":
        if (flank && v > -0.15 && fract((v + 1) * 3.2) < 0.3) col = accent;
        break;
      case "bars":
        if (flank && v > -0.4 && fract(t * 7.5) < 0.32) col = accent;
        break;
      case "glow":
        if (Math.abs(v) < 0.14) col = accent;
        break;
    }
    return col;
  };
}

/** Spots: small round dots set on the skin of the flank (both flanks, or a flatfish's up side), never on the belly. */
function spots(form: Form, def: FishDef): THREE.Mesh[] {
  const color = def.shape === "moon" ? def.palette[1] : def.palette[2];
  const out: THREE.Mesh[] = [];
  let seed = 0;
  for (const ch of def.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const count = form.flat ? 22 : 16;
  for (let i = 0; i < count; i++) {
    const t = 0.12 + 0.72 * rnd();
    const [top, bot] = outline(form, t);
    const half = form.girth * (top + bot) / 2;
    // From low on the flank to near the top of the back.
    const v = -0.25 + 1.0 * rnd();
    const y = v >= 0 ? v * top : v * bot;
    const side = form.flat ? 1 : rnd() < 0.5 ? 1 : -1;
    // On the egg-shaped section, how far out the skin is at this height.
    const z = side * half * Math.sqrt(Math.max(0, 1 - v * v)) + side * 0.002;
    const r = (0.008 + 0.01 * rnd()) * (form.flat ? 1.6 : 1);
    out.push(part(ball(r, 6, 4), color, { scale: [1, 1, 0.35], pos: [xAt(t), form.flat ? y * 0.9 : y, form.flat ? half + 0.003 : z] }));
  }
  return out;
}

/** A fin along the back (or, `under`, the belly) from t0 to t1, raked back toward the tail. */
function backFin(form: Form, [t0, t1, h]: [number, number, number], color: THREE.Color, under = false): THREE.Mesh {
  const [topE, botE] = outline(form, t1);
  const [topS, botS] = outline(form, t0);
  const yE = (under ? botE : topE) * 0.8;
  const yS = (under ? botS : topS) * 0.8;
  const xe = xAt(t1);
  const xs = xAt(t0);
  const span = xe - xs;
  const peak = Math.max(yE, yS) / 0.8 + h;
  const pts: [number, number][] = [
    [xe, yE],
    [xe - span * 0.18 - h * 0.25, peak],
    [xs - h * 0.3, yS / 0.8 + h * 0.3],
    [xs, yS],
  ];
  return part(plate(under ? pts.map(([x, y]) => [x, -y] as [number, number]) : pts), color, { pos: [0, 0, 0] }, { double: true });
}

function tailFin(form: Form, color: THREE.Color): THREE.Mesh | null {
  const s = form.tailSize;
  const tl = s * 0.95;
  const x0 = TAIL_X + 0.012;
  const pts: Record<Exclude<Tail, "none">, [number, number][]> = {
    fork: [[x0, 0.03], [x0 - tl, s], [x0 - tl * 0.55, 0], [x0 - tl, -s], [x0, -0.03]],
    moon: [[x0, 0.025], [x0 - tl * 0.55, s * 0.9], [x0 - tl * 0.8, s], [x0 - tl * 0.35, 0], [x0 - tl * 0.8, -s], [x0 - tl * 0.55, -s * 0.9], [x0, -0.025]],
    round: [[x0, 0.03], [x0 - tl * 0.6, s * 0.8], [x0 - tl, s * 0.45], [x0 - tl * 1.05, 0], [x0 - tl, -s * 0.45], [x0 - tl * 0.6, -s * 0.8], [x0, -0.03]],
    fan: [[x0, 0.03], [x0 - tl, s * 0.85], [x0 - tl * 0.92, 0], [x0 - tl, -s * 0.85], [x0, -0.03]],
    shark: [[x0, 0.035], [x0 - tl * 1.1, s * 1.15], [x0 - tl * 0.75, 0], [x0 - tl * 0.55, -s * 0.55], [x0, -0.03]],
  };
  if (form.tail === "none") return null;
  return part(plate(pts[form.tail]), color, {}, { double: true });
}

/** Fins that lie back along the flank: a pectoral behind each gill (or a flying fish's wings). */
function sideFins(form: Form, color: THREE.Color): THREE.Mesh[] {
  const t = 0.72;
  const [top, bot] = outline(form, t);
  const half = form.girth * (top + bot) / 2;
  const L = form.pectoral;
  const wings = form.extras?.includes("wings");
  const pts: [number, number][] = wings
    ? [[0, 0.02], [-L, L * 0.28], [-L * 0.95, -L * 0.08], [-L * 0.3, -L * 0.1], [0, -0.02]]
    : [[0, 0.015], [-L, -L * 0.18], [-L * 0.75, -L * 0.5], [0, -0.015]];
  const y = wings ? top * 0.25 : -bot * 0.25;
  return [1, -1].map((side) => part(plate(pts), color, { rot: [0, side * 0.35, 0], pos: [xAt(t), y, side * (half + 0.004)] }, { double: true }));
}

/** The head: eyes (a highlight in each), the mouth, and the line of the gill cover. */
function head(form: Form): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const te = 0.9;
  const [top, bot] = outline(form, te);
  const half = form.girth * (top + bot) / 2;
  const r = form.eye ?? Math.max(0.018, top * 0.28);
  const eyes: [number, number][] = form.flat ? [[top * 0.45, 1], [top * 0.05, 1]] : [[top * 0.35, 1], [top * 0.35, -1]];
  for (const [y, side] of eyes) {
    const z = side * Math.max(r * 0.6, half * 0.85);
    out.push(part(ball(r, 8, 6), "#e8e4d8", { pos: [xAt(te), y, z] }));
    out.push(part(ball(r * 0.65, 8, 6), DARK, { pos: [xAt(te) + r * 0.1, y, z + side * r * 0.45] }));
  }
  // The mouth, a dark line at the front of the head, a little below the middle.
  out.push(part(box(0.05, 0.008, half * 1.4 + 0.01), DARK, { pos: [NOSE_X - 0.03, -Math.min(top, bot) * 0.25, 0] }));
  // The gill cover's edge behind the eye, on each flank.
  const tg = 0.8;
  const [gt, gb] = outline(form, tg);
  const gh = form.girth * (gt + gb) / 2;
  if (!form.flat) for (const side of [1, -1]) out.push(part(box(0.006, (gt + gb) * 0.6, 0.004), DARK, { pos: [xAt(tg), (gt - gb) * 0.2, side * gh * 0.92] }, { opacity: 0.6 }));
  return out;
}

function extras(form: Form, def: FishDef, fin: THREE.Color): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const pale = def.palette[1];
  const [nt, nb] = outline(form, 0.95);
  for (const e of form.extras ?? []) {
    if (e === "finlets") {
      for (let k = 0; k < 4; k++) {
        const t = 0.2 - k * 0.045;
        const [top, bot] = outline(form, t);
        for (const [y, s] of [[top, 1], [-bot, -1]] as const) out.push(part(plate([[0.01, 0], [-0.015, s * 0.025], [-0.012, 0]]), fin, { pos: [xAt(t), y * 0.85, 0] }, { double: true }));
      }
    } else if (e === "barbels") {
      out.push(part(cyl(0.004, 0.003, 0.07, 4), pale, { rot: [0, 0, 0.3], pos: [xAt(0.93), -nb - 0.03, 0] }));
    } else if (e === "whiskers") {
      for (const side of [1, -1]) {
        out.push(part(cyl(0.005, 0.002, 0.32, 4), DARK, { rot: [0, 0, Math.PI / 2 + 0.35], pos: [NOSE_X + 0.1, -0.03, side * 0.05] }));
        out.push(part(cyl(0.003, 0.002, 0.1, 4), DARK, { rot: [0, 0, 0.2], pos: [NOSE_X - 0.03, -nb - 0.04, side * 0.02] }));
      }
    } else if (e === "bill" || e === "longbill") {
      const len = e === "longbill" ? 0.42 : 0.3;
      out.push(part(cone(0.016, len, 6), def.palette[0], { rot: [0, 0, -Math.PI / 2], pos: [NOSE_X + len / 2 - 0.03, nt * 0.1, 0] }));
    } else if (e === "beak") {
      out.push(part(cone(0.012, 0.22, 5), def.palette[0], { rot: [0, 0, -Math.PI / 2], pos: [NOSE_X + 0.09, 0.006, 0] }));
      out.push(part(cone(0.01, 0.2, 5), pale, { rot: [0, 0, -Math.PI / 2], pos: [NOSE_X + 0.08, -0.008, 0] }));
    } else if (e === "lure") {
      const [top] = outline(form, 0.85);
      out.push(part(cyl(0.004, 0.004, 0.18, 4), def.palette[0], { rot: [0, 0, -0.6], pos: [xAt(0.85) + 0.05, top + 0.07, 0] }));
      out.push(part(ball(0.025, 8, 6), def.palette[2], { pos: [xAt(0.85) + 0.11, top + 0.15, 0] }));
    } else if (e === "teeth") {
      for (let k = 0; k < 5; k++) out.push(part(cone(0.006, 0.018, 3), "#f4f0e0", { rot: [Math.PI, 0, 0], pos: [NOSE_X - 0.015 - k * 0.018, -nb * 0.05 + 0.008, 0.02] }));
    } else if (e === "scutes") {
      for (let k = 0; k < 9; k++) {
        const t = 0.15 + k * 0.08;
        const [top, bot] = outline(form, t);
        const half = form.girth * (top + bot) / 2;
        out.push(part(cone(0.012, 0.03, 4), pale, { pos: [xAt(t), top + 0.008, 0] }));
        for (const side of [1, -1]) out.push(part(cone(0.009, 0.022, 4), pale, { rot: [side * Math.PI / 2, 0, 0], pos: [xAt(t), 0, side * (half + 0.006)] }));
      }
    } else if (e === "spines") {
      const [d0, d1] = form.dorsal[0];
      for (let k = 0; k < 5; k++) {
        const t = d1 - (d1 - d0) * (k / 5) * 0.6;
        const [top] = outline(form, t);
        out.push(part(cone(0.004, 0.06 + 0.02 * (k % 2), 3), fin, { rot: [0, 0, 0.35], pos: [xAt(t) - 0.01, top + 0.04, 0] }));
      }
    } else if (e === "gills") {
      for (let k = 0; k < 4; k++) {
        const t = 0.8 - k * 0.025;
        const [top, bot] = outline(form, t);
        const half = form.girth * (top + bot) / 2;
        for (const side of [1, -1]) out.push(part(box(0.004, (top + bot) * 0.45, 0.003), DARK, { pos: [xAt(t), 0, side * half * 0.95] }, { opacity: 0.7 }));
      }
    } else if (e === "filament") {
      const [d0] = form.dorsal[0];
      const [top] = outline(form, d0);
      out.push(part(cyl(0.003, 0.002, 0.2, 3), fin, { rot: [0, 0, 1.25], pos: [xAt(d0) - 0.08, top + 0.07, 0] }));
    }
  }
  return out;
}

// ---------- built by hand ----------

/** A ray, seen from above: a diamond of wing with eyes on top, spotted, and a long thin tail. */
function ray(def: FishDef): THREE.Mesh[] {
  const [back, belly, spot] = def.palette.map((c) => new THREE.Color(c));
  const outlinePts: [number, number][] = [[0.3, 0], [0.12, 0.2], [0.0, 0.42], [-0.1, 0.36], [-0.2, 0.08], [-0.22, 0], [-0.2, -0.08], [-0.1, -0.36], [0.0, -0.42], [0.12, -0.2]];
  const shape = new THREE.Shape(outlinePts.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.02, bevelSegments: 1 });
  const paint: Paint = (c, n) => (n.z < -0.3 ? belly : hash(Math.round(c.x * 30), Math.round(c.y * 30), 1) < 0.18 ? spot : back);
  return [
    part(geo, paint, { pos: [0, 0, -0.015] }),
    part(cyl(0.012, 0.004, 0.42, 5), back, { rot: [0, 0, Math.PI / 2], pos: [-0.42, 0, 0] }),
    ...[0.05, -0.05].map((y) => part(ball(0.022, 8, 6), DARK, { pos: [0.16, y, 0.04] })),
    ...[0.05, -0.05].map((y) => part(ball(0.012, 6, 4), "#e8e4d8", { pos: [0.18, y, 0.055] })),
  ];
}

/** A squid: a long mantle with fins at its point, eyes, and arms and two longer tentacles trailing. */
function squid(def: FishDef): THREE.Mesh[] {
  const [body, pale, spot] = def.palette.map((c) => new THREE.Color(c));
  const paint: Paint = (c) => (hash(Math.round(c.x * 30), Math.round(c.y * 30), Math.sign(c.z)) < 0.25 ? spot : c.y < -0.03 ? pale : body);
  const out = [
    part(new THREE.LatheGeometry([[0, 0.5], [0.04, 0.44], [0.08, 0.3], [0.09, 0.1], [0.08, 0.0], [0.05, -0.02]].map(([r, y]) => new THREE.Vector2(r, y)), 10), paint, { rot: [0, 0, -Math.PI / 2] }),
    part(plate([[0.48, 0], [0.32, 0.12], [0.28, 0]]), body, {}, { double: true }),
    part(plate([[0.48, 0], [0.32, -0.12], [0.28, 0]]), body, {}, { double: true }),
    part(ball(0.06, 8, 6), body, { pos: [-0.04, 0, 0], scale: [0.8, 1, 1] }),
    ...[1, -1].map((s) => part(ball(0.022, 8, 6), DARK, { pos: [-0.04, 0.02, s * 0.05] })),
  ];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const len = 0.3 + 0.04 * Math.sin(k * 2.3);
    out.push(part(cyl(0.012, 0.004, len, 4), k % 2 ? body : pale, { rot: [0, 0, Math.PI / 2 + Math.sin(a) * 0.25], pos: [-0.08 - len / 2, Math.sin(a) * 0.04, Math.cos(a) * 0.04] }));
  }
  for (const s of [1, -1]) {
    out.push(part(cyl(0.006, 0.004, 0.42, 4), body, { rot: [0, 0, Math.PI / 2 + s * 0.08], pos: [-0.29, s * 0.02, 0] }));
    out.push(part(ball(0.02, 6, 4), spot, { scale: [1.8, 1, 0.8], pos: [-0.5, s * 0.035, 0] }));
  }
  return out;
}

/** A drifting sunfish: a great round disc of a body that ends in a frill, with a tall fin above and below. */
function sunfish(def: FishDef): THREE.Mesh[] {
  const [back, belly, dark] = def.palette.map((c) => new THREE.Color(c));
  const paint: Paint = (c) => (c.y < -0.12 ? belly : back);
  return [
    part(ball(0.5, 12, 10), paint, { scale: [0.72, 0.62, 0.12] }),
    part(plate([[-0.02, 0.26], [-0.14, 0.62], [-0.24, 0.6], [-0.2, 0.22]]), back, {}, { double: true }),
    part(plate([[-0.02, -0.26], [-0.14, -0.62], [-0.24, -0.6], [-0.2, -0.22]]), back, {}, { double: true }),
    part(plate([[-0.3, 0.2], [-0.4, 0.14], [-0.43, 0], [-0.4, -0.14], [-0.3, -0.2]]), dark, {}, { double: true }),
    part(plate([[0.1, 0.0], [0.0, 0.05], [0.02, -0.05]]), dark, { pos: [0, 0, 0.065] }, { double: true }),
    ...[1, -1].map((s) => part(ball(0.03, 8, 6), DARK, { pos: [0.24, 0.06, s * 0.05] })),
    part(box(0.03, 0.025, 0.04), DARK, { pos: [0.35, -0.02, 0] }),
  ];
}

/** An oarfish: a long silver ribbon with a red crest the whole length of its back, and a plume on its head. */
function ribbon(def: FishDef): THREE.Mesh[] {
  const form = FORMS.ribbon;
  const [, , red] = def.palette.map((c) => new THREE.Color(c));
  const out = [part(bodyGeo(form), bodyPaint(form, def)), backFin(form, form.dorsal[0], red), ...head(form)];
  for (let k = 0; k < 5; k++) out.push(part(cyl(0.004, 0.002, 0.16 + k * 0.02, 3), red, { rot: [0, 0, 0.55 + k * 0.12], pos: [xAt(0.9) - 0.04 - k * 0.012, 0.11 + k * 0.01, 0] }));
  for (const s of [1, -1]) out.push(part(cyl(0.003, 0.002, 0.3, 3), red, { rot: [0, 0, -1.2], pos: [xAt(0.8) - 0.1, -0.12, s * 0.01] }));
  return out;
}

const BESPOKE: Record<string, (def: FishDef) => THREE.Mesh[]> = { ray, squid, sunfish, ribbon };

/** The parts of a fish's model, side-on, head toward +x. */
export function fishModel(def: FishDef): THREE.Mesh[] {
  if (BESPOKE[def.shape]) return BESPOKE[def.shape](def);
  const form = FORMS[def.shape] ?? FORMS.slim;
  const fin = new THREE.Color(def.palette[0]).lerp(new THREE.Color(def.palette[2]), 0.55);
  const tail = tailFin(form, fin);
  return [
    part(bodyGeo(form), bodyPaint(form, def)),
    ...(tail ? [tail] : []),
    ...form.dorsal.map((d) => backFin(form, d, fin)),
    ...form.anal.map((a) => backFin(form, a, fin, true)),
    // A flatfish lies on its side: its side fins would be on the face it shows.
    ...(form.flat ? [] : sideFins(form, fin)),
    ...head(form),
    ...(def.pattern === "spots" ? spots(form, def) : []),
    ...extras(form, def, fin),
  ];
}

/** Every shape the fish models know. */
export const FISH_SHAPES = [...Object.keys(FORMS), ...Object.keys(BESPOKE)];
