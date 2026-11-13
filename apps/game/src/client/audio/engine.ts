// The audio engine: one Web Audio graph for the whole game.
//
//   one-shots ─────────────► SFX:        your trim ─► player slider ─┐
//   atmosphere loops ──────► Atmosphere: your trim ─► player slider ─┼─► master trim ─► master slider ─► hush ─► limiter ─► out
//   music loops, stingers ─► Music:      your trim ─► player slider ─┘
//
// The game asks for sounds by name (`audio.play("footstep.cobble")`) and says
// which scene it is in (`useAudioScene("harbor")`); manifest.ts decides what
// each of those means. Nothing sounds until the player's first click or key
// (browsers allow audio only after one), and the game goes quiet while its
// tab is hidden, as its animation pauses then too.

import { AUDIO } from "./manifest";
import { Library } from "./library";
import { MixStore, dbToGain, faderGain } from "./mixer";
import { TakePicker, curveAt, distanceGain, expandFiles, inRange, placeSound, resolveName, untilNextLine, type Placed } from "./select";
import type { AudioFile, AudioManifest, Emitter, EmitterKind, Follow, Group, Loop, ParamName, SceneName, SoundEvent } from "./types";

const GROUPS: Group[] = ["music", "atmosphere", "sfx"];
/** The most one-shots sounding at once; past it the oldest fades out. */
const MAX_VOICES = 48;
/** A one-shot still loading when it is asked for plays if it is ready within this many seconds, else it is dropped. */
const LATE_LIMIT = 0.25;

export interface PlayOptions {
  /** Where it happens in the world (x, z): it falls off with distance from where you stand. */
  at?: { x: number; z: number };
  /** Extra level for this play, in dB. */
  gainDb?: number;
  /** Extra seconds before it sounds, on top of the event's own delay. */
  delay?: number;
}

interface Voice {
  event: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
}

interface LoopVoice {
  /** "music:harbor" or "ambience:harbor". */
  id: string;
  def: Loop;
  group: Group;
  /** The URLs of its files, to tell when one has changed. */
  urls: string;
  /** The whole loop: its level and its fades. */
  out: GainNode;
  /** The main file, then each layer: its own level and whatever its curve gives. */
  parts: { file: string; src: AudioBufferSourceNode; gain: GainNode; gainDb: number; follow?: Follow }[];
  /** When it started on the audio clock (null while loading), and where in the file. */
  startedAt: number | null;
  offset: number;
  region: { start: number; end: number };
}

/**
 * Where the sea is from where you stand: how far the nearest water is, which way most of it lies
 * (dx, dz: a direction on the map, shorter the more the water is all around), and `spread`, 0 when it
 * is all to one side and 1 when it surrounds you.
 */
export interface SeaArea {
  distance: number;
  dx: number;
  dz: number;
  spread: number;
}

/** Where a placed sound sits: all the placer needs, whichever way it places. */
type Spot = Pick<Placed, "pan" | "side" | "ahead">;

/** Puts a sound to one side: panned between two speakers, or around the head for headphones. */
interface Placer {
  node: AudioNode;
  move(at: Spot, now: number, glide: number): void;
}

/** How far above the ground your ears are, in map units. A sound right where you stand is then below you, not nowhere. */
const EAR_HEIGHT = 1.5;

function makePlacer(ctx: AudioContext, headphones: boolean): Placer {
  const set = (p: AudioParam, v: number, now: number, glide: number) => (glide > 0 ? p.setTargetAtTime(v, now, glide) : p.setValueAtTime(v, now));
  if (headphones) {
    // HRTF: the browser filters the sound as each ear would hear it from that direction. Level and
    // dulling with distance are still ours, so the panner's own distance falloff is switched off.
    const node = ctx.createPanner();
    node.panningModel = "HRTF";
    node.distanceModel = "linear";
    node.rolloffFactor = 0;
    node.positionY.value = -EAR_HEIGHT;
    return {
      node,
      move(at, now, glide) {
        set(node.positionX, at.side, now, glide);
        // Up the screen is in front of you; Web Audio's listener faces down its −z.
        set(node.positionZ, -at.ahead, now, glide);
      },
    };
  }
  const node = ctx.createStereoPanner();
  return { node, move: (at, now, glide) => set(node.pan, Math.max(-1, Math.min(1, at.pan)), now, glide) };
}

/** The reverb of the place you are in: two convolvers, so one can fade in with the next place as the other fades out. */
interface ReverbBus {
  input: GainNode;
  units: { conv: ConvolverNode; out: GainNode }[];
  active: number;
}

