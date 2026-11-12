// Harbor projects: buildings the whole crew pays into together.
//
// A project has a cost in gold and hut materials. Any crew member can give
// toward it from their own stock; when every cost is met it is built, for
// good, and its benefit applies to every voyage the crew launches after
// that. This file holds the catalogue, the check a contribution must pass,
// and what built projects give a voyage. The server stores the progress.

import { RESOURCE_KINDS, RESOURCE_LABEL, type ResourceKind } from "./hut";

/** What a project can be paid in: gold, or any hut material. */
export const PROJECT_COST_KINDS = ["gold", ...RESOURCE_KINDS] as const;
export type ProjectCostKind = "gold" | ResourceKind;
export type ProjectAmounts = Partial<Record<ProjectCostKind, number>>;

export const PROJECT_COST_LABEL: Record<ProjectCostKind, string> = { gold: "Gold", ...RESOURCE_LABEL };

export interface ProjectDef {
  id: string;
  name: string;
  blurb: string;
  /** What it gives once built, in words. */
  benefit: string;
  cost: ProjectAmounts;
  /** False while the project is only announced: it is listed but cannot be funded. */
  open: boolean;
  /** Extra days on the doom clock of every voyage. */
  doomDays?: number;
  /** Line shown as a voyage opens, saying what the project did for it. */
  voyageLine?: string;
}

export const PROJECTS: ProjectDef[] = [
  {
    id: "lighthouse",
    name: "Lighthouse",
    blurb: "A lamp on a stone tower, to see ships out past the shoals and home again.",
    benefit: "Every voyage gets one more day on its clock.",
    cost: { gold: 300, wood: 30, stone: 30, iron: 10 },
    open: true,
    doomDays: 1,
    voyageLine: "The Harbor's lighthouse saw you out past the shoals before dawn: one more day on the clock.",
  },
  {
    id: "apothecary",
    name: "Apothecary",
    blurb: "A narrow shop by the market stall, hung with drying herbs.",
    benefit: "Brew herbs and mushrooms into draughts, tonics and salves for your next voyage.",
    cost: { gold: 250, wood: 25, stone: 15, herbs: 20, mushrooms: 20 },
    open: true,
  },
  {
    id: "smithy",
    name: "Smithy",
    blurb: "A forge and an anvil by the sparring ring.",
    benefit: "Sharpen weapons and reinforce armour, up to +3 an item.",
    cost: { gold: 400, stone: 30, iron: 30, copper: 15 },
    open: true,
  },
  {
    id: "galley",
    name: "Galley",
    blurb: "A cookhouse that provisions ships before they sail.",
    benefit: "Cook chowder and ship's stores into a larder the whole crew sails with.",
    cost: { gold: 250, wood: 30, fur: 15, bone: 10 },
    open: true,
  },
];

export const projectById = (id: string): ProjectDef | undefined => PROJECTS.find((p) => p.id === id);

/** The kinds a project costs, in catalogue order. */
export function projectCostKinds(def: ProjectDef): ProjectCostKind[] {
  return PROJECT_COST_KINDS.filter((k) => (def.cost[k] ?? 0) > 0);
}

/** What a project still needs, given what has been paid in. Never negative; met costs are left out. */
export function projectRemaining(def: ProjectDef, paid: ProjectAmounts): ProjectAmounts {
  const left: ProjectAmounts = {};
  for (const kind of projectCostKinds(def)) {
    const n = def.cost[kind]! - (paid[kind] ?? 0);
    if (n > 0) left[kind] = n;
  }
  return left;
}

/** True once every cost is met. */
export function projectComplete(def: ProjectDef, paid: ProjectAmounts): boolean {
  return projectCostKinds(def).every((k) => (paid[k] ?? 0) >= def.cost[k]!);
}

/** The most a player could give right now: what the project still needs, held to what they have. */
export function projectGivable(def: ProjectDef, paid: ProjectAmounts, holdings: ProjectAmounts): ProjectAmounts {
  const left = projectRemaining(def, paid);
  const out: ProjectAmounts = {};
  for (const kind of projectCostKinds(def)) {
    const n = Math.min(left[kind] ?? 0, Math.max(0, Math.floor(holdings[kind] ?? 0)));
    if (n > 0) out[kind] = n;
  }
  return out;
}

