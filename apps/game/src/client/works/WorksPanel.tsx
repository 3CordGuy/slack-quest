// The Harbor's works: the projects the whole crew pays into together.
//
// One tab per project, each with its picture and its state (built, locked,
// or how far along), and a last tab for who gave what. A project's tab
// shows what it is, what it gives, and a row per cost: what is paid, what
// the player holds, and a stepper to choose how much to give. One button
// gives the lot.
//
// Progress and the contribution log come from the Harbor connection, so a
// crewmate's gift shows up here as it lands. What the player can give is
// worked out from their own stock; the server checks every gift again.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  PROJECTS,
  projectAmountsText,
  projectById,
  projectCostKinds,
  projectGivable,
  projectLock,
  projectLockText,
  projectProgress,
  type CrewProject,
  type HarborWorks,
  type ProjectAmounts,
  type ProjectCostKind,
  type ProjectDef,
  type ProjectLock,
} from "@gantt-quest/world";
import { api } from "../api";
import { DragPanel } from "../DragPanel";
import { blurb, costLabel, label } from "../labels";
import { GOLD_ICON, ThingIcon, resourceIcon } from "../thingIcons";
import { BuildingIcon, LockIcon } from "./buildingArt";
import "./works.css";

/** A cost's icon: the shared gold and material icons, so an admin override reaches here too. */
const KindIcon = ({ kind, size = 18 }: { kind: ProjectCostKind; size?: number }) => <ThingIcon icon={kind === "gold" ? GOLD_ICON : resourceIcon(kind)} size={size} />;

/** How much one press of − or + moves: gold goes in tens, materials one at a time. */
const stepOf = (kind: ProjectCostKind) => (kind === "gold" ? 10 : 1);

