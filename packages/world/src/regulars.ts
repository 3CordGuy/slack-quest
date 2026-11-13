// The pub's regulars: a handful of Harbor folk who drink at the crew's pub
// and have small jobs going. Three of the five are in on any day.
//
// Like the traveling salesmen, nothing schedules them. Who is in, and the job
// each has going, follow from the crew's id and the UTC day, so every crewmate
// sees the same faces and the server re-derives an offer to check it instead
// of storing it. Only what a player took on, how far a trade has gone today,
// and what was handed in are stored (migration 0022_errands.sql); a taken job
// keeps its terms in its row, so it means the same tomorrow.
//
// Three kinds of job:
//
//   fetch  bring N of a material or two and hand it in at the pub;
//   trade  swap some of one material for another at a fair-to-kind rate,
//          a few times a day;
//   quest  do one small thing elsewhere (rest, give to a crew project, come
//          home from a won voyage, meet a contract from the dealer), checked
//          against what the game already records after the job was taken.
//
// Pay is a little XP (under the daily Harbor XP cap, like every pastime)
// plus some gold or materials. A player hands in at most ERRANDS_PER_DAY jobs
// a day, so voyages stay the main way on.

import { RESOURCE_KINDS, RESOURCE_LABEL, canAfford, type ResourceKind, type Resources } from "./hut";
import { gatherDay } from "./gather";
import { makeRng, seedFromString, type Rng } from "./rng";

// ---------- who they are ----------

export type RegularId = "gretta" | "pike" | "wen" | "moss" | "dacey";
export type ErrandKind = "fetch" | "trade" | "quest";
export type QuestGoal = "rest" | "give" | "voyage" | "contract";

export interface Regular {
  id: RegularId;
  name: string;
  /** What they are called across the room: "Gretta". */
  short: string;
  /** What they do, in a few words: "a net-mender". */
  trade: string;
  /** A line of personality, shown in their panel. */
  line: string;
  /** What they say as you walk up: a speech bubble over their head. */
  hello: string;
  /** Sprite kind for the renderer (render/looks.ts). */
  look: string;
  /** The kinds of job they hand out; one is picked each day. */
  kinds: ErrandKind[];
  /** Materials they ask for, in a fetch or as the price of a trade. */
  wants: ResourceKind[];
  /** Materials they give, in a trade or as a bonus. */
  gives: ResourceKind[];
  /** Small things they would like done, for a quest. */
  quests: QuestGoal[];
}

export const REGULARS: Regular[] = [
  {
    id: "gretta",
    name: "Gretta Vane",
    short: "Gretta",
    trade: "a net-mender",
    line: "Every net has a hole, and every hole has a story. I have heard all of them twice.",
    hello: "Mind the twine, love.",
    look: "regular_gretta",
    kinds: ["fetch", "trade"],
    wants: ["bone", "copper", "fur"],
    gives: ["wood", "stone"],
    quests: ["rest"],
  },
  {
    id: "pike",
    name: "Bosun Pike",
    short: "Pike",
    trade: "a bosun, retired",
    line: "Forty years at sea and I still will not sit with my back to the door.",
    hello: "You. Yes, you. Sit.",
    look: "regular_pike",
    kinds: ["quest", "quest", "fetch"],
    wants: ["iron", "wood"],
    gives: ["iron", "copper"],
    quests: ["voyage", "contract", "rest"],
  },
  {
    id: "wen",
    name: "Wen Ashby",
    short: "Wen",
    trade: "a carpenter",
    line: "Measure twice, drink once. Then measure again, because of the drink.",
    hello: "Got a minute and a strong back?",
    look: "regular_wen",
    kinds: ["fetch", "quest", "trade"],
    wants: ["wood", "stone"],
    gives: ["iron", "copper"],
    quests: ["give"],
  },
  {
    id: "moss",
    name: "Old Moss",
    short: "Moss",
    trade: "a lighthouse keeper, mostly retired",
    line: "Thirty years I kept a light. Now I keep this stool, and it is less work.",
    hello: "Eh? Oh. Hello, sailor.",
    look: "regular_moss",
    kinds: ["quest", "fetch"],
    wants: ["herbs", "mushrooms"],
    gives: ["fur", "bone"],
    quests: ["rest", "give"],
  },
  {
    id: "dacey",
    name: "Dacey Fenn",
    short: "Dacey",
    trade: "a smuggler, allegedly",
    line: "I do not know what you heard, but it was probably true.",
    hello: "Psst. Over here.",
    look: "regular_dacey",
    kinds: ["trade", "trade", "fetch"],
    wants: ["copper", "fur", "iron"],
    gives: ["iron", "copper", "fur"],
    quests: ["contract"],
  },
];

