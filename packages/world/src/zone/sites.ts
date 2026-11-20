// Sites: what kind of place a map is. A site says how the ground is laid
// out and what stands on it (lay.ts builds it), what is under and round the
// land (its backdrop), and who lives there. The atlas picks one for each
// node from its ground, its climate and what the node is (`siteFor`); the
// same node is always the same kind of place.
//
// The set pieces a site is built from (lay.ts):
//
//   keep      a curtain wall you can walk the top of, towers, a gatehouse,
//             ladders up from the yard, tents and a fire inside
//   hall      the paved floor of a ruin: rows of pillars, broken walls, a
//             dais with an altar, statues and braziers
//   camp      a palisade round tents and a fire, with a watch platform
//   henge     standing stones in a ring on a mound, round an altar
//   ribcage   the ribs and skull of something vast, half sunk
//   stilts    huts on legs over water, joined by boardwalks
//   forge     a paved island in a pool of lava, reached by causeways
//   watch     a ruined tower on a knoll
//   crag      a hill in steps, ladders from one to the next, a beacon on top
//   den       a hollow ringed with boulders and bones

import type { Clime } from "../map";
import type { ZoneBiome } from "./types";

/** What lies under and round the land: the open sea, or a void the land floats over; or, under a roof or under ground, the dark. */
export type Backdrop = "sea" | "mist" | "abyss" | "lava" | "frost" | "dusk" | "dark";

export type PieceKind = "keep" | "hall" | "camp" | "henge" | "ribcage" | "stilts" | "forge" | "watch" | "crag" | "den";

/** Who lives somewhere: who stands in front, who shoots, and the big one that comes with a large band. */
export interface Faction {
  front: string[];
  shot: string[];
  heavy?: string[];
}

export const FACTIONS = {
  raiders: { front: ["bandit"], shot: ["archer"], heavy: ["brute"] },
  cult: { front: ["bandit"], shot: ["cultist"], heavy: ["brute"] },
  wolves: { front: ["wolf"], shot: [], heavy: ["bear"] },
  spiders: { front: ["spider"], shot: [], heavy: [] },
  coven: { front: ["wolf", "spider"], shot: ["witch"], heavy: ["bear"] },
  dead: { front: ["skeleton", "skeleton", "shade"], shot: ["shade"], heavy: [] },
  frost: { front: ["frost_wolf"], shot: ["wraith"], heavy: ["snow_bear"] },
  frostdead: { front: ["skeleton"], shot: ["wraith"], heavy: [] },
  fen: { front: ["spider", "slime"], shot: ["witch"], heavy: ["troll"] },
  ash: { front: ["ember_hound"], shot: ["cultist"], heavy: ["ogre"] },
  giants: { front: ["bandit"], shot: ["archer"], heavy: ["ogre"] },
  deep: { front: ["spider", "slime"], shot: ["shade"], heavy: ["troll"] },
} satisfies Record<string, Faction>;

export type FactionId = keyof typeof FACTIONS;

export interface SiteDef {
  name: string;
  /** A line about it, for the atlas. */
  blurb: string;
  backdrop: Backdrop;
  /** What it is built from, most important first: a small map has the first two, a large one all of them. */
  pieces: PieceKind[];
  /** Who lives there: each band is one of these, picked in turn. */
  factions: FactionId[];
  /** How much of it is wooded, 0 to 1; and how much standing water (or lava) lies about. */
  woods: number;
  water: number;
  /**
   * Under a roof or under ground, and which: `halls` are walled rooms joined by doorways, `caves` chambers joined
   * by tunnels (indoors.ts lays both). Nothing lies beyond the walls, a fight is not heard through them (only the
   * bands near enough come), and the set pieces above are not used.
   */
  inside?: "halls" | "caves";
  /** A crack runs through the land, with a bridge or two over it. */
  chasm?: boolean;
  /** What stands about on open ground, besides trees: props (props.ts), picked at random. */
  scatter: string[];
}