interface EmitterSlot {
  src: AudioBufferSourceNode;
  gain: GainNode;
  filter: BiquadFilterNode;
  placer: Placer;
  /** Where it was last put, for the debug readout. */
  pan: number;
  /** The source it is sounding for, by position; null while free. */
  key: string | null;
}

interface EmitterGroup {
  file: string;
  out: GainNode | null;
  slots: EmitterSlot[];
  ready: boolean;
}

interface Bus {
  groups: Record<Group, { trim: GainNode; fader: GainNode }>;
  masterTrim: GainNode;
  masterFader: GainNode;
  hush: GainNode;
}

/**
 * Move a gain to `to` over `seconds` on an equal-power curve (it holds its
 * loudness through a crossfade), starting from wherever it is now, even mid-fade.
 */
function fade(param: AudioParam, now: number, to: number, seconds: number) {
  const from = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  if (seconds <= 0.01 || Math.abs(to - from) < 1e-4) {
    param.setValueAtTime(to, now + 0.001);
    return;
  }
  const curve = new Float32Array(64);
  for (let i = 0; i < curve.length; i++) {
    const t = i / (curve.length - 1);
    curve[i] = to > from ? from + (to - from) * Math.sin((t * Math.PI) / 2) : to + (from - to) * Math.cos((t * Math.PI) / 2);
  }
  param.setValueCurveAtTime(curve, now + 0.001, seconds);
}

/** Where a loop goes round, in seconds: the manifest's region, else the file's loop markers, else the whole file. */
export function loopRegion(def: Loop, file: AudioFile | undefined, duration: number): { start: number; end: number } {
  const clamp = (start: number, end: number) => {
    const s = Math.max(0, Math.min(start, duration));
    const e = Math.max(s, Math.min(end, duration));
    return e - s > 0.01 ? { start: s, end: e } : { start: 0, end: duration };
  };
  if (def.loop) {
    const k = def.loop.unit === "samples" ? 1 / (file?.sampleRate || 48000) : 1;
    return clamp(def.loop.start * k, def.loop.end * k);
  }
  if (file?.loop) return clamp(file.loop.start, file.loop.end);
  return { start: 0, end: duration };
}

