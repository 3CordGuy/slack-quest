// Admin content overrides: who may change them, what a valid override looks
// like, and how they are stored in D1 and handed to every client as one
// versioned bundle. Display only: names, palettes and pixel art. The rules
// in @gantt-quest/world keep using ids and never see any of this.

import { CATALOGUE, isCatalogueKind } from "@gantt-quest/world";
import { ITEM_ART_NAMES } from "../client/itemArt";
import { HATS, LOOKS, LOOK_COLORS, LOOK_WEAPONS, type Hat, type LookPalette, type Weapon } from "../client/render/looks";
import type { Env, Player } from "./db";

export const OVERRIDE_KINDS = ["name", "palette", "icon", "sprite"] as const;
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];

export interface NameValue {
  name?: string;
  blurb?: string;
}
export type PaletteValue = LookPalette;
export interface ImageValue {
  /** Base64 PNG, no data: prefix. */
  png: string;
}
export type OverrideValue = NameValue | PaletteValue | ImageValue;

/** Everything a client needs to draw the game with the current overrides. */
export interface ContentBundle {
  version: number;
  /** "<catalogue kind>:<id>" → name and/or blurb. */
  names: Record<string, NameValue>;
  /** Look kind → colour, hat and weapon changes. */
  palettes: Record<string, PaletteValue>;
  /** Icon name → 16×16 PNG. */
  icons: Record<string, ImageValue>;
  /** Sprite kind → 18×22 PNG. */
  sprites: Record<string, ImageValue>;
}

export const NAME_MAX = 32;
export const BLURB_MAX = 200;
export const PNG_MAX_BYTES = 4096;
export const ICON_SIZE = { w: 16, h: 16 };
export const SPRITE_SIZE = { w: 18, h: 22 };
/** Kinds drawn by their own functions rather than from LOOKS; a whole-sprite override may still replace them. */
const SPRITE_ONLY_KINDS = ["wolf", "alpha", "dummy"];

// ---------- who is an admin ----------

/** ADMIN_EMAILS is a comma-separated allow-list held as a Worker secret. Guests (no email) are never admins. */
export function isAdmin(env: Pick<Env, "ADMIN_EMAILS">, player: Pick<Player, "email">): boolean {
  if (!player.email || !env.ADMIN_EMAILS) return false;
  const allowed = env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(player.email.trim().toLowerCase());
}

// ---------- validation ----------

export type Checked = { ok: true; value: OverrideValue } | { ok: false; error: string };

const isKind = (k: string): k is OverrideKind => (OVERRIDE_KINDS as readonly string[]).includes(k);
const HEX = /^#[0-9a-f]{6}$/i;
// Control characters, including newlines and tabs.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");

/** Does `target` name something real for this kind of override? */
export function validTarget(kind: OverrideKind, target: string): boolean {
  if (kind === "name") {
    const sep = target.indexOf(":");
    if (sep < 1) return false;
    const cat = target.slice(0, sep);
    return isCatalogueKind(cat) && Object.hasOwn(CATALOGUE[cat], target.slice(sep + 1));
  }
  if (kind === "palette") return Object.hasOwn(LOOKS, target);
  if (kind === "icon") return ITEM_ART_NAMES.includes(target);
  return Object.hasOwn(LOOKS, target) || SPRITE_ONLY_KINDS.includes(target);
}

function cleanText(raw: unknown, max: number, label: string): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: `${label} must be text.` };
  const text = raw.trim();
  if (!text) return { ok: false, error: `${label} can't be empty.` };
  if (text.length > max) return { ok: false, error: `${label} is ${text.length} characters; the most is ${max}.` };
  if (CONTROL.test(text)) return { ok: false, error: `${label} can't contain line breaks or control characters.` };
  return { ok: true, text };
}

