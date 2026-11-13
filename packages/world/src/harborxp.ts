// A little XP from the Harbor's pastimes: gathering, the pub's tables, the
// sparring ring, crafting, the Apothecary, the Smithy and crew projects.
//
// Voyages stay the way to level up. Each pastime pays a few XP, and a daily
// cap (counted per UTC day, like gathering stamina) stops grinding them from
// replacing a voyage: the whole day's Harbor XP is about a fifth of a won
// voyage. The hut's XP perk is a voyage perk and does not apply here (on
// awards this small it would round to nothing anyway).

import { applyXp, type Progress } from "./progression";
import { gatherDay, gatherResetAt, type GatherState } from "./gather";

/** The most XP the Harbor's pastimes can give one hero in a UTC day. */
export const HARBOR_XP_DAILY_CAP = 30;

/** Sparring bouts per day that count for XP. A bout is fought in the browser, so this keeps it from being farmed. */
export const SPAR_XP_DAILY_BOUTS = 3;

/** What each pastime pays, before the cap. */
export const HARBOR_XP = {
  /** A lost haul: a little, for the effort. */
  gatherBust: 2,
  /** A banked haul: this, plus one per two units brought home (up to GATHER_MAX_UNITS / 2). */
  gatherBanked: 4,
  /** Winning a game of dice or Shoals at the pub. */
  pubWin: 5,
  /** Finishing a bout at the sparring ring, won or lost. */
  spar: 3,
  /** Crafting a furnishing. */
  craft: 5,
  /** A brew at the Apothecary. */
  brew: 3,
  /** A step at the Smithy's forge. */
  smith: 4,
  /** A dish cooked into the Galley's larder. */
  cook: 3,
  /** Giving to a crew project. */
  project: 4,
} as const;

export type HarborXpSource = keyof typeof HARBOR_XP;

/** XP for each perfect split at the chopping block: not a pastime of its own, and not held to the daily cap, nor to a full pile. */
export const PERFECT_SPLIT_XP = 1;

/** XP an ended felling outing pays for its perfect splits, on top of gatherXp and outside the daily cap. */
export function perfectSplitXp(state: Pick<GatherState, "status" | "felling">): number {
  if (state.status !== "banked" || !state.felling) return 0;
  return state.felling.splits.filter((s) => s.grade === "perfect").length * PERFECT_SPLIT_XP;
}

/** XP for an outing that has ended. Nothing while it is still going. */
export function gatherXp(state: Pick<GatherState, "status" | "haul">, paidUnits: number): number {
  if (state.status === "bust") return HARBOR_XP.gatherBust;
  if (state.status !== "banked") return 0;
  return HARBOR_XP.gatherBanked + Math.min(4, Math.floor(Math.max(0, paidUnits) / 2));
}

/** Fishing: each species caught for the first time, and each new crew record, outside the daily cap. */
export const NEW_SPECIES_XP = 1;
export const CREW_RECORD_XP = 2;

/** XP for a fishing sitting that has ended, under the cap: as a banked haul, with one per two kept catches standing in for units. */
export function sittingXp(state: Pick<GatherState, "status" | "sitting">): number {
  if (state.status !== "banked" || !state.sitting) return 0;
  const kept = state.sitting.landed.filter((f) => f.kept).length;
  return HARBOR_XP.gatherBanked + Math.min(4, Math.floor(kept / 2));
}

/** A hero's Harbor XP for the day, as stored. */
export interface HarborXpRecord {
  day: string;
  used: number;
  spars: number;
}

/** Harbor XP a hero may still earn today. */
export function harborXpLeft(record: Pick<HarborXpRecord, "day" | "used"> | null | undefined, now: number): number {
  if (!record || record.day !== gatherDay(now)) return HARBOR_XP_DAILY_CAP;
  return Math.max(0, HARBOR_XP_DAILY_CAP - Math.max(0, record.used));
}

/** Sparring bouts that still count for XP today. */
export function sparBoutsLeft(record: Pick<HarborXpRecord, "day" | "spars"> | null | undefined, now: number): number {
  if (!record || record.day !== gatherDay(now)) return SPAR_XP_DAILY_BOUTS;
  return Math.max(0, SPAR_XP_DAILY_BOUTS - Math.max(0, record.spars));
}

export interface HarborXpStatus {
  left: number;
  cap: number;
  resetsAt: number;
}

export function harborXpStatus(record: HarborXpRecord | null | undefined, now: number): HarborXpStatus {
  return { left: harborXpLeft(record, now), cap: HARBOR_XP_DAILY_CAP, resetsAt: gatherResetAt(now) };
}

/** The outcome of an award, before it is written. */
export interface HarborXpAward {
  /** XP actually given under the cap: the amount, cut down to what is left of today's. */
  granted: number;
  /** XP given on top, outside the cap (perfect splits). Not counted against the day. */
  bonus: number;
  /** What the pastime would have paid without the cap. */
  asked: number;
  /** The hero after the XP, levels included. */
  next: Progress & { levelsGained: number };
  /** The day's record after the award. */
  record: HarborXpRecord;
}

/**
 * Work out an award: cap it, then level the hero up as a voyage would
 * (class auto-allocation plus a free point per level). `spar` counts a bout
 * against the day's sparring allowance; a bout past it pays nothing. `bonus`
 * is given whatever the cap, and does not use any of it.
 */
export function harborXpAward(hero: Progress, record: HarborXpRecord | null | undefined, amount: number, now: number, spar = false, bonus = 0): HarborXpAward {
  const today = gatherDay(now);
  const current: HarborXpRecord = record && record.day === today ? record : { day: today, used: 0, spars: 0 };
  const asked = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : 0));
  const allowed = spar && sparBoutsLeft(current, now) === 0 ? 0 : asked;
  const granted = Math.min(allowed, harborXpLeft(current, now));
  const extra = Math.max(0, Math.floor(Number.isFinite(bonus) ? bonus : 0));
  return {
    granted,
    bonus: extra,
    asked,
    next: applyXp(hero, granted + extra),
    record: { day: today, used: current.used + granted, spars: current.spars + (spar ? 1 : 0) },
  };
}

/**
 * "+4 XP", "+2 XP (daily Harbor XP reached)", "+7 XP (3 for perfect splits)",
 * or "" when the pastime pays nothing. `bonus` is the XP given outside the cap.
 */
export function harborXpText(award: { granted: number; asked: number; bonus?: number; levelsGained?: number }): string {
  const bonus = Math.max(0, award.bonus ?? 0);
  if (award.asked <= 0 && bonus <= 0) return "";
  const level = award.levelsGained ? " Level up!" : "";
  const total = award.granted + bonus;
  if (total <= 0) return "No XP: daily Harbor XP reached.";
  const notes = [bonus > 0 ? `${bonus} for perfect splits` : "", award.granted < award.asked ? "daily Harbor XP reached" : ""].filter(Boolean);
  return `+${total} XP${notes.length ? ` (${notes.join("; ")})` : ""}.${level}`;
}