export const SITES = {
  wilds: { name: "Wilds", blurb: "Open country, with something camped in it.", backdrop: "mist", pieces: ["camp", "henge", "watch", "camp"], factions: ["wolves", "raiders", "spiders", "coven"], woods: 0.5, water: 0.25, scatter: ["boulder", "boulder", "great_tree", "dead_tree"] },
  ruins: { name: "Ruins", blurb: "The floor of something grand, and what still stands of it.", backdrop: "abyss", pieces: ["hall", "watch", "henge", "hall"], factions: ["dead", "cult", "dead", "raiders"], woods: 0.2, water: 0.1, chasm: true, scatter: ["pillar_broken", "wall_broken", "boulder", "statue"] },
  keep: { name: "Keep", blurb: "A walled yard, held against all comers.", backdrop: "mist", pieces: ["keep", "camp", "watch", "camp"], factions: ["raiders", "raiders", "giants", "wolves"], woods: 0.25, water: 0.15, scatter: ["boulder", "barrels", "cart", "dead_tree"] },
  camp: { name: "Raiders' camp", blurb: "Tents behind stakes, and more of them than you would like.", backdrop: "mist", pieces: ["camp", "camp", "watch", "henge"], factions: ["raiders", "giants", "raiders", "wolves"], woods: 0.35, water: 0.2, scatter: ["boulder", "barrels", "cart", "dead_tree"] },
  henge: { name: "Henge", blurb: "Old stones in a ring, and whoever tends them.", backdrop: "mist", pieces: ["henge", "henge", "hall", "camp"], factions: ["coven", "wolves", "cult", "spiders"], woods: 0.45, water: 0.2, scatter: ["standing_stone", "boulder", "great_tree", "mushrooms"] },
  boneyard: { name: "Boneyard", blurb: "Where the great beasts came to die.", backdrop: "dusk", pieces: ["ribcage", "henge", "ribcage", "camp"], factions: ["dead", "spiders", "raiders", "giants"], woods: 0.05, water: 0, chasm: true, scatter: ["ribs", "boulder", "dead_tree", "standing_stone", "skull"] },
  icefield: { name: "Icefield", blurb: "Snow over stone, and a shrine nobody has swept in an age.", backdrop: "frost", pieces: ["henge", "watch", "keep", "camp"], factions: ["frost", "frostdead", "raiders", "frost"], woods: 0.3, water: 0.1, scatter: ["ice_spire", "ice_spire", "boulder", "standing_stone", "crystal"] },
  fen: { name: "Fen", blurb: "Black water, boardwalks, and huts on legs.", backdrop: "mist", pieces: ["stilts", "henge", "stilts", "camp"], factions: ["fen", "coven", "spiders", "fen"], woods: 0.35, water: 0.9, scatter: ["dead_tree", "mushrooms", "mushrooms", "boulder"] },
  caldera: { name: "Caldera", blurb: "Cinders, black glass, and the glow from below.", backdrop: "lava", pieces: ["forge", "hall", "watch", "camp"], factions: ["ash", "cult", "giants", "ash"], woods: 0.05, water: 0.6, chasm: true, scatter: ["basalt", "basalt", "boulder", "dead_tree", "obelisk"] },
  cove: { name: "Cove", blurb: "A landing, and whoever got there first.", backdrop: "sea", pieces: ["camp", "watch", "keep", "camp"], factions: ["raiders", "cult", "giants", "raiders"], woods: 0.2, water: 0.2, scatter: ["boulder", "barrels", "dead_tree", "cart"] },
  crag: { name: "Crag", blurb: "A hill in steps, and whoever holds the top sees everything.", backdrop: "mist", pieces: ["crag", "camp", "watch"], factions: ["raiders", "wolves", "giants"], woods: 0.2, water: 0.05, scatter: ["boulder", "boulder", "standing_stone", "dead_tree"] },
  den: { name: "Den", blurb: "Something big sleeps here, and its own kind keep it company.", backdrop: "mist", pieces: ["den", "camp", "henge"], factions: ["wolves", "spiders", "coven"], woods: 0.4, water: 0.15, scatter: ["boulder", "ribs", "dead_tree", "great_tree"] },
  citadel: { name: "Stronghold", blurb: "Inside the walls: guardrooms, a gallery, and a great hall with somebody in the high seat.", backdrop: "dark", inside: "halls", pieces: [], factions: ["raiders", "giants", "cult", "raiders"], woods: 0, water: 0, scatter: ["barrels", "table", "weapon_rack", "statue", "bookshelf", "cage"] },
  crypt: { name: "Crypt", blurb: "Vaults under the ruin, and the ones laid in them, who did not stay laid.", backdrop: "dark", inside: "halls", pieces: [], factions: ["dead", "cult", "dead", "dead"], woods: 0, water: 0, scatter: ["sarcophagus", "sarcophagus", "statue", "pillar_broken", "altar", "bones"] },
  cavern: { name: "Cavern", blurb: "Under the hill: wet stone, cold light, and what lives without the sun.", backdrop: "dark", inside: "caves", pieces: [], factions: ["deep", "spiders", "dead", "deep"], woods: 0, water: 0.5, scatter: ["stalagmite", "stalagmite", "boulder", "mushrooms", "crystal"] },
  hollow: { name: "Hollow", blurb: "A den gone deep into the rock. The bones get thicker the further in you go.", backdrop: "dark", inside: "caves", pieces: [], factions: ["wolves", "spiders", "coven"], woods: 0, water: 0.2, scatter: ["bones", "stalagmite", "boulder", "ribs", "mushrooms"] },
} satisfies Record<string, SiteDef>;

