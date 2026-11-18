// The figure lab: a dev-only stage for trying every figure's animations.
// Opened from the dev toolbox's Figures tab (DevToolbox.tsx), so it is there
// only on a development deployment.
//
// Pick who stands on the stage (a hero class, a townsperson or an enemy),
// dress a person in any gear, and drive the same pose the game drives
// (render/figures.ts, FigurePose and Figure): walk, strike, stab, sweep,
// shoot, cast, play, flinch, lie down, sit, row. Time can be slowed, paused and stepped a frame at a time, and an
// action can be set to repeat, to watch it over and over. Drag the stage to
// look round the figure, and scroll to come closer.
//
// Nothing here touches the server or the game being played: it builds its own
// figure on its own small scene.

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { ENEMIES, GEAR_BASES, HERO_CLASSES, RARITIES, SLOTS, SLOT_LABEL, WEAPONS, WEAPON_ICON, parseAppearance, slotOfRef, type Outfit, type Rarity, type Slot } from "@gantt-quest/world";
import type { Me } from "./api";
import { label } from "./labels";
import { makeFigure, type Figure } from "./render/figures";
import { LOOKS } from "./render/looks";
import { lookFor } from "./render/sprites";
import "./figureLab.css";

/** The kinds drawn as creatures, with a body of their own: they wear no gear (dressed, a kind is drawn as a person). */
const CREATURES = new Set(["wolf", "alpha", "bear", "great_bear", "dummy", "shade", "haunt", "bat", "skeleton", "slime", "ogre", "troll"]);
const HEROES = HERO_CLASSES.map((c) => c.id);
const FOES = Object.keys(ENEMIES);
const TOWNSFOLK = Object.keys(LOOKS).filter((k) => !HEROES.includes(k) && !FOES.includes(k));
/** A figure's height on the stage, in world units: a hero's in the game. */
const SIZE = 1.5;
/** How fast a lean into a strike eases off, as in the game (WorldRenderer). */
const LEAN_EASE = 8;
const SPEEDS = [1, 0.5, 0.25, 0.1] as const;
/** A jump of two tiles, as the game makes it (WorldRenderer's LEAP): seconds off the ground, and how high at the top. */
const JUMP_AIR = 0.46;
const JUMP_HIGH = 0.9;
const ACTIONS = [
  ["strike", "Strike", "The ordinary blow for what is in hand, with a step in: a cut, with daggers or a dirk a leap and a stab downward, with a rapier a thrust. An archer draws a knife for it; bare hands jab."],
  ["stab", "Stab", "A straight thrust with whatever is held: the hand drawn back, a step into a lunge, the arm shot out. A rapier's own strike."],
  ["heavy", "Heavy strike", "A great two-handed sweep from one side to the other; with a blade in each hand (the rogue), both are tossed up, caught points down and jabbed downward."],
  ["shoot", "Shoot", "Whatever shoots: a bow is drawn and loosed; a pistol is levelled at arm's length and a long gun or crossbow brought to the shoulder, then the kick, flash and smoke. Only a figure carrying one of them shoots."],
  ["cast", "Cast", "A spell or a throw: swung round overhead, then pointed at the mark as it leaves. An orb, astrolabe or chalice is held aloft and presented; a book has a hand waved over it."],
  ["play", "Play", "A bard's song: the lute strummed, the flute lifted to the mouth or the ship's bell rung, notes and wisps rising. Only a figure carrying one plays."],
  ["guard", "Guard", "Braced: knees bent and the shield brought up in front; with no shield, what is in hand and the other forearm. Shield Wall and Hold the Line."],
  ["jump", "Jump", "The jump from tile to tile: a crouch with the arms drawn back, a spring, the knees drawn up over the top and the feet put out to land, then a deep crouch on landing. Here it goes straight up and down; in the game it is carried across the tiles."],
  ["hit", "Flinch", "Taking a blow: thrown back, arms flung wide, then gathered again."],
  ["lean", "Lean", "The plain lean, easing off: what every attack used to be, and a stomp still is."],
] as const;
type Action = (typeof ACTIONS)[number][0];

