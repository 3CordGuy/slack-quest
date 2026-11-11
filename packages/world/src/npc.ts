// NPC conversations: free text in, validated verbs out.
//
// The model returns { say, intent?, attitude_delta }. `say` is only words.
// `intent` is a request to use one of the NPC's capabilities from the story
// bible; validateIntent decides whether it happens. Anything the model
// invents (items, gold, places, verbs) fails here and changes nothing.

import type { Capability, NpcSheet } from "./story";

export const NPC_VERBS = ["give_item", "reveal_location", "start_combat", "end_conversation"] as const;
export type NpcVerb = (typeof NPC_VERBS)[number];

export interface NpcIntent {
  verb: string;
  args: Record<string, unknown>;
}

export interface NpcOutput {
  say: string;
  intent: NpcIntent | null;
  attitudeDelta: number;
}

/** Per-run state of one NPC. */
export interface NpcRun {
  /** -2 hostile .. 2 devoted. */
  attitude: number;
  /** A hero has passed a persuasion check in this conversation. */
  persuaded: boolean;
  /** Capability ids already spent. Each fires once. */
  used: string[];
  /** Player messages so far, against MAX_NPC_MESSAGES. */
  messages: number;
  /** A model call is in flight. */
  busy: boolean;
  /** Fought the party; will not talk again. */
  hostile: boolean;
  /** Persuasion attempts per hero id. */
  attempts: Record<string, number>;
}

export const MAX_NPC_MESSAGES = 16;
export const MAX_PERSUADE_ATTEMPTS = 2;
export const MAX_PLAYER_TEXT = 280;
export const MAX_SAY = 600;

export const NPC_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string" },
    intent: {
      type: ["object", "null"],
      properties: {
        verb: { type: "string", enum: [...NPC_VERBS] },
        args: { type: "object" },
      },
      required: ["verb"],
    },
    attitude_delta: { type: "integer", minimum: -1, maximum: 1 },
  },
  required: ["say"],
} as const;

/** Parse whatever the model returned. Tolerates a JSON string, code fences, and missing optional fields. */
export function parseNpcOutput(raw: unknown): NpcOutput | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.say !== "string") return null;
  const say = o.say.replace(/\s+/g, " ").trim().slice(0, MAX_SAY);
  if (!say) return null;

  let intent: NpcIntent | null = null;
  if (o.intent && typeof o.intent === "object") {
    const i = o.intent as Record<string, unknown>;
    if (typeof i.verb === "string") {
      const args = i.args && typeof i.args === "object" && !Array.isArray(i.args) ? (i.args as Record<string, unknown>) : {};
      intent = { verb: i.verb, args };
    }
  }
  const delta = typeof o.attitude_delta === "number" && Number.isFinite(o.attitude_delta) ? o.attitude_delta : 0;
  return { say, intent, attitudeDelta: Math.max(-1, Math.min(1, Math.round(delta))) };
}

/** Capabilities the NPC could use right now. This is also what the prompt is allowed to mention. */
export function availableCapabilities(sheet: NpcSheet, run: NpcRun): Capability[] {
  if (run.hostile) return [];
  return sheet.capabilities.filter((c) => !run.used.includes(c.id) && (c.gate === "free" || run.persuaded));
}

export type IntentVerdict =
  | { ok: true; capability: Capability | null }
  | { ok: false; reason: string };

/**
 * Decide whether an intent from the model is allowed. A valid intent names
 * a known verb and matches, exactly, one unspent capability on this NPC's
 * sheet whose gate is open.
 */
export function validateIntent(sheet: NpcSheet, run: NpcRun, intent: NpcIntent): IntentVerdict {
  if (!(NPC_VERBS as readonly string[]).includes(intent.verb)) {
    return { ok: false, reason: `unknown verb "${intent.verb}"` };
  }
  if (intent.verb === "end_conversation") return { ok: true, capability: null };
  if (run.hostile) return { ok: false, reason: "npc is hostile" };

  const candidates = sheet.capabilities.filter((c) => c.verb === intent.verb);
  if (candidates.length === 0) return { ok: false, reason: `${sheet.id} cannot ${intent.verb}` };

  const match = candidates.find((c) => {
    if (c.verb === "give_item") return intent.args.item === c.item;
    if (c.verb === "reveal_location") return intent.args.poi === c.poi;
    return true;
  });
  if (!match) return { ok: false, reason: `${sheet.id} has nothing matching ${JSON.stringify(intent.args)}` };
  if (run.used.includes(match.id)) return { ok: false, reason: `${match.id} already used` };
  if (match.gate === "persuade" && !run.persuaded) return { ok: false, reason: `${match.id} needs a passed persuasion check` };
  return { ok: true, capability: match };
}

export function newNpcRun(): NpcRun {
  return { attitude: 0, persuaded: false, used: [], messages: 0, busy: false, hostile: false, attempts: {} };
}
