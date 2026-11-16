// The dev toolbox: a small spanner in the top-right corner of every screen,
// there only on a development deployment (the worker's ENVIRONMENT is "dev":
// local and staging; see devTools.ts). It opens a window with a tab for each
// kind of tool:
//
//   Sky & sound   hold the time of day and the weather where you want them,
//                 and see what the audio engine is doing. Your own tab only.
//   Gold          add gold to your hero's purse, or take it away.
//   Items         put a chosen piece of gear, or some of a material, in
//                 your hero's pack, or take a material away.
//   Figures       try the low-poly people (a prototype; render/figures.ts).
//                 This browser only; it reloads the page.
//   Maps          make a zone (a map to walk and fight on) and walk into it;
//                 while one is on screen, place enemies, paint the ground and
//                 the rest (zone/MapsTab.tsx).
//
// Gold and items are changed on the server (server/dev.ts), which refuses
// outside a development deployment. They are your own hero's alone.
//
// Open or shut, and the tab it was on, it stays that way from view to view
// and across a reload.

import { useState, type ReactNode } from "react";
import { GEAR_BASES, HERO_CLASSES, RARITIES, RESOURCE_KINDS, SLOTS, SLOT_LABEL, WEAPONS, slotOfRef, type Rarity, type ResourceKind, type Slot } from "@gantt-quest/world";
import { api, type Me } from "./api";
import { SkyAndSound } from "./audio/SoundButton";
import { DragPanel } from "./DragPanel";
import { itemName, label } from "./labels";
import { PixelIcon } from "./PixelIcon";
import { BLOCKY_KEY } from "./render/figures";
import { WRENCH } from "./ui/menuIcons";
import { MapsTab } from "./zone/MapsTab";

const OPEN_KEY = "gq.dev.readout";
const TAB_KEY = "gq.dev.tab";
const TABS = [
  ["sky", "Sky & sound"],
  ["gold", "Gold"],
  ["items", "Items"],
  ["figures", "Figures"],
  ["maps", "Maps"],
] as const;
type Tab = (typeof TABS)[number][0];

const recall = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Blocked storage: it stays as it is until the page is closed.
  }
};

export function DevToolbox({ me, refresh }: { me: Me; refresh(): Promise<void> }) {
  const [open, setOpen] = useState(() => recall(OPEN_KEY) === "1");
  const [tab, setTab] = useState<Tab>(() => TABS.find(([id]) => id === recall(TAB_KEY))?.[0] ?? "sky");
  const show = (on: boolean) => {
    remember(OPEN_KEY, on ? "1" : null);
    setOpen(on);
  };
  const pick = (id: Tab) => {
    remember(TAB_KEY, id);
    setTab(id);
  };
  return (
    <>
      <button className={`dev-corner ${open ? "selected" : ""}`} title="Dev toolbox" aria-label="Dev toolbox" aria-pressed={open} onClick={() => show(!open)}>
        <PixelIcon rows={WRENCH} size={14} />
      </button>
      {open && (
        <DragPanel id="dev.readout" title="Dev toolbox" compact resizable className="sound-readout panel">
          <div className="sound-readout-head">
            <strong>Dev toolbox</strong>
            <button className="link" onClick={() => show(false)}>
              Close
            </button>
          </div>
          <div className="dev-tabs" role="tablist" aria-label="Dev tools">
            {TABS.map(([id, name]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={`small ${tab === id ? "selected" : ""}`} onClick={() => pick(id)}>
                {name}
              </button>
            ))}
          </div>
          {tab === "sky" && <SkyAndSound />}
          {tab === "gold" && <Seeding key="gold" me={me} refresh={refresh}>{(seed) => <GoldSeed me={me} seed={seed} />}</Seeding>}
          {tab === "figures" && <FigureStyle />}
          {tab === "maps" && (me.character?.status === "active" ? <MapsTab /> : <p className="muted">Create a character first: there is no hero to walk in.</p>)}
          {tab === "items" && <Seeding key="items" me={me} refresh={refresh}>{(seed) => <ItemSeed me={me} seed={seed} />}</Seeding>}
        </DragPanel>
      )}
    </>
  );
}

/** Switch the people (in this browser) back to their old box models, to compare. Every figure is built afresh, so it reloads. */
function FigureStyle() {
  const blocky = recall(BLOCKY_KEY) === "1";
  const flip = () => {
    remember(BLOCKY_KEY, blocky ? null : "1");
    location.reload();
  };
  return (
    <div className="dev-seed">
      <p>
        People are drawn <strong>{blocky ? "in the old boxes" : "low-poly"}</strong>.
      </p>
      <p className="muted">Heroes who chose how they look stay low-poly either way. Creatures (wolves, bears, bats, ghosts, slimes, skeletons) are still boxes.</p>
      <div className="dev-row">
        <button className="small primary" onClick={flip}>
          {blocky ? "Back to low-poly" : "Show the old boxes"}
        </button>
      </div>
    </div>
  );
}

/** Run one seeding call, then read the hero again so the bar and the bag show it. `said` turns the answer into a line. */
type Seed = <T>(call: () => Promise<T>, said: (result: T) => string) => void;