export const regular = (id: unknown): Regular | undefined => REGULARS.find((r) => r.id === id);

/** How many regulars are in on any day. */
export const REGULARS_PER_DAY = 3;
/** Jobs (fetches and quests) a player may hand in per UTC day, across every regular. */
export const ERRANDS_PER_DAY = 3;
/** Times a day each player may take a regular's trade. */
export const TRADES_PER_DAY = 2;

/** `count` different picks from `items`, in a seeded order. */
function some<T>(rng: Rng, items: readonly T[], count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (pool.length > 0 && out.length < count) out.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0]);
  return out;
}

/** The regulars in the crew's pub on `day` (YYYY-MM-DD, UTC), in the order they take their spots. */
export function regularsOn(crewId: string, day: string): Regular[] {
  return some(makeRng(seedFromString(`regulars|${crewId}|${day}`)), REGULARS, REGULARS_PER_DAY);
}

/** The regulars in at `now` (epoch ms). */
export const regularsAt = (crewId: string, now: number): Regular[] => regularsOn(crewId, gatherDay(now));

// ---------- the jobs ----------

export interface ErrandReward {
  xp: number;
  gold: number;
  resources?: Resources;
}

interface ErrandBase {
  /** "<day>:<regular>": names the offer, shared by the crew. */
  id: string;
  regular: RegularId;
  day: string;
  /** The ask, in the regular's voice. */
  text: string;
}

export type Errand =
  | (ErrandBase & { kind: "fetch"; need: Resources; reward: ErrandReward })
  | (ErrandBase & { kind: "trade"; give: Resources; get: Resources; times: number; reward: ErrandReward })
  | (ErrandBase & { kind: "quest"; goal: QuestGoal; reward: ErrandReward });

/**
 * What each material is worth to a regular, roughly: how often a gathering
 * outing turns it up. A trade swaps equal worth, rounded in the player's
 * favour, and a little over.
 */
export const MATERIAL_WORTH: Record<ResourceKind, number> = { wood: 1, stone: 1, bone: 1, herbs: 1, mushrooms: 1, fur: 1.5, copper: 2, iron: 2, gem: 6 };
/** The most gold a fetch pays: about a contract, at the low end. */
export const FETCH_GOLD_MAX = 30;
/** A trade gives this much more worth than it takes. */
export const TRADE_GENEROSITY = 1.2;

/** What a quest asks, in a few words for its row: "Rest on a bedroll or in your hut". */
export const QUEST_TEXT: Record<QuestGoal, string> = {
  rest: "Rest on a bedroll or at home in your hut",
  give: "Give something to one of the crew's Harbor projects",
  voyage: "Come home from a voyage the crew won",
  contract: "Meet one of the contract dealer's contracts on a voyage",
};

/** What the regular says when asking. */
const QUEST_ASK: Record<RegularId, Partial<Record<QuestGoal, string>>> = {
  gretta: { rest: "You look worse than my nets. Go and lie down for a bit, then come and tell me you did." },
  pike: {
    voyage: "Bring a ship home with a win in her hold and I will stand you something better than ale.",
    contract: "Take one of those notices off the board and see it through. Proper work, that.",
    rest: "Sleep, sailor. A tired hand loses fingers. Rest, then report.",
  },
  wen: { give: "The crew's building something. Put a bit of yourself into it, and I will put a bit into you." },
  moss: {
    rest: "When did you last sleep? Go on. Rest, and come back with a clearer eye.",
    give: "Help the crew build something that outlasts you. Then come tell an old man about it.",
  },
  dacey: { contract: "There is a notice on the board with your name on it, if you squint. See it done." },
};

/** Base pay for each quest, before a regular's day roll. Voyage work pays the most. */
const QUEST_PAY: Record<QuestGoal, { xp: number; gold: number; bonus: number }> = {
  rest: { xp: 4, gold: 10, bonus: 0 },
  give: { xp: 5, gold: 15, bonus: 0 },
  voyage: { xp: 8, gold: 30, bonus: 2 },
  contract: { xp: 8, gold: 25, bonus: 2 },
};