export type ContributionCheck =
  | {
      ok: true;
      /** The gift, with only the kinds actually given. */
      give: ProjectAmounts;
      /** What the project holds afterwards. */
      paid: ProjectAmounts;
      /** True if this gift meets the last of the costs. */
      completes: boolean;
    }
  | { ok: false; error: string };

/**
 * Check one contribution. `give` is whatever the client sent and is not
 * trusted: every amount must be a whole, non-negative number, the giver must
 * hold it, and the project must still need it. A gift that would over-pay
 * any cost is refused outright rather than trimmed, so nobody gives more or
 * less than they meant to.
 */
export function checkContribution(
  projectId: string,
  state: { paid: ProjectAmounts; built: boolean },
  holdings: ProjectAmounts,
  give: unknown,
): ContributionCheck {
  const def = projectById(projectId);
  if (!def) return { ok: false, error: "No such project." };
  if (!def.open) return { ok: false, error: `The ${def.name} is not yet open.` };
  if (state.built || projectComplete(def, state.paid)) return { ok: false, error: `The ${def.name} is already built.` };
  if (typeof give !== "object" || give === null || Array.isArray(give)) return { ok: false, error: "Nothing was given." };

  const left = projectRemaining(def, state.paid);
  const clean: ProjectAmounts = {};
  const paid: ProjectAmounts = { ...state.paid };
  for (const [key, raw] of Object.entries(give as Record<string, unknown>)) {
    if (raw === 0 || raw === undefined || raw === null) continue;
    const kind = PROJECT_COST_KINDS.find((k) => k === key);
    if (!kind) return { ok: false, error: `The ${def.name} has no use for ${key}.` };
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return { ok: false, error: "Amounts must be whole numbers." };
    const label = PROJECT_COST_LABEL[kind].toLowerCase();
    if (!def.cost[kind]) return { ok: false, error: `The ${def.name} has no use for ${label}.` };
    if (raw > (left[kind] ?? 0)) return { ok: false, error: left[kind] ? `The ${def.name} only needs ${left[kind]} more ${label}.` : `The ${def.name} has all the ${label} it needs.` };
    if (raw > (holdings[kind] ?? 0)) return { ok: false, error: `You do not have ${raw} ${label}.` };
    clean[kind] = raw;
    paid[kind] = (paid[kind] ?? 0) + raw;
  }
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing was given." };
  return { ok: true, give: clean, paid, completes: projectComplete(def, paid) };
}

/** "20 gold, 5 wood", in catalogue order. */
export function projectAmountsText(amounts: ProjectAmounts): string {
  return PROJECT_COST_KINDS.filter((k) => amounts[k]).map((k) => `${amounts[k]} ${PROJECT_COST_LABEL[k].toLowerCase()}`).join(", ");
}

// ---------- what built projects give a voyage ----------

export interface VoyageBoons {
  /** Days added to the doom clock. */
  doomDays: number;
  /** One line per project that did something, for the voyage's opening feed. */
  lines: { projectId: string; text: string }[];
}

/** The benefits of a crew's built projects. Unknown and unopened ids give nothing. */
export function voyageBoons(built: readonly string[] | undefined): VoyageBoons {
  const boons: VoyageBoons = { doomDays: 0, lines: [] };
  for (const id of new Set(built ?? [])) {
    const def = projectById(id);
    if (!def?.open) continue;
    boons.doomDays += def.doomDays ?? 0;
    if (def.voyageLine) boons.lines.push({ projectId: def.id, text: def.voyageLine });
  }
  return boons;
}

// ---------- wire types ----------

/** One project as the Harbor shows it. */
export interface CrewProject {
  id: string;
  paid: ProjectAmounts;
  /** Epoch ms it was finished, or null while it is still being built. */
  builtAt: number | null;
}

/** One line of the contribution log. */
export interface ProjectGift {
  name: string;
  projectId: string;
  kind: ProjectCostKind;
  qty: number;
  at: number;
}

/** A crew's projects: progress on each one in the catalogue, and the latest gifts, newest first. */
export interface HarborWorks {
  projects: CrewProject[];
  gifts: ProjectGift[];
}

/** Ids of the projects a crew has finished. */
export const builtProjects = (works: HarborWorks | undefined): string[] => (works?.projects ?? []).filter((p) => p.builtAt !== null).map((p) => p.id);