export type SiteId = keyof typeof SITES;
export const SITE_IDS = Object.keys(SITES) as SiteId[];

/** Whether a site (by its id; anything else is not one) is under a roof or under ground. */
export const siteInside = (site: string): boolean => !!(SITES as Record<string, SiteDef>)[site]?.inside;
/** Whether a site (by its id) is out under the sky. What is not a site at all (a cave of the old kind) is not. */
export const siteOpen = (site: string): boolean => site in SITES && !siteInside(site);

/**
 * The ground a place stands on, as far as what kind of place it may be goes: a map's own ground (its options'
 * `biome`, where a cave is reckoned open ground), or high ground, which only a place on the atlas's hills has
 * (its map is made as open ground, laid steep).
 */
export type SiteGround = Exclude<ZoneBiome, "caves"> | "heights";
export const SITE_GROUNDS: SiteGround[] = ["meadow", "woods", "shore", "heights"];

/**
 * The sites a stretch of ground in a climate may be, most likely first. The last of each is under a roof or
 * under ground. The first is what that ground in that climate most plainly is: a cove on a shore, bones in the
 * sand, a fen in the mire, a crag in the hills. (The ashlands have no sea, so no cove: their shore is the edge of the fire.)
 */
const CLIME_SITES: Record<Clime, Record<SiteGround, SiteId[]>> = {
  greenwood: { meadow: ["keep", "ruins", "camp", "citadel"], woods: ["wilds", "henge", "camp", "cavern"], shore: ["cove", "camp", "keep", "cavern"], heights: ["crag", "keep", "ruins", "cavern"] },
  frost: { meadow: ["icefield", "keep", "ruins", "citadel"], woods: ["icefield", "henge", "camp", "cavern"], shore: ["cove", "icefield", "keep", "cavern"], heights: ["crag", "icefield", "keep", "cavern"] },
  dunes: { meadow: ["boneyard", "ruins", "camp", "crypt"], woods: ["boneyard", "henge", "ruins", "crypt"], shore: ["cove", "boneyard", "camp", "crypt"], heights: ["crag", "ruins", "boneyard", "crypt"] },
  mire: { meadow: ["fen", "henge", "ruins", "cavern"], woods: ["fen", "wilds", "henge", "cavern"], shore: ["fen", "cove", "camp", "crypt"], heights: ["crag", "henge", "ruins", "cavern"] },
  ash: { meadow: ["caldera", "ruins", "keep", "citadel"], woods: ["caldera", "boneyard", "ruins", "cavern"], shore: ["caldera", "boneyard", "keep", "crypt"], heights: ["crag", "caldera", "keep", "cavern"] },
};

/** What the void round the land is in each climate, where a site does not say otherwise (the sea is the sea everywhere). */
const CLIME_BACKDROP: Partial<Record<Clime, Backdrop>> = { frost: "frost", dunes: "dusk", ash: "lava" };

/** Who is likelier to be found in a climate than a site's own would be: swapped in for the site's wolves, raiders and the dead. */
const CLIME_FACTION: Partial<Record<Clime, Partial<Record<FactionId, FactionId>>>> = {
  frost: { wolves: "frost", dead: "frostdead", coven: "frost" },
  ash: { wolves: "ash", coven: "cult", spiders: "ash" },
  mire: { wolves: "spiders", raiders: "fen" },
  dunes: { wolves: "spiders", coven: "cult" },
};

/** How often a lookout is a tower held from the inside and not a crag, and how often a lair has gone under ground. */
export const LOOKOUT_INSIDE = 0.4;
export const LAIR_INSIDE = 0.7;

/**
 * The kind of place a map is, from its ground and climate, picked by `roll` (0 to 1: the atlas rolls it once for a
 * node, so a node is always the same kind of place). A lookout is a crag, or a citadel held from the inside. A
 * lair is most often under a roof (the halls of a citadel on the shore, where the beast is a thing of stone; a
 * hollow in the rock anywhere else) and otherwise a den in the open. Anywhere else is one of the sites that suit
 * the ground: the likeliest comes up a little under half the time, and the last, the one indoors, about one time in six.
 */