/** A seeding tab: its controls, and under them what the last press did, or why it did nothing. It needs a hero to give things to. */
function Seeding({ me, refresh, children }: { me: Me; refresh(): Promise<void>; children(seed: Seed): ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  if (me.character?.status !== "active") return <p className="muted">Create a character first: there is no hero to give things to yet.</p>;
  const seed: Seed = (call, line) => {
    setBusy(true);
    call()
      .then(async (result) => {
        await refresh();
        setSaid({ text: line(result) });
      })
      .catch((err: Error) => setSaid({ text: err.message, bad: true }))
      .finally(() => setBusy(false));
  };
  return (
    <fieldset className="dev-seed" disabled={busy}>
      {children(seed)}
      <p className={`dev-said ${said?.bad ? "bad" : "muted"}`} role="status">
        {said?.text}
      </p>
    </fieldset>
  );
}

const count = (n: number) => n.toLocaleString("en");
/** A whole number above nothing from a field, or null if it is not one. */
const wholeOf = (text: string) => (/^\d+$/.test(text.trim()) && Number(text) > 0 ? Number(text) : null);

function GoldSeed({ me, seed }: { me: Me; seed: Seed }) {
  const c = me.character!;
  const [amount, setAmount] = useState("1000");
  const n = wholeOf(amount);
  const give = (by: number) => seed(() => api.devGold(by), (r) => `${by > 0 ? "Added" : "Took"} ${count(Math.abs(by))} gold. The purse holds ${count(r.gold)}.`);
  return (
    <>
      <p>
        {c.name} has <strong>{count(c.gold)}</strong> gold.
      </p>
      <div className="dev-row">
        <input type="number" min={1} step={100} value={amount} aria-label="Gold" onChange={(e) => setAmount(e.target.value)} />
        <button className="small primary" disabled={!n} onClick={() => give(n!)}>
          Add
        </button>
        <button className="small" disabled={!n || c.gold === 0} onClick={() => give(-Math.min(n!, c.gold))}>
          Take
        </button>
      </div>
      <div className="dev-row">
        {[100, 1000, 10_000, 100_000].map((by) => (
          <button key={by} className="small" onClick={() => give(by)}>
            +{count(by)}
          </button>
        ))}
      </div>
    </>
  );
}

/** Every piece of gear there is, grouped for the picker: each class's weapons, then the armor and trinkets slot by slot. */
const GEAR_GROUPS: ({ classId: string; refs: string[] } | { slot: Slot; refs: string[] })[] = [
  ...HERO_CLASSES.map((c) => ({ classId: c.id, refs: Object.values(WEAPONS).filter((w) => w.classId === c.id).map((w) => w.id) })),
  ...SLOTS.filter((s) => s !== "main_hand").map((slot) => ({ slot, refs: GEAR_BASES.filter((b) => slotOfRef(b.ref) === slot).map((b) => b.ref) })),
].filter((g) => g.refs.length > 0);

function ItemSeed({ me, seed }: { me: Me; seed: Seed }) {
  const c = me.character!;
  // The hero's own first weapon to start with, so the first press gives something they can use.
  const [ref, setRef] = useState(() => HERO_CLASSES.find((h) => h.id === c.class_id)?.weapons[0] ?? GEAR_GROUPS[0].refs[0]);
  const [rarity, setRarity] = useState<Rarity>("rare");
  const [level, setLevel] = useState(String(c.level));
  const [kind, setKind] = useState<ResourceKind>("wood");
  const [qty, setQty] = useState("10");
  const lv = wholeOf(level);
  const n = wholeOf(qty);
  const held = me.materials?.[kind] ?? 0;
  const material = label("resource", kind).toLowerCase();
  const giveMaterial = (by: number) => seed(() => api.devMaterial(kind, by), (r) => `${by > 0 ? "Added" : "Took"} ${count(Math.abs(by))} ${material}. The pack holds ${count(r.qty)}.`);
  return (
    <>
      {me.carry && (
        <p className="muted">
          Pack: {me.carry.carried} of {me.carry.limit} squares filled.
        </p>
      )}
      <h4>Gear</h4>
      <div className="dev-row">
        <select value={ref} aria-label="Gear" onChange={(e) => setRef(e.target.value)}>
          {GEAR_GROUPS.map((g) =>
            "classId" in g ? (
              <optgroup key={g.classId} label={`${label("class", g.classId)}${g.classId === c.class_id ? " (your class)" : ""}`}>
                {g.refs.map((r) => (
                  <option key={r} value={r}>
                    {label("weapon", r)}
                  </option>
                ))}
              </optgroup>
            ) : (
              <optgroup key={g.slot} label={SLOT_LABEL[g.slot]}>
                {g.refs.map((r) => (
                  <option key={r} value={r}>
                    {label("gear", r)}
                  </option>
                ))}
              </optgroup>
            ),
          )}
        </select>
      </div>
      <div className="dev-row">
        <select value={rarity} aria-label="Rarity" onChange={(e) => setRarity(e.target.value as Rarity)}>
          {RARITIES.map((r) => (
            <option key={r} value={r}>
              {r[0].toUpperCase() + r.slice(1)}
            </option>
          ))}
        </select>
        <label>
          Level <input type="number" min={1} max={50} value={level} onChange={(e) => setLevel(e.target.value)} />
        </label>
        <button className="small primary" disabled={!lv} onClick={() => seed(() => api.devGear(ref, rarity, lv!), (r) => `${itemName(r.item)} is in the pack.`)}>
          Add to pack
        </button>
      </div>
      <h4>Materials</h4>
      <div className="dev-row">
        <select value={kind} aria-label="Material" onChange={(e) => setKind(e.target.value as ResourceKind)}>
          {RESOURCE_KINDS.map((k) => (
            <option key={k} value={k}>
              {label("resource", k)}
            </option>
          ))}
        </select>
        <input type="number" min={1} value={qty} aria-label="How many" onChange={(e) => setQty(e.target.value)} />
        <button className="small primary" disabled={!n} onClick={() => giveMaterial(n!)}>
          Add
        </button>
        <button className="small" disabled={!n || held === 0} onClick={() => giveMaterial(-Math.min(n!, held))}>
          Take
        </button>
        <span className="muted">{count(held)} in the pack</span>
      </div>
    </>
  );
}
