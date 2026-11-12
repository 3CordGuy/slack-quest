// Story generation: structure from code, flavour from the model.
//
// A frame fixes what the story *is*: its objectives, which NPC can do what,
// and where things are. The model only fills in names, motives and voice
// (a StoryFill). buildBible joins the two, and validateBible proves the
// result is completable before a run is allowed to start on it.

import type { WorldMap } from "./map";
import { poiById } from "./map";
import { ENEMIES } from "./content";
import { makeRng, seedFromString, type Rng } from "./rng";

// ---------- what the model writes ----------

export interface StoryFill {
  title: string;
  premise: string;
  island_name: string;
  villain_name: string;
  villain_description: string;
  relic_name: string;
  lair_name: string;
  npc_name: string;
  npc_role: string;
  npc_persona: string;
  npc_voice: string;
  npc_goal: string;
  npc_secret: string;
  npc_knowledge: string[];
  charm_name: string;
}

const FILL_LIMITS: Record<Exclude<keyof StoryFill, "npc_knowledge">, number> = {
  title: 60,
  premise: 400,
  island_name: 40,
  villain_name: 40,
  villain_description: 240,
  relic_name: 50,
  lair_name: 50,
  npc_name: 40,
  npc_role: 60,
  npc_persona: 300,
  npc_voice: 200,
  npc_goal: 240,
  npc_secret: 240,
  charm_name: 50,
};

/** JSON schema handed to the model for structured output. */
export const STORY_FILL_SCHEMA = {
  type: "object",
  properties: {
    ...Object.fromEntries(Object.keys(FILL_LIMITS).map((k) => [k, { type: "string" }])),
    npc_knowledge: { type: "array", items: { type: "string" } },
  },
  required: [...Object.keys(FILL_LIMITS), "npc_knowledge"],
} as const;

/** Accept a model response only if every field is present, a string, and a sane length. */
export function validateFill(raw: unknown): StoryFill | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, max] of Object.entries(FILL_LIMITS)) {
    const v = obj[key];
    if (typeof v !== "string") return null;
    const text = v.replace(/\s+/g, " ").trim();
    if (text.length < 2 || text.length > max) return null;
    out[key] = text;
  }
  const knows = obj.npc_knowledge;
  if (!Array.isArray(knows)) return null;
  const facts = knows
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.replace(/\s+/g, " ").trim())
    .filter((k) => k.length > 0 && k.length <= 200)
    .slice(0, 5);
  if (facts.length === 0) return null;
  out.npc_knowledge = facts;
  return out as unknown as StoryFill;
}

// ---------- the bible ----------

export type Gate = "free" | "persuade" | "provoked" | "demand";

/**
 * The one thing an NPC asks of the party before helping. Demands come from
 * a fixed list so the game can always tell whether one has been met; the
 * model words the request but cannot invent a different one.
 */
export interface Demand {
  id: string;
  /** Completes "They ask that you …". */
  text: string;
  /** World fact that satisfies it, or null when a passed persuasion check does. */
  fact: string | null;
}

/**
 * When a capability may fire. `free`: whenever the NPC chooses. `persuade`:
 * only after a hero passes a persuasion check. `provoked`: only once the NPC
 * already disliked the party before this exchange, so it takes two bad
 * exchanges, not one odd remark, to start a fight. `demand`: only once the
 * story's Demand has been met.
 */
/** One thing an NPC is able to do to the game. The model only decides when. */
export type Capability =
  | { id: string; verb: "give_item"; item: string; itemName: string; gate: Gate }
  | { id: string; verb: "reveal_location"; poi: string; poiName: string; gate: Gate }
  | { id: string; verb: "start_combat"; enemies: string[]; gate: Gate };

export interface NpcSheet {
  id: string;
  /** POI the NPC stands at. */
  poi: string;
  name: string;
  role: string;
  persona: string;
  voice: string;
  goal: string;
  secret: string;
  knows: string[];
  capabilities: Capability[];
}

export interface Objective {
  id: string;
  text: string;
  /** World fact that completes it. */
  fact: string;
}

/**
 * Something the party does at a place once certain facts are true: bring a
 * rescued islander home, restore a mended relic at the shrine. Performing it
 * sets a fact, which is usually an objective.
 */
export interface Rite {
  id: string;
  poi: string;
  requires: string[];
  sets: string;
  /** Button label. */
  label: string;
  /** Log line when it is done. */
  text: string;
}

/** When every required fact is true, a hidden place is revealed. */
export interface Trigger {
  requires: string[];
  reveal: string;
}

