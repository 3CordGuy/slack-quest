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
  /** The path this story takes. Missing on stories saved before paths varied, which all took their frame's first. */
  spine?: Spine;
}

/** The parts of a bible that depend on which kind of story it is. */
type FramePlan = Pick<StoryBible, "objectives" | "finalObjective" | "rites" | "triggers" | "encounters" | "route" | "victoryLine" | "defeatLine"> & {
  capabilities: Capability[];
  poiNames?: Record<string, string>;
};

/** Where the islander who can help is found. */
export type NpcPlace = "hut" | "shrine" | "landing";
/** How the party learns where the lair is: the islander tells them, or they follow a trail themselves. */
export type Lead = "told" | "trail";
/** What finishes the story: the fight at the lair, or carrying what was won to someone or somewhere. */
export type Ending = "fight" | "homecoming" | "shrine" | "ship";

/**
 * The path a story takes through its island. A frame says which paths suit
 * it; each voyage picks one, so two stories of the same kind can still be
 * found, followed and finished differently.
 */
export interface Spine {
  npcAt: NpcPlace;
  lead: Lead;
  ending: Ending;
}

export interface StoryFrame {
  id: string;
  /** Tells the model what kind of story to write. Where the islander is, and how it ends, are added from the spine. */
  brief: string;
  /** What three of the fill's fields mean in this kind of story. */
  fields: { relic: string; villain: string; lair: string };
  /** Kinds of thing taken and of culprit that suit this story, replacing the general lists. */
  hints?: { relic?: string[]; villain?: string[] };
  /** Shortest the doom clock may be; the run lengthens it to fit the island. */
  doomRounds: number;
  demands: Demand[];
  /** The paths this kind of story may take. The first of each is the one used when none is picked. */
  spines: { npcAt: NpcPlace[]; lead: Lead[]; ending: Ending[] };
  /** For a trail: the cache that reveals the lair, its name on the map, and what the islander says it is. */
  trail?: { poi: "cache1" | "cache2"; name: string; text: string };
  /** Where the brief says the one who can help is found, when it is not one of the island places (a cave mouth). */
  npcPlace?: string;
  /** How the brief describes each ending, completing "The story ends when …". */
  endings?: Partial<Record<Ending, string>>;
  /** How the brief describes what the islander knows, when it is not the way to a lair. */
  leads?: Partial<Record<Lead, string>>;
  plan(fill: StoryFill, rng: Rng, spine: Spine): FramePlan;
}

const DEMANDS = {
  clear_camp: { id: "clear_camp", text: "clear out the camp in the wilds", fact: "defeated:camp" },
  earn_trust: { id: "earn_trust", text: "convince them you can be trusted", fact: null },
  fetch: { id: "fetch", text: "bring back what they left at the cache near the shore", fact: "searched:cache1" },
  pray: { id: "pray", text: "pay your respects at the old shrine", fact: "prayed:shrine" },
} satisfies Record<string, Demand>;

const CAMP_ENCOUNTERS = [["bandit", "wolf"], ["bandit", "bandit"], ["archer", "bandit"], ["brute"], ["wolf", "wolf", "wolf"], ["cultist", "archer"], ["bear"]];
/**
 * A beast hunt whose beast is a bear (its description says so), so the den
 * holds a Great Bear and not a pack leader. Singular only: one beast is "a
 * bear", while "bears" is as often the verb ("bears a grudge").
 */
export const isBearHunt = (fill: Pick<StoryFill, "villain_description">) => /\bbear\b/i.test(fill.villain_description);
const charm = (fill: StoryFill, gate: Gate): Capability => ({ id: "give_charm", verb: "give_item", item: "charm", itemName: fill.charm_name, gate });
const revealLair = (fill: StoryFill): Capability => ({ id: "reveal_lair", verb: "reveal_location", poi: "lair", poiName: fill.lair_name, gate: "demand" });
const callGuard: Capability = { id: "call_guard", verb: "start_combat", enemies: ["bandit"], gate: "provoked" };

const NPC_PLACE_TEXT: Record<NpcPlace, { find: string; brief: string }> = {
  hut: { find: "at the hut near the shore", brief: "lives in a hut near the shore" },
  shrine: { find: "at the old shrine", brief: "keeps the old shrine inland and is found there" },
  landing: { find: "waiting at the landing", brief: "is waiting at the landing when the heroes' ship comes in" },
};
const meet = (fill: StoryFill, spine: Spine): Objective => ({ id: "meet", text: `Find ${fill.npc_name} ${NPC_PLACE_TEXT[spine.npcAt].find}`, fact: "met:npc1" });

/** Where an ending is performed, or null when the fight itself ends the story. */
export function endingPoi(spine: Spine): string | null {
  return spine.ending === "fight" ? null : spine.ending === "homecoming" ? spine.npcAt : spine.ending === "shrine" ? "shrine" : "landing";
}

/**
 * Objectives, rites, triggers and capabilities for a story that ends at a
 * lair: find the islander, learn the way (told or trailed), win the fight,
 * then perhaps carry what was won somewhere.
 */
