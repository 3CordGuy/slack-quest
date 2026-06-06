// Shared types for hand-authored expedition events.
//
// See docs/expedition-map.md "Event pool depth". Pass 1 ships ~10 events to
// prove the pattern; the remaining 50 (to reach the 60-event target) are
// follow-up content work.

export type EventTone = "grim" | "wry" | "hopeful" | "weird";
export type EventSetup = "encounter" | "discovery" | "dilemma" | "npc";
export type EventRisk = "safe" | "mixed" | "dangerous";
export type EventTheme = "greed" | "mercy" | "curiosity" | "fear";

/**
 * Outcomes are *declarative effects*. The expedition resolver translates
 * them into D1/character mutations — events themselves never touch the DB.
 *
 * Keep the surface small: gold delta, hp delta, mana delta, optional item
 * grant by catalog name, optional named status effect, optional XP delta.
 */
export interface EventOutcomeEffects {
  gold?: number;       // can be negative
  hp?: number;         // can be negative; applies to picker
  mana?: number;       // can be negative
  xp?: number;         // never negative in practice
  /** Catalog item name to grant (resolver looks it up by name). */
  item?: string;
  /** Free-form status effect name; resolver maps to existing effect system. */
  effect?: string;
}

export interface EventOutcome {
  /** Sampling weight within a branch (e.g. 60/30/10). */
  weight: number;
  /** Short hand-authored result text shown to the player. */
  text: string;
  effects?: EventOutcomeEffects;
}

export interface EventBranch {
  /** Stable id for analytics / logging. */
  id: string;
  /** Button label. */
  label: string;
  /** 2-3 outcome variants weighted by `weight`. */
  outcomes: EventOutcome[];
}

export interface ExpeditionEvent {
  /** Stable id; used for no-repeat tracking and analytics. */
  id: string;
  setup: EventSetup;
  tone: EventTone;
  risk: EventRisk;
  theme: EventTheme;
  /** Short scene title shown above the prose. */
  title: string;
  /** Hand-authored body text. Optional AI-flavor pass rewrites this layer only. */
  body: string;
  branches: EventBranch[];
}