/** Width and height from a PNG's IHDR chunk, or null if the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || SIG.some((b, i) => bytes[i] !== b)) return null;
  // The first chunk must be IHDR: length (4) + "IHDR" (4), then width and height as big-endian u32.
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

function decodeBase64(b64: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function checkImage(raw: unknown, size: { w: number; h: number }): Checked {
  const png = (raw as ImageValue | null)?.png;
  if (typeof png !== "string") return { ok: false, error: "Send the image as { png: <base64> }." };
  const b64 = png.replace(/^data:image\/png;base64,/, "");
  // Reject before decoding anything huge: base64 is 4 chars per 3 bytes.
  if (b64.length > Math.ceil(PNG_MAX_BYTES / 3) * 4) return { ok: false, error: `The image is over ${PNG_MAX_BYTES} bytes.` };
  const bytes = decodeBase64(b64);
  if (!bytes) return { ok: false, error: "The image isn't valid base64." };
  if (bytes.length > PNG_MAX_BYTES) return { ok: false, error: `The image is over ${PNG_MAX_BYTES} bytes.` };
  const dims = pngSize(bytes);
  if (!dims) return { ok: false, error: "The image isn't a PNG." };
  if (dims.w !== size.w || dims.h !== size.h) return { ok: false, error: `The image is ${dims.w}×${dims.h}; it must be ${size.w}×${size.h}.` };
  return { ok: true, value: { png: b64 } };
}

/** Check one override from an admin and return it in its stored form. */
export function checkOverride(kind: string, target: string, raw: unknown): Checked {
  if (!isKind(kind)) return { ok: false, error: `Unknown override kind "${kind}".` };
  if (!validTarget(kind, target)) return { ok: false, error: `Nothing called "${target}" can take a ${kind} override.` };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The value must be an object." };
  const body = raw as Record<string, unknown>;

  if (kind === "name") {
    const out: NameValue = {};
    for (const key of Object.keys(body)) if (key !== "name" && key !== "blurb") return { ok: false, error: `Unknown field "${key}".` };
    if (body.name !== undefined) {
      const t = cleanText(body.name, NAME_MAX, "Name");
      if (!t.ok) return t;
      out.name = t.text;
    }
    if (body.blurb !== undefined) {
      const t = cleanText(body.blurb, BLURB_MAX, "Blurb");
      if (!t.ok) return t;
      out.blurb = t.text;
    }
    if (out.name === undefined && out.blurb === undefined) return { ok: false, error: "Give a name, a blurb, or both." };
    return { ok: true, value: out };
  }

  if (kind === "palette") {
    const out: PaletteValue = {};
    for (const [key, v] of Object.entries(body)) {
      if ((LOOK_COLORS as readonly string[]).includes(key)) {
        if (typeof v !== "string" || !HEX.test(v)) return { ok: false, error: `${key} must be a colour like #a1b2c3.` };
        out[key as (typeof LOOK_COLORS)[number]] = v.toLowerCase();
      } else if (key === "hat") {
        if (typeof v !== "string" || !(HATS as readonly string[]).includes(v)) return { ok: false, error: `hat must be one of ${HATS.join(", ")}.` };
        out.hat = v as Hat;
      } else if (key === "weapon") {
        if (typeof v !== "string" || !(LOOK_WEAPONS as readonly string[]).includes(v)) return { ok: false, error: `weapon must be one of ${LOOK_WEAPONS.join(", ")}.` };
        out.weapon = v as Weapon;
      } else return { ok: false, error: `Unknown field "${key}".` };
    }
    if (!Object.keys(out).length) return { ok: false, error: "Change at least one colour, the hat or the weapon." };
    return { ok: true, value: out };
  }

  return checkImage(body, kind === "icon" ? ICON_SIZE : SPRITE_SIZE);
}

// ---------- storage ----------

export interface OverrideRow {
  kind: OverrideKind;
  target: string;
  value: OverrideValue;
  updated_by: string;
  updated_at: number;
}

export interface HistoryRow {
  id: number;
  old: OverrideValue | null;
  new: OverrideValue | null;
  by: string;
  by_name: string | null;
  at: number;
}

export async function contentVersion(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT v FROM content_meta WHERE k = 'version'").first<{ v: string }>();
  return Number(row?.v ?? 0);
}

export async function listOverrides(db: D1Database): Promise<OverrideRow[]> {
  const { results } = await db
    .prepare("SELECT kind, target, value_json, updated_by, updated_at FROM content_overrides ORDER BY kind, target")
    .all<{ kind: OverrideKind; target: string; value_json: string; updated_by: string; updated_at: number }>();
  return results.map((r) => ({ kind: r.kind, target: r.target, value: JSON.parse(r.value_json), updated_by: r.updated_by, updated_at: r.updated_at }));
}

export async function contentBundle(db: D1Database): Promise<ContentBundle> {
  const [version, rows] = await Promise.all([contentVersion(db), listOverrides(db)]);
  const bundle: ContentBundle = { version, names: {}, palettes: {}, icons: {}, sprites: {} };
  const slot = { name: bundle.names, palette: bundle.palettes, icon: bundle.icons, sprite: bundle.sprites } as const;
  for (const r of rows) (slot[r.kind] as Record<string, OverrideValue>)[r.target] = r.value;
  return bundle;
}

const BUMP = "UPDATE content_meta SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) WHERE k = 'version'";
const LOG =
  "INSERT INTO content_override_log (kind, target, old_json, new_json, by, at) VALUES (?1, ?2, (SELECT value_json FROM content_overrides WHERE kind = ?1 AND target = ?2), ?3, ?4, ?5)";

