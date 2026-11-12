// Recolour a class's, enemy's or townsperson's sprite: five body colours, an
// optional hat colour, and the hat and weapon they carry. The preview draws
// the draft with the game's own sprite code.

import { useState } from "react";
import type { Outfit } from "@gantt-quest/world";
import type { PaletteValue } from "../../server/content";
import { HATS, LOOKS, LOOK_WEAPONS, type LookPalette } from "../render/looks";
import { previewSpriteUrl } from "../render/sprites";
import { adminApi } from "./adminApi";
import { History, lookGroup, lookName, useRunner, type EditorProps } from "./shared";

const COLOURS = [
  ["skin", "Skin"],
  ["hair", "Hair"],
  ["body", "Body"],
  ["legs", "Legs"],
  ["accent", "Accent"],
] as const;

/** Something to wear in the hero preview, so the gear's colours can be judged against the new ones. */
const SAMPLE_OUTFIT: Outfit = {
  body: { icon: "chest-armor", ref: "hauberk", rarity: "rare" },
  helmet: { icon: "heavy-helm", ref: "helm", rarity: "rare" },
  main_hand: { icon: "broadsword", ref: "greatsword", rarity: "rare" },
};

/** Keep only the fields that differ from the code default, so a later code change to the rest still shows. */
export function paletteDiff(kind: string, draft: LookPalette): PaletteValue {
  const base = LOOKS[kind];
  const out: PaletteValue = {};
  for (const [k, v] of Object.entries(draft) as [keyof LookPalette, string | undefined][]) {
    if (v !== undefined && v !== base[k]) (out as Record<string, string>)[k] = v;
  }
  return out;
}

const sameValue = (a: PaletteValue | undefined, b: PaletteValue) => JSON.stringify(a ?? {}) === JSON.stringify(b);

function Swatches({ v }: { v: PaletteValue }) {
  return (
    <span className="admin-swatches">
      {Object.entries(v).map(([k, c]) =>
        c.startsWith("#") ? <i key={k} title={`${k} ${c}`} style={{ background: c }} /> : <span key={k} className="muted"> {k}: {c}</span>,
      )}
    </span>
  );
}
export { Swatches };

export function PaletteEditor({ kind, current, ...props }: { kind: string; current: PaletteValue | undefined } & EditorProps) {
  const base = LOOKS[kind];
  const start = { ...base, ...current };
  const [draft, setDraft] = useState<LookPalette>({
    skin: start.skin,
    hair: start.hair,
    body: start.body,
    legs: start.legs,
    accent: start.accent,
    hatColor: start.hatColor,
    hat: start.hat,
    weapon: start.weapon,
  });
  const { busy, run } = useRunner(props);
  const value = paletteDiff(kind, draft);
  const changed = !sameValue(current, value);
  const name = lookName(kind);
  const set = (patch: LookPalette) => setDraft((d) => ({ ...d, ...patch }));

  const save = () =>
    Object.keys(value).length === 0
      ? run(() => adminApi.revert("palette", kind), `${name} is back to its default look.`)
      : run(() => adminApi.save("palette", kind, value), `Saved ${name}'s look.`);

  const previews: [string, string][] = [
    ["Now", previewSpriteUrl(kind, current)],
    ["Draft", previewSpriteUrl(kind, draft)],
    ["Asleep", previewSpriteUrl(kind, draft, undefined, true)],
  ];
  if (lookGroup(kind) === "class") previews.push(["In gear", previewSpriteUrl(kind, draft, SAMPLE_OUTFIT)]);

  return (
    <section className="admin-editor panel">
      <h2>{name}</h2>
      <p className="muted">look:{kind} · changes the sprite's colours only</p>

      <div className="admin-sprite-previews">
        {previews.map(([cap, url]) => (
          <figure key={cap}>
            <img src={url} alt={`${name}, ${cap.toLowerCase()}`} className="pixel" width={18 * 4} height={22 * 4} />
            <figcaption className="muted">{cap}</figcaption>
          </figure>
        ))}
        <figure>
          <img src={previews[1][1]} alt="" className="pixel" width={18} height={22} />
          <figcaption className="muted">1×</figcaption>
        </figure>
      </div>

      <div className="admin-colours">
        {COLOURS.map(([key, text]) => (
          <label key={key} className="admin-colour">
            <input type="color" value={draft[key]} onChange={(e) => set({ [key]: e.target.value })} />
            <span>{text}</span>
            {draft[key] !== base[key] && (
              <button className="small" title={`Back to ${base[key]}`} onClick={() => set({ [key]: base[key] })}>↺</button>
            )}
          </label>
        ))}
        <label className="admin-colour">
          <input
            type="checkbox"
            checked={draft.hatColor !== undefined}
            disabled={base.hatColor !== undefined}
            onChange={(e) => set({ hatColor: e.target.checked ? (base.hatColor ?? draft.body) : undefined })}
          />
          <span>Own hat colour</span>
          {draft.hatColor !== undefined && <input type="color" value={draft.hatColor} onChange={(e) => set({ hatColor: e.target.value })} />}
        </label>
      </div>

      <div className="admin-selects">
        <label className="admin-field">
          <span>Hat</span>
          <select value={draft.hat} onChange={(e) => set({ hat: e.target.value as LookPalette["hat"] })}>
            {HATS.map((h) => <option key={h} value={h}>{h}{h === base.hat ? " (default)" : ""}</option>)}
          </select>
        </label>
        <label className="admin-field">
          <span>Weapon</span>
          <select value={draft.weapon} onChange={(e) => set({ weapon: e.target.value as LookPalette["weapon"] })}>
            {LOOK_WEAPONS.map((w) => <option key={w} value={w}>{w}{w === base.weapon ? " (default)" : ""}</option>)}
          </select>
        </label>
      </div>
      <p className="muted">Heroes wearing gear show their equipped helmet and weapon in place of these.</p>

      <div className="admin-actions">
        <button className="primary" disabled={busy || !changed} onClick={() => void save()}>Save</button>
        <button disabled={busy} onClick={() => setDraft({ ...base })}>Reset draft to default</button>
        <button disabled={busy || !current} onClick={() => void run(() => adminApi.revert("palette", kind), `${name} is back to its default look.`)}>Revert to default</button>
      </div>

      <History<PaletteValue>
        kind="palette"
        target={kind}
        current={current}
        busy={busy}
        render={(v) => <Swatches v={v} />}
        onRestore={(v) => void run(() => adminApi.save("palette", kind, v), "Restored that version.")}
      />
    </section>
  );
}