function ago(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

type Status = { kind: "built" } | { kind: "locked"; lock: ProjectLock } | { kind: "open"; progress: number };

function statusOf(def: ProjectDef, project: CrewProject | undefined, crew: CrewProject[]): Status {
  if (project?.builtAt != null) return { kind: "built" };
  const lock = projectLock(def.id, crew);
  if (lock || !def.open) return { kind: "locked", lock: lock ?? { needs: [] } };
  return { kind: "open", progress: projectProgress(def, project?.paid ?? {}) };
}

/** The tab to open on: the first project the crew can pay into (furthest along first), else the first one. */
function firstTab(projects: CrewProject[]): string {
  const open = PROJECTS.map((def) => ({ def, s: statusOf(def, projects.find((p) => p.id === def.id), projects) })).filter((x) => x.s.kind === "open");
  const best = open.sort((a, b) => (b.s.kind === "open" ? b.s.progress : 0) - (a.s.kind === "open" ? a.s.progress : 0))[0];
  return best?.def.id ?? PROJECTS[0].id;
}

/** A tab's state at a glance: a check, a padlock, or how far along it is. */
function TabStatus({ status }: { status: Status }) {
  if (status.kind === "built") return <span className="works-tab-state built">✓ Built</span>;
  if (status.kind === "locked") return <span className="works-tab-state locked"><LockIcon size={18} /> Locked</span>;
  const pct = Math.floor(status.progress * 100);
  return (
    <span className="works-tab-state open">
      <span className="works-mini-bar" aria-hidden><span style={{ width: `${pct}%` }} /></span>
      {pct}%
    </span>
  );
}

/** − [amount] + : a compact way to choose how much of one thing to give. */
function Stepper({ value, max, step, label: name, disabled, onChange }: { value: number; max: number; step: number; label: string; disabled: boolean; onChange(n: number): void }) {
  const clamp = (n: number) => Math.max(0, Math.min(max, Math.floor(n) || 0));
  return (
    <span className="works-stepper">
      <button type="button" className="small" aria-label={`${step} less ${name}`} disabled={disabled || value <= 0} onClick={() => onChange(clamp(value - step))}>−</button>
      <input
        type="number"
        min={0}
        max={max}
        step={1}
        inputMode="numeric"
        aria-label={`${name} to give`}
        disabled={disabled}
        value={value || ""}
        placeholder="0"
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
      />
      <button type="button" className="small" aria-label={`${step} more ${name}`} disabled={disabled || value >= max} onClick={() => onChange(clamp(value + step))}>+</button>
    </span>
  );
}

function ProjectView({ def, project, crew, stock, onGive }: { def: ProjectDef; project: CrewProject | undefined; crew: CrewProject[]; stock: ProjectAmounts | null; onGive(give: ProjectAmounts): Promise<string | null> }) {
  const [amounts, setAmounts] = useState<Partial<Record<ProjectCostKind, number>>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  /** The rows that just took a gift, lit for a moment. */
  const [lit, setLit] = useState<ProjectCostKind[]>([]);
  const paid = project?.paid ?? {};
  const status = statusOf(def, project, crew);
  const fundable = status.kind === "open";
  const givable = stock ? projectGivable(def, paid, stock) : {};
  // What is chosen, held to what can be given right now (a crewmate may have just covered some of it).
  const give: ProjectAmounts = {};
  for (const kind of projectCostKinds(def)) {
    const n = Math.min(amounts[kind] ?? 0, givable[kind] ?? 0);
    if (n > 0) give[kind] = n;
  }
  const giving = Object.keys(give).length > 0;
  const anything = Object.keys(givable).length > 0;
  const allChosen = projectCostKinds(def).every((k) => (amounts[k] ?? 0) >= (givable[k] ?? 0));

  useEffect(() => {
    if (lit.length === 0) return;
    const t = setTimeout(() => setLit([]), 1400);
    return () => clearTimeout(t);
  }, [lit]);

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      const error = await onGive(give);
      if (error) setResult({ ok: false, text: error });
      else {
        setLit(Object.keys(give) as ProjectCostKind[]);
        setAmounts({});
      }
    } finally {
      setBusy(false);
    }
  };

  // An empty Give says why it cannot be pressed yet, in its own words.
  const reason = !stock ? "Counting what you hold…" : !anything ? "Nothing you hold is needed" : "Choose what to give";

  return (
    <section className={`works-project ${status.kind}`} data-project={def.id} role="tabpanel" aria-label={label("project", def.id)}>
      <header className="works-project-head">
        <span className={`works-picture ${status.kind}`}><BuildingIcon id={def.id} size={72} dim={status.kind === "locked"} /></span>
        <div className="works-project-text">
          <h3>
            {label("project", def.id)}
            {status.kind === "built" && <span className="tag good">Built{project?.builtAt ? ` ${ago(project.builtAt)}` : ""}</span>}
            {status.kind === "locked" && <span className="tag locked">Locked</span>}
            {status.kind === "open" && <span className="tag">{Math.floor(status.progress * 100)}% paid</span>}
          </h3>
          <p className="muted">{blurb("project", def.id)}</p>
          <p className="works-benefit"><strong>{status.kind === "built" ? "Gives the crew:" : "Once built:"}</strong> {def.benefit}</p>
        </div>
      </header>

      {status.kind === "locked" && (
        <div className="works-lockbox" role="note">
          <LockIcon size={36} />
          <div>
            <strong>{status.lock.needs.length ? projectLockText(status.lock) : "Not yet open."}</strong>
            {def.requires && (
              <ul className="works-needs">
                {def.requires.map((id) => {
                  const done = crew.find((p) => p.id === id)?.builtAt != null;
                  return (
                    <li key={id} className={done ? "done" : ""}>
                      <BuildingIcon id={id} size={18} dim={!done} /> {label("project", id)} {done ? "✓ built" : "not built yet"}
                    </li>
                  );
                })}
              </ul>
            )}
            <span className="muted small-note">Until then it cannot be paid into. Its costs are below, so the crew can save up.</span>
          </div>
        </div>
      )}

      {status.kind !== "built" && (
        <ul className="works-costs">
          {projectCostKinds(def).map((kind) => {
            const cost = def.cost[kind]!;
            const have = Math.min(paid[kind] ?? 0, cost);
            const met = have >= cost;
            const max = givable[kind] ?? 0;
            const held = stock?.[kind] ?? 0;
            const chosen = Math.min(amounts[kind] ?? 0, max);
            const name = costLabel(kind);
            return (
              <li key={kind} className={`works-cost ${met ? "met" : ""} ${lit.includes(kind) ? "lit" : ""}`} data-kind={kind}>
                <span className="works-kind"><KindIcon kind={kind} /> {name}</span>
                <span className="bar works-bar" role="progressbar" aria-label={`${label("project", def.id)}: ${name}`} aria-valuemin={0} aria-valuemax={cost} aria-valuenow={have}>
                  <span className={`bar-fill works-fill ${met ? "met" : ""}`} style={{ width: `${(100 * have) / cost}%` }} />
                  {chosen > 0 && <span className="bar-fill works-fill-chosen" style={{ left: `${(100 * have) / cost}%`, width: `${(100 * chosen) / cost}%` }} />}
                  <span>{have} / {cost}</span>
                </span>
                <span className="works-held muted">{!stock ? "…" : held ? <>you have <strong>{held}</strong></> : "you have none"}</span>
                <span className="works-give">
                  {met ? (
                    <span className="good small-note">✓ Paid in full</span>
                  ) : !fundable || max === 0 ? null : (
                    <>
                      <Stepper value={chosen} max={max} step={stepOf(kind)} label={name.toLowerCase()} disabled={busy} onChange={(n) => setAmounts((a) => ({ ...a, [kind]: n }))} />
                      {chosen < max && (
                        <button type="button" className="small link works-fill-btn" disabled={busy} onClick={() => setAmounts((a) => ({ ...a, [kind]: max }))} title={max < (cost - have) ? `All ${max} you have` : `The ${max} still needed`}>
                          {max < cost - have ? `all ${max}` : `${max} to finish`}
                        </button>
                      )}
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {fundable && (
        <div className="works-actions">
          <button className="primary works-give-btn" disabled={busy || !giving} title={giving ? undefined : !anything && stock ? "You hold none of what this project still needs." : "Set an amount on a row above, or fill what you can."} onClick={() => void submit()}>
            {busy ? "Giving…" : giving ? `Give ${projectAmountsText(give)}` : reason}
          </button>
          {anything && !allChosen && (
            <button type="button" className="small" disabled={busy} onClick={() => setAmounts({ ...givable })}>Fill what I can</button>
          )}
          {giving && (
            <button type="button" className="small link" disabled={busy} onClick={() => setAmounts({})}>Clear</button>
          )}
        </div>
      )}
      {result && <p className={result.ok ? "good" : "bad"} role="alert">{result.text}</p>}
    </section>
  );
}

function GiftLog({ works }: { works: HarborWorks }) {
  if (works.gifts.length === 0) return <p className="muted">Nobody has given anything yet.</p>;
  return (
    <ul className="works-gifts">
      {works.gifts.map((g, i) => (
        <li key={`${g.at}:${g.kind}:${i}`}>
          <BuildingIcon id={g.projectId} size={18} />
          <span className="grow"><strong>{g.name}</strong> gave <span className="works-gift-amount"><KindIcon kind={g.kind} size={18} />{g.qty} {costLabel(g.kind).toLowerCase()}</span> to the {label("project", g.projectId)}</span>
          <span className="muted">{ago(g.at)}</span>
        </li>
      ))}
    </ul>
  );
}

const LOG = "log";

export function WorksPanel({ works, refresh, onClose }: { works: HarborWorks | undefined; refresh(): Promise<unknown>; onClose(): void }) {
  const [fetched, setFetched] = useState<HarborWorks | null>(null);
  const [stock, setStock] = useState<ProjectAmounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    api.projects().then((r) => {
      setFetched(r.works);
      setStock(r.stock);
    }, (e: Error) => setError(e.message));
  }, []);
  // The Harbor's copy is the live one; the fetched copy only covers the moment before it arrives.
  const shown = works ?? fetched;
  const current = tab ?? (shown ? firstTab(shown.projects) : null);

  const give = (def: ProjectDef) => async (amounts: ProjectAmounts): Promise<string | null> => {
    setError(null);
    setNotice(null);
    try {
      const res = await api.giveToProject(def.id, amounts);
      setFetched(res.works);
      setStock(res.stock);
      const xp = res.xp?.text ? ` ${res.xp.text}` : "";
      setNotice((res.completed ? `The ${def.name} is built! The whole crew has it from the next voyage.` : `You gave ${projectAmountsText(amounts)} to the ${def.name}.`) + xp);
      // Gold left the character sheet too.
      void refresh();
      return null;
    } catch (e) {
      // Whatever went wrong, show what is true now.
      api.projects().then((r) => setStock(r.stock), () => {});
      return (e as Error).message;
    }
  };

  const ids = [...PROJECTS.map((p) => p.id), LOG];
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowRight" ? (i + 1) % ids.length : e.key === "ArrowLeft" ? (i - 1 + ids.length) % ids.length : e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(ids[to]);
    tabs.current[to]?.focus();
  };
  const def = current && current !== LOG ? projectById(current) : undefined;

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <DragPanel id="harbor.works" title="The works" compact className="panel works-panel" role="dialog" aria-label="Harbor projects">
        <header className="works-head">
          <h2>The works</h2>
          <span className="spacer" />
          <button className="small" onClick={onClose}>Close</button>
        </header>
        <p className="muted works-intro">Buildings the whole crew pays for together. Anyone can give; once every cost is met it stands for good.</p>
        {error && <p className="bad" role="alert">{error}</p>}
        {!shown && !error && <p className="muted">Looking over the plans…</p>}
        {shown && current && (
          <>
            <div className="works-tabs" role="tablist" aria-label="Projects">
              {ids.map((id, i) => {
                const d = projectById(id);
                const selected = id === current;
                const status = d ? statusOf(d, shown.projects.find((p) => p.id === id), shown.projects) : null;
                return (
                  <button
                    key={id}
                    ref={(el) => (tabs.current[i] = el)}
                    role="tab"
                    id={`works-tab-${id}`}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className={`works-tab ${selected ? "selected" : ""} ${status?.kind ?? "log"}`}
                    title={d ? label("project", id) : "Recent contributions"}
                    onClick={() => {
                      setTab(id);
                      setNotice(null);
                    }}
                    onKeyDown={(e) => onTabKey(e, i)}
                  >
                    {d ? <BuildingIcon id={id} size={36} dim={status?.kind === "locked"} /> : <span className="works-log-icon" aria-hidden>✎</span>}
                    <span className="works-tab-name">{d ? label("project", id) : "Log"}</span>
                    {status ? <TabStatus status={status} /> : <span className="works-tab-state">{shown.gifts.length ? `${shown.gifts.length} recent` : "none yet"}</span>}
                  </button>
                );
              })}
            </div>
            {notice && <p className="works-notice" role="status">✓ {notice}</p>}
            <div className="works-body">
              {def ? (
                <ProjectView key={def.id} def={def} project={shown.projects.find((p) => p.id === def.id)} crew={shown.projects} stock={stock} onGive={give(def)} />
              ) : (
                <section role="tabpanel" aria-label="Recent contributions">
                  <h3 className="works-log-title">Recent contributions</h3>
                  <GiftLog works={shown} />
                </section>
              )}
            </div>
          </>
        )}
      </DragPanel>
    </div>
  );
}