function setStatements(db: D1Database, kind: OverrideKind, target: string, value: OverrideValue, by: string, at: number): D1PreparedStatement[] {
  const json = JSON.stringify(value);
  return [
    db.prepare(LOG).bind(kind, target, json, by, at),
    db
      .prepare(
        "INSERT INTO content_overrides (kind, target, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, target) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      )
      .bind(kind, target, json, by, at),
  ];
}

/** Save a checked override. One batch: history, the row, and a new bundle version. */
export async function putOverride(db: D1Database, kind: OverrideKind, target: string, value: OverrideValue, by: string): Promise<number> {
  await db.batch([...setStatements(db, kind, target, value, by, Date.now()), db.prepare(BUMP)]);
  return contentVersion(db);
}

/** Revert to the code default. Returns false when there was no override. */
export async function deleteOverride(db: D1Database, kind: OverrideKind, target: string, by: string): Promise<boolean> {
  const exists = await db.prepare("SELECT 1 FROM content_overrides WHERE kind = ? AND target = ?").bind(kind, target).first();
  if (!exists) return false;
  await db.batch([
    db.prepare(LOG).bind(kind, target, null, by, Date.now()),
    db.prepare("DELETE FROM content_overrides WHERE kind = ? AND target = ?").bind(kind, target),
    db.prepare(BUMP),
  ]);
  return true;
}

/** Save many checked overrides at once (an import). Existing overrides not in the list are left alone. */
export async function putOverrides(db: D1Database, items: { kind: OverrideKind; target: string; value: OverrideValue }[], by: string): Promise<number> {
  if (!items.length) return contentVersion(db);
  const at = Date.now();
  await db.batch([...items.flatMap((i) => setStatements(db, i.kind, i.target, i.value, by, at)), db.prepare(BUMP)]);
  return contentVersion(db);
}

export async function overrideHistory(db: D1Database, kind: OverrideKind, target: string, limit = 50): Promise<HistoryRow[]> {
  const { results } = await db
    .prepare(
      "SELECT l.id, l.old_json, l.new_json, l.by, p.name AS by_name, l.at FROM content_override_log l LEFT JOIN players p ON p.id = l.by WHERE l.kind = ? AND l.target = ? ORDER BY l.id DESC LIMIT ?",
    )
    .bind(kind, target, limit)
    .all<{ id: number; old_json: string | null; new_json: string | null; by: string; by_name: string | null; at: number }>();
  return results.map((r) => ({
    id: r.id,
    old: r.old_json ? JSON.parse(r.old_json) : null,
    new: r.new_json ? JSON.parse(r.new_json) : null,
    by: r.by,
    by_name: r.by_name,
    at: r.at,
  }));
}

export interface LogRow extends HistoryRow {
  kind: OverrideKind;
  target: string;
}

/** The latest changes of every kind, newest first: the admin page's change log. */
export async function recentLog(db: D1Database, limit = 100, before?: number): Promise<LogRow[]> {
  const { results } = await db
    .prepare(
      "SELECT l.id, l.kind, l.target, l.old_json, l.new_json, l.by, p.name AS by_name, l.at FROM content_override_log l LEFT JOIN players p ON p.id = l.by WHERE (?1 IS NULL OR l.id < ?1) ORDER BY l.id DESC LIMIT ?2",
    )
    .bind(before ?? null, Math.max(1, Math.min(limit, 200)))
    .all<{ id: number; kind: OverrideKind; target: string; old_json: string | null; new_json: string | null; by: string; by_name: string | null; at: number }>();
  return results.map((r) => ({
    id: r.id,
    kind: r.kind,
    target: r.target,
    old: r.old_json ? JSON.parse(r.old_json) : null,
    new: r.new_json ? JSON.parse(r.new_json) : null,
    by: r.by,
    by_name: r.by_name,
    at: r.at,
  }));
}

/** An exported bundle turned back into a list of overrides, each checked as if it were sent one at a time. */
export function checkImport(bundle: unknown): { ok: true; items: { kind: OverrideKind; target: string; value: OverrideValue }[] } | { ok: false; error: string } {
  if (!bundle || typeof bundle !== "object") return { ok: false, error: "Import a JSON object exported from the admin page." };
  const b = bundle as Record<string, unknown>;
  const sections: [string, OverrideKind][] = [["names", "name"], ["palettes", "palette"], ["icons", "icon"], ["sprites", "sprite"]];
  const items: { kind: OverrideKind; target: string; value: OverrideValue }[] = [];
  for (const [section, kind] of sections) {
    const entries = b[section];
    if (entries === undefined) continue;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return { ok: false, error: `"${section}" must be an object.` };
    for (const [target, raw] of Object.entries(entries)) {
      const checked = checkOverride(kind, target, raw);
      if (!checked.ok) return { ok: false, error: `${section}.${target}: ${checked.error}` };
      items.push({ kind, target, value: checked.value });
    }
  }
  return { ok: true, items };
}

export const isOverrideKind = isKind;
