// Story generation: structure from code, flavour from the model.
//
// A frame fixes what the story *is*: its objectives, which NPC can do what,
// and where things are. The model only fills in names, motives and voice
// (a StoryFill). buildBible joins the two, and validateBible proves the
// result is completable before a run is allowed to start on it.

import type { WorldMap } from "./map";
import { poiById } from "./map";
import type { Rng } from "./rng";

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

/**
 * When a capability may fire. `free`: whenever the NPC chooses. `persuade`:
 * only after a hero passes a persuasion check. `provoked`: only once the NPC
 * already disliked the party before this exchange, so it takes two bad
 * exchanges, not one odd remark, to start a fight. `demand`: only once the
 * story's Demand has been met.
 */
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
  /** What the NPC asks before revealing the lair. */
  demand: Demand;
  /** Completing this objective wins the run. */
  finalObjective: string;
  /** Rounds before the villain gets away. */
  doomRounds: number;
}

export interface StoryFrame {
  id: string;
  /** One line telling the model what kind of story to write. */
  brief: string;
  /** Shortest the doom clock may be; the run lengthens it to fit the island. */
  doomRounds: number;
  demands: Demand[];
}

export const STORY_FRAMES: StoryFrame[] = [
  {
    id: "stolen_relic",
    brief:
      "A villain has stolen a relic the island's people depend on and gone to ground in a hidden lair. " +
      "One islander living in a hut near the shore knows where the lair is and owns a protective charm.",
    doomRounds: 16,
    demands: [
      { id: "clear_camp", text: "drive the brigands out of their camp", fact: "defeated:camp" },
      { id: "earn_trust", text: "convince them you can be trusted", fact: null },
    ],
  },
];

export function pickFrame(rng: Rng): StoryFrame {
  return rng.pick(STORY_FRAMES);
}

export function pickDemand(frame: StoryFrame, rng: Rng): Demand {
  return rng.pick(frame.demands);
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

export function storyHints(rng: Rng): StoryHints {
  const letters = [...HINT_INITIALS];
  // Three different letters, so the names do not alliterate.
  const letter = () => letters.splice(rng.int(0, letters.length - 1), 1)[0];
  return {
    mood: rng.pick(HINT_MOODS),
    island: rng.pick(HINT_ISLANDS),
    relic: rng.pick(HINT_RELICS),
    villain: rng.pick(HINT_VILLAINS),
    islander: rng.pick(HINT_ISLANDERS),
    naming: rng.pick(HINT_NAMING),
    initials: { island: letter(), villain: letter(), islander: letter() },
  };
}

export function buildBible(frame: StoryFrame, fill: StoryFill, demand: Demand = frame.demands[0]): StoryBible {
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
    capabilities: [
      { id: "reveal_lair", verb: "reveal_location", poi: "lair", poiName: fill.lair_name, gate: "demand" },
      { id: "give_charm", verb: "give_item", item: "charm", itemName: fill.charm_name, gate: "persuade" },
      { id: "call_guard", verb: "start_combat", enemies: ["bandit"], gate: "provoked" },
    ],
  };
  return {
    frameId: frame.id,
    title: fill.title,
    premise: fill.premise,
    islandName: fill.island_name,
    villain: { name: fill.villain_name, description: fill.villain_description },
    relicName: fill.relic_name,
    poiNames: { lair: fill.lair_name, hut: `${fill.npc_name}'s hut`, landing: "The Landing" },
    npcs: [npc],
    objectives: [
      { id: "meet", text: `Find ${fill.npc_name} at the hut near the shore`, fact: "met:npc1" },
      { id: "locate", text: `Learn where ${fill.lair_name} is hidden`, fact: "revealed:lair" },
      { id: "defeat", text: `Defeat ${fill.villain_name} and recover ${fill.relic_name}`, fact: "defeated:lair" },
    ],
    demand,
    finalObjective: "defeat",
    doomRounds: frame.doomRounds,
  };
}

/**
 * Check a bible against the map it will be played on. Returns a list of
 * problems; empty means the story can be completed.
 */
export function validateBible(bible: StoryBible, map: WorldMap): string[] {
  const problems: string[] = [];
  const npcIds = new Set(bible.npcs.map((n) => n.id));
  for (const npc of bible.npcs) {
    if (!poiById(map, npc.poi)) problems.push(`npc ${npc.id} stands at missing poi ${npc.poi}`);
    for (const cap of npc.capabilities) {
      if (cap.verb === "reveal_location" && !poiById(map, cap.poi)) {
        problems.push(`capability ${cap.id} reveals missing poi ${cap.poi}`);
      }
    }
  }
  const final = bible.objectives.find((o) => o.id === bible.finalObjective);
  if (!final) problems.push("final objective missing");
  for (const o of bible.objectives) {
    const [kind, ref] = o.fact.split(":");
    if (kind === "met" && !npcIds.has(ref)) problems.push(`objective ${o.id} needs missing npc ${ref}`);
    if (kind === "revealed" || kind === "defeated") {
      const poi = poiById(map, ref);
      if (!poi) problems.push(`objective ${o.id} needs missing poi ${ref}`);
      else if (kind === "defeated" && poi.enemies.length === 0) problems.push(`objective ${o.id}: nothing to defeat at ${ref}`);
    }
  }
  if (bible.demand.fact) {
    const [kind, ref] = bible.demand.fact.split(":");
    const poi = poiById(map, ref);
    if (kind !== "defeated" || !poi || poi.enemies.length === 0) problems.push(`demand ${bible.demand.id} cannot be met on this island`);
  }
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
};

export function cannedFill(frame: StoryFrame, rng: Rng): StoryFill {
  return rng.pick(CANNED_FILLS[frame.id]);
}