function lairPlan(
  fill: StoryFill,
  spine: Spine,
  frame: Pick<StoryFrame, "trail">,
  text: { locate: string; defeat: string; deliver: (poi: string) => { objective: string; label: string; done: string } },
): Pick<FramePlan, "objectives" | "finalObjective" | "rites" | "triggers" | "route" | "capabilities" | "poiNames"> {
  const trail = spine.lead === "trail" ? frame.trail : undefined;
  const at = endingPoi(spine);
  const deliver = at ? text.deliver(at) : null;
  return {
    capabilities: trail ? [charm(fill, "demand"), callGuard] : [revealLair(fill), charm(fill, "persuade"), callGuard],
    objectives: [
      meet(fill, spine),
      trail
        ? { id: "trail", text: `Follow the trail: search ${trail.name.charAt(0).toLowerCase()}${trail.name.slice(1)}`, fact: `searched:${trail.poi}` }
        : { id: "locate", text: text.locate, fact: "revealed:lair" },
      { id: "defeat", text: text.defeat, fact: "defeated:lair" },
      ...(deliver && at ? [{ id: "return", text: deliver.objective, fact: `returned:${at}` }] : []),
    ],
    finalObjective: deliver ? "return" : "defeat",
    rites: deliver && at ? [{ id: "return", poi: at, requires: ["defeated:lair"], sets: `returned:${at}`, label: deliver.label, text: deliver.done }] : [],
    triggers: trail ? [{ requires: [`searched:${trail.poi}`], reveal: "lair" }] : [],
    route: ["landing", spine.npcAt, ...(trail ? [trail.poi] : []), "lair", ...(at ? [at] : [])],
    poiNames: trail ? { [trail.poi]: trail.name } : undefined,
  };
}

