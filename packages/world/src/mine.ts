// The quarry: thirty seconds at a rock face, hunting for the seam.
//
// The face is a wall of rocks. Most of it is junk: loose rubble that comes
// away in a blow or two and now and then gives a piece of usable stone, and
// hard granite that takes a charged swing to crack and gives stone more often.
// Somewhere in it a seam of ore runs across, a few rocks long, and beside it
// there may be a geode full of gems. The seam glints through the junk around
// it, so the glints are the thing to read, though loose mica glints too.
//
// A tap of the pick is one blow's worth. Holding the swing charges it: half
// a charge is two, a full one three, and a full one also knocks a point off
// each rock either side, above and below. Charging takes time, so it pays on
// hard rock and wastes it on rubble. Breaking a rock shows what is in the
// ones beside it, so a seam once found can be followed.
//
// Nothing holds the face up but itself. Break a rock and everything above it
// in its column comes down into the gap, taking a point of damage for every
// row it drops, and the rock it lands on takes a point too. A rock the fall
// breaks is smashed to grit, and one crushed under a falling rock is lost the
// same way: whatever was in it is gone. So work the seam from the top or from
// the side, and never knock a hole in the column above or below it.
//
// Pure functions. The server holds the face and starts the clock; the client
// plays the swings and reports each blow with when it was struck, and the
// server replays them: no faster than a pick can swing, none after the clock,
// none from the future. The rules are the same on both sides, so the client
// shows every crack and fall at once; what a broken rock gives is rolled by
// the server.

import type { ResourceKind, Resources } from "./hut";
import type { Rng } from "./rng";

export const MINE_COLS = 8;
export const MINE_ROWS = 7;
/** How long the clock runs once the first swing is ready. */
export const MINE_MS = 25_000;
/** A pick needs this long between blows. */
export const MINE_RECOVER_MS = 550;
/** A full charge, before the hero's Vitality makes it quicker or slower. */
export const MINE_CHARGE_MS = 900;
/** Slack for timers that fire a frame late. */
export const MINE_TOLERANCE_MS = 40;
/** Most blows one report may carry. */
export const MINE_MAX_BATCH = 60;
/** Chance a face has a geode beside its seam. */
export const MINE_GEODE_CHANCE = 0.33;
/**
 * How brightly rocks glint, as chances: a seam rock glints 3 or 2 (else 1); junk beside the seam 2 or 1 (else 0);
 * other junk (mica) 3, 2 or 1 (else 0).
 */
const GLINT = { seam: [0.45, 0.35], near: [0.3, 0.4], mica: [0.03, 0.07, 0.12] };
/** Damage a rock takes for each row it falls. */
export const MINE_FALL_DAMAGE = 1;
/** Damage a falling rock does to the rock it lands on, however far it fell. */
export const MINE_CRUSH_DAMAGE = 1;

export type RockKind = "rubble" | "granite" | "seam" | "geode";
/** How hard a blow is: a tap, half a charge, a full charge. */
export type BlowPower = 1 | 2 | 3;

/** A rock. Its place in `MineState.rocks` is its id, which it keeps as it falls; `cell` is where it is now. */
export interface Rock {
  kind: RockKind;
  /** Where it is in the face now: row × MINE_COLS + column, row 0 at the top. */
  cell: number;
  /** Blows' worth it takes to break. */
  hp: number;
  /** Damage it has taken so far, from the pick and from falling. */
  dmg: number;
  broken: boolean;
  /** How much it glints, 0 to 3: the seam shows through the junk near it, and some junk glints anyway. */
  glint: number;
  /** What is in it has been seen: it was opened up beside a gap. Once seen it stays seen, wherever it falls. */
  seen?: boolean;
  /** Rows it has fallen, all told. */
  fell?: number;
  /** A fall broke it, or a rock falling onto it did, and what was in it is lost. */
  lost?: boolean;
  /** What it gave when it broke. */
  got?: Resources;
}

export interface MineState {
  rocks: Rock[];
  /** Milliseconds for a full charge, for this hero. */
  chargeMs: number;
  /** The server's clock when the timer started; null until the player is ready. */
  startedAt: number | null;
  /** When the last blow landed, in ms after the start. */
  lastAt: number | null;
}

/** One swing of the pick, as the client reports it: which place in the face, how hard, and when (ms after the start). */
export interface Blow {
  cell: number;
  power: BlowPower;
  at: number;
}

export interface MineRockView {
  /** Its place in the list; it keeps it as it falls. */
  id: number;
  cell: number;
  hp: number;
  dmg: number;
  broken: boolean;
  /** What it is: known once it or a rock beside it has been opened up, or once the outing is over. */
  kind: RockKind | null;
  glint: number;
  fell: number;
  lost: boolean;
  got: Resources | null;
}