const nameOf = (kind: string) => (HEROES.includes(kind) ? label("class", kind) : FOES.includes(kind) ? label("enemy", kind) : kind.replace(/_/g, " "));
/** Models with no weapon in the game yet: offered in the main hand, to see them held. */
const SPARE_MODELS = [
  ["cutlass", "Cutlass (model only)"],
  ["sabre", "Sabre (model only)"],
  ["rapier", "Rapier (model only)"],
  ["dirk", "Dirk (model only)"],
  ["pistol", "Pistol (model only)"],
  ["blunderbuss", "Blunderbuss (model only)"],
  ["harpoon-gun", "Harpoon gun (model only)"],
  ["heavy-crossbow", "Crossbow (model only)"],
] as const;
const gearChoices = (slot: Slot): { ref: string; icon: string; name: string }[] =>
  slot === "main_hand" ? [...Object.keys(WEAPONS).map((ref) => ({ ref, icon: WEAPON_ICON[ref] ?? ref, name: label("weapon", ref) })), ...SPARE_MODELS.map(([icon, name]) => ({ ref: icon, icon, name }))] : GEAR_BASES.filter((b) => slotOfRef(b.ref) === slot).map((b) => ({ ref: b.ref, icon: b.icon, name: label("gear", b.ref) }));

/** What the frame loop reads each frame: kept in a ref, so moving a slider never rebuilds the stage. */
interface Live {
  walking: boolean;
  pace: number;
  lying: boolean;
  sitting: number;
  rowing: boolean;
  speed: number;
  paused: boolean;
  spin: boolean;
  /** The figure itself turns on the spot, a quarter turn one way and then the other, to fling what hangs loose. */
  pivot: boolean;
  repeat: Action | null;
  every: number;
}

