// How a hero looks, chosen at character creation: body proportions, the shape
// of the head and face, and their colouring. Every choice is one of a fixed
// set of presets, so worn gear can be drawn to fit any of them, and the server
// can check what it is sent. Pure data: the client draws it (render/figures.ts).

/** One preset: its id, what the picker calls it, and the number the renderer uses where it is a size. */
interface Preset<Id extends string> {
  id: Id;
  label: string;
}
interface SizedPreset<Id extends string> extends Preset<Id> {
  /** 1 is the usual; above it is more. */
  k: number;
}

export const HEIGHTS = [
  { id: "stubby", label: "Stubby", k: 0.75 },
  { id: "short", label: "Short", k: 0.88 },
  { id: "average", label: "Average", k: 1 },
  { id: "tall", label: "Tall", k: 1.14 },
  { id: "lanky", label: "Lanky", k: 1.3 },
] as const satisfies readonly SizedPreset<string>[];

export const BUILDS = [
  { id: "slim", label: "Slim", k: 0.84 },
  { id: "average", label: "Average", k: 1 },
  { id: "sturdy", label: "Sturdy", k: 1.14 },
  { id: "stout", label: "Stout", k: 1.3 },
] as const satisfies readonly SizedPreset<string>[];

export const SHOULDERS = [
  { id: "narrow", label: "Narrow", k: 0.84 },
  { id: "average", label: "Average", k: 1 },
  { id: "broad", label: "Broad", k: 1.15 },
  { id: "hulking", label: "Hulking", k: 1.32 },
] as const satisfies readonly SizedPreset<string>[];

export const HIPS = [
  { id: "narrow", label: "Narrow", k: 0.82 },
  { id: "average", label: "Average", k: 1 },
  { id: "wide", label: "Wide", k: 1.18 },
  { id: "broad", label: "Broad", k: 1.36 },
] as const satisfies readonly SizedPreset<string>[];

export const HEAD_SIZES = [
  { id: "small", label: "Small", k: 0.86 },
  { id: "average", label: "Average", k: 1 },
  { id: "big", label: "Big", k: 1.14 },
  { id: "huge", label: "Huge", k: 1.28 },
] as const satisfies readonly SizedPreset<string>[];

export const HEAD_SHAPES = [
  { id: "round", label: "Round" },
  { id: "long", label: "Long" },
  { id: "squat", label: "Squat" },
  { id: "pointed", label: "Pointed chin" },
  { id: "square", label: "Square jaw" },
  { id: "pear", label: "Pear" },
] as const satisfies readonly Preset<string>[];

export const HAIR_STYLES = [
  { id: "short", label: "Short" },
  { id: "long", label: "Long" },
  { id: "ponytail", label: "Ponytail" },
  { id: "bun", label: "Bun" },
  { id: "braids", label: "Braids" },
  { id: "frontBraids", label: "Front braids" },
  { id: "bald", label: "Bald" },
] as const satisfies readonly Preset<string>[];

export const EYES = [
  { id: "round", label: "Round" },
  { id: "big", label: "Big" },
  { id: "beady", label: "Beady" },
  { id: "narrow", label: "Narrow" },
  { id: "sleepy", label: "Sleepy" },
  { id: "fierce", label: "Fierce" },
] as const satisfies readonly Preset<string>[];

export const NOSES = [
  { id: "button", label: "Button" },
  { id: "pointy", label: "Pointy" },
  { id: "broad", label: "Broad" },
  { id: "long", label: "Long" },
  { id: "hooked", label: "Hooked" },
] as const satisfies readonly Preset<string>[];

export const MUSTACHES = [
  { id: "none", label: "None" },
  { id: "bushy", label: "Bushy" },
  { id: "pencil", label: "Pencil" },
  { id: "handlebar", label: "Handlebar" },
  { id: "walrus", label: "Walrus" },
] as const satisfies readonly Preset<string>[];

/** Hair on the cheeks, jaw and chin (the mustache is its own choice; see MUSTACHES). */
export const BEARDS = [
  { id: "none", label: "None" },
  { id: "stubble", label: "Stubble" },
  { id: "goatee", label: "Goatee" },
  { id: "full", label: "Full beard" },
  { id: "chops", label: "Mutton chops" },
  { id: "wizard", label: "Wizard beard" },
] as const satisfies readonly Preset<string>[];

export const EARS = [
  { id: "round", label: "Round" },
  { id: "wide", label: "Wide" },
  { id: "thin", label: "Thin" },
  { id: "tall", label: "Tall" },
  { id: "pointy", label: "Pointy" },
] as const satisfies readonly Preset<string>[];

export const SKIN_TONES = ["#f6d9c0", "#f1c9a5", "#e3b48c", "#d9a67c", "#c48a5c", "#a8704a", "#87573a", "#5f3c27", "#c9b8c4", "#9fbf9a"] as const;
export const HAIR_COLORS = ["#1a1424", "#3a2a20", "#5a3d22", "#8a5a2b", "#c9743a", "#e0b84a", "#ececec", "#9a9aa2", "#b9433d", "#3f6fa8", "#5d7d3a", "#8b5bb5"] as const;

