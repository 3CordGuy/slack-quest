// A room's `xp` message, as the renderer's events: the sparkle over the hero, and the level-up flourish.

import type { WorldEvent, XpMessage } from "@gantt-quest/world";

export function xpEvents(m: XpMessage): WorldEvent[] {
  const out: WorldEvent[] = [{ t: "xp", heroId: m.id, amount: m.amount }];
  if (m.levelsGained > 0) out.push({ t: "level_up", heroId: m.id, level: m.level });
  return out;
}