export interface StoryBible {
  frameId: string;
  title: string;
  premise: string;
  islandName: string;
  villain: { name: string; description: string };
  relicName: string;
  poiNames: Record<string, string>;
  npcs: NpcSheet[];
  objectives: Objective[];
  /** What the NPC asks before helping. */
  demand: Demand;
  /** Completing this objective wins the run. */
  finalObjective: string;
  rites: Rite[];
  triggers: Trigger[];
  /** Who is fought where, by POI id. Replaces the map's defaults when the run begins. */
  encounters: Record<string, string[]>;
  /** POIs in the order the story roughly takes the party, for sizing the doom clock. */
  route: string[];
  /** Said when the story is won, and when time runs out. */
  victoryLine: string;
  defeatLine: string;
  /** Rounds before time runs out. The run lengthens this to fit the island. */
  doomRounds: number;
}

/** The parts of a bible that depend on which kind of story it is. */
type FramePlan = Pick<StoryBible, "objectives" | "finalObjective" | "rites" | "triggers" | "encounters" | "route" | "victoryLine" | "defeatLine"> & {
  capabilities: Capability[];
  poiNames?: Record<string, string>;
};

export interface StoryFrame {
  id: string;
  /** Tells the model what kind of story to write. */
  brief: string;
  /** What three of the fill's fields mean in this kind of story. */
  fields: { relic: string; villain: string; lair: string };
  /** Kinds of thing taken and of culprit that suit this story, replacing the general lists. */
  hints?: { relic?: string[]; villain?: string[] };
  /** Shortest the doom clock may be; the run lengthens it to fit the island. */
  doomRounds: number;
  demands: Demand[];
  plan(fill: StoryFill, rng: Rng): FramePlan;
}

const DEMANDS = {
  clear_camp: { id: "clear_camp", text: "clear out the camp in the wilds", fact: "defeated:camp" },
  earn_trust: { id: "earn_trust", text: "convince them you can be trusted", fact: null },
  fetch: { id: "fetch", text: "bring back what they left at the cache near the shore", fact: "searched:cache1" },
  pray: { id: "pray", text: "pay your respects at the old shrine", fact: "prayed:shrine" },
} satisfies Record<string, Demand>;

const CAMP_ENCOUNTERS = [["bandit", "wolf"], ["bandit", "bandit"], ["archer", "bandit"], ["brute"], ["wolf", "wolf", "wolf"], ["cultist", "archer"]];
const charm = (fill: StoryFill, gate: Gate): Capability => ({ id: "give_charm", verb: "give_item", item: "charm", itemName: fill.charm_name, gate });
const revealLair = (fill: StoryFill): Capability => ({ id: "reveal_lair", verb: "reveal_location", poi: "lair", poiName: fill.lair_name, gate: "demand" });
const callGuard: Capability = { id: "call_guard", verb: "start_combat", enemies: ["bandit"], gate: "provoked" };
const meet = (fill: StoryFill): Objective => ({ id: "meet", text: `Find ${fill.npc_name} at the hut near the shore`, fact: "met:npc1" });

