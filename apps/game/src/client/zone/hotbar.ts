// How a fight's bar is laid out: twenty slots in two rows of ten (keys 1 to 9
// and 0, the bottom row with Shift), each holding
// one thing the hero can do, by key: `ab:<ability>`, `do:<common action>`,
// `it:<item>`, or "" for an empty slot. The player arranges it (drag to swap,
// right-click to choose) and the arrangement is kept in this browser, one
// per class, since what there is to put on it depends on the class and the
// weapon in hand.

import type { CommonAction, Throwable } from "@gantt-quest/world";

export const BAR_ROW = 10;
/** How wide a row was before it grew to ten: a bar saved then is widened, not thrown away. */
const OLD_BAR_ROW = 9;
export const BAR_SLOTS = BAR_ROW * 2;

export const COMMON_ORDER: CommonAction[] = ["disengage", "jump", "shove", "help", "flee"];
export const ITEM_ORDER: Throwable[] = ["healing", "poison", "fire", "oil", "water", "acid", "slime", "torch"];

const key = (kind: string) => `gq.zone.bar.${kind}`;
const pad = (keys: string[], to: number) => [...keys, ...Array.from({ length: Math.max(0, to - keys.length) }, () => "")].slice(0, to);

/** Everything a hero with these abilities could put on the bar. */
export function barChoices(abilities: string[]): string[] {
  return [...abilities.map((a) => `ab:${a}`), ...COMMON_ORDER.map((c) => `do:${c}`), ...ITEM_ORDER.map((i) => `it:${i}`)];
}

/**
 * The bar as it starts out: abilities and the common actions along the top, the pack along the bottom, and Flee
 * at the end of it. What the top row has no room for goes on the bottom one, before Flee.
 */
export function defaultBar(abilities: string[]): string[] {
  const top = [...abilities.map((a) => `ab:${a}`), ...COMMON_ORDER.filter((c) => c !== "flee").map((c) => `do:${c}`)];
  return [...pad(top, BAR_ROW), ...pad([...ITEM_ORDER.map((i) => `it:${i}`), ...top.slice(BAR_ROW)], BAR_ROW - 1), "do:flee"];
}

/** A bar saved when a row was OLD_BAR_ROW long, as it is now: each row gets the new slots on its end, empty. */
function widened(saved: unknown): unknown {
  if (!Array.isArray(saved) || saved.length !== OLD_BAR_ROW * 2) return saved;
  return [...pad(saved.slice(0, OLD_BAR_ROW), BAR_ROW), ...pad(saved.slice(OLD_BAR_ROW), BAR_ROW)];
}

/**
 * The bar this class was last left with, made to fit what the hero has now: anything they no longer
 * have is dropped, and an ability the bar has never held (a new weapon's) takes the first empty slot.
 */
export function loadBar(kind: string, abilities: string[]): string[] {
  let saved: unknown = null;
  try {
    saved = widened(JSON.parse(localStorage.getItem(key(kind)) ?? "null"));
  } catch {
    // Blocked or broken storage: the default it is.
  }
  if (!Array.isArray(saved) || saved.length !== BAR_SLOTS || saved.some((s) => typeof s !== "string")) return defaultBar(abilities);
  const can = new Set(barChoices(abilities));
  const seen = new Set<string>();
  const bar = (saved as string[]).map((s) => {
    if (!can.has(s) || seen.has(s)) return "";
    seen.add(s);
    return s;
  });
  for (const ability of abilities.map((a) => `ab:${a}`)) {
    const free = bar.indexOf("");
    if (!seen.has(ability) && free >= 0) bar[free] = ability;
  }
  return bar;
}

export function saveBar(kind: string, bar: string[]): void {
  try {
    localStorage.setItem(key(kind), JSON.stringify(bar));
  } catch {
    // Blocked storage: the arrangement lasts until the page is closed.
  }
}

/** Swap two slots. */
export function moveSlot(bar: string[], from: number, to: number): string[] {
  const next = [...bar];
  [next[from], next[to]] = [next[to] ?? "", next[from] ?? ""];
  return next;
}

/** Put something in a slot ("" to empty it). If it was in another slot, what was here goes there: nothing is on the bar twice. */
export function assignSlot(bar: string[], index: number, what: string): string[] {
  const next = [...bar];
  const was = what ? next.indexOf(what) : -1;
  if (was >= 0) next[was] = next[index];
  next[index] = what;
  return next;
}
