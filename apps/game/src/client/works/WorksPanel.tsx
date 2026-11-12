// The Harbor's works: the projects the whole crew pays into together.
//
// Progress and the contribution log come from the Harbor connection, so a
// crewmate's gift shows up here as it lands. What the player can give is
// worked out from their own stock; the server checks every gift again.

import { useEffect, useState } from "react";
import {
  PROJECTS,
  projectAmountsText,
  projectCostKinds,
  projectGivable,
  type HarborWorks,
  type ProjectAmounts,
  type ProjectCostKind,
  type ProjectDef,
} from "@gantt-quest/world";
import { api } from "../api";
import { DragPanel } from "../DragPanel";
import { blurb, costLabel, label } from "../labels";
import "./works.css";

/** Projects shown side by side, in this order. */
const PAIRED = ["apothecary", "smithy"];

function ago(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

function ProjectCard({ def, paid, builtAt, stock, onGive }: { def: ProjectDef; paid: ProjectAmounts; builtAt: number | null; stock: ProjectAmounts | null; onGive(give: ProjectAmounts): Promise<void> }) {
  const [amounts, setAmounts] = useState<Partial<Record<ProjectCostKind, string>>>({});
  const [busy, setBusy] = useState(false);
  const built = builtAt !== null;
  const fundable = def.open && !built;
  const givable = stock ? projectGivable(def, paid, stock) : {};
  // What is typed, held to what can be given right now (a crewmate may have just covered some of it).
  const give: ProjectAmounts = {};
  for (const kind of projectCostKinds(def)) {
    const n = Math.min(Math.floor(Number(amounts[kind] ?? 0)) || 0, givable[kind] ?? 0);
    if (n > 0) give[kind] = n;
  }
  const submit = async () => {
    setBusy(true);
    try {
      await onGive(give);
      setAmounts({});
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`works-project ${built ? "built" : ""} ${def.open ? "" : "closed"}`} data-project={def.id}>
      <div className="works-title">
        <strong>{label("project", def.id)}</strong>
        {built ? <span className="tag good">Built</span> : !def.open && <span className="tag">Not yet open</span>}
      </div>
      <span className="muted">{blurb("project", def.id)}</span>
      <span>{built ? "" : "Once built: "}{def.benefit}</span>
      {!built && (
        <div className="works-costs">
          {projectCostKinds(def).map((kind) => {
            const cost = def.cost[kind]!;
            const have = Math.min(paid[kind] ?? 0, cost);
            const max = givable[kind] ?? 0;
            return (
              <div key={kind} className="works-cost" data-kind={kind}>
                <span className="works-kind">{costLabel(kind)}</span>
                <span className="bar" role="progressbar" aria-label={`${label("project", def.id)}: ${costLabel(kind)}`} aria-valuemin={0} aria-valuemax={cost} aria-valuenow={have}>
                  <span className={`bar-fill works-fill ${have >= cost ? "met" : ""}`} style={{ width: `${(100 * have) / cost}%` }} />
                  <span>{have} / {cost}</span>
                </span>
                {fundable && (
                  <>
                    <input
                      type="number"
                      min={0}
                      max={max}
                      step={1}
                      inputMode="numeric"
                      aria-label={`${costLabel(kind)} to give`}
                      placeholder="0"
                      disabled={max === 0 || busy}
                      value={amounts[kind] ?? ""}
                      onChange={(e) => setAmounts((a) => ({ ...a, [kind]: e.target.value }))}
                    />
                    <button className="small" disabled={max === 0 || busy} title={max === 0 ? (have >= cost ? "Fully paid" : "You have none to give") : `Give ${max}`} onClick={() => setAmounts((a) => ({ ...a, [kind]: String(max) }))}>
                      Max {max}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {fundable && (
        <button className="primary" disabled={busy || Object.keys(give).length === 0} onClick={submit}>
          {Object.keys(give).length === 0 ? "Give" : `Give ${projectAmountsText(give)}`}
        </button>
      )}
      {!def.open && !built && <span className="muted">The crew cannot pay into this one yet.</span>}
    </li>
  );
}

export function WorksPanel({ works, refresh, onClose }: { works: HarborWorks | undefined; refresh(): Promise<unknown>; onClose(): void }) {
  const [fetched, setFetched] = useState<HarborWorks | null>(null);
  const [stock, setStock] = useState<ProjectAmounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    api.projects().then((r) => {
      setFetched(r.works);
      setStock(r.stock);
    }, (e: Error) => setError(e.message));
  }, []);
  // The Harbor's copy is the live one; the fetched copy only covers the moment before it arrives.
  const shown = works ?? fetched;

  const give = (def: ProjectDef) => async (amounts: ProjectAmounts) => {
    setError(null);
    setNotice(null);
    try {
      const res = await api.giveToProject(def.id, amounts);
      setFetched(res.works);
      setStock(res.stock);
      const xp = res.xp?.text ? ` ${res.xp.text}` : "";
      setNotice((res.completed ? `The ${def.name} is built!` : `You gave ${projectAmountsText(amounts)} to the ${def.name}.`) + xp);
      // Gold left the character sheet too.
      void refresh();
    } catch (e) {
      setError((e as Error).message);
      // Whatever went wrong, show what is true now.
      api.projects().then((r) => setStock(r.stock), () => {});
    }
  };

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <DragPanel id="harbor.works" title="The works" compact className="panel works-panel" role="dialog" aria-label="Harbor projects">
        <header className="works-head">
          <h2>The works</h2>
          <span className="spacer" />
          <button className="small" onClick={onClose}>Close</button>
        </header>
        <p className="muted">Buildings the whole crew pays for together. Anyone can give gold or materials; once every cost is met the building stands for good.</p>
        <p className="works-stock">You hold: <strong>{stock ? projectAmountsText(stock) || "nothing to give" : "…"}</strong></p>
        {error && <p className="bad" role="alert">{error}</p>}
        {notice && <p className="good" role="status">{notice}</p>}
        {!shown && !error && <p className="muted">Looking over the plans…</p>}
        {shown && (
          <>
            <ul className="works-list">
              {PROJECTS.filter((def) => !PAIRED.includes(def.id) || def.id === PAIRED[0]).map((def) => {
                const card = (d: ProjectDef) => {
                  const p = shown.projects.find((x) => x.id === d.id);
                  return <ProjectCard key={d.id} def={d} paid={p?.paid ?? {}} builtAt={p?.builtAt ?? null} stock={stock} onGive={give(d)} />;
                };
                // The apothecary and the smithy open together and are shown as a pair.
                if (def.id === PAIRED[0]) return <li key="pair" className="works-pair-row"><ul className="works-pair">{PROJECTS.filter((d) => PAIRED.includes(d.id)).map(card)}</ul></li>;
                return card(def);
              })}
            </ul>
            <h3>Recent contributions</h3>
            {shown.gifts.length === 0 && <p className="muted">Nobody has given anything yet.</p>}
            <ul className="works-gifts">
              {shown.gifts.map((g, i) => (
                <li key={`${g.at}:${g.kind}:${i}`}>
                  <span><strong>{g.name}</strong> gave {g.qty} {costLabel(g.kind).toLowerCase()} to the {label("project", g.projectId)}</span>
                  <span className="muted">{ago(g.at)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </DragPanel>
    </div>
  );
}