export const STORY_FRAMES: StoryFrame[] = [
  {
    // Find who knows, learn where, take it back by force.
    id: "stolen_relic",
    brief:
      "A villain has stolen something the island's people depend on and gone to ground in a hidden lair. " +
      "One islander living in a hut near the shore knows where the lair is and owns a protective charm.",
    fields: {
      relic: "the stolen thing, starting with \"the\"",
      villain: "the thief",
      lair: "where the thief hides, starting with \"the\"",
    },
    doomRounds: 16,
    demands: [DEMANDS.clear_camp, DEMANDS.earn_trust, DEMANDS.fetch, DEMANDS.pray],
    plan: (fill, rng) => ({
      capabilities: [revealLair(fill), charm(fill, "persuade"), callGuard],
      objectives: [
        meet(fill),
        { id: "locate", text: `Learn where ${fill.lair_name} is hidden`, fact: "revealed:lair" },
        { id: "defeat", text: `Defeat ${fill.villain_name} and recover ${fill.relic_name}`, fact: "defeated:lair" },
      ],
      finalObjective: "defeat",
      rites: [],
      triggers: [],
      encounters: { lair: ["villain", rng.pick(["cultist", "brute", "archer"])], camp: rng.pick(CAMP_ENCOUNTERS) },
      route: ["landing", "hut", "lair"],
      victoryLine: `${fill.villain_name} is beaten and ${fill.relic_name} is on its way home.`,
      defeatLine: `${fill.villain_name} slipped away with ${fill.relic_name}.`,
    }),
  },
  {
    // The fight is in the middle; the story ends by walking someone home.
    id: "rescue",
    brief:
      "Someone the island cannot do without has been carried off by a gang and is held at a hidden hideout. " +
      "Their kin, living in a hut near the shore, knows where the hideout is and owns a protective charm. " +
      "The story ends when the captive is brought home to that hut.",
    fields: {
      relic: "the captive: a first name and their trade, e.g. \"Wenna the bonesetter\" (a person, not an object)",
      villain: "the leader of the gang",
      lair: "the gang's hideout, starting with \"the\"",
    },
    hints: {
      relic: ["the island's only healer", "a young bell-founder's apprentice", "the ferryman everyone relies on", "a midwife", "the keeper of the seed store", "a child who can read the weather"],
      villain: ["a ransom-taker who does this for a living", "a press-gang captain short of crew", "a spurned suitor with hired muscle", "a debt collector who takes people instead of coin", "a slaver posing as a merchant"],
    },
    doomRounds: 18,
    demands: [DEMANDS.clear_camp, DEMANDS.earn_trust, DEMANDS.pray],
    plan: (fill, rng) => ({
      capabilities: [revealLair(fill), charm(fill, "persuade"), callGuard],
      objectives: [
        meet(fill),
        { id: "locate", text: `Learn where ${fill.lair_name} is hidden`, fact: "revealed:lair" },
        { id: "free", text: `Free ${fill.relic_name} from ${fill.villain_name}'s gang`, fact: "defeated:lair" },
        { id: "return", text: `Bring ${fill.relic_name} home to ${fill.npc_name}`, fact: "returned:hut" },
      ],
      finalObjective: "return",
      rites: [{ id: "return", poi: "hut", requires: ["defeated:lair"], sets: "returned:hut", label: `Bring ${fill.relic_name} home`, text: `${fill.relic_name} is home.` }],
      triggers: [],
      encounters: { lair: ["villain", rng.pick(["bandit", "archer", "brute"])], camp: rng.pick(CAMP_ENCOUNTERS) },
      route: ["landing", "hut", "lair", "hut"],
      victoryLine: `${fill.relic_name} is home safe, and ${fill.villain_name}'s gang is scattered.`,
      defeatLine: `${fill.villain_name}'s gang sailed with ${fill.relic_name} aboard.`,
    }),
  },
  {
    // No one to ask the way: the party tracks the beast by searching two places.
    id: "beast_hunt",
    brief:
      "A great beast has been preying on the island and nobody knows where it dens. A tracker living in a hut near " +
      "the shore has been following its signs, which lie at two spots on the island, and owns a protective charm. " +
      "There is no human villain: the beast is the threat.",
    fields: {
      relic: "what the beast has been taking or ruining, starting with \"the\" (the flocks, the night catch)",
      villain: "what islanders call the beast, e.g. \"the Grey Widow\"; its description says what kind of animal it is",
      lair: "the beast's den, starting with \"the\"",
    },
    hints: {
      relic: ["the flocks", "the night catch", "the hives", "the orchard pickers' nerve", "the island's hounds", "the winter stores"],
      villain: ["an enormous old wolf with one white eye", "a wolf-mother leading a starving pack", "a hound gone feral and grown huge", "a pale wolf the islanders think is a ghost", "a scarred pack leader that has learned to open gates"],
    },
    doomRounds: 18,
    demands: [DEMANDS.clear_camp, DEMANDS.earn_trust, DEMANDS.pray],
    plan: (fill) => ({
      // The tracker cannot point to the den; the charm is what the demand unlocks.
      capabilities: [charm(fill, "demand"), callGuard],
      objectives: [
        meet(fill),
        { id: "sign1", text: "Search for the beast's tracks near the shore", fact: "searched:cache1" },
        { id: "sign2", text: "Search the kill site further inland", fact: "searched:cache2" },
        { id: "slay", text: `Hunt down ${fill.villain_name} at ${fill.lair_name}`, fact: "defeated:lair" },
      ],
      finalObjective: "slay",
      rites: [],
      triggers: [{ requires: ["searched:cache1", "searched:cache2"], reveal: "lair" }],
      encounters: { lair: ["alpha", "wolf"], camp: [["wolf", "wolf"], ["bandit", "wolf"], ["archer", "bandit"]][fill.title.length % 3] },
      route: ["landing", "hut", "cache1", "cache2", "lair"],
      poiNames: { cache1: "Tracks near the shore", cache2: "The kill site" },
      victoryLine: `${fill.villain_name} is dead, and ${fill.relic_name} can rest easy.`,
      defeatLine: `${fill.villain_name} is still out there, and the island has run out of patience for hunters.`,
    }),
  },
  {
    // Three things to gather in any order, and the ending is not a fight.
    id: "broken_relic",
    brief:
      "Something the island depends on was broken into three pieces and scattered: raiders took one to their camp, " +
      "one lies lost at an old cache inland, and a guardian holds the last in a hidden vault. An islander living in a " +
      "hut near the shore knows the way to the vault and owns a protective charm. Whole again, it must be restored " +
      "at the island's old shrine. The guardian is not evil, only bound to its duty.",
    fields: {
      relic: "the broken thing, starting with \"the\"",
      villain: "the vault's guardian (a stone sentinel, an old automaton, a bound spirit); its description says what it is",
      lair: "the vault, starting with \"the\"",
    },
    hints: {
      villain: ["a stone sentinel that has forgotten who set it there", "a brass automaton still following its last order", "a weathered statue that wakes when the vault is opened", "a guardian of knotted driftwood and rope", "a suit of armor with nobody inside"],
    },
    doomRounds: 20,
    demands: [DEMANDS.earn_trust, DEMANDS.fetch, DEMANDS.pray],
    plan: (fill, rng) => ({
      capabilities: [revealLair(fill), charm(fill, "persuade"), callGuard],
      objectives: [
        meet(fill),
        { id: "piece1", text: `Take a piece of ${fill.relic_name} back from the raiders' camp`, fact: "defeated:camp" },
        { id: "piece2", text: "Recover the piece lost at the inland cache", fact: "searched:cache2" },
        { id: "locate", text: `Learn the way to ${fill.lair_name}`, fact: "revealed:lair" },
        { id: "piece3", text: `Win the last piece from ${fill.villain_name} in ${fill.lair_name}`, fact: "defeated:lair" },
        { id: "restore", text: `Restore ${fill.relic_name} at the old shrine`, fact: "restored:shrine" },
      ],
      finalObjective: "restore",
      rites: [
        { id: "restore", poi: "shrine", requires: ["defeated:camp", "searched:cache2", "defeated:lair"], sets: "restored:shrine", label: `Restore ${fill.relic_name}`, text: `${fill.relic_name} is whole again.` },
      ],
      triggers: [],
      encounters: { lair: ["guardian"], camp: rng.pick([["bandit", "bandit"], ["archer", "bandit"], ["brute"], ["cultist", "archer"]]) },
      route: ["landing", "hut", "camp", "cache2", "lair", "shrine"],
      poiNames: { cache2: "The lost piece" },
      victoryLine: `${fill.relic_name} is whole again and back where it belongs.`,
      defeatLine: `The pieces of ${fill.relic_name} stayed scattered, and the island went without.`,
    }),
  },
];

