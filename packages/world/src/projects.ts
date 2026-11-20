// Harbor projects: buildings the whole crew pays into together.
//
// A project has a cost in gold and hut materials. Any crew member can give
// toward it from their own stock; when every cost is met it is built, for
// good. This file holds the catalogue and the check a contribution must
// pass. The server stores the progress.

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
  /** Projects the crew must have built before this one can be paid into. */
  requires?: string[];
}

// The Apothecary and the Smithy are the Harbor's first buildings and open from
// the start. The Lighthouse and the Galley are the second tier: they unlock
// once both workshops stand (see `projectLock`).
export const PROJECTS: ProjectDef[] = [
  {
    id: "apothecary",
    name: "Apothecary",
    blurb: "A narrow shop by the market stall, hung with drying herbs.",
    benefit: "Make potions, flasks and bombs for your pack from what you gather, or buy them ready-made.",
    cost: { gold: 250, wood: 25, stone: 15, herbs: 20, mushrooms: 20 },
    open: true,
  },
  {
    id: "smithy",
    name: "Smithy",
    blurb: "A forge and an anvil by the sparring ring.",
    benefit: "Sharpen weapons and reinforce armour, up to +3 an item.",
    cost: { gold: 800, stone: 60, iron: 60, copper: 15 },
    open: true,
  },
  {
    id: "lighthouse",
    name: "Lighthouse",
    blurb: "A lamp on a stone tower, to see ships out past the shoals and home again.",
    benefit: "A lit tower on the point, its lamp turning over the Harbor. It is there to be seen: it does nothing else yet.",
    cost: { gold: 300, wood: 30, stone: 30, iron: 10 },
    open: true,
    requires: ["apothecary", "smithy"],
  },
  {
    id: "galley",
    name: "Galley",
    blurb: "A cookhouse that provisions ships before they sail.",
    benefit: "A room to walk into, with the cook at his block. He has nothing to sell or cook for you yet.",
    cost: { gold: 250, wood: 30, fur: 15, bone: 10 },
    open: true,
    requires: ["apothecary", "smithy"],
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

/** How far along a project is, 0 to 1: each cost counts the same, and over-payment of one does not make up for another. */
export function projectProgress(def: ProjectDef, paid: ProjectAmounts): number {
  const kinds = projectCostKinds(def);
  if (kinds.length === 0) return 0;
  return kinds.reduce((sum, k) => sum + Math.min(1, (paid[k] ?? 0) / def.cost[k]!), 0) / kinds.length;
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

/** A crew's progress on one project, as far as the unlock rule cares. */
export type ProjectProgress = Pick<CrewProject, "id" | "paid" | "builtAt">;

/** Why a project cannot be paid into yet. */
export interface ProjectLock {
  /** The required projects the crew has not built, in catalogue order. */
  needs: string[];
}

/**
 * Whether a crew may pay into a project yet, given its progress on every
 * project: null when it may, or what it still needs built.
 *
 * A project with `requires` is locked until every one of them is built.
 * A project the crew has already built, or already paid anything into, is
 * never locked: crews that started the Lighthouse or the Galley before the
 * unlock rule existed keep it, and can finish what they began.
 */
export function projectLock(projectId: string, crew: readonly ProjectProgress[]): ProjectLock | null {
  const def = projectById(projectId);
  if (!def?.requires?.length) return null;
  const own = crew.find((p) => p.id === projectId);
  if (own && (own.builtAt !== null || Object.values(own.paid).some((n) => (n ?? 0) > 0))) return null;
  const built = new Set(crew.filter((p) => p.builtAt !== null).map((p) => p.id));
  const needs = PROJECTS.filter((p) => def.requires!.includes(p.id) && !built.has(p.id)).map((p) => p.id);
  return needs.length ? { needs } : null;
}

/** "Unlocks once the Apothecary and the Smithy are built." */
export function projectLockText(lock: ProjectLock): string {
  const names = lock.needs.map((id) => `the ${projectById(id)?.name ?? id}`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `Unlocks once ${list} ${names.length > 1 ? "are" : "is"} built.`;
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
 * less than they meant to. `crew` is the crew's progress on every project,
 * for the unlock rule (`projectLock`).
 */
export function checkContribution(
  projectId: string,
  state: { paid: ProjectAmounts; built: boolean },
  holdings: ProjectAmounts,
  give: unknown,
  crew: readonly ProjectProgress[],
): ContributionCheck {
  const def = projectById(projectId);
  if (!def) return { ok: false, error: "No such project." };
  if (!def.open) return { ok: false, error: `The ${def.name} is not yet open.` };
  if (state.built || projectComplete(def, state.paid)) return { ok: false, error: `The ${def.name} is already built.` };
  const lock = projectLock(projectId, crew);
  if (lock) return { ok: false, error: `The ${def.name} is locked. ${projectLockText(lock)}` };
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