export default function FigureLab({ me, onClose }: { me: Me; onClose(): void }) {
  const [kind, setKind] = useState(() => me.character?.class_id ?? HEROES[0]);
  const [dressed, setDressed] = useState(false);
  const [gear, setGear] = useState<Partial<Record<Slot, string>>>({});
  const [rarity, setRarity] = useState<Rarity>("common");
  const [ownLook, setOwnLook] = useState(false);
  const [rod, setRod] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const [live, setLive] = useState<Live>({ walking: false, pace: 1.5, lying: false, sitting: 0, rowing: false, speed: 1, paused: false, spin: false, pivot: false, repeat: null, every: 1.6 });
  const [note, setNote] = useState("");
  const set = (patch: Partial<Live>) => setLive((was) => ({ ...was, ...patch }));

  const person = !CREATURES.has(kind);
  const appearance = useMemo(() => parseAppearance(me.character?.appearance ?? null), [me.character?.appearance]);
  // What the figure wears: nothing given draws the kind's stock look (its own clothes and weapon).
  const outfit = useMemo<Outfit | undefined>(() => {
    if (!person || (!dressed && !ownLook)) return undefined;
    const out: Outfit = {};
    if (dressed) {
      for (const slot of SLOTS) {
        const choice = gearChoices(slot).find((c) => c.ref === gear[slot]);
        if (choice) out[slot] = { ref: choice.ref, icon: choice.icon, rarity };
      }
    }
    if (ownLook && appearance) out.appearance = appearance;
    return out;
  }, [person, dressed, ownLook, gear, rarity, appearance]);

  const canvas = useRef<HTMLCanvasElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const stage = useRef<{ stand: THREE.Group; camera: THREE.PerspectiveCamera; figure: Figure | null; look: { yaw: number; pitch: number; away: number; mid: number }; act(action: Action): string; step(): void } | null>(null);

  // The stage: a floor, lights that throw the figure's shadow, and a camera that looks round it. Made once.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true });
    } catch {
      setNote("No WebGL here: the stage cannot be drawn.");
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#6f7d8c");
    scene.add(new THREE.HemisphereLight("#fff6e6", "#5a5a78", 1.9));
    const sun = new THREE.DirectionalLight("#fff1d8", 2);
    sun.position.set(-3, 6, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 20 });
    sun.shadow.bias = -0.002;
    scene.add(sun);
    const rim = new THREE.DirectionalLight("#9fc8ff", 0.7);
    rim.position.set(4, 3, -5);
    scene.add(rim);
    // The floor: a hex the size of a tile, so strides and reaches can be judged against the game's own ground.
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.08, 6).translate(0, -0.04, 0), new THREE.MeshLambertMaterial({ color: "#8f9a86" }));
    floor.receiveShadow = true;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 48).rotateX(-Math.PI / 2).translate(0, -0.08, 0), new THREE.MeshLambertMaterial({ color: "#77838f" }));
    ground.receiveShadow = true;
    const stand = new THREE.Group();
    scene.add(floor, ground, stand);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
    const look = { yaw: 0.5, pitch: 0.28, away: 6, mid: 0.8 };

    let t = 0;
    let stride = 0;
    let lean = 0;
    let sinceAct = 0;
    /** A jump under way: when the feet leave the ground, on the stage's clock. */
    let sprang = -Infinity;
    const draw = (dt: number) => {
      const s = stage.current;
      const now = liveRef.current;
      if (!s) return;
      t += dt;
      lean *= Math.exp(-dt * LEAN_EASE);
      if (now.walking) stride += dt * now.pace;
      if (now.repeat) {
        sinceAct += dt;
        if (sinceAct >= now.every) s.act(now.repeat);
      }
      // Turned on the spot (before the pose, so what hangs loose feels this frame's turn).
      if (s.figure) {
        const facing = now.pivot ? [0, 1, 0, -1][Math.floor(t / 1.4) % 4] * (Math.PI / 2) : 0;
        const r = s.figure.root.rotation;
        r.y += (facing - r.y) * Math.min(1, dt * 9);
      }
      // At the oars the stroke runs on its own: reach, pull, reach.
      const rowing = now.rowing ? 0.5 - 0.5 * Math.cos(t * 2.4) : undefined;
      s.figure?.update({ time: t, stride, walking: now.walking, lean, lying: now.lying, sitting: now.sitting, rowing });
      // A jump goes up and comes down on the spot, as high as one of two tiles does in the game.
      const up = (t - sprang) / JUMP_AIR;
      if (s.figure) s.figure.root.position.y = up > 0 && up < 1 ? 4 * JUMP_HIGH * up * (1 - up) : 0;
      if (readout.current) readout.current.textContent = `${t.toFixed(2)}s · lean ${lean.toFixed(2)} · strike ${Math.min(1, Math.abs(lean) * 2).toFixed(2)}`;
    };
    const act = (action: Action): string => {
      sinceAct = 0;
      const figure = stage.current?.figure;
      if (!figure) return "";
      if (action === "hit") {
        figure.hit();
        return "";
      }
      if (action === "strike" || action === "stab" || action === "heavy") {
        const wait = figure.strike(action === "strike" ? "light" : action);
        return wait > 0 ? `The blow lands ${wait.toFixed(2)}s in.` : "A creature: it has no wind-up, and lunges at once.";
      }
      if (action === "cast") {
        const wait = figure.cast();
        return wait > 0 ? `It leaves the hand ${wait.toFixed(2)}s in.` : "A creature, or a hand already pointing: it leaves at once.";
      }
      if (action === "jump") {
        const wait = figure.jump(JUMP_AIR);
        sprang = t + wait;
        return wait > 0 ? `The feet leave the ground ${wait.toFixed(2)}s in, and come down ${(wait + JUMP_AIR).toFixed(2)}s in.` : "A creature: it has no crouch, and springs at once.";
      }
      if (action === "guard") {
        const wait = figure.guard();
        return wait > 0 ? `The guard is up ${wait.toFixed(2)}s in.` : "A creature: it has no guard.";
      }
      if (action === "play") {
        const wait = figure.play();
        return wait > 0 ? `The song takes hold ${wait.toFixed(2)}s in.` : "No instrument in hand, or already mid-song. Pick the Shanty Bard, or give a person a lute, a flute or the ship's bell.";
      }
      if (action === "shoot") {
        // As the game does it: a bow if there is one, else a gun or a crossbow.
        const wait = figure.loose() || figure.fire();
        return wait > 0 ? `The shot leaves ${wait.toFixed(2)}s in.` : "Nothing in hand that shoots. Pick the Archer, or dress a person in gear and give them a shortbow, pistol, blunderbuss, harpoon gun or crossbow.";
      }
      lean = -0.9;
      return "";
    };
    stage.current = { stand, camera, figure: null, look, act, step: () => draw(1 / 60) };

    let raf = 0;
    let last = performance.now();
    const frame = (at: number) => {
      const s = stage.current;
      if (!s) return;
      const real = Math.min(0.1, (at - last) / 1000);
      last = at;
      const now = liveRef.current;
      if (now.spin && !dragging) look.yaw += real * 0.5;
      if (!now.paused) draw(real * now.speed);
      // The camera goes round the figure; the figure itself stays facing +z, as in the game.
      const flat = Math.cos(look.pitch) * look.away;
      camera.position.set(Math.sin(look.yaw) * flat, look.mid + Math.sin(look.pitch) * look.away, Math.cos(look.yaw) * flat);
      camera.lookAt(0, look.mid, 0);
      const [w, h] = [el.clientWidth, el.clientHeight];
      if (w > 0 && h > 0 && (el.width !== Math.round(w * renderer.getPixelRatio()) || el.height !== Math.round(h * renderer.getPixelRatio()))) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // Drag to look round and over the figure; the wheel comes closer or stands back.
    let dragging = false;
    let from = { x: 0, y: 0 };
    const down = (e: PointerEvent) => {
      dragging = true;
      from = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      look.yaw -= (e.clientX - from.x) * 0.01;
      look.pitch = Math.min(1.45, Math.max(-0.1, look.pitch + (e.clientY - from.y) * 0.008));
      from = { x: e.clientX, y: e.clientY };
    };
    const up = () => {
      dragging = false;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      look.away = Math.min(14, Math.max(1.6, look.away * Math.exp(e.deltaY * 0.0012)));
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
      stage.current?.figure?.dispose();
      floor.geometry.dispose();
      ground.geometry.dispose();
      renderer.dispose();
      stage.current = null;
    };
  }, []);

  // The figure: built afresh whenever who it is, what it wears or how it is made changes.
  const built = `${kind}|${JSON.stringify(outfit ?? null)}|${rod}|${asleep}`;
  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    if (s.figure) {
      s.stand.remove(s.figure.root);
      s.figure.dispose();
    }
    const figure = makeFigure(kind, lookFor(kind), outfit, { asleep, rod });
    figure.setSize(SIZE);
    s.stand.add(figure.root);
    s.figure = figure;
    // Look at its middle, standing far enough back to take all of it in.
    figure.update({ time: 0, stride: 0, walking: false, lean: 0, lying: false });
    figure.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(figure.root);
    s.look.mid = Math.max(0.4, (box.max.y + box.min.y) / 2);
    setNote("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built]);

  // Escape shuts the lab; the space bar holds and lets go of time.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "Escape") onClose();
      else if (e.key === " ") {
        e.preventDefault();
        setLive((was) => ({ ...was, paused: !was.paused }));
      } else return;
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);

  const act = (action: Action) => setNote(stage.current?.act(action) ?? "");
  const view = (yaw: number, pitch: number) => {
    if (stage.current) Object.assign(stage.current.look, { yaw, pitch });
  };

  return (
    <div className="figure-lab" role="dialog" aria-label="Figure lab">
      <canvas ref={canvas} className="figure-lab-stage" aria-label="The figure on its stage. Drag to look round it; scroll to come closer." role="img" />
      <div className="figure-lab-side panel">
        <div className="figure-lab-head">
          <strong>Figure lab</strong>
          <button className="link" onClick={onClose}>
            Close
          </button>
        </div>

        <h4>Who</h4>
        <div className="dev-row">
          <select value={kind} aria-label="Figure" onChange={(e) => setKind(e.target.value)}>
            {(
              [
                ["Heroes", HEROES],
                ["Townsfolk", TOWNSFOLK],
                ["Enemies", FOES],
              ] as const
            ).map(([group, kinds]) => (
              <optgroup key={group} label={group}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {nameOf(k)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        {person ? (
          <>
            <div className="dev-row">
              <label>
                <input type="checkbox" checked={dressed} onChange={(e) => setDressed(e.target.checked)} /> Dress in gear
              </label>
              <label title={appearance ? "Your own hero's face, hair and build." : "Your hero has not chosen a look."}>
                <input type="checkbox" checked={ownLook} disabled={!appearance} onChange={(e) => setOwnLook(e.target.checked)} /> My hero's look
              </label>
              <label title="A fishing rod in the right hand, as at a pier.">
                <input type="checkbox" checked={rod} onChange={(e) => setRod(e.target.checked)} /> Rod
              </label>
            </div>
            {dressed && (
              <div className="figure-lab-gear">
                {SLOTS.map((slot) => (
                  <label key={slot}>
                    <span>{SLOT_LABEL[slot]}</span>
                    <select value={gear[slot] ?? ""} onChange={(e) => setGear((was) => ({ ...was, [slot]: e.target.value }))}>
                      <option value="">Nothing</option>
                      {gearChoices(slot).map((c) => (
                        <option key={c.ref} value={c.ref}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <label>
                  <span>Rarity</span>
                  <select value={rarity} onChange={(e) => setRarity(e.target.value as Rarity)}>
                    {RARITIES.map((r) => (
                      <option key={r} value={r}>
                        {r[0].toUpperCase() + r.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </>
        ) : (
          <p className="muted">A creature: it has its own body and wears no gear.</p>
        )}

        <h4>Actions</h4>
        <div className="dev-row">
          {ACTIONS.map(([id, name, what]) => (
            <button key={id} className="small primary" title={what} onClick={() => act(id)}>
              {name}
            </button>
          ))}
        </div>
        <div className="dev-row">
          <label title="Do it again and again, this often.">
            Repeat
            <select value={live.repeat ?? ""} onChange={(e) => set({ repeat: (e.target.value || null) as Action | null })}>
              <option value="">Off</option>
              {ACTIONS.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            every
            <input type="range" min={0.6} max={4} step={0.1} value={live.every} onChange={(e) => set({ every: Number(e.target.value) })} />
            {live.every.toFixed(1)}s
          </label>
        </div>
        {note && <p className="figure-lab-note">{note}</p>}

        <h4>Pose</h4>
        <div className="dev-row">
          <label>
            <input type="checkbox" checked={live.walking} onChange={(e) => set({ walking: e.target.checked })} /> Walk
          </label>
          <label>
            pace
            <input type="range" min={0.3} max={4} step={0.1} value={live.pace} onChange={(e) => set({ pace: Number(e.target.value) })} />
          </label>
        </div>
        <div className="dev-row">
          <label title="Down in a fight, or on a bedroll.">
            <input type="checkbox" checked={live.lying} onChange={(e) => set({ lying: e.target.checked })} /> Lying
          </label>
          <button
            className="small"
            title="Killed: it goes limp and falls where it stands, knocked backward by the blow (a ragdoll), as anyone downed in a fight does. Untick Lying and it gets up again."
            onClick={() => {
              const figure = stage.current?.figure;
              if (!figure) return;
              liveRef.current = { ...liveRef.current, lying: true };
              set({ lying: true });
              figure.fall(new THREE.Vector3(0, 0, -1).applyQuaternion(figure.root.getWorldQuaternion(new THREE.Quaternion())));
            }}
          >
            Fall dead
          </button>
          <button
            className="small"
            title="Shoved off its feet: it falls (a ragdoll), lies a moment, then gets up again, as from a shove in a fight."
            onClick={() => {
              const figure = stage.current?.figure;
              if (!figure) return;
              liveRef.current = { ...liveRef.current, lying: true };
              set({ lying: true });
              figure.fall(new THREE.Vector3(0, 0, -1).applyQuaternion(figure.root.getWorldQuaternion(new THREE.Quaternion())));
              setTimeout(() => {
                liveRef.current = { ...liveRef.current, lying: false };
                set({ lying: false });
              }, 1600);
            }}
          >
            Knocked down
          </button>
          <label title="Eyes shut. The figure is built again.">
            <input type="checkbox" checked={asleep} onChange={(e) => setAsleep(e.target.checked)} /> Asleep
          </label>
          <label title="At the oars of a rowboat: seated, the stroke running.">
            <input type="checkbox" checked={live.rowing} disabled={!person} onChange={(e) => set({ rowing: e.target.checked })} /> Rowing
          </label>
        </div>
        <div className="dev-row">
          <label title="From standing (0) to seated (1): only people sit.">
            Sit
            <input type="range" min={0} max={1} step={0.01} value={live.sitting} disabled={!person} onChange={(e) => set({ sitting: Number(e.target.value) })} />
            {live.sitting.toFixed(2)}
          </label>
        </div>

        <h4>Time</h4>
        <div className="dev-row">
          {SPEEDS.map((s) => (
            <button key={s} className={`small ${live.speed === s ? "selected" : ""}`} aria-pressed={live.speed === s} onClick={() => set({ speed: s })}>
              {s}×
            </button>
          ))}
          <button className={`small ${live.paused ? "selected" : ""}`} aria-pressed={live.paused} title="Space" onClick={() => set({ paused: !live.paused })}>
            {live.paused ? "Paused" : "Pause"}
          </button>
          <button className="small" disabled={!live.paused} title="One frame on: a sixtieth of a second." onClick={() => stage.current?.step()}>
            Step
          </button>
        </div>
        <p className="muted figure-lab-readout">
          <span ref={readout} />
        </p>

        <h4>View</h4>
        <div className="dev-row">
          <button className="small" onClick={() => view(0, 0.12)}>
            Front
          </button>
          <button className="small" onClick={() => view(Math.PI / 2, 0.12)}>
            Side
          </button>
          <button className="small" onClick={() => view(Math.PI, 0.12)}>
            Back
          </button>
          <button className="small" title="About where the game's camera looks from." onClick={() => view(0.5, 0.75)}>
            Game
          </button>
          <label>
            <input type="checkbox" checked={live.spin} onChange={(e) => set({ spin: e.target.checked })} /> Turn
          </label>
          <label title="The figure turns on the spot, a quarter turn each way: a flail's ball or a lantern swings out and back.">
            <input type="checkbox" checked={live.pivot} onChange={(e) => set({ pivot: e.target.checked })} /> Pivot
          </label>
        </div>
        <p className="muted">Drag the stage to look round the figure; scroll to come closer. Space pauses, Escape closes.</p>
      </div>
    </div>
  );
}
