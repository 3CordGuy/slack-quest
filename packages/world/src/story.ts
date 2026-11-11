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
 * exchanges, not one odd remark, to start a fight.
 */
export type Gate = "free" | "persuade" | "provoked";

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
  /** Completing this objective wins the run. */
  finalObjective: string;
  /** Rounds before the villain gets away. */
  doomRounds: number;
}

export interface StoryFrame {
  id: string;
  /** One line telling the model what kind of story to write. */
  brief: string;
  doomRounds: number;
}

export const STORY_FRAMES: StoryFrame[] = [
  {
    id: "stolen_relic",
    brief:
      "A villain has stolen a relic the island's people depend on and gone to ground in a hidden lair. " +
      "One islander living in a hut near the shore knows where the lair is and owns a protective charm.",
    doomRounds: 16,
  },
];

export function pickFrame(rng: Rng): StoryFrame {
  return rng.pick(STORY_FRAMES);
}

export function buildBible(frame: StoryFrame, fill: StoryFill): StoryBible {
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
      { id: "reveal_lair", verb: "reveal_location", poi: "lair", poiName: fill.lair_name, gate: "free" },
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