export const STORY_FRAMES: StoryFrame[] = [
  {
    // Find who knows, learn where, take it back by force.
    id: "stolen_relic",
    brief:
      "A villain has stolen something the island's people depend on and gone to ground in a hidden lair. " +
      "One islander can help, and owns a protective charm.",
    fields: {
      relic: "the stolen thing, starting with \"the\"",
      villain: "the thief",
      lair: "where the thief hides, starting with \"the\"",
    },
    doomRounds: 16,
    demands: [DEMANDS.clear_camp, DEMANDS.earn_trust, DEMANDS.fetch, DEMANDS.pray],
    spines: { npcAt: ["hut", "shrine", "landing"], lead: ["told", "trail"], ending: ["fight", "homecoming", "shrine", "ship"] },
    trail: { poi: "cache2", name: "Where the thieves rested", text: "the thieves stopped to rest somewhere inland and left signs of where they were going" },
    endings: {
      homecoming: "the stolen thing is carried back to that islander",
      shrine: "the stolen thing is set back in its place at the island's old shrine",
      ship: "the stolen thing is carried aboard the heroes' ship, out of the thief's reach",
    },
    plan: (fill, rng, spine) => ({
      ...lairPlan(fill, spine, frameById("stolen_relic")!, {
        locate: `Learn where ${fill.lair_name} is hidden`,
        defeat: `Defeat ${fill.villain_name} and recover ${fill.relic_name}`,
        deliver: (poi) =>
          poi === "shrine"
            ? { objective: `Set ${fill.relic_name} back in its place at the shrine`, label: `Set ${fill.relic_name} in its place`, done: `${fill.relic_name} is back where it belongs.` }
            : poi === "landing"
              ? { objective: `Get ${fill.relic_name} aboard the ship`, label: `Load ${fill.relic_name} aboard`, done: `${fill.relic_name} is stowed aboard and safe.` }
              : { objective: `Return ${fill.relic_name} to ${fill.npc_name}`, label: `Return ${fill.relic_name}`, done: `${fill.relic_name} is back in ${fill.npc_name}'s hands.` },
      }),
      encounters: { lair: ["villain", rng.pick(["cultist", "brute", "archer"])], camp: rng.pick(CAMP_ENCOUNTERS) },
      victoryLine: `${fill.villain_name} is beaten and ${fill.relic_name} is on its way home.`,
      defeatLine: `${fill.villain_name} slipped away with ${fill.relic_name}.`,
    }),
  },
  {
    // The fight is in the middle; the story ends by walking someone to safety.
    id: "rescue",
    brief:
      "Someone the island cannot do without has been carried off by a gang and is held at a hidden hideout. " +
      "Their kin can help, and owns a protective charm.",
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
    spines: { npcAt: ["hut", "landing"], lead: ["told", "trail"], ending: ["homecoming", "ship"] },
    trail: { poi: "cache2", name: "Where the struggle was", text: "there was a struggle somewhere inland, and the gang left a trail from it" },
    endings: {
      homecoming: "the captive is brought home to that islander",
      ship: "the captive is taken aboard the heroes' ship, where the gang cannot follow",
    },
    plan: (fill, rng, spine) => ({
      ...lairPlan(fill, spine, frameById("rescue")!, {
        locate: `Learn where ${fill.lair_name} is hidden`,
        defeat: `Free ${fill.relic_name} from ${fill.villain_name}'s gang`,
        deliver: (poi) =>
          poi === "landing" && spine.ending === "ship"
            ? { objective: `Get ${fill.relic_name} aboard the ship`, label: `Help ${fill.relic_name} aboard`, done: `${fill.relic_name} is aboard and safe.` }
            : { objective: `Bring ${fill.relic_name} home to ${fill.npc_name}`, label: `Bring ${fill.relic_name} home`, done: `${fill.relic_name} is home.` },
      }),
      encounters: { lair: ["villain", rng.pick(["bandit", "archer", "brute"])], camp: rng.pick(CAMP_ENCOUNTERS) },
      victoryLine: `${fill.relic_name} is safe, and ${fill.villain_name}'s gang is scattered.`,
      defeatLine: `${fill.villain_name}'s gang sailed with ${fill.relic_name} aboard.`,
    }),
  },
  {
    // No one to ask the way: the party tracks the beast by searching two places.
    id: "beast_hunt",
    brief:
      "A great beast has been preying on the island and nobody knows where it dens. A tracker has been following " +
      "its signs, which lie at two spots on the island, and owns a protective charm. There is no human villain: the beast is the threat.",
    fields: {
      relic: "what the beast has been taking or ruining, starting with \"the\" (the flocks, the night catch)",
      villain: "what islanders call the beast, e.g. \"the Grey Widow\"; its description says plainly what kind of animal it is (a wolf or a bear)",
      lair: "the beast's den, starting with \"the\"",
    },
    hints: {
      relic: ["the flocks", "the night catch", "the hives", "the orchard pickers' nerve", "the island's hounds", "the winter stores"],
      villain: [
        "an enormous old wolf with one white eye",
        "a wolf-mother leading a starving pack",
        "a hound gone feral and grown huge",
        "a pale wolf the islanders think is a ghost",
        "a scarred pack leader that has learned to open gates",
        "a great cave bear woken too early from its winter sleep",
        "an old one-eared bear that tears open storehouse doors",
        "a she-bear grown bold and enormous on stolen stores",
      ],
    },
    doomRounds: 18,
    demands: [DEMANDS.clear_camp, DEMANDS.earn_trust, DEMANDS.pray],
    // The signs are the lead, so a hunt is always tracked; the tracker may be anywhere.
    spines: { npcAt: ["hut", "landing", "shrine"], lead: ["trail"], ending: ["fight", "homecoming"] },
    endings: { homecoming: "proof of the kill is brought back to the tracker" },
    plan: (fill, _rng, spine) => {
      const home = spine.ending === "homecoming" ? spine.npcAt : null;
      return {
        // The tracker cannot point to the den; the charm is what the demand unlocks.
        capabilities: [charm(fill, "demand"), callGuard],
        objectives: [
          meet(fill, spine),
          { id: "sign1", text: "Search for the beast's tracks near the shore", fact: "searched:cache1" },
          { id: "sign2", text: "Search the kill site further inland", fact: "searched:cache2" },
          { id: "slay", text: `Hunt down ${fill.villain_name} at ${fill.lair_name}`, fact: "defeated:lair" },
          ...(home ? [{ id: "return", text: `Bring proof of the kill to ${fill.npc_name}`, fact: `returned:${home}` }] : []),
        ],
        finalObjective: home ? "return" : "slay",
        rites: home ? [{ id: "return", poi: home, requires: ["defeated:lair"], sets: `returned:${home}`, label: `Show ${fill.npc_name} the kill`, text: `${fill.npc_name} turns the trophy over in their hands and nods.` }] : [],
        triggers: [{ requires: ["searched:cache1", "searched:cache2"], reveal: "lair" }],
        // A bear dens alone and its country has bears in it; anything else is a wolf and its pack.
        encounters: isBearHunt(fill)
          ? { lair: ["great_bear"], camp: [["bear"], ["bandit", "wolf"], ["bear"]][fill.title.length % 3] }
          : { lair: ["alpha", "wolf"], camp: [["wolf", "wolf"], ["bandit", "wolf"], ["archer", "bandit"]][fill.title.length % 3] },
        route: ["landing", spine.npcAt, "cache1", "cache2", "lair", ...(home ? [home] : [])],
        poiNames: { cache1: "Tracks near the shore", cache2: "The kill site" },
        victoryLine: `${fill.villain_name} is dead, and ${fill.relic_name} can rest easy.`,
        defeatLine: `${fill.villain_name} is still out there, and the island has run out of patience for hunters.`,
      };
    },
  },
  {
    // Three things to gather in any order, and the ending is not a fight.
    id: "broken_relic",
    brief:
      "Something the island depends on was broken into three pieces and scattered: raiders took one to their camp, " +
      "one lies lost at an old cache inland, and a guardian holds the last in a hidden vault. One islander can help, " +
      "and owns a protective charm. Whole again, it must be restored at the island's old shrine. The guardian is not evil, only bound to its duty.",
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
    spines: { npcAt: ["hut", "shrine"], lead: ["told", "trail"], ending: ["shrine"] },
    trail: { poi: "cache1", name: "An old chart", text: "an old chart showing the way to the vault was hidden near the shore" },
    plan: (fill, rng, spine) => {
      const chart = spine.lead === "trail";
      return {
        capabilities: chart ? [charm(fill, "demand"), callGuard] : [revealLair(fill), charm(fill, "persuade"), callGuard],
        objectives: [
          meet(fill, spine),
          { id: "piece1", text: `Take a piece of ${fill.relic_name} back from the raiders' camp`, fact: "defeated:camp" },
          { id: "piece2", text: "Recover the piece lost at the inland cache", fact: "searched:cache2" },
          chart
            ? { id: "trail", text: `Find the old chart to ${fill.lair_name} near the shore`, fact: "searched:cache1" }
            : { id: "locate", text: `Learn the way to ${fill.lair_name}`, fact: "revealed:lair" },
          { id: "piece3", text: `Win the last piece from ${fill.villain_name} in ${fill.lair_name}`, fact: "defeated:lair" },
          { id: "restore", text: `Restore ${fill.relic_name} at the old shrine`, fact: "restored:shrine" },
        ],
        finalObjective: "restore",
        rites: [
          { id: "restore", poi: "shrine", requires: ["defeated:camp", "searched:cache2", "defeated:lair"], sets: "restored:shrine", label: `Restore ${fill.relic_name}`, text: `${fill.relic_name} is whole again.` },
        ],
        triggers: chart ? [{ requires: ["searched:cache1"], reveal: "lair" }] : [],
        encounters: { lair: ["guardian"], camp: rng.pick([["bandit", "bandit"], ["archer", "bandit"], ["brute"], ["cultist", "archer"]]) },
        route: ["landing", spine.npcAt, "camp", "cache2", ...(chart ? ["cache1"] : []), "lair", "shrine"],
        poiNames: { cache2: "The lost piece", ...(chart ? { cache1: "An old chart" } : {}) },
        victoryLine: `${fill.relic_name} is whole again and back where it belongs.`,
        defeatLine: `The pieces of ${fill.relic_name} stayed scattered, and the island went without.`,
      };
    },
  },
  {
    // A race: two halves of a chart, a rival crew to beat to the vault, and a run back to the ship.
    id: "rival_crew",
    brief:
      "A rival crew of treasure-seekers landed on the island just ahead of the heroes, after the same hoard, which lies in a " +
      "sealed vault nobody has opened in living memory. The way to the vault is on a chart torn in two: one half was hidden " +
      "near the shore, and the rivals hold the other at their camp in the wilds. Their captain means to reach the vault first. " +
      "One islander can help, and owns a protective charm.",
    fields: {
      relic: "the hoard, starting with \"the\" (what it is and whose it was, e.g. \"the Saltwife's silver\")",
      villain: "the rival crew's captain",
      lair: "the sealed vault, starting with \"the\"",
    },
    hints: {
      relic: ["a drowned king's silver", "a lighthouse keeper's hidden savings", "a cargo of spices nobody came back for", "a chest of ship's bells", "a smuggler's stash of fine glass", "the island's old tithe, never paid"],
      villain: ["a cheerful rogue who thinks this is all a game", "a captain who lost everything and needs this to pay her crew", "a cold-eyed salvager who takes what he finds", "an old rival of every captain in the Harbor", "a pair of twins who never agree on anything"],
    },
    doomRounds: 18,
    // Clearing the camp and searching the shore are already the story, so the islander asks something else.
    demands: [DEMANDS.earn_trust, DEMANDS.pray],
    spines: { npcAt: ["hut", "shrine", "landing"], lead: ["told"], ending: ["ship", "homecoming"] },
    leads: { told: "They know a way into the vault and will tell it once they trust the heroes, though the two halves of the chart show it too." },
    endings: {
      ship: "the hoard is safely aboard the heroes' ship",
      homecoming: "the islanders are given their share of the hoard",
    },
    plan: (fill, rng, spine) => {
      const at = spine.ending === "homecoming" ? spine.npcAt : "landing";
      return {
        capabilities: [revealLair(fill), charm(fill, "persuade"), callGuard],
        objectives: [
          meet(fill, spine),
          { id: "chart1", text: "Find the half of the chart hidden near the shore", fact: "searched:cache1" },
          { id: "chart2", text: `Take the other half from ${fill.villain_name}'s crew at their camp`, fact: "defeated:camp" },
          { id: "vault", text: `Beat ${fill.villain_name} to ${fill.relic_name} at ${fill.lair_name}`, fact: "defeated:lair" },
          spine.ending === "homecoming"
            ? { id: "return", text: `Give ${fill.npc_name} the island's share of ${fill.relic_name}`, fact: `returned:${at}` }
            : { id: "return", text: `Get ${fill.relic_name} aboard the ship`, fact: `returned:${at}` },
        ],
        finalObjective: "return",
        rites: [
          spine.ending === "homecoming"
            ? { id: "return", poi: at, requires: ["defeated:lair"], sets: `returned:${at}`, label: `Share out ${fill.relic_name}`, text: `${fill.npc_name} counts out the island's share, and laughs for the first time in days.` }
            : { id: "return", poi: at, requires: ["defeated:lair"], sets: `returned:${at}`, label: `Load ${fill.relic_name} aboard`, text: `${fill.relic_name} is stowed below decks.` },
        ],
        // Both halves of the chart show the way, as the islander can.
        triggers: [{ requires: ["searched:cache1", "defeated:camp"], reveal: "lair" }],
        // The captain holds the camp; the crew's best went ahead to the vault.
        encounters: { camp: ["villain", rng.pick(["bandit", "archer"])], lair: rng.pick([["brute", "bandit"], ["archer", "archer", "bandit"], ["brute", "archer"]]) },
        route: ["landing", spine.npcAt, "cache1", "camp", "lair", at],
        poiNames: { cache1: "Half a chart", camp: `${fill.villain_name}'s camp` },
        victoryLine: `${fill.villain_name} sails home empty-handed, and ${fill.relic_name} is yours.`,
        defeatLine: `${fill.villain_name}'s crew got away with ${fill.relic_name}.`,
      };
    },
  },
  {
    // No villain to fight: three stones to wake, then the curse broken where it began.
    id: "lift_curse",
    brief:
      "A curse lies on the island and has taken something its people cannot live without. It is held in place by three old " +
      "standing stones that have gone cold: one near the shore, one inland, and one in the wilds where raiders have made camp. " +
      "Each must be woken with words only one islander still knows, and then the curse broken at the place where it began. " +
      "Whoever laid the curse is long gone and cannot be fought. The islander owns a protective charm.",
    fields: {
      relic: "what the curse has taken from the island, starting with \"the\" (the island's sleep, the fish, the children's voices)",
      villain: "who laid the curse long ago; they are gone or dead and cannot be fought",
      lair: "the place where the curse began and must be broken, starting with \"the\"",
    },
    hints: {
      relic: ["the island's sleep", "the fish from the bay", "every bird's song", "the colour from the flowers", "the warmth from the hearths", "the children's laughter"],
      villain: ["a drowned witch nobody would help", "a saint whose prayer went wrong", "a jilted lighthouse keeper", "a merchant cheated by the whole island", "a sea-spirit whose shrine was neglected"],
    },
    doomRounds: 20,
    // The camp is one of the stones, so the islander does not ask for it twice.
    demands: [DEMANDS.earn_trust, DEMANDS.fetch, DEMANDS.pray],
    spines: { npcAt: ["hut", "landing"], lead: ["told"], ending: ["shrine"] },
    leads: { told: "They know the old words that wake the stones, and teach them to anyone who comes to speak with them." },
    endings: { shrine: "the curse is broken at the place where it began, the island's old shrine" },
    plan: (fill, rng, spine) => {
      const words = "met:npc1";
      return {
        capabilities: [charm(fill, "persuade"), callGuard],
        objectives: [
          { ...meet(fill, spine), text: `Learn the old words from ${fill.npc_name}` },
          { id: "stone1", text: "Wake the standing stone near the shore", fact: "woken:cache1" },
          { id: "stone2", text: "Wake the standing stone inland", fact: "woken:cache2" },
          { id: "stone3", text: "Drive the raiders off the third stone and wake it", fact: "woken:camp" },
          { id: "break", text: `Break the curse at ${fill.lair_name}`, fact: "broken:shrine" },
        ],
        finalObjective: "break",
        rites: [
          { id: "stone1", poi: "cache1", requires: [words], sets: "woken:cache1", label: "Speak the words to the stone", text: "The shore stone hums, and warms under your hand." },
          { id: "stone2", poi: "cache2", requires: [words], sets: "woken:cache2", label: "Speak the words to the stone", text: "The inland stone hums, and warms under your hand." },
          { id: "stone3", poi: "camp", requires: [words, "defeated:camp"], sets: "woken:camp", label: "Speak the words to the stone", text: "The last stone hums. All three are awake." },
          { id: "break", poi: "shrine", requires: ["woken:cache1", "woken:cache2", "woken:camp"], sets: "broken:shrine", label: "Break the curse", text: `The air cracks like ice on a pond, and ${fill.relic_name} comes back to the island.` },
        ],
        triggers: [],
        // Nobody is the boss here: the hidden place in the hills holds only the curse's last followers.
        encounters: { camp: rng.pick(CAMP_ENCOUNTERS), lair: ["cultist", rng.pick(["cultist", "archer"])] },
        route: ["landing", spine.npcAt, "cache1", "camp", "cache2", "shrine"],
        poiNames: { cache1: "The shore stone", cache2: "The inland stone", shrine: fill.lair_name, lair: "A hidden coven" },
        victoryLine: `The curse is broken, and ${fill.relic_name} is the island's again.`,
        defeatLine: `The stones went cold again, and the curse kept ${fill.relic_name}.`,
      };
    },
  },
];