export function frameById(id: string): StoryFrame | undefined {
  return STORY_FRAMES.find((f) => f.id === id);
}

/**
 * Pick the kind of story for a voyage. `recent` is the crew's last voyages'
 * frame ids, newest first: the most recent half of the frames are skipped,
 * so a crew never sails the same kind of story twice running and works
 * through the others before one comes round again.
 */
export function pickFrame(rng: Rng, recent: string[] = []): StoryFrame {
  const skip = new Set(recent.slice(0, Math.floor(STORY_FRAMES.length / 2)));
  const fresh = STORY_FRAMES.filter((f) => !skip.has(f.id));
  return rng.pick(fresh.length > 0 ? fresh : STORY_FRAMES);
}

/** Pick what the islander asks, avoiding the ask `recent` names (the crew's last) when there is another. */
export function pickDemand(frame: StoryFrame, rng: Rng, recent?: string): Demand {
  const fresh = frame.demands.filter((d) => d.id !== recent);
  return rng.pick(fresh.length > 0 ? fresh : frame.demands);
}

/** Stands in for a demand on stories saved before demands existed: nothing is asked. */
export const NO_DEMAND: Demand = { id: "none", text: "", fact: null };

/** Has the party done what the NPC asked? `persuaded` is that NPC's persuasion flag. */
export function demandMet(bible: StoryBible, facts: Record<string, boolean>, persuaded: boolean): boolean {
  if (bible.demand.id === NO_DEMAND.id) return true;
  return bible.demand.fact ? !!facts[bible.demand.fact] : persuaded;
}

// ---------- per-voyage flavour ----------

/**
 * Seeded prompts that push the model somewhere different on each voyage.
 * Left alone it writes nearly the same title, island and villain every time;
 * these come from the run's seed, so a run's story is still reproducible.
 */
export interface StoryHints {
  mood: string;
  island: string;
  relic: string;
  villain: string;
  islander: string;
  naming: string;
  /** First letters for the island, villain and islander names. */
  initials: { island: string; villain: string; islander: string };
}