/** Whether a loop that keeps playing across a change can carry on as it is (a change of level or curve can). */
function sameTake(a: Loop, b: Loop) {
  const files = (l: Loop) => [l.file, ...(l.layers ?? []).map((x) => x.file)].join("|");
  return files(a) === files(b) && a.startAt === b.startAt && JSON.stringify(a.loop) === JSON.stringify(b.loop);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** How much decoded audio to hold: less on phones and small devices. */
function memoryBudget(): number {
  const mem = (navigator as { deviceMemory?: number }).deviceMemory;
  const phone = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return (mem !== undefined ? mem <= 4 : phone) ? 64e6 : 160e6;
}

export class AudioEngine {
  readonly mix: MixStore;
  private ctx: AudioContext | null = null;
  private lib: Library | null = null;
  private bus: Bus | null = null;
  private indexed = false;
  private voices: Voice[] = [];
  private loops = new Map<string, LoopVoice>();
  private takes = new Map<string, TakePicker>();
  private lastPlayed = new Map<string, number>();
  private expanded = new Map<string, string[]>();
  private scenes: { id: number; scene: SceneName | null }[] = [];
  private nextScene = 1;
  private listener: { x: number; z: number } | null = null;
  /** The camera's turn about the map, which decides what is left and what is right. */
  private yaw = 0;
  private points = new Map<EmitterKind, { x: number; z: number }[]>();
  private sea: SeaArea | null = null;
  private emitters = new Map<EmitterKind, EmitterGroup>();
  private worldAt = 0;
  private headphones = false;
  private reverb: ReverbBus | null = null;
  /** The ground you stand on, and the reverb zone now heard (undefined before the first is chosen). */
  private ground: string | null = null;
  private zone: string | null | undefined = undefined;
  private zoneTimer: ReturnType<typeof setTimeout> | undefined;
  private zoneAt = 0;
  private params = new Map<ParamName, number>();
  private reported = new Set<string>();
  private suspendTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private manifest: AudioManifest) {
    this.mix = new MixStore(manifest.mix, safeStorage());
    this.headphones = this.mix.get().headphones;
    this.mix.subscribe(() => {
      this.applyMix();
      // Switching between speakers and headphones: placed loops are rebuilt with the other kind of placer.
      if (this.mix.get().headphones !== this.headphones) {
        this.headphones = this.mix.get().headphones;
        for (const kind of [...this.emitters.keys()]) this.dropEmitter(kind);
      }
    });
    if (typeof window === "undefined") return;
    // iOS counts only some events as permission to play, so listen for all of them until one works.
    for (const type of ["pointerdown", "pointerup", "touchend", "keydown"]) window.addEventListener(type, this.unlock, { capture: true });
    document.addEventListener("visibilitychange", () => this.onVisibility());
  }

  // ---------- what the game calls ----------

  /**
   * Play a one-shot. Give several names to fall back from the most specific
   * to the most general: the first one the manifest has files for plays.
   */
  play(names: string | string[], opts: PlayOptions = {}): void {
    const { ctx, lib } = this;
    if (!ctx || !lib || !this.indexed || ctx.state !== "running") return;
    const candidates = Array.isArray(names) ? names : [names];
    const name = resolveName(candidates, (n) => this.takesOf(n).length > 0);
    if (!name) return this.report(candidates);
    const ev = this.manifest.events[name];
    const now = ctx.currentTime;
    if (ev.cooldown && now - (this.lastPlayed.get(name) ?? -Infinity) < ev.cooldown) return;

    let gain = dbToGain((ev.gainDb ?? 0) + inRange(ev.volume) + (opts.gainDb ?? 0));
    // Placed in the world: quieter, duller and off to one side, by where it is from you and how the camera is turned.
    let placed: Placed | undefined;
    if (opts.at && this.listener) {
      const p = placeSound(opts.at.x - this.listener.x, opts.at.z - this.listener.z, this.yaw);
      if (p.gain < 0.01) return;
      gain *= p.gain;
      placed = p;
    }
    this.lastPlayed.set(name, now);
    const files = this.takesOf(name);
    const picker = this.takes.get(name) ?? new TakePicker();
    this.takes.set(name, picker);
    const key = files[picker.next(files.length, ev.order)];
    const when = now + (ev.delay ?? 0) + (opts.delay ?? 0);
    const rate = 2 ** (inRange(ev.pitch) / 12);

    const ready = lib.ready(key);
    if (ready) this.voice(name, ev, ready, when, gain, rate, placed);
    else
      void lib.load(key).then((buffer) => {
        if (buffer && ctx.currentTime - when < LATE_LIMIT) this.voice(name, ev, buffer, Math.max(when, ctx.currentTime), gain, rate, placed);
      });
  }

  /** Where you stand, in world x and z, and how the camera is turned about the map. The renderer sets it every frame. */
  setListener(x: number, z: number, yaw = 0) {
    if (this.listener) {
      this.listener.x = x;
      this.listener.z = z;
    } else this.listener = { x, z };
    this.yaw = yaw;
    this.updateWorld();
  }

  /** Enter a scene. The newest scene still entered is the one heard; leave it with popScene. */
  pushScene(scene: SceneName | null): number {
    const id = this.nextScene++;
    this.scenes.push({ id, scene });
    this.applyScene();
    return id;
  }

  /** Change an entered scene in place (an island turning into a fight). */
  setScene(id: number, scene: SceneName | null) {
    const entry = this.scenes.find((s) => s.id === id);
    if (!entry || entry.scene === scene) return;
    entry.scene = scene;
    this.applyScene();
  }

  popScene(id: number) {
    this.scenes = this.scenes.filter((s) => s.id !== id);
    this.applyScene();
  }

  get scene(): SceneName | null {
    return this.scenes.at(-1)?.scene ?? null;
  }

  // ---------- starting up ----------

  private unlock = () => {
    if (!this.ctx) this.boot();
    const ctx = this.ctx;
    if (ctx && ctx.state !== "running" && !document.hidden) void ctx.resume().catch(() => undefined);
  };

  private boot() {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: "interactive" });
    } catch {
      return;
    }
    this.ctx = ctx;

    // A safety limiter on the very end, so stacked sounds never clip. Mix so it rarely has work to do.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    const masterTrim = ctx.createGain();
    const masterFader = ctx.createGain();
    const hush = ctx.createGain();
    masterTrim.connect(masterFader).connect(hush).connect(limiter).connect(ctx.destination);
    const groups = {} as Bus["groups"];
    for (const g of GROUPS) {
      const trim = ctx.createGain();
      const fader = ctx.createGain();
      trim.connect(fader).connect(masterTrim);
      groups[g] = { trim, fader };
    }
    this.bus = { groups, masterTrim, masterFader, hush };
    this.applyMix(true);
    // The reverb returns into the SFX group, so its slider turns the room down with the sounds in it.
    const input = ctx.createGain();
    const units = [0, 1].map(() => {
      const conv = ctx.createConvolver();
      const out = ctx.createGain();
      out.gain.value = 0;
      input.connect(conv).connect(out).connect(groups.sfx.trim);
      return { conv, out };
    });
    this.reverb = { input, units, active: 0 };

    this.lib = new Library(ctx, memoryBudget());
    void this.lib.loadIndex().then(() => {
      this.indexed = true;
      this.applyScene();
      this.preloadEffects();
    });
  }

  /** Decode every one-shot in the background, a few at a time, so the first footstep is not late. */
  private preloadEffects() {
    const lib = this.lib;
    if (!lib) return;
    const keys = new Set<string>();
    for (const name of Object.keys(this.manifest.events)) for (const k of this.takesOf(name)) keys.add(k);
    const queue = [...keys];
    let active = 0;
    const pump = () => {
      while (active < 4 && queue.length > 0) {
        active++;
        void lib.load(queue.shift()!).finally(() => {
          active--;
          pump();
        });
      }
    };
    pump();
  }

  // ---------- the mix ----------

  private applyMix(immediate = false) {
    const { ctx, bus } = this;
    if (!ctx || !bus) return;
    const now = ctx.currentTime;
    // Glide rather than jump, so dragging a slider never zips.
    const set = (p: AudioParam, v: number) => {
      p.cancelScheduledValues(now);
      if (immediate) p.setValueAtTime(v, now);
      else p.setTargetAtTime(v, now, 0.04);
    };
    for (const g of GROUPS) {
      set(bus.groups[g].trim.gain, dbToGain(this.manifest.mix[g].trimDb));
      set(bus.groups[g].fader.gain, faderGain(this.mix.volume(g)));
    }
    set(bus.masterTrim.gain, dbToGain(this.manifest.mix.master.trimDb));
    set(bus.masterFader.gain, this.mix.get().muted ? 0 : faderGain(this.mix.volume("master")));
  }

  private onVisibility() {
    const { ctx, bus } = this;
    if (!ctx || !bus) return;
    clearTimeout(this.suspendTimer);
    if (document.hidden) {
      fade(bus.hush.gain, ctx.currentTime, 0, 0.15);
      this.suspendTimer = setTimeout(() => void ctx.suspend().catch(() => undefined), 250);
    } else {
      void ctx
        .resume()
        .then(() => fade(bus.hush.gain, ctx.currentTime, 1, 0.5))
        .catch(() => undefined);
    }
  }

  // ---------- one-shots ----------

  /** The file keys an event can play, worked out once per index. */
  private takesOf(name: string): string[] {
    let files = this.expanded.get(name);
    if (!files) {
      const ev = this.manifest.events[name];
      files = ev && this.lib ? expandFiles(ev.files, this.lib.keys()) : [];
      this.expanded.set(name, files);
    }
    return files;
  }

  private voice(name: string, ev: SoundEvent, buffer: AudioBuffer, when: number, gain: number, rate: number, placed?: Placed) {
    const { ctx, bus } = this;
    if (!ctx || !bus) return;
    const same = this.voices.filter((v) => v.event === name);
    if (same.length >= (ev.maxVoices ?? 4)) this.release(same[0]);
    if (this.voices.length >= MAX_VOICES) this.release(this.voices[0]);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    const dest = bus.groups[ev.group ?? "sfx"].trim;
    let tail: AudioNode = g;
    if (placed) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = placed.cutoff;
      const placer = makePlacer(ctx, this.headphones);
      placer.move(placed, ctx.currentTime, 0);
      g.connect(filter).connect(placer.node);
      tail = placer.node;
    }
    src.connect(g);
    tail.connect(dest);
    // A share of it goes to the reverb of the place you are in, before it is panned: a room answers from all round.
    let send: GainNode | null = null;
    if (ev.reverb !== undefined && this.reverb) {
      send = ctx.createGain();
      send.gain.value = dbToGain(ev.reverb);
      g.connect(send).connect(this.reverb.input);
    }
    const voice: Voice = { event: name, src, gain: g };
    this.voices.push(voice);
    src.onended = () => {
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
      tail.disconnect();
      send?.disconnect();
    };
    src.start(when);
  }

  /** Fade a one-shot out quickly to make room for another. */
  private release(voice: Voice) {
    const ctx = this.ctx!;
    const i = this.voices.indexOf(voice);
    if (i >= 0) this.voices.splice(i, 1);
    fade(voice.gain.gain, ctx.currentTime, 0, 0.03);
    try {
      voice.src.stop(ctx.currentTime + 0.05);
    } catch {
      /* already stopped */
    }
  }

  // ---------- scenes and loops ----------

  /** Tell the engine a value loops can follow (see ParamName). Call as often as you like. */
  setParam(name: ParamName, value: number) {
    if (Math.abs((this.params.get(name) ?? -1) - value) < 0.002) return;
    this.params.set(name, value);
    if (!this.ctx) return;
    for (const lv of this.loops.values()) if (lv.parts.some((p) => p.follow?.param === name)) this.levelParts(lv, 0.15);
  }

  /** Set each stem of a loop to its own level times whatever its curve gives right now. */
  private levelParts(lv: LoopVoice, glide: number) {
    const now = this.ctx!.currentTime;
    for (const part of lv.parts) {
      const follow = part.follow ? curveAt(part.follow.curve, this.params.get(part.follow.param) ?? 0) : 1;
      const level = dbToGain(part.gainDb) * Math.max(0, Math.min(1, follow));
      part.gain.gain.cancelScheduledValues(now);
      if (glide > 0) part.gain.gain.setTargetAtTime(level, now, glide);
      else part.gain.gain.setValueAtTime(level, now);
    }
  }

  private applyScene() {
    if (!this.ctx || !this.lib || !this.indexed) return;
    const scene = this.scene ? this.manifest.scenes[this.scene] : undefined;
    const want = new Map<string, { def: Loop; group: Group }>();
    if (scene?.music && this.manifest.music[scene.music]) want.set(`music:${scene.music}`, { def: this.manifest.music[scene.music], group: "music" });
    for (const name of scene?.ambience ?? []) {
      if (this.manifest.ambience[name]) want.set(`ambience:${name}`, { def: this.manifest.ambience[name], group: "atmosphere" });
    }
    const now = this.ctx.currentTime;
    const incoming = [...want].filter(([id]) => !this.loops.has(id)).map(([, w]) => w);
    // New music can wait for the next bar or beat of the music it replaces.
    const enter = incoming.find((w) => w.group === "music")?.def.enter ?? "now";
    let wait = 0;
    for (const [id, lv] of [...this.loops]) {
      const next = want.get(id);
      if (next && sameTake(lv.def, next.def)) {
        // Only levels or curves changed (the manifest was edited): glide there and keep playing.
        const levelChanged = next.def.gainDb !== lv.def.gainDb;
        lv.def = next.def;
        const defs = [next.def, ...(next.def.layers ?? [])];
        lv.parts.forEach((part) => {
          const d = defs.find((x) => x.file === part.file);
          part.follow = d?.follow;
          part.gainDb = d === next.def ? 0 : (d?.gainDb ?? 0);
        });
        if (lv.startedAt !== null) {
          this.levelParts(lv, 0.15);
          if (levelChanged) fade(lv.out.gain, now, dbToGain(next.def.gainDb ?? 0), 0.3);
        }
        continue;
      }
      if (lv.group === "music" && enter !== "now" && lv.def.bpm && lv.startedAt !== null && lv.startedAt <= now) {
        const unit = (60 / lv.def.bpm) * (enter === "bar" ? (lv.def.beatsPerBar ?? 4) : 1);
        wait = untilNextLine(now - lv.startedAt, lv.offset, lv.region, lv.def.startAt === "loop" ? lv.region.start : 0, unit);
      }
    }
    for (const [id, lv] of [...this.loops]) {
      const next = want.get(id);
      if (!next || !sameTake(lv.def, next.def)) this.stopLoop(lv, undefined, lv.group === "music" ? wait : 0);
    }
    for (const [id, w] of want) if (!this.loops.has(id)) void this.startLoop(id, w.def, w.group, undefined, w.group === "music" ? now + wait : now);
    this.scheduleZone();
  }

  private async startLoop(id: string, def: Loop, group: Group, fadeIn = def.fadeIn ?? 2, at = 0) {
    const { ctx, lib, bus } = this;
    if (!ctx || !lib || !bus) return;
    const defs = [{ file: def.file, gainDb: 0, follow: def.follow }, ...(def.layers ?? [])];
    // A stem with no file yet is left out; the rest still play.
    const have = defs.filter((d, i) => {
      if (lib.url(d.file)) return true;
      this.report([`${id} (${i === 0 ? "file" : "layer"} "${d.file}")`]);
      return false;
    });
    if (have.length === 0 || have[0] !== defs[0]) return;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(bus.groups[group].trim);
    const lv: LoopVoice = { id, def, group, urls: have.map((d) => lib.url(d.file)).join("|"), out, parts: [], startedAt: null, offset: 0, region: { start: 0, end: 0 } };
    this.loops.set(id, lv);
    const files = have.map((d) => d.file);
    files.forEach((f) => lib.pin(f));
    const buffers = await Promise.all(files.map((f) => lib.load(f)));
    // The scene moved on while it loaded, or the main file would not load.
    if (this.loops.get(id) !== lv || !buffers[0]) {
      if (this.loops.get(id) === lv) this.loops.delete(id);
      files.forEach((f) => lib.unpin(f));
      out.disconnect();
      return;
    }
    const region = loopRegion(def, lib.file(def.file), buffers[0].duration);
    const offset = def.startAt === "loop" ? region.start : 0;
    // Every stem starts on the same sample, a moment ahead so none of them is late.
    const when = Math.max(at, ctx.currentTime + 0.05);
    have.forEach((d, i) => {
      const buffer = buffers[i];
      if (!buffer) return lib.unpin(d.file);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.loopStart = region.start;
      src.loopEnd = Math.min(region.end, buffer.duration);
      const gain = ctx.createGain();
      src.connect(gain).connect(out);
      src.onended = () => {
        gain.disconnect();
        lib.unpin(d.file);
        if (i === 0) out.disconnect();
      };
      src.start(when, offset);
      lv.parts.push({ file: d.file, src, gain, gainDb: i === 0 ? 0 : (d.gainDb ?? 0), follow: d.follow });
    });
    lv.startedAt = when;
    lv.offset = offset;
    lv.region = region;
    this.levelParts(lv, 0);
    fade(out.gain, when, dbToGain(def.gainDb ?? 0), fadeIn);
  }

  private stopLoop(lv: LoopVoice, fadeOut = lv.def.fadeOut ?? 2, wait = 0) {
    const ctx = this.ctx!;
    if (this.loops.get(lv.id) === lv) this.loops.delete(lv.id);
    if (lv.startedAt === null) return; // still loading: startLoop sees it was dropped and lets go
    // Switching on a bar line, the old music gets out of the way quickly.
    const seconds = wait > 0 ? Math.min(fadeOut, 0.4) : fadeOut;
    const when = Math.max(ctx.currentTime + wait, lv.startedAt);
    fade(lv.out.gain, when, 0, seconds);
    for (const part of lv.parts) part.src.stop(when + seconds + 0.05);
  }

  // ---------- sounds placed in the world ----------

  /** Where the looping sources of one kind are (every fire, say). Only the nearest few are heard. */
  setEmitters(kind: EmitterKind, points: { x: number; z: number }[]) {
    this.points.set(kind, points);
    if (points.length === 0) this.dropEmitter(kind);
  }

  /** Where the sea is from where you stand, or null with no water near. */
  setSea(area: SeaArea | null) {
    this.sea = area;
    if (!area) this.dropEmitter("sea");
  }

  /** Forget everything placed in the world (the map is going away). */
  clearWorld() {
    this.points.clear();
    this.sea = null;
    for (const kind of [...this.emitters.keys()]) this.dropEmitter(kind);
  }

  /** Move every placed loop to where it now sits around you. Runs as the listener moves, a few times a second. */
  private updateWorld() {
    const { ctx, lib } = this;
    const ear = this.listener;
    if (!ctx || !lib || !this.indexed || !ear || ctx.state !== "running") return;
    if (ctx.currentTime - this.worldAt < 0.05) return;
    this.worldAt = ctx.currentTime;
    const defs = this.manifest.emitters ?? {};
    for (const kind of Object.keys(defs) as EmitterKind[]) {
      const def = defs[kind]!;
      if (kind === "sea") {
        const sea = this.sea;
        if (!sea) continue;
        const group = this.emitter(kind, def, 1);
        if (!group.ready) continue;
        // Close to the water, or with it all around, the sea stops coming from one side.
        const side = sea.dx * Math.cos(this.yaw) - sea.dz * Math.sin(this.yaw);
        const far = Math.min(1, sea.distance / (def.max ?? 18));
        const ahead = -(sea.dx * Math.sin(this.yaw) + sea.dz * Math.cos(this.yaw));
        const wide = 1 - sea.spread;
        this.place(group.slots[0], distanceGain(sea.distance, def.ref ?? 3, def.max ?? 18), 20000 * 2 ** (-2 * far), { pan: side * 0.8 * wide, side: side * 4 * wide, ahead: ahead * 4 * wide });
        continue;
      }
      const points = this.points.get(kind);
      if (!points || points.length === 0) continue;
      const group = this.emitter(kind, def, def.voices ?? 3);
      if (!group.ready) continue;
      const max = def.max ?? 14;
      const near = points
        .map((p) => ({ key: `${p.x.toFixed(2)},${p.z.toFixed(2)}`, dx: p.x - ear.x, dz: p.z - ear.z }))
        .filter((p) => Math.hypot(p.dx, p.dz) < max)
        .sort((a, b) => Math.hypot(a.dx, a.dz) - Math.hypot(b.dx, b.dz))
        .slice(0, group.slots.length);
      // A source keeps its voice while it stays among the nearest; a newcomer takes one that fell free.
      for (const slot of group.slots) if (slot.key && !near.some((p) => p.key === slot.key)) slot.key = null;
      for (const p of near) {
        const slot = group.slots.find((s) => s.key === p.key) ?? group.slots.find((s) => s.key === null);
        if (!slot) continue;
        slot.key = p.key;
        const placed = placeSound(p.dx, p.dz, this.yaw, def.ref ?? 1.5, max);
        this.place(slot, placed.gain, placed.cutoff, placed);
      }
      for (const slot of group.slots) if (slot.key === null) this.place(slot, 0, 20000, { pan: 0, side: 0, ahead: 0 });
    }
  }

  private place(slot: EmitterSlot, gain: number, cutoff: number, at: Spot) {
    const now = this.ctx!.currentTime;
    slot.gain.gain.setTargetAtTime(gain, now, 0.12);
    slot.filter.frequency.setTargetAtTime(cutoff, now, 0.12);
    slot.placer.move(at, now, 0.12);
    slot.pan = at.pan;
  }

  // ---------- the reverb of the place you are in ----------

  /** The ground you stand on (a biome), or null. With the scene, it decides which reverb is heard. */
  setGround(ground: string | null) {
    if (ground === this.ground) return;
    this.ground = ground;
    this.scheduleZone();
  }

  /** The reverb for where you are: by the ground first, then the scene, then the default. */
  private zoneName(): string | null {
    const zones = this.manifest.zones;
    if (!zones) return null;
    if (this.ground && zones.ground && this.ground in zones.ground) return zones.ground[this.ground];
    const scene = this.scene;
    if (scene && zones.scene && scene in zones.scene) return zones.scene[scene] ?? null;
    return zones.default ?? null;
  }

  /**
   * Change reverb once the place has held for a moment, and never twice within a crossfade:
   * walking along the edge of a wood would otherwise flick between two rooms.
   */
  private scheduleZone() {
    if (!this.ctx || !this.reverb || !this.indexed) return;
    clearTimeout(this.zoneTimer);
    if (this.zoneName() === this.zone) return;
    const wait = Math.max(this.zone === undefined ? 0 : 400, this.zoneAt + 1100 - performance.now());
    this.zoneTimer = setTimeout(() => this.applyZone(), wait);
  }

  private applyZone() {
    const { ctx, lib, reverb } = this;
    if (!ctx || !lib || !reverb) return;
    const name = this.zoneName();
    if (name === this.zone) return;
    this.zone = name;
    this.zoneAt = performance.now();
    const def = name ? this.manifest.reverbs?.[name] : undefined;
    if (!def) {
      if (name) this.report([`reverb "${name}"`]);
      for (const unit of reverb.units) fade(unit.out.gain, ctx.currentTime, 0, 1);
      return;
    }
    void lib.load(def.file).then((buffer) => {
      if (this.zone !== name) return;
      if (!buffer) return this.report([`reverb "${name}" (file "${def.file}")`]);
      // The idle convolver takes the new room and the two cross over.
      const next = reverb.units[1 - reverb.active];
      next.conv.buffer = buffer;
      const now = ctx.currentTime;
      fade(next.out.gain, now, dbToGain(def.gainDb ?? 0), 1);
      fade(reverb.units[reverb.active].out.gain, now, 0, 1);
      reverb.active = 1 - reverb.active;
    });
  }

  /** The voices for one kind of source, made the first time one is near: the same loop, each started at a different point. */
  private emitter(kind: EmitterKind, def: Emitter, voices: number): EmitterGroup {
    const { ctx, lib, bus } = this;
    let group = this.emitters.get(kind);
    if (group || !ctx || !lib || !bus) return group ?? { file: def.file, out: null, slots: [], ready: false };
    const out = ctx.createGain();
    out.gain.value = dbToGain(def.gainDb ?? 0);
    out.connect(bus.groups.atmosphere.trim);
    const made: EmitterGroup = { file: def.file, out, slots: [], ready: false };
    group = made;
    this.emitters.set(kind, made);
    if (!lib.url(def.file)) {
      this.report([`emitter ${kind} (file "${def.file}")`]);
      return made;
    }
    lib.pin(def.file);
    void lib.load(def.file).then((buffer) => {
      if (this.emitters.get(kind) !== made || !buffer) return lib.unpin(def.file);
      for (let i = 0; i < voices; i++) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 20000;
        const placer = makePlacer(ctx, this.headphones);
        src.connect(gain).connect(filter).connect(placer.node).connect(out);
        src.start(ctx.currentTime, Math.random() * buffer.duration);
        made.slots.push({ src, gain, filter, placer, pan: 0, key: null });
      }
      made.ready = true;
    });
    return made;
  }

  private dropEmitter(kind: EmitterKind) {
    const group = this.emitters.get(kind);
    const { ctx, lib } = this;
    if (!group || !ctx || !lib) return;
    this.emitters.delete(kind);
    if (!group.out) return;
    const out = group.out;
    fade(out.gain, ctx.currentTime, 0, 0.4);
    for (const slot of group.slots) slot.src.stop(ctx.currentTime + 0.5);
    setTimeout(() => out.disconnect(), 700);
    if (group.ready) lib.unpin(group.file);
  }

  // ---------- developing ----------

  /** Read the index again and restart any loop whose file changed. The dev server asks for this when a master changes. */
  async reload() {
    const lib = this.lib;
    if (!lib) return;
    await lib.loadIndex();
    this.expanded.clear();
    for (const kind of [...this.emitters.keys()]) this.dropEmitter(kind);
    for (const lv of [...this.loops.values()]) {
      const urls = [lv.def.file, ...(lv.def.layers ?? []).map((l) => l.file)]
        .map((f) => lib.url(f))
        .filter(Boolean)
        .join("|");
      if (urls === lv.urls) continue;
      this.stopLoop(lv, 0.3);
      void this.startLoop(lv.id, lv.def, lv.group, 0.3);
    }
    this.preloadEffects();
  }

  /** Swap in an edited manifest without reloading the page. */
  setManifest(next: AudioManifest) {
    this.manifest = next;
    Object.assign(this.mix.defaults, next.mix);
    this.expanded.clear();
    this.reported.clear();
    for (const kind of [...this.emitters.keys()]) this.dropEmitter(kind);
    // The reverb may have a new file or level: choose it afresh.
    if (this.zone !== undefined) this.zone = undefined;
    this.applyMix();
    this.applyScene();
    this.preloadEffects();
  }

  /** While developing, say once which names were asked for and found nothing, so you know what the game wants. */
  private report(candidates: string[]) {
    if (!import.meta.env.DEV) return;
    const chain = candidates.join(" → ");
    if (this.reported.has(chain)) return;
    this.reported.add(chain);
    console.info(`[audio] nothing to play for ${chain}`);
  }

  /** A snapshot for poking at from the console (`__gqAudio.debug()`). */
  debug() {
    return {
      state: this.ctx?.state ?? "not started",
      scene: this.scene,
      loops: [...this.loops.values()].map((lv) => ({ id: lv.id, parts: lv.parts.map((p) => `${p.file.split("/").pop()} ${(p.gain.gain.value * lv.out.gain.value).toFixed(2)}`) })),
      voices: this.voices.map((v) => v.event),
      listener: this.listener,
      params: Object.fromEntries(this.params) as Partial<Record<ParamName, number>>,
      yaw: this.yaw,
      headphones: this.headphones,
      ground: this.ground,
      reverb: this.zone ?? null,
      sea: this.sea,
      emitters: Object.fromEntries([...this.emitters].map(([kind, g]) => [kind, g.slots.map((sl) => `${sl.gain.gain.value.toFixed(2)} pan ${sl.pan.toFixed(2)}`)])),
      library: this.lib?.stats() ?? null,
    };
  }
}

export const audio = new AudioEngine(AUDIO);

if (import.meta.hot) {
  import.meta.hot.accept("./manifest", (mod) => {
    if (mod) audio.setManifest((mod as unknown as { AUDIO: AudioManifest }).AUDIO);
  });
  import.meta.hot.on("gq:audio-changed", () => void audio.reload());
}
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __gqAudio: AudioEngine }).__gqAudio = audio;