/**
 * Stories for the Haunted Caverns. Shorter than an island's: the haunt is
 * bound by something lost down one passage or the other, and either will do.
 * The party picks a way at the fork (past the smugglers' camp or the drowned
 * shrine), finds what binds the haunt, faces it in the deep chamber, and lays
 * it to rest with what they found.
 */
export const CAVERN_FRAMES: StoryFrame[] = [
  {
    id: "restless_haunt",
    brief:
      "Behind the heroes' home port, an old smugglers' cave runs back into the rocks. Something down there has woken and haunts the " +
      "town at night. Past the first chamber the tunnels fork: one way runs by the smugglers' old camp, the other down to a drowned " +
      "shrine. Somewhere down one passage or the other lies what binds the haunt; with it, the haunt can be faced in the deep chamber " +
      "and laid to rest. The one who can help owns a protective charm.",
    fields: {
      relic: "what binds the haunt, starting with \"the\" (its bones, a drowned bell, a smuggler's ledger)",
      villain: "the haunt: who it was in life, e.g. \"Black Annet, the smugglers' queen\"; its description says how it haunts the town",
      lair: "the deep chamber where it is bound, starting with \"the\"",
    },
    hints: {
      relic: ["its own bones", "a drowned ship's bell", "a smuggler's ledger of debts", "a lantern that never went out", "a wedding ring", "a sealed letter never sent"],
      villain: ["a smugglers' queen betrayed by her crew", "a lamplighter who drowned in the tunnels", "a miner who dug too deep", "a child who hid from the press-gang and was never found", "a harbourmaster who sold the town out"],
    },
    npcPlace: "is an old smuggler who sits at the cave mouth and knows the stories",
    leads: { told: "They know the way to the deep chamber, and will tell it once they trust the heroes." },
    endings: { fight: "the haunt is faced in the deep chamber and laid to rest with what binds it" },
    doomRounds: 9,
    demands: [DEMANDS.earn_trust, DEMANDS.clear_camp, DEMANDS.pray],
    spines: { npcAt: ["landing"], lead: ["told"], ending: ["fight"] },
    plan: (fill, rng) => ({
      capabilities: [revealLair(fill), charm(fill, "persuade")],
      objectives: [
        { id: "meet", text: `Hear ${fill.npc_name} out at the cave mouth`, fact: "met:npc1" },
        { id: "bind", text: `Find ${fill.relic_name}, down one passage or the other`, fact: "found:binding" },
        { id: "face", text: `Face ${fill.villain_name} in ${fill.lair_name}`, fact: "defeated:lair" },
        { id: "rest", text: `Lay ${fill.villain_name} to rest with ${fill.relic_name}`, fact: "rested:lair" },
      ],
      finalObjective: "rest",
      rites: [
        // Either passage's cache holds it; whichever the party reaches first.
        { id: "find_west", poi: "cache1", requires: [], sets: "found:binding", label: `Take up ${fill.relic_name}`, text: `${fill.relic_name}, found at last in the west passage.` },
        { id: "find_east", poi: "cache2", requires: [], sets: "found:binding", label: `Take up ${fill.relic_name}`, text: `${fill.relic_name}, found at last in the east passage.` },
        { id: "rest", poi: "lair", requires: ["found:binding", "defeated:lair"], sets: "rested:lair", label: `Lay ${fill.villain_name} to rest`, text: `${fill.villain_name} goes quiet, and the caverns with it.` },
      ],
      // What binds the haunt knows the way down.
      triggers: [{ requires: ["found:binding"], reveal: "lair" }],
      encounters: {
        // The smugglers' camp is held by the smugglers, long dead.
        camp: rng.pick([["skeleton", "skeleton"], ["skeleton", "bat", "bat"], ["skeleton", "slime"]]),
        lair: ["haunt", rng.pick(["shade", "skeleton"])],
      },
      route: ["landing", "cache1", "lair"],
      poiNames: { landing: "The cave mouth", camp: "The smugglers' camp", cache1: "The west passage", cache2: "The east passage", shrine: "The drowned shrine" },
      victoryLine: `${fill.villain_name} is laid to rest, and the Harbor sleeps easy again.`,
      defeatLine: `${fill.villain_name} still walks the caverns, and the Harbor lies awake.`,
    }),
  },
];