const HINT_MOODS = [
  "wistful and salt-worn, like a sea shanty",
  "wry and a little absurd",
  "eerie and hushed",
  "warm and pastoral, with trouble at the edges",
  "swashbuckling and brisk",
  "melancholy, about things slowly being forgotten",
  "tense, like a village holding its breath",
  "storybook-bright with a sharp edge",
];
const HINT_ISLANDS = [
  "a fishing community that lives by the tides",
  "an island of orchards and beekeepers",
  "a windswept place of shepherds and standing stones",
  "an island of glassblowers and kiln smoke",
  "a quiet island of retired sailors and their gardens",
  "an island of bell-makers where every hill has a bell",
  "a salt-harvesting island of white pans and grey skies",
  "an island of kite-flyers and weather-watchers",
  "a mossy island of weavers and dye-makers",
  "an island of lamplighters whose paths are lit every dusk",
];
const HINT_RELICS = [
  "a lantern or lamp",
  "a seed, sapling or graft",
  "a bell or chime",
  "a loom shuttle or spindle",
  "a weathervane or compass",
  "a kettle, cauldron or cup",
  "a book of names or a ledger",
  "a mask or crown of woven reeds",
  "a tuning fork or pipe",
  "a jar holding something alive",
  "a key that fits no door on the island",
  "an anchor or ship's wheel",
];
const HINT_VILLAINS = [
  "a wrecker who profits from other people's misfortune",
  "a preacher certain the island must suffer to be saved",
  "an exiled islander nursing an old grudge",
  "a collector who cannot bear for anyone else to own a beautiful thing",
  "a failed inventor who needs the relic for one last machine",
  "a tax-gatherer from the mainland who has gone too far",
  "a charming smuggler who thinks of it as borrowing",
  "a hermit who believes the relic is whispering to them",
  "a deposed harbourmaster who wants to be needed again",
  "a storm-chaser who thinks the relic can command the weather",
];
const HINT_ISLANDERS = [
  "a retired keeper of something (a light, a lock, a ledger)",
  "a sharp-tongued herbalist",
  "a young ferryman who saw too much",
  "a widowed boatbuilder",
  "a former follower of the villain",
  "a gossiping innkeeper with no inn left to keep",
  "a patient schoolteacher",
  "a half-deaf bell-ringer",
  "a shepherd who talks to the flock more than to people",
  "a mapmaker who distrusts their own maps",
];
const HINT_NAMING = [
  "short, blunt names of one or two syllables",
  "soft names full of L, M and N sounds",
  "old seafaring names, as from a ship's muster",
  "names with a descriptive byname, like 'the Wrecker' or 'of the Low Road'",
  "plain country names a farmer would have",
  "names that sound faintly Nordic",
  "names that sound faintly Cornish or Breton",
];
const HINT_INITIALS = "ABCDEFGHIKLMNOPRSTVW";

export function storyHints(rng: Rng, frame?: StoryFrame): StoryHints {
  const letters = [...HINT_INITIALS];
  // Three different letters, so the names do not alliterate.
  const letter = () => letters.splice(rng.int(0, letters.length - 1), 1)[0];
  return {
    mood: rng.pick(HINT_MOODS),
    island: rng.pick(HINT_ISLANDS),
    relic: rng.pick(frame?.hints?.relic ?? HINT_RELICS),
    villain: rng.pick(frame?.hints?.villain ?? HINT_VILLAINS),
    islander: rng.pick(HINT_ISLANDERS),
    naming: rng.pick(HINT_NAMING),
    initials: { island: letter(), villain: letter(), islander: letter() },
  };
}

/** The POI a fact is earned at, if it is earned at one. */
export function factPoi(fact: string | null): string | null {
  if (!fact) return null;
  const [kind, ref] = fact.split(":");
  return ["defeated", "searched", "prayed", "revealed"].includes(kind) ? ref : null;
}

/**
 * Join a frame and a fill into a bible. `rng` varies who is fought where;
 * without one the choice is fixed by the story's title, so the same fill
 * always builds the same bible.
 */
export function buildBible(frame: StoryFrame, fill: StoryFill, demand: Demand = frame.demands[0], rng: Rng = makeRng(seedFromString(fill.title))): StoryBible {
  const { capabilities, poiNames, route, ...plan } = frame.plan(fill, rng);
  const npc: NpcSheet = {
    id: "npc1",
    poi: "hut",
    name: fill.npc_name,
    role: fill.npc_role,
    persona: fill.npc_persona,
    voice: fill.npc_voice,
    goal: fill.npc_goal,
    secret: fill.npc_secret,
    knows: fill.npc_knowledge,
    capabilities,
  };
  // An errand for the NPC means a trip out and back before the story moves on.
  const errand = factPoi(demand.fact);
  const at = route.indexOf(npc.poi);
  const fullRoute = errand && at >= 0 && !route.includes(errand) ? [...route.slice(0, at + 1), errand, npc.poi, ...route.slice(at + 1)] : route;
  return {
    frameId: frame.id,
    title: fill.title,
    premise: fill.premise,
    islandName: fill.island_name,
    villain: { name: fill.villain_name, description: fill.villain_description },
    relicName: fill.relic_name,
    poiNames: { lair: fill.lair_name, hut: `${fill.npc_name}'s hut`, landing: "The Landing", ...poiNames },
    npcs: [npc],
    demand,
    route: fullRoute,
    doomRounds: frame.doomRounds,
    ...plan,
  };
}

