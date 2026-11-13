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
import { TakePicker, distanceGain, expandFiles, inRange, resolveName } from "./select";
import type { AudioFile, AudioManifest, Group, Loop, SceneName, SoundEvent } from "./types";

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
  url: string;
  gain: GainNode;
  src: AudioBufferSourceNode | null;
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

/** Whether a loop that keeps playing across a change can carry on as it is (a level change can). */
function sameTake(a: Loop, b: Loop) {
  return a.file === b.file && a.startAt === b.startAt && JSON.stringify(a.loop) === JSON.stringify(b.loop);
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
  private reported = new Set<string>();
  private suspendTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private manifest: AudioManifest) {
    this.mix = new MixStore(manifest.mix, safeStorage());
    this.mix.subscribe(() => this.applyMix());
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
    if (opts.at && this.listener) {
      const falloff = distanceGain(Math.hypot(opts.at.x - this.listener.x, opts.at.z - this.listener.z));
      if (falloff < 0.01) return;
      gain *= falloff;
    }
    this.lastPlayed.set(name, now);
    const files = this.takesOf(name);
    const picker = this.takes.get(name) ?? new TakePicker();
    this.takes.set(name, picker);
    const key = files[picker.next(files.length, ev.order)];
    const when = now + (ev.delay ?? 0) + (opts.delay ?? 0);
    const rate = 2 ** (inRange(ev.pitch) / 12);

    const ready = lib.ready(key);
    if (ready) this.voice(name, ev, ready, when, gain, rate);
    else
      void lib.load(key).then((buffer) => {
        if (buffer && ctx.currentTime - when < LATE_LIMIT) this.voice(name, ev, buffer, Math.max(when, ctx.currentTime), gain, rate);
      });
  }

  /** Where you stand, in world x and z, for distance falloff. The renderer sets it every frame. */
  setListener(x: number, z: number) {
    if (this.listener) {
      this.listener.x = x;
      this.listener.z = z;
    } else this.listener = { x, z };
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

  private voice(name: string, ev: SoundEvent, buffer: AudioBuffer, when: number, gain: number, rate: number) {
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
    src.connect(g).connect(bus.groups[ev.group ?? "sfx"].trim);
    const voice: Voice = { event: name, src, gain: g };
    this.voices.push(voice);
    src.onended = () => {
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
      g.disconnect();
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

  private applyScene() {
    if (!this.ctx || !this.lib || !this.indexed) return;
    const scene = this.scene ? this.manifest.scenes[this.scene] : undefined;
    const want = new Map<string, { def: Loop; group: Group }>();
    if (scene?.music && this.manifest.music[scene.music]) want.set(`music:${scene.music}`, { def: this.manifest.music[scene.music], group: "music" });
    for (const name of scene?.ambience ?? []) {
      if (this.manifest.ambience[name]) want.set(`ambience:${name}`, { def: this.manifest.ambience[name], group: "atmosphere" });
    }
    const now = this.ctx.currentTime;
    for (const [id, lv] of [...this.loops]) {
      const next = want.get(id);
      if (!next || !sameTake(lv.def, next.def)) this.stopLoop(lv);
      else if (next.def.gainDb !== lv.def.gainDb) {
        // Only its level changed (the manifest was edited): glide there and keep playing.
        lv.def = next.def;
        if (lv.src) fade(lv.gain.gain, now, dbToGain(next.def.gainDb ?? 0), 0.3);
      } else lv.def = next.def;
    }
    for (const [id, w] of want) if (!this.loops.has(id)) void this.startLoop(id, w.def, w.group);
  }

  private async startLoop(id: string, def: Loop, group: Group, fadeIn = def.fadeIn ?? 2) {
    const { ctx, lib, bus } = this;
    if (!ctx || !lib || !bus) return;
    const url = lib.url(def.file);
    if (!url) return this.report([`${id} (file "${def.file}")`]);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(bus.groups[group].trim);
    const lv: LoopVoice = { id, def, group, url, gain, src: null };
    this.loops.set(id, lv);
    lib.pin(def.file);
    const buffer = await lib.load(def.file);
    // The scene moved on while it loaded, or it would not load.
    if (this.loops.get(id) !== lv || !buffer) {
      if (this.loops.get(id) === lv) this.loops.delete(id);
      lib.unpin(def.file);
      gain.disconnect();
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const region = loopRegion(def, lib.file(def.file), buffer.duration);
    src.loopStart = region.start;
    src.loopEnd = region.end;
    src.connect(gain);
    src.onended = () => {
      gain.disconnect();
      lib.unpin(def.file);
    };
    const now = ctx.currentTime;
    src.start(now, def.startAt === "loop" ? region.start : 0);
    lv.src = src;
    fade(gain.gain, now, dbToGain(def.gainDb ?? 0), fadeIn);
  }

  private stopLoop(lv: LoopVoice, fadeOut = lv.def.fadeOut ?? 2) {
    const ctx = this.ctx!;
    if (this.loops.get(lv.id) === lv) this.loops.delete(lv.id);
    if (!lv.src) return; // still loading: startLoop sees it was dropped and lets go
    const now = ctx.currentTime;
    fade(lv.gain.gain, now, 0, fadeOut);
    lv.src.stop(now + fadeOut + 0.05);
  }

  // ---------- developing ----------

  /** Read the index again and restart any loop whose file changed. The dev server asks for this when a master changes. */
  async reload() {
    const lib = this.lib;
    if (!lib) return;
    await lib.loadIndex();
    this.expanded.clear();
    for (const lv of [...this.loops.values()]) {
      if (lib.url(lv.def.file) === lv.url) continue;
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
      loops: [...this.loops.keys()],
      voices: this.voices.map((v) => v.event),
      listener: this.listener,
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