/** The spine a frame takes when none is picked: the first of each of its options. */
export function defaultSpine(frame: StoryFrame): Spine {
  return { npcAt: frame.spines.npcAt[0], lead: frame.spines.lead[0], ending: frame.spines.ending[0] };
}

/** Pick a path through this kind of story. */
export function pickSpine(frame: StoryFrame, rng: Rng): Spine {
  return { npcAt: rng.pick(frame.spines.npcAt), lead: rng.pick(frame.spines.lead), ending: rng.pick(frame.spines.ending) };
}

/** Every path this kind of story can take, for tests and tools. */
export function allSpines(frame: StoryFrame): Spine[] {
  return frame.spines.npcAt.flatMap((npcAt) => frame.spines.lead.flatMap((lead) => frame.spines.ending.map((ending) => ({ npcAt, lead, ending }))));
}

/**
 * The asks that make sense on this path: not to pray at the shrine the
 * islander stands at, and not to search the cache the trail already leads to.
 */
export function demandsFor(frame: StoryFrame, spine: Spine): Demand[] {
  const busy = new Set<string>();
  if (spine.npcAt === "shrine") busy.add("prayed:shrine");
  if (spine.lead === "trail" && frame.trail) busy.add(`searched:${frame.trail.poi}`);
  const ok = frame.demands.filter((d) => !d.fact || !busy.has(d.fact));
  return ok.length > 0 ? ok : frame.demands;
}