/**
 * Why a fact can never become true on this island, or null if it can.
 * A fact is earned by meeting an NPC, finding or clearing a place, searching
 * a cache, praying at a shrine, or performing a rite whose own requirements
 * can be met.
 */
function unreachable(fact: string, bible: StoryBible, map: WorldMap, depth = 0): string | null {
  const [kind, ref] = fact.split(":");
  const poi = poiById(map, ref);
  if (kind === "met") return bible.npcs.some((n) => n.id === ref) ? null : `no npc ${ref}`;
  if (kind === "revealed") return poi ? null : `no place ${ref}`;
  if (kind === "defeated") return poi && (bible.encounters[ref] ?? poi.enemies).length > 0 ? null : `nothing to defeat at ${ref}`;
  if (kind === "searched") return poi?.kind === "cache" ? null : `no cache ${ref}`;
  if (kind === "prayed") return poi?.kind === "shrine" ? null : `no shrine ${ref}`;
  const rite = bible.rites.find((r) => r.sets === fact);
  if (!rite) return `nothing sets ${fact}`;
  if (!poiById(map, rite.poi)) return `rite ${rite.id} is at missing place ${rite.poi}`;
  if (depth > 4) return `rite ${rite.id} depends on itself`;
  for (const need of rite.requires) {
    const why = unreachable(need, bible, map, depth + 1);
    if (why) return why;
  }
  return null;
}

/**
 * Check a bible against the map it will be played on. Returns a list of
 * problems; empty means the story can be completed.
 */
export function validateBible(bible: StoryBible, map: WorldMap): string[] {
  const problems: string[] = [];
  for (const npc of bible.npcs) {
    if (!poiById(map, npc.poi)) problems.push(`npc ${npc.id} stands at missing poi ${npc.poi}`);
    for (const cap of npc.capabilities) {
      if (cap.verb === "reveal_location" && !poiById(map, cap.poi)) problems.push(`capability ${cap.id} reveals missing poi ${cap.poi}`);
    }
  }
  if (!bible.objectives.some((o) => o.id === bible.finalObjective)) problems.push("final objective missing");
  for (const o of bible.objectives) {
    const why = unreachable(o.fact, bible, map);
    if (why) problems.push(`objective ${o.id}: ${why}`);
  }
  if (bible.demand.fact) {
    const why = unreachable(bible.demand.fact, bible, map);
    if (why) problems.push(`demand ${bible.demand.id} cannot be met on this island: ${why}`);
  }
  for (const [poiId, enemies] of Object.entries(bible.encounters)) {
    if (!poiById(map, poiId)) problems.push(`encounter at missing poi ${poiId}`);
    if (enemies.some((k) => !ENEMIES[k])) problems.push(`encounter at ${poiId} names an unknown enemy`);
  }
  for (const t of bible.triggers) if (!poiById(map, t.reveal)) problems.push(`trigger reveals missing poi ${t.reveal}`);
  for (const id of bible.route) if (!poiById(map, id)) problems.push(`route passes missing poi ${id}`);
  if (bible.doomRounds < 6) problems.push("doom clock too short");
  return problems;
}

// ---------- canned fills (used when the model is unavailable or invalid) ----------