const units = (r: Resources) => RESOURCE_KINDS.reduce((n, k) => n + (r[k] ?? 0), 0);
const worth = (r: Resources) => RESOURCE_KINDS.reduce((n, k) => n + (r[k] ?? 0) * MATERIAL_WORTH[k], 0);

/** "5 herbs and 2 copper". */
export function materialsText(r: Resources): string {
  const parts = RESOURCE_KINDS.filter((k) => (r[k] ?? 0) > 0).map((k) => `${r[k]} ${RESOURCE_LABEL[k].toLowerCase()}`);
  return parts.length <= 1 ? (parts[0] ?? "nothing") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The job `who` has going on `day` in this crew's pub. Deterministic in its arguments. */
export function errandFor(crewId: string, day: string, who: Regular): Errand {
  const rng = makeRng(seedFromString(`errand|${crewId}|${day}|${who.id}`));
  const base = { id: `${day}:${who.id}`, regular: who.id, day };
  const kind = rng.pick(who.kinds);

  if (kind === "fetch") {
    // One or two of what they want: three to six pieces in all, about two outings' worth.
    const kinds = some(rng, who.wants, rng.int(1, Math.min(2, who.wants.length)));
    const need: Resources = {};
    const total = rng.int(3, 6);
    kinds.forEach((k, i) => (need[k] = i === kinds.length - 1 ? total - units(need) : Math.max(1, Math.floor(total / kinds.length))));
    const value = worth(need);
    // Paid in gold above the stall's price (capped), a few XP, and now and then a piece of what they give.
    const bonus: Resources = rng.chance(0.4) ? { [rng.pick(who.gives)]: 1 } : {};
    const reward: ErrandReward = { xp: Math.min(8, 3 + units(need)), gold: Math.min(FETCH_GOLD_MAX, Math.round(value * 4) + rng.int(0, 4)), ...(units(bonus) > 0 ? { resources: bonus } : {}) };
    return { ...base, kind, need, reward, text: `Bring me ${materialsText(need)}. I'll make it worth your while.` };
  }

  if (kind === "trade") {
    const take = rng.pick(who.wants);
    const giveKinds = who.gives.filter((k) => k !== take);
    const out = rng.pick(giveKinds.length > 0 ? giveKinds : who.gives);
    // Swap at least two pieces' worth, and always get at least one back.
    let n = rng.int(2, 4);
    while (Math.floor((n * MATERIAL_WORTH[take] * TRADE_GENEROSITY) / MATERIAL_WORTH[out]) < 1) n++;
    const get = Math.max(1, Math.round((n * MATERIAL_WORTH[take] * TRADE_GENEROSITY) / MATERIAL_WORTH[out]));
    const give: Resources = { [take]: n };
    const back: Resources = { [out]: get };
    return { ...base, kind, give, get: back, times: TRADES_PER_DAY, reward: { xp: 2, gold: 0 }, text: `${materialsText(give)} for ${materialsText(back)}. Fair's fair. Fairer, even.` };
  }

  const goal = rng.pick(who.quests);
  const pay = QUEST_PAY[goal];
  const bonus: Resources = pay.bonus > 0 ? { [rng.pick(who.gives)]: pay.bonus } : {};
  const reward: ErrandReward = { xp: pay.xp, gold: pay.gold + rng.int(0, 5), ...(units(bonus) > 0 ? { resources: bonus } : {}) };
  return { ...base, kind: "quest", goal, reward, text: QUEST_ASK[who.id][goal] ?? `${QUEST_TEXT[goal]}, would you?` };
}

/** Today's offers in the crew's pub, one per regular who is in. */
export function errandsOn(crewId: string, day: string): Errand[] {
  return regularsOn(crewId, day).map((r) => errandFor(crewId, day, r));
}

// ---------- doing them ----------

/** What the game records that a quest is checked against, counted from when the job was taken. */
export interface QuestFacts {
  /** Rested on a bedroll or at home. */
  rested: boolean;
  /** Gave to a crew project. */
  gave: boolean;
  /** Came home from a won voyage. */
  wonVoyage: boolean;
  /** Met a notice-board contract on a voyage. */
  metContract: boolean;
}

export const NO_FACTS: QuestFacts = { rested: false, gave: false, wonVoyage: false, metContract: false };

export function questMet(goal: QuestGoal, facts: QuestFacts): boolean {
  if (goal === "rest") return facts.rested;
  if (goal === "give") return facts.gave;
  if (goal === "voyage") return facts.wonVoyage;
  return facts.metContract;
}

/** A player's standing with one regular's job, as the server reads it. */
export interface ErrandRecord {
  /** The terms as taken (or, for a trade, as first traded). */
  errand: Errand;
  acceptedAt: number;
  /** When it was handed in; for a trade, when it was first traded. Null while held. */
  doneAt: number | null;
  /** Trades made on this offer. */
  count: number;
}

/** What the player has that a job depends on. */
export interface ErrandPlayer {
  resources: Resources;
  /** Jobs handed in today, every regular counted. */
  handedInToday: number;
  facts: QuestFacts;
}

/** "You need 2 more copper and 1 more fur." */
function shortText(have: Resources, need: Resources): string {
  const short = RESOURCE_KINDS.filter((k) => (have[k] ?? 0) < (need[k] ?? 0)).map((k) => `${(need[k] ?? 0) - (have[k] ?? 0)} more ${RESOURCE_LABEL[k].toLowerCase()}`);
  return `You need ${short.join(" and ")}.`;
}

/** Why `errand` cannot be taken on, given what the player already holds with that regular; null if it can. */
export function acceptProblem(errand: Errand | undefined, held: ErrandRecord | null, today: ErrandRecord | null): string | null {
  if (!errand) return "They have nothing for you today.";
  if (errand.kind === "trade") return "That is a trade: there is nothing to take on.";
  if (held && held.doneAt === null) return held.errand.id === errand.id ? "You are already on it." : "Finish the job you have from them first.";
  if (today) return "You have done that one. Come back tomorrow.";
  return null;
}

/** Why a held job cannot be handed in now; null if it can. */
export function handInProblem(record: ErrandRecord | null, player: ErrandPlayer): string | null {
  if (!record || record.doneAt !== null) return "You have no job from them to hand in.";
  const { errand } = record;
  if (errand.kind === "trade") return "That is a trade, not a job.";
  if (player.handedInToday >= ERRANDS_PER_DAY) return `That's ${ERRANDS_PER_DAY} jobs today. Come back tomorrow and they'll pay.`;
  if (errand.kind === "fetch" && !canAfford(player.resources, errand.need)) return shortText(player.resources, errand.need);
  if (errand.kind === "quest" && !questMet(errand.goal, player.facts)) return `Not done yet. ${QUEST_TEXT[errand.goal]} first.`;
  return null;
}

/** Why a trade cannot be made now; null if it can. `record` is today's trading with this regular, if any. */
export function swapProblem(errand: Errand | undefined, record: ErrandRecord | null, resources: Resources): string | null {
  if (!errand || errand.kind !== "trade") return "They are not trading today.";
  if ((record?.count ?? 0) >= errand.times) return `Twice a day is plenty. Come back tomorrow.`;
  if (!canAfford(resources, errand.give)) return shortText(resources, errand.give);
  return null;
}

/** How far along a job is, for its row: what is held toward each need, or whether the deed is done. */
export function errandProgress(errand: Errand, resources: Resources, facts: QuestFacts): { have: Resources; ready: boolean } {
  if (errand.kind === "quest") return { have: {}, ready: questMet(errand.goal, facts) };
  const need = errand.kind === "fetch" ? errand.need : errand.give;
  const have: Resources = {};
  for (const k of RESOURCE_KINDS) if (need[k]) have[k] = Math.min(need[k]!, resources[k] ?? 0);
  return { have, ready: canAfford(resources, need) };
}

/** Read an errand back from its stored JSON. Null if it is not one this code knows. */
export function parseErrand(json: string): Errand | null {
  try {
    const e = JSON.parse(json) as Errand;
    if (!e || typeof e.id !== "string" || !regular(e.regular)) return null;
    if (e.kind === "fetch" || e.kind === "trade" || (e.kind === "quest" && e.goal in QUEST_TEXT)) return e;
    return null;
  } catch {
    return null;
  }
}

/** The start of a UTC day, in epoch ms: hand-ins at or after it count for that day. */
export const dayStart = (now: number): number => Math.floor(now / 86_400_000) * 86_400_000;
