// Who a crew is fighting, as the battle cards name them. Pure, so it can be tested.

import { ENEMIES } from "@gantt-quest/world";
import { label } from "./labels";

/**
 * The foes of a fight, for a card. A fight with a boss in it names everyone
 * as the battle does, so the boss goes by the name the story gave it ("the
 * Sleepless Sow, Brute"); otherwise kinds are counted up ("2 × Dire Wolf").
 */
export function foeNames(foes: { kind: string; name: string }[]): string {
  if (foes.some((c) => ENEMIES[c.kind]?.boss)) return foes.map((c) => c.name).join(", ");
  const count = new Map<string, number>();
  for (const { kind } of foes) count.set(kind, (count.get(kind) ?? 0) + 1);
  return [...count].map(([k, n]) => (n > 1 ? `${n} × ${label("enemy", k)}` : label("enemy", k))).join(", ");
}

/** To open a sentence: "the Sleepless Sow beaten." reads "The Sleepless Sow beaten." */
export const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