export const CANNED_FILLS: Record<string, StoryFill[]> = {
  stolen_relic: [
    {
      title: "The Lantern of Low Tide",
      premise:
        "The Tidewatch Lantern kept the harbour fog off Saltmere for a hundred years. Three nights ago it went dark, " +
        "and the fishing boats have not dared leave the cove since. Someone carried it inland.",
      island_name: "Saltmere",
      villain_name: "Maud the Wrecker",
      villain_description: "A shipbreaker who lures vessels onto the rocks and now holds the lantern to ransom the whole island.",
      relic_name: "the Tidewatch Lantern",
      lair_name: "the Wrecker's Hollow",
      npc_name: "Old Brannoch",
      npc_role: "retired lighthouse keeper",
      npc_persona: "Weathered, proud and suspicious of outsiders, but soft on anyone who shows respect for the sea.",
      npc_voice: "Short gruff sentences, sailing metaphors, calls everyone 'lubber' until they earn better.",
      npc_goal: "Wants the lantern relit, not sold. Will only help people who promise to bring it back to the island.",
      npc_secret: "He let Maud into the lighthouse himself, years ago, and is ashamed of it.",
      npc_knowledge: [
        "Maud's crew carried something heavy inland three nights ago.",
        "The Hollow is a sea cave in the far hills, reachable on foot at low tide.",
        "Maud's cultists fear fire.",
      ],
      charm_name: "Keeper's Brass Whistle",
    },
    {
      title: "Roots of the Greenheart",
      premise:
        "The Greenheart Seed made the orchards of Verdance fruit in every season. Since it was cut from the old tree, " +
        "the leaves have been falling in midsummer, and the islanders are counting their stores.",
      island_name: "Verdance",
      villain_name: "The Hollow Abbot",
      villain_description: "A masked preacher who believes the island must wither to be reborn, and took the seed to make it so.",
      relic_name: "the Greenheart Seed",
      lair_name: "the Ashen Chapel",
      npc_name: "Sister Imre",
      npc_role: "orchard-keeper and former acolyte",
      npc_persona: "Gentle, tired and precise. She tests people with small questions before trusting them.",
      npc_voice: "Calm and measured, speaks in images of trees and seasons, never raises her voice.",
      npc_goal: "Wants the seed replanted and nobody killed who does not have to be. Helps those who show mercy.",
      npc_secret: "She once followed the Abbot and still knows the chapel's prayers by heart.",
      npc_knowledge: [
        "The Abbot's followers walk the hill paths at dusk.",
        "The Ashen Chapel stands in the burnt hills on the far side of the island.",
        "The Abbot is weaker when his followers are not near him.",
      ],
      charm_name: "Sprig of the First Tree",
    },
  ],
  rescue: [
    {
      title: "The Bonesetter of Harl",
      premise:
        "Wenna has set every broken limb on Harl for thirty years. Two nights ago a gang came up from the cove and took her, " +
        "and the island has a fisherman with a crushed hand and nobody to mend it. Her brother saw which way they went.",
      island_name: "Harl",
      villain_name: "Captain Dask",
      villain_description: "A press-gang captain who takes skilled people and sells their work to the highest bidder.",
      relic_name: "Wenna the bonesetter",
      lair_name: "the Tar Shed",
      npc_name: "Corwin",
      npc_role: "net-mender, Wenna's brother",
      npc_persona: "Frightened and angry in equal parts, quick to blame himself, steadied by anyone who speaks plainly.",
      npc_voice: "Halting, repeats himself when upset, plain fisherman's words.",
      npc_goal: "Wants to be sure the people he sends after his sister will not get her killed.",
      npc_secret: "He hid in the loft while they took her and has told everyone he was out with the boats.",
      npc_knowledge: ["Dask's gang numbers only a handful.", "They mean to sail on the next spring tide.", "Wenna will be kept unharmed; her hands are what they want."],
      charm_name: "Wenna's Bone Needle",
    },
    {
      title: "Little Marrec",
      premise:
        "Marrec is nine and can smell a storm a day before it breaks; the boats of Tolvane go out on his say. He was taken from " +
        "the quay by a man who called it a debt. Without him the fleet is guessing, and the season is nearly over.",
      island_name: "Tolvane",
      villain_name: "Osk the Reckoner",
      villain_description: "A debt collector who has decided the boy is worth more than the money he was owed.",
      relic_name: "Marrec the weather-boy",
      lair_name: "the Counting House",
      npc_name: "Gran Ebbet",
      npc_role: "Marrec's grandmother, a sailmaker",
      npc_persona: "Tiny, fierce, and far too proud to plead. Warms to people who do a job without being asked twice.",
      npc_voice: "Clipped and dry, calls everyone 'you there', never wastes a word.",
      npc_goal: "Wants proof the heroes are doers and not talkers before she trusts them with the boy's life.",
      npc_secret: "The debt was hers. She borrowed against the boy's gift to keep the sail loft.",
      npc_knowledge: ["Osk keeps hired muscle but pays them late.", "The boy will not be harmed while he is useful.", "Osk has a boat coming for him within the fortnight."],
      charm_name: "Sailmaker's Palm",
    },
  ],
  beast_hunt: [
    {
      title: "The Grey Widow",
      premise:
        "Something has been taking the flocks of Penmoor: first lambs, then ewes, now a ram dragged clean over a wall. " +
        "The shepherds call it the Grey Widow and will not graze the high ground. Nobody has found where it lies up.",
      island_name: "Penmoor",
      villain_name: "the Grey Widow",
      villain_description: "An enormous old she-wolf with one white eye, leading what is left of her pack.",
      relic_name: "the flocks",
      lair_name: "the Bone Hollow",
      npc_name: "Jory Fenn",
      npc_role: "tracker and former poacher",
      npc_persona: "Patient, unhurried and a little amused by people in a rush. Respects the wolf more than most of his neighbours.",
      npc_voice: "Slow and quiet, speaks of the wolf as 'she', trails off to listen mid-sentence.",
      npc_goal: "Wants to know the hunters will finish it cleanly and not leave a wounded animal on the island.",
      npc_secret: "He fed her as a cub one hard winter and half believes this is his fault.",
      npc_knowledge: ["She hunts at dusk and lies up by day.", "There are fresh tracks near the shore and an old kill inland.", "She will not run from a fight once cornered."],
      charm_name: "Poacher's Wolf Tooth",
    },
    {
      title: "Open Gates at Ardley",
      premise:
        "Every morning another gate on Ardley stands open and the hounds are gone from behind it. The islanders hunt by hound; " +
        "without the dogs there is no winter meat. Whatever is doing it has learned to lift a latch.",
      island_name: "Ardley",
      villain_name: "Old Latchlifter",
      villain_description: "A scarred pack leader, clever beyond any wolf the island has known, that opens gates with its teeth.",
      relic_name: "the island's hounds",
      lair_name: "the Thornbrake",
      npc_name: "Hesper Vane",
      npc_role: "kennel-keeper",
      npc_persona: "Brisk and grieving, hides it behind lists and instructions. Softens for anyone kind to animals.",
      npc_voice: "Fast and practical, counts things off on her fingers, never says the names of the dogs she has lost.",
      npc_goal: "Wants hunters who will bring the hounds back alive if any still are.",
      npc_secret: "She left the first gate unlatched herself, the night it started.",
      npc_knowledge: ["The pack takes hounds alive more often than not.", "There are signs near the shore and a kill site inland.", "The leader is always last to leave and first to turn."],
      charm_name: "Kennel-keeper's Whistle",
    },
  ],
  broken_relic: [
    {
      title: "The Three-Part Bell",
      premise:
        "The Fog Bell of Kessary rang the boats home for two hundred years, until raiders dropped it from the tower and it split in three. " +
        "They kept one piece for its bronze. One was lost on the road inland. The third rolled into the old vault, and the vault kept it.",
      island_name: "Kessary",
      villain_name: "the Warden of Stillness",
      villain_description: "A stone sentinel set over the vault long ago, which lets nothing that enters leave again.",
      relic_name: "the Fog Bell",
      lair_name: "the Quiet Vault",
      npc_name: "Tamsin Rook",
      npc_role: "half-deaf bell-ringer",
      npc_persona: "Loud, cheerful and stubborn, treats the bell as a difficult old friend. Tests people by seeing if they listen.",
      npc_voice: "Shouts without meaning to, asks you to repeat things, laughs at her own jokes.",
      npc_goal: "Wants the bell recast and rung, not melted for coin, and needs to believe the heroes want that too.",
      npc_secret: "She was asleep in the tower when the raiders came and never rang the alarm.",
      npc_knowledge: ["The raiders want the bronze, not the bell.", "The Warden does not hate anyone; it only keeps what comes in.", "The shrine's old forge-stone can make broken bronze whole."],
      charm_name: "Bell-ringer's Ear Trumpet",
    },
    {
      title: "Wheel of the Selwick",
      premise:
        "The Selwick's wheel hung in the harbour chapel and every skipper touched it before sailing. A storm brought the roof down and broke it " +
        "in three. Raiders carried off one piece, one washed inland with the flood, and the last lies under a guardian nobody set there on purpose.",
      island_name: "Morran",
      villain_name: "the Empty Coat",
      villain_description: "A suit of old sea-armor with nobody inside, which stands over whatever is brought into its vault.",
      relic_name: "the Selwick's Wheel",
      lair_name: "the Drowned Vault",
      npc_name: "Ansel Pike",
      npc_role: "retired harbourmaster",
      npc_persona: "Courteous, exact and lonely. Lights up when anyone asks about the old ships.",
      npc_voice: "Formal and old-fashioned, gives bearings instead of directions, apologises for talking too long.",
      npc_goal: "Wants the wheel hung again where skippers can touch it, and wants to be asked to help.",
      npc_secret: "He was the Selwick's last mate, and was ashore drunk the night she was lost.",
      npc_knowledge: ["The raiders camp in the wilds and think the wheel is worth selling.", "The Empty Coat only strikes those who try to carry something out.", "The old shrine is where broken things on Morran are made whole."],
      charm_name: "Harbourmaster's Brass Rule",
    },
  ],
};

export function cannedFill(frame: StoryFrame, rng: Rng): StoryFill {
  return rng.pick(CANNED_FILLS[frame.id]);
}
