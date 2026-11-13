import { describe, expect, it } from "vitest";
import { BOOK_PAGES, BOOK_SLOTS, FISH, FISH_IDS, WATERS, bookPage, type FishDef } from "./fishcatalog";
import { holdFight, idleFight, playFight } from "./fishbot";
import { FIGHT_MAX_EDGES, FIGHT_MAX_MS, PULSE_MS, TAP_MS, edgesProblem, fightEase, makeFightScript, pressureAt, replayFight, type FightEase } from "./fishfight";
import { FISH_SPOTS, HAUL_SHARE, castMetres, marketPrice, rollCatch, rollSize, tamPrice } from "./fishing";
import { makeRng } from "./rng";

const MID: FightEase = { str: 0.5, dex: 0.5 };
const fishes = (pred: (f: FishDef) => boolean) => FISH_IDS.map((id) => FISH[id]).filter(pred);

/** Roll a catch of `def` and the script it fights with. */
function hooked(def: FishDef, seed: number, reach = 0.5) {
  const rng = makeRng(seed);
  const size = rollSize(rng, def, reach);
  return { size, script: makeFightScript(rng, def, size.grams / 1000, castMetres(reach)) };
}

describe("the catalogue", () => {
  it("fills the Catch Book's pages, with Old Ironjaw outside the count", () => {
    const sizes = Object.fromEntries(BOOK_PAGES.map((p) => [p, bookPage(p).length]));
    expect(sizes).toEqual({ shallows: 10, mouth: 10, deep: 11, sea: 10, strays: 3, flotsam: 14, bonus: 1 });
    expect(FISH_IDS).toHaveLength(59);
    expect(BOOK_SLOTS).toBe(58);
    expect(bookPage("bonus")[0].id).toBe("ironjaw");
  });

  it("gives every entry sane ranges, a shape and colours", () => {
    for (const f of Object.values(FISH)) {
      expect(f.lengthCm[0], f.id).toBeGreaterThan(0);
      expect(f.lengthCm[1], f.id).toBeGreaterThanOrEqual(f.lengthCm[0]);
      expect(f.weightKg[1], f.id).toBeGreaterThanOrEqual(f.weightKg[0]);
      expect(f.water.length, f.id).toBeGreaterThan(0);
      expect(f.shape, f.id).toBeTruthy();
      expect(f.palette.length, f.id).toBeGreaterThanOrEqual(3);
      if (f.kind === "haul") expect(f.style, f.id).toBe("dead");
    }
  });

  it("lists each page commons first", () => {
    for (const page of BOOK_PAGES) {
      const order = bookPage(page).map((f) => ["common", "uncommon", "rare", "legendary", "mythic"].indexOf(f.rarity));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it("keeps the open sea's fish, and Old Ironjaw, to the open sea", () => {
    for (const f of bookPage("sea")) expect(f.water).toEqual(["sea"]);
    expect(FISH.ironjaw.water).toEqual(["sea"]);
    expect(FISH_SPOTS.sea.vessel).toBe("rowboat");
  });
});

describe("what bites", () => {
  it("only ever brings up what lives in that water", () => {
    for (const water of WATERS) {
      const rng = makeRng(7);
      for (let i = 0; i < 400; i++) expect(rollCatch(rng, water, rng.next()).water).toContain(water);
    }
  });

  it("brings up a haul about one bite in eight", () => {
    const rng = makeRng(11);
    let hauls = 0;
    for (let i = 0; i < 4000; i++) if (rollCatch(rng, "mouth", 0.5).kind === "haul") hauls++;
    expect(hauls / 4000).toBeGreaterThan(HAUL_SHARE - 0.03);
    expect(hauls / 4000).toBeLessThan(HAUL_SHARE + 0.03);
  });

  it("finds rarer fish on a long cast", () => {
    const rare = (reach: number) => {
      const rng = makeRng(3);
      let n = 0;
      for (let i = 0; i < 4000; i++) if (["rare", "legendary"].includes(rollCatch(rng, "deep", reach).rarity)) n++;
      return n;
    };
    expect(rare(1)).toBeGreaterThan(rare(0) * 1.5);
  });

  it("sizes catches within their kind, mostly small, the big ones specimens", () => {
    for (const f of fishes((f) => f.kind !== "haul")) {
      const rng = makeRng(5);
      let specimens = 0;
      for (let i = 0; i < 200; i++) {
        const s = rollSize(rng, f, 0.5);
        expect(s.mm, f.id).toBeGreaterThanOrEqual(f.lengthCm[0] * 10);
        expect(s.mm, f.id).toBeLessThanOrEqual(f.lengthCm[1] * 10);
        expect(s.grams, f.id).toBeGreaterThanOrEqual(Math.floor(f.weightKg[0] * 900));
        expect(s.grams, f.id).toBeLessThanOrEqual(Math.ceil(f.weightKg[1] * 1080));
        if (s.specimen) specimens++;
      }
      if (f.rarity === "common" || f.rarity === "uncommon") expect(specimens, f.id).toBeLessThan(60);
      else expect(specimens, f.id).toBe(200);
    }
  });

  it("prices fish by weight, specimens higher, and Tam only buys for the kitchen", () => {
    const herring = FISH.herring;
    expect(marketPrice(herring, 400, false)).toBeGreaterThanOrEqual(1);
    expect(marketPrice(FISH.bluefin, 100_000, true)).toBeGreaterThan(marketPrice(FISH.bluefin, 100_000, false));
    expect(marketPrice(FISH.bluefin, 100_000, false)).toBeGreaterThan(marketPrice(FISH.bluefin, 20_000, false));
    expect(tamPrice(herring, 400)).toBeGreaterThanOrEqual(1);
    expect(tamPrice(FISH.silver_king, 30_000)).toBeNull();
    expect(marketPrice(FISH.boot, 900, false)).toBe(0);
    expect(marketPrice(FISH.ships_bell, 20_000, false)).toBeGreaterThan(0);
  });
});

describe("the fight", () => {
  it("reads presses as taps and holds", () => {
    // A tap: 100 ms down. Half pressure from the press for a pulse.
    expect(pressureAt([1000, 1100], 999)).toBe(0);
    expect(pressureAt([1000, 1100], 1050)).toBe(0.5);
    expect(pressureAt([1000, 1100], 1000 + PULSE_MS - 1)).toBe(0.5);
    expect(pressureAt([1000, 1100], 1000 + PULSE_MS)).toBe(0);
    // A hold: half until it is clearly not a tap, then full, until released.
    expect(pressureAt([1000, 3000], 1000 + TAP_MS - 1)).toBe(0.5);
    expect(pressureAt([1000, 3000], 1000 + TAP_MS)).toBe(1);
    expect(pressureAt([1000, 3000], 3000)).toBe(0);
    // Still held at the end of the report.
    expect(pressureAt([1000], 9000)).toBe(1);
  });

  it("refuses reports that cannot be played", () => {
    expect(edgesProblem([0, 100, 50])).toBeTruthy();
    expect(edgesProblem([0, Number.NaN])).toBeTruthy();
    expect(edgesProblem([-1])).toBeTruthy();
    expect(edgesProblem("nope")).toBeTruthy();
    expect(edgesProblem(Array.from({ length: FIGHT_MAX_EDGES + 1 }, (_, i) => i))).toBeTruthy();
    expect(edgesProblem([0, 100, 100, 400])).toBeNull();
  });

  it("plays the same fight from a report as it did live, every time", () => {
    const all = fishes(() => true);
    for (let i = 0; i < 400; i++) {
      const f = all[i % all.length];
      const ease = fightEase(20 + (i * 37) % 76, 20 + (i * 53) % 76);
      const { script } = hooked(f, 1000 + i);
      const { end, edges } = playFight(script, ease, 0.6 + (i % 4) * 0.1);
      const again = replayFight(script, ease, JSON.parse(JSON.stringify(edges)));
      expect(again, f.id).toEqual(end);
    }
  });

  it("always ends, by the time limit at the latest", () => {
    for (const f of [FISH.ironjaw, FISH.sunfish, FISH.oarfish]) {
      const { script } = hooked(f, 9);
      expect(playFight(script, MID).end.t).toBeLessThanOrEqual(FIGHT_MAX_MS);
    }
  });

  it("lands nearly every common for a player who taps the runs and holds the rests", () => {
    let landed = 0;
    let fights = 0;
    for (const f of fishes((f) => f.rarity === "common" && f.kind !== "haul")) {
      for (let i = 0; i < 20; i++) {
        fights++;
        if (playFight(hooked(f, i).script, MID).end.outcome === "landed") landed++;
      }
    }
    expect(landed / fights).toBeGreaterThan(0.95);
  });

  it("snaps the line on a big fish held hard through its runs", () => {
    let snapped = 0;
    for (let i = 0; i < 20; i++) if (holdFight(hooked(FISH.amberjack, i, 1).script, MID).outcome === "snapped") snapped++;
    expect(snapped).toBe(20);
  });

  it("loses a fish that is never reeled", () => {
    for (let i = 0; i < 20; i++) expect(idleFight(hooked(FISH.mackerel, i).script, MID).outcome).not.toBe("landed");
  });

  it("lets Strength and Dexterity land big fish more often, and sooner", () => {
    const weak = fightEase(30, 30);
    const strong = fightEase(85, 85);
    let weakLanded = 0;
    let strongLanded = 0;
    let weakMs = 0;
    let strongMs = 0;
    for (let i = 0; i < 40; i++) {
      const { script } = hooked(FISH.wreck_grouper, i);
      const a = playFight(script, weak).end;
      const b = playFight(script, strong).end;
      if (a.outcome === "landed") (weakLanded++, (weakMs += a.t));
      if (b.outcome === "landed") (strongLanded++, (strongMs += b.t));
    }
    expect(strongLanded).toBeGreaterThan(weakLanded);
    expect(strongMs / strongLanded).toBeLessThan(weakMs / Math.max(1, weakLanded));
  });

  it("lets Strength alone reel faster", () => {
    const { script } = hooked(FISH.pollock, 4);
    const slow = playFight(script, { str: 0, dex: 0.5 }).end;
    const fast = playFight(script, { str: 1, dex: 0.5 }).end;
    expect(fast.outcome).toBe("landed");
    expect(fast.t).toBeLessThan(slow.t);
  });

  it("lets Dexterity alone hold the line harder", () => {
    let clumsy = 0;
    let deft = 0;
    for (let i = 0; i < 40; i++) {
      const { script } = hooked(FISH.reef_shark, i);
      if (playFight(script, { str: 0.5, dex: 0 }).end.outcome === "snapped") clumsy++;
      if (playFight(script, { str: 0.5, dex: 1 }).end.outcome === "snapped") deft++;
    }
    expect(deft).toBeLessThan(clumsy);
  });
});

describe("measures", () => {
  it("writes weights and lengths in metric or imperial", async () => {
    const { formatLength, formatLoad, formatWeight } = await import("./fishing");
    expect(formatWeight(860)).toBe("860 g");
    expect(formatWeight(1240)).toBe("1.24 kg");
    expect(formatWeight(150, "imperial")).toBe("5.3 oz");
    expect(formatWeight(5556, "imperial")).toBe("12 lb 4 oz");
    expect(formatWeight(453, "imperial")).toBe("1 lb");
    expect(formatLength(620)).toBe("62 cm");
    expect(formatLength(2400)).toBe("2.4 m");
    expect(formatLength(610, "imperial")).toBe("24 in");
    expect(formatLength(2388, "imperial")).toBe("7 ft 10 in");
    expect(formatLoad(34_000)).toBe("34 kg");
    expect(formatLoad(34_000, "imperial")).toBe("75 lb");
  });
});