export function siteFor(biome: ZoneBiome | SiteGround, clime: Clime | undefined, what: "landfall" | "lookout" | "lair", roll: number): SiteId {
  if (what === "lookout") return roll < LOOKOUT_INSIDE ? "citadel" : "crag";
  if (what === "lair") return roll >= LAIR_INSIDE ? "den" : biome === "shore" ? "citadel" : "hollow";
  const sites = CLIME_SITES[clime ?? "greenwood"][biome === "caves" ? "meadow" : biome];
  return sites[roll < 0.44 ? 0 : roll < 0.68 ? 1 : roll < 0.84 ? 2 : 3];
}

/**
 * What lies under and round a site's land, in a climate; and, where the map's ground is given, on that ground.
 * A place on the shore stands in the sea whatever it is (save in the ashlands, which have none: what lies round
 * the land there is the fire; and in the mire, whose shore is black pools in the mist, not open water). Anywhere
 * else it is the climate's own, or where the climate has none (the greenwood and the mire) the site's: mist, or
 * the abyss under a ruin. The sea, lava and the dark are a site's for good.
 */
export function backdropOf(site: SiteId, clime: Clime | undefined, ground?: ZoneBiome): Backdrop {
  const own = SITES[site].backdrop;
  if (own === "sea" || own === "lava" || own === "dark") return own;
  if (own !== "abyss" && ground === "shore" && clime !== "ash" && clime !== "mire") return "sea";
  // A climate with a sky of its own keeps it over an abyss too: ruins in the dunes are ruins in the sun.
  return (clime && CLIME_BACKDROP[clime]) || own;
}

/** What each climate's country is called when a place in it is named; in the greenwood, by the ground the place stands on. */
const COUNTRY: Record<Exclude<Clime, "greenwood">, string> = { frost: "Frozen", dunes: "Desert", mire: "Marsh", ash: "Ashland" };
const GREEN_COUNTRY: Record<SiteGround, string> = { meadow: "Meadow", woods: "Woodland", shore: "Coastal", heights: "Hill" };
/** The sites whose own name already says where they are: an icefield is not a "frozen icefield". */
const OWN_COUNTRY: Partial<Record<SiteId, Clime>> = { icefield: "frost", fen: "mire", caldera: "ash", cove: "greenwood", crag: "greenwood", wilds: "greenwood" };

/**
 * A kind of place, named with the country it is in, as the atlas says it: "Desert ruins", "Frozen keep",
 * "Woodland henge", "Marsh cove". The same words wherever a place is named, so the atlas and a muster agree.
 */
export function placeName(site: SiteId, clime: Clime | undefined, ground: SiteGround): string {
  const name: string = SITES[site].name;
  const where = clime ?? "greenwood";
  if (OWN_COUNTRY[site] === where) return name;
  return `${where === "greenwood" ? GREEN_COUNTRY[ground] : COUNTRY[where]} ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}

/** Who lives at a site in a climate: its own bands, with the climate's own in place of those that do not live there. */
export function factionsOf(site: SiteId, clime: Clime | undefined): FactionId[] {
  const swap = (clime && CLIME_FACTION[clime]) || {};
  const list: FactionId[] = SITES[site].factions;
  return list.map((f) => swap[f] ?? f);
}

/**
 * A band of `size` from a faction: one that shoots for every three, the big one once there are four or more, and
 * the rest to stand in front. In the order they are posted: the front first, then the big one, then those that shoot.
 */
export function bandOf(faction: FactionId, size: number, pick: <T>(list: readonly T[]) => T): { kind: string; role: "front" | "shot" | "heavy" }[] {
  const f: Faction = FACTIONS[faction];
  const n = Math.max(1, size);
  const heavy = n >= 4 && f.heavy && f.heavy.length > 0 ? 1 : 0;
  const shot = f.shot.length > 0 ? Math.floor(n / 3) : 0;
  const front = Math.max(0, n - heavy - shot);
  return [
    ...Array.from({ length: front }, () => ({ kind: pick(f.front), role: "front" as const })),
    ...Array.from({ length: heavy }, () => ({ kind: pick(f.heavy!), role: "heavy" as const })),
    ...Array.from({ length: shot }, () => ({ kind: pick(f.shot), role: "shot" as const })),
  ];
}