export interface MineView {
  cols: number;
  rows: number;
  rocks: MineRockView[];
  chargeMs: number;
  recoverMs: number;
  fallDamage: number;
  /** The whole clock, and what was left of it when this view was made (null until it starts). */
  ms: number;
  leftMs: number | null;
  /** When the last blow the server has landed was struck, in ms after the start. */
  lastAt: number | null;
}

/** Rarity of what a quarry gives, commonest first. */
export const MINE_RARITY: Record<"stone" | "iron" | "copper" | "gem", { label: string; color: string }> = {
  stone: { label: "Common", color: "#c6ccd6" },
  iron: { label: "Uncommon", color: "#7fb8ff" },
  copper: { label: "Rare", color: "#f0a060" },
  gem: { label: "Precious", color: "#ff7ae0" },
};

/** What a broken rock may give. Rubble now and then, granite more often, the seam always, a geode richly. */
export const ROCK_YIELD = {
  rubbleStone: 0.12,
  graniteStone: 0.4,
  /** Ore in the seam: weights for iron, copper and a stray gem. */
  seam: [["iron", 58], ["copper", 36], ["gem", 6]] as [ResourceKind, number][],
  /** A geode: one gem, and sometimes a second. */
  geodeSecond: 0.35,
};

const idx = (row: number, col: number) => row * MINE_COLS + col;
const rowOf = (cell: number) => Math.floor(cell / MINE_COLS);
const colOf = (cell: number) => cell % MINE_COLS;

/** The places directly above, below and either side of `cell`. */
export function mineNeighbours(cell: number): number[] {
  const r = rowOf(cell);
  const c = colOf(cell);
  const out: number[] = [];
  if (r > 0) out.push(idx(r - 1, c));
  if (r < MINE_ROWS - 1) out.push(idx(r + 1, c));
  if (c > 0) out.push(idx(r, c - 1));
  if (c < MINE_COLS - 1) out.push(idx(r, c + 1));
  return out;
}

/** Which rock (by id) stands at each place in the face; -1 where there is a gap. */
export function mineGrid(rocks: readonly Pick<Rock, "cell" | "broken">[]): number[] {
  const grid = Array<number>(MINE_COLS * MINE_ROWS).fill(-1);
  rocks.forEach((r, id) => {
    if (!r.broken) grid[r.cell] = id;
  });
  return grid;
}

/**
 * A new face. The seam wanders across most of the columns, a row up or down
 * at most per column, always joined edge to edge so it can be followed, and
 * never in the bottom row or the top one. The geode, when there is one, sits
 * against the seam.
 */
export function seedMine(rng: Rng, chargeMs: number): MineState {
  const kinds: RockKind[] = Array(MINE_ROWS * MINE_COLS).fill("rubble");
  const span = rng.int(MINE_COLS - 4, MINE_COLS - 2);
  const from = rng.int(0, MINE_COLS - span);
  let row = rng.int(1, MINE_ROWS - 2);
  const seam: number[] = [];
  for (let c = from; c < from + span; c++) {
    if (c > from && rng.chance(0.55)) {
      // Step up or down: the rock in the new row of the previous column joins them edge to edge.
      const next = Math.max(1, Math.min(MINE_ROWS - 2, row + (rng.chance(0.5) ? 1 : -1)));
      if (next !== row) {
        seam.push(idx(next, c - 1));
        row = next;
      }
    }
    seam.push(idx(row, c));
  }
  for (const cell of seam) kinds[cell] = "seam";
  if (rng.chance(MINE_GEODE_CHANCE)) {
    const beside = [...new Set(seam.flatMap(mineNeighbours))].filter((c) => kinds[c] === "rubble");
    if (beside.length > 0) kinds[rng.pick(beside)] = "geode";
  }
  // About a quarter of the junk is hard granite.
  for (let i = 0; i < kinds.length; i++) if (kinds[i] === "rubble" && rng.chance(0.28)) kinds[i] = "granite";

  const nearSeam = new Set(seam.flatMap(mineNeighbours));
  const rocks: Rock[] = kinds.map((kind, cell) => {
    const hp = kind === "rubble" ? (rng.chance(0.65) ? 1 : 2) : kind === "granite" ? (rng.chance(0.5) ? 3 : 4) : kind === "seam" ? (rng.chance(0.5) ? 2 : 3) : 4;
    // The seam mostly glints, but not always brightly; the junk beside it often catches some of its shine; and loose
    // mica glints for nothing, now and then as brightly as ore. Reading the face is weighing these, not spotting a light.
    const roll = rng.next();
    let glint: number;
    if (kind === "seam") glint = roll < GLINT.seam[0] ? 3 : roll < GLINT.seam[0] + GLINT.seam[1] ? 2 : 1;
    else if (kind === "geode") glint = roll < 0.7 ? 3 : 2;
    else if (nearSeam.has(cell)) glint = roll < GLINT.near[0] ? 2 : roll < GLINT.near[0] + GLINT.near[1] ? 1 : 0;
    else glint = roll < GLINT.mica[0] ? 3 : roll < GLINT.mica[0] + GLINT.mica[1] ? 2 : roll < GLINT.mica[0] + GLINT.mica[1] + GLINT.mica[2] ? 1 : 0;
    return { kind, cell, hp, dmg: 0, broken: false, glint };
  });
  return { rocks, chargeMs: Math.round(chargeMs), startedAt: null, lastAt: null };
}

