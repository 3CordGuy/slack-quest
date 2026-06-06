// Expedition event pool + sampler.
//
// Pass 2 ships 60 events (encounter 16, discovery 15, dilemma 15, npc 14)
// hitting the design doc's 60-event floor — see docs/expedition-map.md
// "Authoring distribution for the 60-event pool".
//
// Sampler rules (from the design doc):
//   1. No repeat within a single expedition.
//   2. Last 10 events seen by a character (across all expeditions) excluded.
//   3. Soft weight bias against any event the character has resolved 3+ times
//      in their last 50 events.
//   4. Tag-based anti-monotony bias: soft-penalize matching tone/setup/risk
//      against the previous 2-3 events on the same expedition. Specifically
//      back-to-back grim+dilemma must be biased *down*, not banned outright.

import type {
  EventBranch,
  EventOutcome,
  EventRisk,
  EventSetup,
  EventTheme,
  EventTone,
  ExpeditionEvent,
} from "./types";
import { ENCOUNTER_EVENTS } from "./encounter";
import { DISCOVERY_EVENTS } from "./discovery";
import { DILEMMA_EVENTS } from "./dilemma";
import { NPC_EVENTS } from "./npc";

export type {
  ExpeditionEvent,
  EventBranch,
  EventOutcome,
  EventTone,
  EventSetup,
  EventRisk,
  EventTheme,
};
export { ENCOUNTER_EVENTS, DISCOVERY_EVENTS, DILEMMA_EVENTS, NPC_EVENTS };

/** Full v1 event pool. Pass 2: 60 events across 4 setup categories. */
export const ALL_EVENTS: ExpeditionEvent[] = [
  ...ENCOUNTER_EVENTS,
  ...DISCOVERY_EVENTS,
  ...DILEMMA_EVENTS,
  ...NPC_EVENTS,
];

export function findEventById(id: string): ExpeditionEvent | null {
  return ALL_EVENTS.find((e) => e.id === id) ?? null;
}

// ---------- sampler ----------

export interface SamplerHistory {
  /** Event ids already resolved in the current expedition. */
  expeditionResolvedIds: readonly string[];
  /** Last N (target: 10) events resolved by this character across all expeditions, most-recent first. */
  recentCharacterEventIds: readonly string[];
  /** Last ~50 events resolved by this character — used for 3+ overuse penalty. */
  longTailCharacterEventIds: readonly string[];
  /** Last 2-3 events resolved in *this* expedition for anti-monotony bias. */
  recentExpeditionTags: readonly Pick<
    ExpeditionEvent,
    "tone" | "setup" | "risk" | "theme"
  >[];
}

export interface SampleArgs {
  /** Pure RNG: must return a float in [0, 1). */
  rng: () => number;
  history: SamplerHistory;
  /** Optional override of the pool — defaults to ALL_EVENTS. */
  pool?: readonly ExpeditionEvent[];
}

const RECENCY_CHARACTER_EXCLUSION = 10;
const OVERUSE_LOOKBACK = 50;
const OVERUSE_THRESHOLD = 3;
const ANTI_MONOTONY_LOOKBACK = 3;

// Penalty multipliers; multiplicative so they compose.
const PENALTY_TONE_MATCH = 0.6;
const PENALTY_SETUP_MATCH = 0.6;
const PENALTY_RISK_MATCH = 0.8;
const PENALTY_OVERUSED = 0.4;

/**
 * Sample one event from the pool given the character/expedition history.
 * Returns null only if every event in the pool is hard-excluded (this should
 * not happen with a 60-event pool but can happen in the 10-event Pass 1
 * world if a single character has seen all of them recently — the caller is
 * expected to relax constraints in that edge case).
 */
export function sampleEvent(args: SampleArgs): ExpeditionEvent | null {
  const pool = args.pool ?? ALL_EVENTS;
  const { history, rng } = args;

  const recentChar = new Set(
    history.recentCharacterEventIds.slice(0, RECENCY_CHARACTER_EXCLUSION),
  );
  const inExpedition = new Set(history.expeditionResolvedIds);

  // Tally long-tail usage.
  const tailWindow = history.longTailCharacterEventIds.slice(0, OVERUSE_LOOKBACK);
  const tailCounts = new Map<string, number>();
  for (const id of tailWindow) {
    tailCounts.set(id, (tailCounts.get(id) ?? 0) + 1);
  }

  // Last few tags in this expedition for anti-monotony.
  const recentTags = history.recentExpeditionTags.slice(0, ANTI_MONOTONY_LOOKBACK);

  // Compute weights.
  const weighted: { event: ExpeditionEvent; weight: number }[] = [];
  for (const event of pool) {
    if (inExpedition.has(event.id)) continue;   // hard exclude (rule 1)
    if (recentChar.has(event.id)) continue;     // hard exclude (rule 2)

    let w = 1.0;
    if ((tailCounts.get(event.id) ?? 0) >= OVERUSE_THRESHOLD) {
      w *= PENALTY_OVERUSED;                    // soft penalty (rule 3)
    }
    // Anti-monotony: soft penalty per tag match against recent expedition tags.
    for (const tag of recentTags) {
      if (tag.tone === event.tone) w *= PENALTY_TONE_MATCH;
      if (tag.setup === event.setup) w *= PENALTY_SETUP_MATCH;
      if (tag.risk === event.risk) w *= PENALTY_RISK_MATCH;
    }
    weighted.push({ event, weight: w });
  }

  if (weighted.length === 0) return null;

  const total = weighted.reduce((acc, w) => acc + w.weight, 0);
  if (total <= 0) return weighted[0].event;
  let r = rng() * total;
  for (const { event, weight } of weighted) {
    r -= weight;
    if (r <= 0) return event;
  }
  return weighted[weighted.length - 1].event;
}

/**
 * Sample one outcome variant from a branch using its declared weights.
 * Pure — RNG is injected.
 */
export function sampleOutcome(rng: () => number, branch: EventBranch): EventOutcome {
  const total = branch.outcomes.reduce((acc, o) => acc + o.weight, 0);
  let r = rng() * total;
  for (const o of branch.outcomes) {
    r -= o.weight;
    if (r <= 0) return o;
  }
  return branch.outcomes[branch.outcomes.length - 1];
}