type IdOf<T extends readonly { id: string }[]> = T[number]["id"];

export interface Appearance {
  height: IdOf<typeof HEIGHTS>;
  build: IdOf<typeof BUILDS>;
  shoulders: IdOf<typeof SHOULDERS>;
  /** How wide the hips are, and so how far apart the legs. */
  hips: IdOf<typeof HIPS>;
  headSize: IdOf<typeof HEAD_SIZES>;
  headShape: IdOf<typeof HEAD_SHAPES>;
  ears: IdOf<typeof EARS>;
  hairStyle: IdOf<typeof HAIR_STYLES>;
  eyes: IdOf<typeof EYES>;
  nose: IdOf<typeof NOSES>;
  mustache: IdOf<typeof MUSTACHES>;
  beard: IdOf<typeof BEARDS>;
  /** Tattoos they drew on the paper doll, if any (see Ink). */
  ink?: Ink;
  /** One of SKIN_TONES. */
  skin: string;
  /** One of HAIR_COLORS. */
  hair: string;
}

export const DEFAULT_APPEARANCE: Appearance = {
  height: "average",
  build: "average",
  shoulders: "average",
  hips: "average",
  headSize: "average",
  headShape: "round",
  ears: "round",
  hairStyle: "short",
  eyes: "round",
  nose: "pointy",
  mustache: "none",
  beard: "none",
  skin: SKIN_TONES[1],
  hair: HAIR_COLORS[3],
};

/** Every field's presets, for checking and for the picker, in the order the picker shows them. */
export const APPEARANCE_OPTIONS = {
  height: HEIGHTS,
  build: BUILDS,
  shoulders: SHOULDERS,
  hips: HIPS,
  headSize: HEAD_SIZES,
  headShape: HEAD_SHAPES,
  ears: EARS,
  hairStyle: HAIR_STYLES,
  eyes: EYES,
  nose: NOSES,
  mustache: MUSTACHES,
  beard: BEARDS,
} as const;

/** The size factor of a sized choice (height, build, shoulders, head size). */
export function appearanceK(field: "height" | "build" | "shoulders" | "hips" | "headSize", look: Appearance): number {
  return (APPEARANCE_OPTIONS[field] as readonly SizedPreset<string>[]).find((p) => p.id === look[field])?.k ?? 1;
}

/**
 * An appearance from anything (a request body, a stored column): each field
 * kept if it is one of its presets, otherwise the default. Null if it is not
 * an object at all.
 */
export function parseAppearance(raw: unknown): Appearance | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: Appearance = { ...DEFAULT_APPEARANCE };
  for (const [field, presets] of Object.entries(APPEARANCE_OPTIONS) as [keyof typeof APPEARANCE_OPTIONS, readonly { id: string }[]][]) {
    const v = r[field];
    if (typeof v === "string" && presets.some((p) => p.id === v)) (out as unknown as Record<string, string>)[field] = v;
  }
  // A look saved when facial hair was one choice: the mustache and beard it drew.
  if (typeof r.facialHair === "string" && r.mustache === undefined && r.beard === undefined) {
    const old: Record<string, [Appearance["mustache"], Appearance["beard"]]> = {
      stubble: ["none", "stubble"],
      mustache: ["bushy", "none"],
      goatee: ["bushy", "goatee"],
      beard: ["bushy", "full"],
      chops: ["bushy", "chops"],
      wizard: ["bushy", "wizard"],
    };
    const was = old[r.facialHair];
    if (was) [out.mustache, out.beard] = was;
  }
  if (typeof r.skin === "string" && (SKIN_TONES as readonly string[]).includes(r.skin)) out.skin = r.skin;
  if (typeof r.hair === "string" && (HAIR_COLORS as readonly string[]).includes(r.hair)) out.hair = r.hair;
  const ink = parseInk(r.ink);
  if (ink) out.ink = ink;
  return out;
}

/** A short stable string for an appearance, for caching whatever is drawn from it. */
export function appearanceKey(look: Appearance | undefined): string {
  if (!look) return "";
  return [look.height, look.build, look.shoulders, look.hips, look.headSize, look.headShape, look.ears, look.hairStyle, look.eyes, look.nose, look.mustache, look.beard, look.skin, look.hair, inkKey(look.ink)].join(".");
}

/** A random appearance, for the picker's dice. `rand` returns 0 to 1. */
export function randomAppearance(rand: () => number = Math.random): Appearance {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  return {
    height: pick(HEIGHTS).id,
    build: pick(BUILDS).id,
    shoulders: pick(SHOULDERS).id,
    hips: pick(HIPS).id,
    headSize: pick(HEAD_SIZES).id,
    headShape: pick(HEAD_SHAPES).id,
    ears: pick(EARS).id,
    hairStyle: pick(HAIR_STYLES).id,
    eyes: pick(EYES).id,
    nose: pick(NOSES).id,
    mustache: pick(MUSTACHES).id,
    beard: pick(BEARDS).id,
    skin: pick(SKIN_TONES),
    hair: pick(HAIR_COLORS),
  };
}

