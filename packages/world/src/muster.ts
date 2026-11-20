// A muster: one of the crew is setting out for a place on the atlas, and
// the rest who are in town are asked whether they are coming.
//
// Whoever sets out calls it. Everyone else in the crew's Harbor is shown
// where to and how long is left, and says "ready" or "not this time". The
// map is made when the caller says "start anyway", when everyone asked has
// answered, or when the time runs out, whichever comes first; it is made for
// as many as are ready, and only they are taken to it. Nobody has to go:
// one who said no, or said nothing, stays in town, and can still walk
// through the waygate to the map later.
//
// This file is the rules of it, with no clock and no network of its own: the
// crew's Harbor room (apps/game/src/server/harbor-room.ts) keeps the muster,
// its timer, and makes the map.

/** How long a muster waits for answers. */
export const MUSTER_MS = 60_000;
/** How long a muster that has started (or fallen through) is still told to those who ask: long enough for everyone to hear how it ended. */
export const MUSTER_LINGER_MS = 20_000;

export interface MusterMember {
  id: string;
  name: string;
}

export interface Muster {
  id: string;
  /** Who called it: the one setting out. They are ready from the first. */
  by: MusterMember;
  /** Where to: the atlas node, and what to call it. */
  node: string;
  place: string;
  /** What kind of place it is, and the level of what is there, for the prompt. */
  site?: string;
  level?: number;
  /** When it starts whether or not everyone has answered (ms since the epoch). */
  deadline: number;
  /** Who was in town when it was called, besides the caller: the ones it waits for. */
  asked: MusterMember[];
  /** Who is coming, the caller first; and who has said they are not. */
  ready: MusterMember[];
  declined: string[];
  /** Once it has started: the map's code, and when. */
  code?: string;
  /** If it fell through (called off, or the map could not be made): why. */
  failed?: string;
  endedAt?: number;
}

/** What someone can say to a muster. "start" and "cancel" are the caller's alone. */
export type MusterAnswer = "ready" | "no" | "start" | "cancel";
export const MUSTER_ANSWERS: readonly MusterAnswer[] = ["ready", "no", "start", "cancel"];

/** The most a map is made for. */
export const MUSTER_PARTY = 4;

export function callMuster(id: string, by: MusterMember, to: { node: string; place: string; site?: string; level?: number }, asked: MusterMember[], now: number): Muster {
  return {
    id,
    by,
    node: to.node,
    place: to.place,
    ...(to.site ? { site: to.site } : {}),
    ...(to.level !== undefined ? { level: to.level } : {}),
    deadline: now + MUSTER_MS,
    asked: asked.filter((m) => m.id !== by.id),
    ready: [by],
    declined: [],
  };
}

/** Whether it is still waiting for answers. */
export const musterOpen = (m: Muster | null | undefined): boolean => !!m && !m.code && !m.failed;

/** Whether it is worth telling anyone about: waiting, or ended so lately that not everyone may have heard. */
export const musterShown = (m: Muster | null | undefined, now: number): boolean => !!m && (musterOpen(m) || (m.endedAt !== undefined && now - m.endedAt < MUSTER_LINGER_MS));

/** Whether everyone it waits for has said one thing or the other. */
export const musterAnswered = (m: Muster): boolean => m.asked.every((a) => m.ready.some((r) => r.id === a.id) || m.declined.includes(a.id));

/** Whether it should start now: the time is up, everyone asked has answered, or there is no room for another. */
export const musterDue = (m: Muster, now: number): boolean => musterOpen(m) && (now >= m.deadline || musterAnswered(m) || m.ready.length >= MUSTER_PARTY);

/**
 * Someone answers. Returns the muster as it now stands and whether that answer starts it (`start`) or calls it off
 * (`cancel`), or why the answer was not taken (`error`). The muster handed in is not changed.
 */
export function answerMuster(m: Muster, who: MusterMember, answer: MusterAnswer, now: number): { muster: Muster; start?: true; cancel?: true } | { error: string } {
  if (!musterOpen(m)) return { error: m.code ? "They have set out already." : "That muster is over." };
  const caller = who.id === m.by.id;
  if (answer === "start" || answer === "cancel") {
    if (!caller) return { error: `Only ${m.by.name} can do that: it is their muster.` };
    return answer === "start" ? { muster: m, start: true } : { muster: m, cancel: true };
  }
  if (caller) return { error: "You called it: you are going. Call it off if you are not." };
  const others = m.ready.filter((r) => r.id !== who.id);
  if (answer === "ready") {
    if (others.length >= MUSTER_PARTY) return { error: `There is room for ${MUSTER_PARTY}, and they are spoken for.` };
    const next: Muster = { ...m, ready: [...others, who], declined: m.declined.filter((id) => id !== who.id) };
    return musterDue(next, now) ? { muster: next, start: true } : { muster: next };
  }
  const next: Muster = { ...m, ready: others, declined: [...m.declined.filter((id) => id !== who.id), who.id] };
  return musterDue(next, now) ? { muster: next, start: true } : { muster: next };
}