/** The brief handed to the model: the frame's own, plus where the islander is, how the way is found, and how it ends. */
export function storyBrief(frame: StoryFrame, spine: Spine): string {
  const parts = [frame.brief, frame.npcPlace ? `The one who can help ${frame.npcPlace}.` : `The islander who can help ${NPC_PLACE_TEXT[spine.npcAt].brief}.`];
  const lead = frame.leads?.[spine.lead];
  if (lead) parts.push(lead);
  else if (spine.lead === "trail" && frame.trail) parts.push(`They cannot say where the lair is, but they know ${frame.trail.text}.`);
  else if (spine.lead === "told") parts.push("They know the way to the lair, and will tell it once they trust the heroes.");
  const ending = frame.endings?.[spine.ending];
  parts.push(ending ? `The story ends when ${ending}.` : spine.ending === "fight" ? "The story ends with the fight at the lair." : "");
  return parts.filter(Boolean).join(" ");
}

export function frameById(id: string): StoryFrame | undefined {
  return STORY_FRAMES.find((f) => f.id === id) ?? CAVERN_FRAMES.find((f) => f.id === id);
}

/** The kinds of story a run can tell: an island's, or the Haunted Caverns'. */
export function framesFor(kind: "voyage" | "caverns" = "voyage"): StoryFrame[] {
  return kind === "caverns" ? CAVERN_FRAMES : STORY_FRAMES;
}