// ---------- tattoos ----------

/**
 * The inks a tattoo is drawn in: greys, darkest first, then muted colours (slate blue, teal, sage, ochre,
 * rust, plum). A cell's colour is 1 for the first of these, and so on.
 */
export const INK_COLORS = ["#1c1c22", "#4a4a53", "#87878f", "#c8c8ce", "#3f4c6b", "#4c7470", "#6c7d5a", "#a08848", "#8e5345", "#6c5470"] as const;

/** How strongly a cell is inked, 1 to INK_LEVELS: that many fifths of the ink over the skin. */
export const INK_LEVELS = 5;

/** A cell's ink, as `decodeInk` gives it: its colour (1 for INK_COLORS[0]) and its level, packed in one number. */
export function inkCell(color: number, level: number): number {
  return color * 16 + level;
}
export function inkColorOf(cell: number): number {
  return cell >> 4;
}
export function inkLevelOf(cell: number): number {
  return cell & 15;
}
const validCell = (cell: number) => inkColorOf(cell) >= 1 && inkColorOf(cell) <= INK_COLORS.length && inkLevelOf(cell) >= 1 && inkLevelOf(cell) <= INK_LEVELS;

/**
 * The parts of the body a tattoo can be drawn on, each a grid of cells seen from the front and from the
 * back: the head, the forearms below the vest's sleeves, the thighs below the drawers and the shins. The
 * renderer (render/figures.ts) knows where on the body each cell lies.
 */
export const INK_REGIONS = {
  head: { cols: 28, rows: 28 },
  armR: { cols: 10, rows: 13 },
  armL: { cols: 10, rows: 13 },
  thighR: { cols: 12, rows: 4 },
  thighL: { cols: 12, rows: 4 },
  shinR: { cols: 10, rows: 8 },
  shinL: { cols: 10, rows: 8 },
} as const;
export type InkRegion = keyof typeof INK_REGIONS;
export type InkView = "f" | "b";
/** A region seen from one side, as `ink` keys it: "head.f", "armL.b". */
export type InkSide = `${InkRegion}.${InkView}`;

/**
 * A hero's tattoos: for each region and side drawn on, its inked cells. Each cell is four characters: its
 * index in the grid (row by row from the top left as seen) in two base-36 digits, then its colour (a base-36
 * digit, 1 for INK_COLORS[0]) and its level, 1 to INK_LEVELS.
 */
export type Ink = Partial<Record<InkSide, string>>;

/** The most cells a hero may have inked, all told. */
export const MAX_INK_CELLS = 1600;

export const INK_SIDES: InkSide[] = (Object.keys(INK_REGIONS) as InkRegion[]).flatMap((r) => [`${r}.f`, `${r}.b`] as InkSide[]);

/** The inked cells of one side: index to cell (see inkCell). */
export function decodeInk(cells: string | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!cells) return out;
  for (let i = 0; i + 4 <= cells.length; i += 4) {
    const at = parseInt(cells.slice(i, i + 2), 36);
    const cell = inkCell(parseInt(cells[i + 2], 36), Number(cells[i + 3]));
    if (Number.isFinite(at) && at >= 0 && validCell(cell)) out.set(at, cell);
  }
  return out;
}

/** One side's inked cells as `Ink` keeps them, in index order. */
export function encodeInk(cells: Map<number, number>): string {
  return [...cells.entries()]
    .filter(([, cell]) => validCell(cell))
    .sort((a, b) => a[0] - b[0])
    .map(([at, cell]) => at.toString(36).padStart(2, "0") + inkColorOf(cell).toString(36) + inkLevelOf(cell))
    .join("");
}

/**
 * Tattoos from anything: only known sides, cells inside their grids, known colours and levels, at most MAX_INK_CELLS
 * all told (the rest dropped). Undefined if there are none.
 */
export function parseInk(raw: unknown): Ink | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Ink = {};
  let left = MAX_INK_CELLS;
  for (const side of INK_SIDES) {
    const v = r[side];
    if (typeof v !== "string" || !v || left <= 0) continue;
    const { cols, rows } = INK_REGIONS[side.split(".")[0] as InkRegion];
    const cells = new Map<number, number>();
    for (const [at, cell] of decodeInk(v.slice(0, 4 * MAX_INK_CELLS))) {
      if (at >= cols * rows || left <= 0) continue;
      cells.set(at, cell);
      left--;
    }
    if (cells.size) out[side] = encodeInk(cells);
  }
  return Object.keys(out).length ? out : undefined;
}

/** A short stable string for a hero's tattoos, for caching what is drawn from them. */
export function inkKey(ink: Ink | undefined): string {
  if (!ink) return "";
  let h = 5381;
  for (const side of INK_SIDES) {
    const v = ink[side];
    if (!v) continue;
    for (const ch of side + v) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  }
  return h.toString(36);
}