/** How long before a blow of `power` the pick must have been free: the recovery, and the charge it was held for. */
export function blowGap(power: BlowPower, chargeMs: number): number {
  return MINE_RECOVER_MS + (power === 3 ? chargeMs : power === 2 ? chargeMs / 2 : 0);
}

/** The power a swing held for `heldMs` (counted from when the pick was free) lands with. */
export function powerFor(heldMs: number, chargeMs: number): BlowPower {
  return heldMs >= chargeMs ? 3 : heldMs >= chargeMs / 2 ? 2 : 1;
}

/** A rock coming down into a gap. */
export interface MineFall {
  id: number;
  from: number;
  to: number;
  /** The fall broke it: what was in it is lost. */
  lost: boolean;
}

/** A falling rock landing on one that stayed put. */
export interface MineCrush {
  /** The rock landed on, and the one that landed. */
  id: number;
  by: number;
  /** It broke under the weight: what was in it is lost. */
  lost: boolean;
}

export interface BlowsResult {
  mine: MineState;
  /** Rocks (by id) broken by these blows, by falling or by being landed on, in the order they broke. */
  broken: number[];
  /** Every fall, in order. A rock can fall more than once as the gaps under it open. */
  falls: MineFall[];
  /** Every rock landed on, in order. */
  crushes: MineCrush[];
}

/**
 * Let everything above a gap come down. Each column settles to the bottom, and
 * a rock takes MINE_FALL_DAMAGE for each row it drops; the rock it lands on, if
 * that one stayed put, takes MINE_CRUSH_DAMAGE. A rock either of those breaks is
 * gone, with what was in it, and leaves a gap of its own; the face settles
 * again until nothing moves. Mutates `rocks`.
 */
function settle(rocks: Rock[], broken: number[], falls: MineFall[], crushes: MineCrush[]) {
  // Each pass every column drops as far as it can; a rock crushed in one opens a gap for the next.
  for (let pass = 0; pass < MINE_ROWS * 2 + 2; pass++) {
    let moved = false;
    for (let c = 0; c < MINE_COLS; c++) {
      // Standing rocks in this column, bottom first, stack down from the floor.
      const standing = rocks
        .map((r, id) => ({ r, id }))
        .filter(({ r }) => !r.broken && colOf(r.cell) === c)
        .sort((a, b) => rowOf(b.r.cell) - rowOf(a.r.cell));
      let floor = MINE_ROWS - 1;
      /** The last rock that stayed put in this column, which a falling rock lands on. */
      let rest: number | null = null;
      for (const { r, id } of standing) {
        const row = rowOf(r.cell);
        if (row >= floor) {
          rest = id;
          floor--;
          continue;
        }
        const drop = floor - row;
        const from = r.cell;
        r.cell = idx(floor, c);
        r.fell = (r.fell ?? 0) + drop;
        r.dmg = Math.min(r.hp, r.dmg + drop * MINE_FALL_DAMAGE);
        const lost = r.dmg >= r.hp;
        falls.push({ id, from, to: r.cell, lost });
        moved = true;
        // It lands on the rock that stayed put below (if any, and if that one is still whole).
        if (rest !== null && !rocks[rest].broken) {
          const under = rocks[rest];
          under.dmg = Math.min(under.hp, under.dmg + MINE_CRUSH_DAMAGE);
          const crushed = under.dmg >= under.hp;
          crushes.push({ id: rest, by: id, lost: crushed });
          if (crushed) {
            under.broken = true;
            under.lost = true;
            broken.push(rest);
          }
        }
        if (lost) {
          r.broken = true;
          r.lost = true;
          broken.push(id);
          // It is gone: the next rock lands where it did.
          continue;
        }
        // Only the lowest of a falling stack lands on anything: the rest come down on top of it, together.
        rest = null;
        floor--;
      }
    }
    if (!moved) break;
  }
  // Whatever stands beside a gap can now be seen into.
  const grid = mineGrid(rocks);
  rocks.forEach((r, id) => {
    if (r.broken) r.seen = true;
    else if (!r.seen && mineNeighbours(r.cell).some((n) => grid[n] === -1)) r.seen = true;
    void id;
  });
}

