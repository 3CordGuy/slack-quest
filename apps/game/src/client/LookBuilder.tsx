// The look builder at character creation: the hero's body, head and face,
// skin and hair, each picked from a few presets (packages/world appearance.ts),
// with the hero turning beside them. They can be seen in their class's
// starting clothes, which they will have as items, or in what is under them.

import { useMemo, useState } from "react";
import {
  APPEARANCE_OPTIONS,
  HAIR_COLORS,
  SKIN_TONES,
  heroClass,
  randomAppearance,
  starterGarb,
  weaponItem,
  type Appearance,
  type Outfit,
} from "@gantt-quest/world";
import { FigurePreview } from "./FigurePreview";
import { InkEditor } from "./InkEditor";
import "./builder.css";

type Field = keyof typeof APPEARANCE_OPTIONS;

/** The pickers, grouped as the panel shows them. */
const GROUPS: { title: string; fields: [Field, string][] }[] = [
  { title: "Body", fields: [["height", "Height"], ["build", "Build"], ["shoulders", "Shoulders"], ["hips", "Hips"]] },
  { title: "Head", fields: [["headSize", "Head size"], ["headShape", "Head shape"], ["ears", "Ears"], ["hairStyle", "Hair"]] },
  { title: "Face", fields: [["eyes", "Eyes"], ["nose", "Nose"], ["mustache", "Mustache"], ["beard", "Beard"]] },
];

/** What a hero of `classId` wears on their first day, with their look on it; `dressed` false for none of it. */
export function startingOutfit(classId: string, look: Appearance, dressed = true): Outfit {
  const outfit: Outfit = { appearance: look };
  if (!dressed) return outfit;
  const weapon = heroClass(classId)?.weapons[0];
  for (const item of [...(weapon ? [weaponItem(weapon)] : []), ...starterGarb(classId)]) outfit[item.slot] = { icon: item.icon, ref: item.ref, rarity: item.rarity };
  return outfit;
}

/**
 * `wearing` is what a hero already out in the world has on, to see them in instead of their class's
 * starting clothes (changing their look from their sheet; see ChangeLook).
 */
export function LookBuilder({ classId, look, onChange, wearing }: { classId: string; look: Appearance; onChange(next: Appearance): void; wearing?: Outfit }) {
  const [dressed, setDressed] = useState(true);
  const [spin, setSpin] = useState(true);
  const [walk, setWalk] = useState(false);
  // Which way to turn the hero: set when a side of the paper doll is drawn on, to show that side.
  const [aim, setAim] = useState<{ turn: number; n: number } | null>(null);
  const outfit = useMemo(() => (wearing && dressed ? { ...wearing, appearance: look } : startingOutfit(classId, look, dressed)), [classId, look, dressed, wearing]);
  const set = <K extends keyof Appearance>(field: K, value: Appearance[K]) => onChange({ ...look, [field]: value });

  return (
    <div className="look-builder">
      <div className="look-stage">
        <span className="look-plinth">
          <FigurePreview classId={classId} outfit={outfit} size={260} spin={spin} walk={walk} aim={aim} />
          <button type="button" className="small look-walk" aria-pressed={walk} onClick={() => setWalk(!walk)}>
            {walk ? "■ Stand" : "Walk"}
          </button>
          <button type="button" className="small look-spin" aria-pressed={!spin} onClick={() => setSpin(!spin)} title={spin ? "Stop turning" : "Turn"}>
            {spin ? "❚❚ Stop turning" : "▶ Turn"}
          </button>
        </span>
        <div className="look-stage-row" role="group" aria-label="What they are wearing">
          <button type="button" className={`small ${dressed ? "selected" : ""}`} aria-pressed={dressed} onClick={() => setDressed(true)}>
            {wearing ? "What they wear" : "Starting clothes"}
          </button>
          <button type="button" className={`small ${!dressed ? "selected" : ""}`} aria-pressed={!dressed} onClick={() => setDressed(false)}>
            Undergarments
          </button>
        </div>
        <button type="button" className="small look-dice" onClick={() => onChange({ ...randomAppearance(), ink: look.ink })}>
          <span aria-hidden>🎲</span> Surprise me
        </button>
        <p className="muted hint">Drag to turn them by hand. The hat, tunic, trousers and shoes are items you can take off or swap for armor.</p>
      </div>

      <div className="look-pickers">
        {GROUPS.map((g) => (
          <fieldset key={g.title} className="look-group">
            <legend>{g.title}</legend>
            {g.fields.map(([field, name]) => (
              <div key={field} className="look-row" role="radiogroup" aria-label={name}>
                <span className="look-label">{name}</span>
                <span className="look-chips">
                  {(APPEARANCE_OPTIONS[field] as readonly { id: string; label: string }[]).map((p) => {
                    const on = look[field] === p.id;
                    return (
                      <button key={p.id} type="button" role="radio" aria-checked={on} className={`look-chip ${on ? "selected" : ""}`} onClick={() => set(field, p.id as Appearance[typeof field])}>
                        {p.label}
                      </button>
                    );
                  })}
                </span>
              </div>
            ))}
          </fieldset>
        ))}
        <fieldset className="look-group">
          <legend>Tattoos</legend>
          <InkEditor
            look={look}
            onChange={(ink) => onChange({ ...look, ink })}
            onView={(view) => {
              // Show the hero bare and still, turned to the side being drawn on.
              setDressed(false);
              setSpin(false);
              setAim((a) => ({ turn: view === "b" ? Math.PI : 0, n: (a?.n ?? 0) + 1 }));
            }}
          />
        </fieldset>
        <fieldset className="look-group">
          <legend>Colouring</legend>
          {(
            [
              ["skin", "Skin", SKIN_TONES],
              ["hair", "Hair", HAIR_COLORS],
            ] as const
          ).map(([field, name, colors]) => (
            <div key={field} className="look-row" role="radiogroup" aria-label={name}>
              <span className="look-label">{name}</span>
              <span className="look-chips">
                {colors.map((c, i) => {
                  const on = look[field] === c;
                  return <button key={c} type="button" role="radio" aria-checked={on} aria-label={`${name} ${i + 1}`} className={`look-swatch ${on ? "selected" : ""}`} style={{ background: c }} onClick={() => set(field, c)} />;
                })}
              </span>
            </div>
          ))}
        </fieldset>
      </div>
    </div>
  );
}