/**
 * Pick the kind of story for a voyage. `recent` is the crew's last voyages'
 * frame ids, newest first: the most recent half of the frames are skipped,
 * so a crew never sails the same kind of story twice running and works
 * through the others before one comes round again.
 */
export function pickFrame(rng: Rng, recent: string[] = [], frames: StoryFrame[] = STORY_FRAMES): StoryFrame {
  const skip = new Set(recent.slice(0, Math.floor(frames.length / 2)));
  const fresh = frames.filter((f) => !skip.has(f.id));
  return rng.pick(fresh.length > 0 ? fresh : frames);
}

/** Pick what the islander asks, avoiding the ask `recent` names (the crew's last) when there is another. */
export function pickDemand(frame: StoryFrame, rng: Rng, recent?: string, spine: Spine = defaultSpine(frame)): Demand {
  const suits = demandsFor(frame, spine);
  const fresh = suits.filter((d) => d.id !== recent);
  return rng.pick(fresh.length > 0 ? fresh : suits);
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
export function buildBible(
  frame: StoryFrame,
  fill: StoryFill,
  demand: Demand = frame.demands[0],
  rng: Rng = makeRng(seedFromString(fill.title)),
  spine: Spine = defaultSpine(frame),
): StoryBible {
  const { capabilities, poiNames, route, ...plan } = frame.plan(fill, rng, spine);
  const npc: NpcSheet = {
    id: "npc1",
    poi: spine.npcAt,
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
    // The hut is only someone's when the islander lives there.
    poiNames: { lair: fill.lair_name, ...(spine.npcAt === "hut" ? { hut: `${fill.npc_name}'s hut` } : {}), landing: "The Landing", ...poiNames },
    npcs: [npc],
    demand,
    spine,
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
    {
      title: "The Sleepless Sow",
      premise:
        "The winter stores of Hollin have been broken open three nights running, the doors torn off their pins and the barrels rolled away. " +
        "Something that should be asleep in a cave until spring is awake, hungry and huge, and nobody has found where it lies up.",
      island_name: "Hollin",
      villain_name: "the Sleepless Sow",
      villain_description: "A great cave bear woken too early from her winter sleep, grown bold on the island's stores.",
      relic_name: "the winter stores",
      lair_name: "the Sow's Barrow",
      npc_name: "Wenna Crale",
      npc_role: "beekeeper and trapper",
      npc_persona: "Calm, weathered and wry, more worried for the bear than afraid of it. Hates waste.",
      npc_voice: "Low and even, speaks in short sentences, hums when she is thinking.",
      npc_goal: "Wants hunters steady enough to finish the bear before the island starves or someone gets killed trying.",
      npc_secret: "Her smoke drove the bear out of its cave in the first place, when she went after a wild hive.",
      npc_knowledge: ["The bear raids by night and sleeps off the day.", "There are tracks near the shore and a torn-open store inland.", "Her roar can freeze a grown man where he stands."],
      charm_name: "Trapper's Bear Claw",
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
  rival_crew: [
    {
      title: "The Saltwife's Silver",
      premise:
        "Everyone on Quell knows the story of the Saltwife, who sank her husband's silver in a vault under the hills rather than let him drink it. " +
        "Nobody believed it until this morning, when a strange ship dropped anchor in the next cove and its crew went inland with spades.",
      island_name: "Quell",
      villain_name: "Captain Rusk",
      villain_description: "A grinning salvager who has never once been beaten to a prize, and talks about it constantly.",
      relic_name: "the Saltwife's silver",
      lair_name: "the Sunken Strongroom",
      npc_name: "Dilly Marr",
      npc_role: "net-weaver and the Saltwife's great-granddaughter",
      npc_persona: "Sharp, practical and suspicious of anyone who mentions the silver too quickly. Respects people who ask about her family first.",
      npc_voice: "Quick and teasing, answers questions with questions, calls the silver 'Gran's sulk'.",
      npc_goal: "Wants the island to see some of that silver for once, and Rusk to sail home with nothing.",
      npc_secret: "She sold Rusk half the chart herself, before she understood what it was.",
      npc_knowledge: ["Rusk's crew are camped in the wilds and squabbling over the chart.", "The other half of the chart was hidden near the shore, under the old net store.", "The strongroom's door only opens to someone holding the whole chart."],
      charm_name: "Gran's Silver Thimble",
    },
    {
      title: "Bells Under Brackwater",
      premise:
        "A hundred years ago a ship carrying new bells for the mainland churches wrecked off Brackwater, and the islanders hid the bells in the hills to sell later. " +
        "They never did. Now a rival crew has come with half a chart, and they have a head start.",
      island_name: "Brackwater",
      villain_name: "Mother Teague",
      villain_description: "A hard old captain who lost her last ship and means to pay her crew with these bells or not go home.",
      relic_name: "the wreck bells",
      lair_name: "the Bell Cellar",
      npc_name: "Owain Pellow",
      npc_role: "retired bell-ringer",
      npc_persona: "Gentle, deaf in one ear and full of stories. Grows serious and careful once he thinks someone means business.",
      npc_voice: "Slow and musical, hums between sentences, calls the bells by their names.",
      npc_goal: "Wants the bells rung again, here, before he dies; not sold off to strangers.",
      npc_secret: "His grandfather was one of the men who hid the bells, and he has always known roughly where.",
      npc_knowledge: ["Teague's crew camp in the wilds and keep their half of the chart close.", "The other half was left near the shore by his grandfather.", "The cellar was built to be found only by someone with both halves."],
      charm_name: "Bell-rope Bracelet",
    },
  ],
  lift_curse: [
    {
      title: "The Sleepless Isle",
      premise:
        "Nobody on Lunna has slept in nine nights. The old standing stones that ring the island went cold the night it started, and the islanders say the curse " +
        "the Lantern Witch laid on them, a hundred years ago, has finally woken.",
      island_name: "Lunna",
      villain_name: "the Lantern Witch",
      villain_description: "A woman the islanders refused shelter in a storm, a hundred years ago, who cursed them as she drowned.",
      relic_name: "the island's sleep",
      lair_name: "the Witch's Step",
      npc_name: "Nan Corrow",
      npc_role: "the last person who knows the stone-words",
      npc_persona: "Tiny, ancient and wide awake; finds the whole thing grimly funny. Trusts people who are polite to her cat.",
      npc_voice: "Dry and sing-song, drops into old words without explaining them, calls everyone 'duck'.",
      npc_goal: "Wants the curse broken properly, with the words said right, before she forgets them.",
      npc_secret: "Her own grandmother was one of the people who turned the witch away.",
      npc_knowledge: ["The stones must be woken in no particular order, but all three before the curse can break.", "Raiders have camped around the third stone in the wilds.", "The Witch's Step is the old shrine, where she was turned away."],
      charm_name: "Nan's Thread of Rowan",
    },
    {
      title: "No Fish at Harrowmouth",
      premise:
        "The nets of Harrowmouth have come up empty since midsummer, every one, every day. The three stones on the island have gone cold, " +
        "and the old people say the drowned saint's curse is back.",
      island_name: "Harrowmouth",
      villain_name: "Saint Ebba",
      villain_description: "A saint who prayed the island would never go hungry, and was drowned by the people she prayed for.",
      relic_name: "the fish",
      lair_name: "Ebba's Rock",
      npc_name: "Pascoe Bligh",
      npc_role: "lay preacher and failed fisherman",
      npc_persona: "Nervous, kind and full of apologies, but steady as a rock when it comes to the old words.",
      npc_voice: "Halting, quotes scripture nobody else has heard of, counts on his fingers when anxious.",
      npc_goal: "Wants the island to remember Ebba kindly once the curse is lifted.",
      npc_secret: "He has been praying for the curse to come back for years, so the island would remember her.",
      npc_knowledge: ["Each of the three stones answers to the same words.", "Raiders squat by the third stone in the wilds.", "Ebba's Rock is the old shrine, where she was drowned."],
      charm_name: "Ebba's Fishbone Cross",
    },
  ],
  restless_haunt: [
    {
      title: "The Queen Under the Rock",
      premise:
        "Every night this week the Harbor's lamps have gone out at the same hour, and something has been heard singing in the rocks behind the town. " +
        "The old folk say Black Annet is awake again: the smugglers' queen whose crew sealed her in the caves rather than share her silver.",
      island_name: "the Smugglers' Caves",
      villain_name: "Black Annet",
      villain_description: "A smugglers' queen betrayed and walled in by her own crew, who now puts out every lamp in the Harbor looking for them.",
      relic_name: "Annet's own bones",
      lair_name: "the Sealed Vault",
      npc_name: "Old Teague",
      npc_role: "retired smuggler",
      npc_persona: "Wheezing, sly and secretly terrified. Tells the truth only to people who buy him a drink first, in spirit if not in fact.",
      npc_voice: "Low and conspiratorial, calls everyone 'matey', taps his nose when he lies.",
      npc_goal: "Wants Annet laid to rest before she finds out who helped wall her in.",
      npc_secret: "He was the youngest of the crew that sealed her in.",
      npc_knowledge: ["The tunnels fork past the first chamber; both ways lead down eventually.", "Her bones were never buried, only left where she fell.", "She hates the light, and worse, she hates traitors."],
      charm_name: "Teague's Lucky Doubloon",
    },
    {
      title: "The Lamplighter's Last Round",
      premise:
        "Wick Harrow lit the Harbor's lamps for forty years until the night he went into the caves after a lost child and never came out. " +
        "Now his lantern is seen moving in the rocks at night, and the lamps he lit will not stay lit.",
      island_name: "the Lamplighter's Caves",
      villain_name: "Wick Harrow",
      villain_description: "A drowned lamplighter still making his last round through the caves, dragging the living along to light his way.",
      relic_name: "the lantern that never went out",
      lair_name: "the Flooded Gallery",
      npc_name: "Moll Ashby",
      npc_role: "the child Wick went looking for, now grown and grey",
      npc_persona: "Quiet, guilty and stubborn. Brings a fresh candle to the cave mouth every evening.",
      npc_voice: "Soft and careful, never says his name aloud, calls him 'the old man'.",
      npc_goal: "Wants the old man to finish his round and rest, and to say sorry to him somehow.",
      npc_secret: "She wasn't lost that night; she was hiding from him because she had broken his lamp.",
      npc_knowledge: ["Past the first chamber the tunnels split, but both come together again further down.", "His lantern is still down there somewhere.", "He can't abide being in the dark himself."],
      charm_name: "Moll's Evening Candle",
    },
  ],
};

export function cannedFill(frame: StoryFrame, rng: Rng): StoryFill {
  return rng.pick(CANNED_FILLS[frame.id]);
}