/**
 * Land a run of blows. `elapsed` is how long the server's clock has run.
 * Refused (with a reason) if any blow is too quick after the last, after the
 * clock, or later than the server has got to. A blow at a gap (a full swing's
 * knock can break a rock the client then swung at, or a fall can take one away)
 * is wasted. Never mutates `mine`.
 */
export function landBlows(mine: MineState, blows: unknown, elapsed: number): BlowsResult | string {
  if (mine.startedAt === null) return "Get ready first.";
  if (!Array.isArray(blows) || blows.length === 0) return "Swing at something.";
  if (blows.length > MINE_MAX_BATCH) return "Too many swings at once.";
  const rocks = mine.rocks.map((r) => ({ ...r }));
  let lastAt = mine.lastAt;
  const broken: number[] = [];
  const falls: MineFall[] = [];
  const crushes: MineCrush[] = [];
  for (const b of blows as Partial<Blow>[]) {
    const cell = Number(b?.cell);
    const power = Number(b?.power);
    const at = Number(b?.at);
    if (!Number.isInteger(cell) || cell < 0 || cell >= MINE_COLS * MINE_ROWS) return "Swing at a rock.";
    if (power !== 1 && power !== 2 && power !== 3) return "That is not a swing.";
    if (!Number.isFinite(at) || at < 0) return "That swing has no time.";
    if (at > MINE_MS) return "Time was up.";
    if (at > elapsed + 100) return "That swing has not happened yet.";
    if (lastAt !== null && at < lastAt + blowGap(power, mine.chargeMs) - MINE_TOLERANCE_MS) return "Your arms are not that quick.";
    lastAt = at;
    const grid = mineGrid(rocks);
    if (grid[cell] === -1) continue;
    const hit = (id: number, dmg: number) => {
      const rock = rocks[id];
      rock.dmg = Math.min(rock.hp, rock.dmg + dmg);
      if (rock.dmg >= rock.hp) {
        rock.broken = true;
        broken.push(id);
      }
    };
    hit(grid[cell], power);
    if (power === 3) for (const n of mineNeighbours(cell)) if (grid[n] !== -1) hit(grid[n], 1);
    settle(rocks, broken, falls, crushes);
  }
  return { mine: { ...mine, rocks, lastAt }, broken, falls, crushes };
}

/** What a rock gives as it breaks. A rock the fall smashed gives nothing. */
export function rockYield(rng: Rng, rock: Pick<Rock, "kind" | "lost">): Resources {
  if (rock.lost) return {};
  switch (rock.kind) {
    case "rubble":
      return rng.chance(ROCK_YIELD.rubbleStone) ? { stone: 1 } : {};
    case "granite":
      return rng.chance(ROCK_YIELD.graniteStone) ? { stone: 1 } : {};
    case "seam": {
      const total = ROCK_YIELD.seam.reduce((a, [, w]) => a + w, 0);
      let roll = rng.next() * total;
      const kind = (ROCK_YIELD.seam.find(([, w]) => (roll -= w) < 0) ?? ROCK_YIELD.seam[0])[0];
      return { [kind]: 1 };
    }
    case "geode":
      return { gem: rng.chance(ROCK_YIELD.geodeSecond) ? 2 : 1 };
  }
}

/** What the client may see of the face: where every rock is, hardness and glints, and inside the ones it has opened up. */
export function mineView(mine: MineState, over: boolean, now?: number): MineView {
  return {
    cols: MINE_COLS,
    rows: MINE_ROWS,
    rocks: mine.rocks.map((r, id) => ({
      id,
      cell: r.cell,
      hp: r.hp,
      dmg: r.dmg,
      broken: r.broken,
      kind: over || r.seen ? r.kind : null,
      glint: r.glint,
      fell: r.fell ?? 0,
      lost: !!r.lost,
      got: r.got ?? null,
    })),
    chargeMs: mine.chargeMs,
    recoverMs: MINE_RECOVER_MS,
    fallDamage: MINE_FALL_DAMAGE,
    ms: MINE_MS,
    leftMs: mine.startedAt === null ? null : Math.max(0, MINE_MS - Math.max(0, (now ?? mine.startedAt) - mine.startedAt)),
    lastAt: mine.lastAt,
  };
}
