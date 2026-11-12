// A gathering outing: fishing, felling or the quarry. The server holds the
// outing and rolls every check; this panel shows what it sends back and
// posts the player's choice to push on or bank.

import { useEffect, useRef, useState } from "react";
import { FELLING_SIDE, GATHER_SPOTS, QUARRY_SIDE, STAT_LABEL, type GatherChoice, type GatherSpot, type GatherView, type Resources } from "@gantt-quest/world";
import { api, type GatherStatus } from "./api";
import { DragPanel } from "./DragPanel";
import { ResourceChips, resourceText } from "./hutDrops";
import "./gather.css";

const WORDS: Record<GatherSpot, { start: string; push: string; bank: string; meter: string }> = {
  fishing: { start: "Go fishing", push: "", bank: "Land what you have", meter: "Line tension" },
  felling: { start: "Start felling", push: "", bank: "Carry it home", meter: "" },
  quarry: { start: "Start cutting", push: "", bank: "Haul it out", meter: "Cracks in the roof" },
};

function resetIn(at: number): string {
  const minutes = Math.max(1, Math.ceil((at - Date.now()) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

function Rolls({ rolls }: { rolls: boolean[] }) {
  return (
    <span className="gather-rolls">
      {rolls.map((hit, i) => <i key={i} className={`slot ${hit ? "hit" : "miss"}`}>{hit ? "✓" : "✗"}</i>)}
    </span>
  );
}

function Trees({ outing, busy, pick }: { outing: GatherView; busy: boolean; pick(cell: number): void }) {
  return (
    <div className="gather-trees" style={{ gridTemplateColumns: `repeat(${FELLING_SIDE}, 1fr)` }}>
      {outing.trees!.map((tree, cell) => {
        const open = outing.status === "active" && !tree.picked;
        const label = tree.kind === null ? "Standing" : tree.kind === "rotten" ? "Rotten" : tree.kind === "den" ? "Den" : tree.picked ? "Felled" : "Sound";
        return (
          <button key={cell} className={`gather-tree ${tree.kind ?? "hidden"} ${tree.picked ? "picked" : ""}`} disabled={!open || busy} onClick={() => pick(cell)} aria-label={`Tree ${cell + 1}: ${label}`}>
            <span className="tree-glyph">{tree.kind === "rotten" ? "☠" : tree.picked ? "▂" : "▲"}</span>
            <span>{label}</span>
            {tree.near !== null && <span className="muted">{tree.near} rotten near</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The shore: five places to cast. Past casts show what they read; the gulls mark where to start looking. */
function Water({ outing, busy, cast }: { outing: GatherView; busy: boolean; cast(cell: number): void }) {
  const water = outing.water!;
  const active = outing.status === "active";
  const last = water.casts.at(-1);
  return (
    <div className="gather-water" style={{ gridTemplateColumns: `repeat(${water.cells}, 1fr)` }}>
      {Array.from({ length: water.cells }, (_, cell) => {
        const here = [...water.casts].reverse().find((c) => c.cell === cell);
        const isLast = last?.cell === cell;
        const read = !here ? null : here.read === "on" ? "On the school" : here.read === "near" ? `Close, ${here.dir < 0 ? "← west" : "east →"}` : `Far, ${here.dir < 0 ? "← west" : "east →"}`;
        return (
          <button key={cell} className={`gather-swim ${here?.read ?? ""} ${isLast ? "last" : ""} ${water.school === cell ? "school" : ""}`} disabled={!active || busy} onClick={() => cast(cell)} aria-label={`Cast at place ${cell + 1}${read ? `: last read ${read}` : ""}`}>
            <span className="tree-glyph">{water.school === cell ? "🐟" : water.casts.length === 0 && water.gulls === cell ? "⌄⌄" : "≈"}</span>
            <span>{water.school === cell ? "The school" : water.casts.length === 0 && water.gulls === cell ? "Gulls" : read ?? "Cast here"}</span>
            {here && !isLast && <span className="muted">earlier</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The quarry face: nine blocks, with the dust count for each row down the side and each column along the bottom. */
function Face({ outing, busy, cut }: { outing: GatherView; busy: boolean; cut(cell: number): void }) {
  const face = outing.face!;
  const dust = (n: number) => (n === 0 ? "no dust" : n === 1 ? "· dust" : "·· dust");
  return (
    <div className="gather-face" style={{ gridTemplateColumns: `repeat(${QUARRY_SIDE}, 1fr) auto` }}>
      {face.blocks.map((block, cell) => {
        const open = outing.status === "active" && !block.cut;
        const label = block.kind === null ? "Uncut" : block.kind === "weak" ? "Weak" : block.kind === "ore" ? "Ore" : "Stone";
        return [
          <button key={cell} className={`gather-tree gather-block ${block.kind ?? "hidden"} ${block.cut ? "picked" : ""}`} disabled={!open || busy} onClick={() => cut(cell)} aria-label={`Block ${cell + 1}: ${label}`}>
            <span className="tree-glyph">{block.kind === "weak" ? "☠" : block.kind === "ore" ? "◆" : block.cut ? "▫" : "▩"}</span>
            <span>{label}</span>
            {block.oreNear !== null && <span className="muted">{block.oreNear} ore near</span>}
          </button>,
          cell % QUARRY_SIDE === QUARRY_SIDE - 1 && <span key={`r${cell}`} className={`gather-dust ${face.rows[Math.floor(cell / QUARRY_SIDE)] ? "on" : ""}`} title="Weak blocks in this row">{dust(face.rows[Math.floor(cell / QUARRY_SIDE)])}</span>,
        ];
      })}
      {face.cols.map((n, c) => <span key={`c${c}`} className={`gather-dust ${n ? "on" : ""}`} title="Weak blocks in this column">{dust(n)}</span>)}
      <span />
    </div>
  );
}

export function GatherPanel({ spot, onClose }: { spot: GatherSpot; onClose(): void }) {
  const [status, setStatus] = useState<GatherStatus | null>(null);
  const [paid, setPaid] = useState<Resources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.gather().then(setStatus, (e: Error) => setError(e.message));
  }, []);

  const run = async (call: () => Promise<GatherStatus & { paid?: Resources }>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await call();
      setStatus(next);
      setPaid(next.paid ?? null);
    } catch (e) {
      setError((e as Error).message);
      // Whatever went wrong, show where the outing really stands.
      await api.gather().then(setStatus, () => undefined);
    } finally {
      setBusy(false);
    }
  };
  const step = (choice: GatherChoice) => run(() => api.gatherStep(choice));

  const outing = status?.outing ?? null;
  // Keep the newest check in view as the log grows.
  const logEnd = useRef<HTMLLIElement>(null);
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "nearest" });
  }, [outing?.log.length]);
  // An outing begun at another spot is still the one in progress: show it, wherever the player stands.
  const shown = outing?.spot ?? spot;
  const def = GATHER_SPOTS[shown];
  const words = WORDS[shown];
  const active = outing?.status === "active";
  const pct = outing && active ? outing.pct : status?.chances[shown];
  const left = status?.stamina.left ?? 0;

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <DragPanel id="harbor.gather" title={def.name} compact className="panel gather" role="dialog" aria-label={def.name}>
        <header className="gather-head">
          <h2>{def.name}</h2>
          <span className="spacer" />
          <button className="small" onClick={onClose}>{active ? "Step away" : "Close"}</button>
        </header>
        {outing && outing.spot !== spot && active && <p className="bad">You left this outing unfinished. Finish it before starting another.</p>}
        <p className="muted">{def.blurb}</p>

        {status && (
          <div className="gather-facts">
            <div><span className="muted">Chance per roll</span><strong>{pct}%</strong><span className="muted">{STAT_LABEL[def.stat]} · {outing?.rolls ?? 2} rolls a check</span></div>
            <div>
              <span className="muted">Stamina</span>
              <strong className="gather-pips" aria-label={`${left} of ${status.stamina.max} outings left today`}>
                {Array.from({ length: status.stamina.max }, (_, i) => <i key={i} className={i < left ? "on" : ""} />)}
              </strong>
              <span className="muted">{left} of {status.stamina.max} left · resets in {resetIn(status.stamina.resetsAt)}</span>
            </div>
            <div><span className="muted">Pays</span><strong>{def.pays.join(", ")}</strong><span className="muted">banking always pays at least 1</span></div>
          </div>
        )}
        {error && <p className="bad">{error}</p>}
        {!status && !error && <p className="muted">Looking around…</p>}

        {status && !outing && (
          left > 0
            ? <button className="primary" disabled={busy} onClick={() => run(() => api.gatherStart(spot))}>{words.start} · uses 1 stamina</button>
            : <p className="bad">You are worn out for today. A voyage gives all three outings back, and a meal at the pub gives back one a day.</p>
        )}

        {outing && (
          <>
            {outing.cracks !== null && (
              <div className="gather-meter" aria-label={`${outing.cracks} of ${outing.maxCracks} cracks`}>
                <span className="muted">{words.meter}</span>
                {Array.from({ length: outing.maxCracks! }, (_, i) => <i key={i} className={i < outing.cracks! ? "on" : ""} />)}
                <span className="muted">{outing.cracks} of {outing.maxCracks}</span>
              </div>
            )}
            {outing.spot === "fishing" && (
              <div className="gather-meter" aria-label={`Reel ${outing.step} of ${outing.maxSteps}`}>
                <span className="muted">{words.meter}</span>
                {Array.from({ length: outing.maxSteps }, (_, i) => <i key={i} className={i < outing.step ? "on" : ""} />)}
                <span className="muted">cast {outing.step} of {outing.maxSteps}</span>
              </div>
            )}
            {outing.trees && <Trees outing={outing} busy={busy} pick={(cell) => step({ t: "push", cell })} />}
            {outing.water && (
              <>
                <Water outing={outing} busy={busy} cast={(cell) => step({ t: "push", cell })} />
                {active && <p className="muted gather-hint">On the school: +{outing.water.read}% a roll and one more fish. Two or more places off: −{outing.water.read}%. The school drifts a place at most between casts.</p>}
              </>
            )}
            {outing.face && (
              <>
                <Face outing={outing} busy={busy} cut={(cell) => step({ t: "push", cell })} />
                {active && <p className="muted gather-hint">Dust marks a row or column with a weak block in it (two dots: both). A weak block is two cracks; missing both rolls is one.</p>}
              </>
            )}

            <div className="gather-haul">
              <span className="muted">{active ? "Haul so far" : outing.status === "banked" ? "Brought home" : "Lost"}</span>
              {outing.status === "banked"
                ? <ResourceChips resources={paid ?? outing.payout} />
                : Object.keys(outing.haul).length > 0 ? <ResourceChips resources={outing.haul} /> : <span className="muted">Nothing {active ? "yet" : "to show for it"}.</span>}
            </div>

            <ol className="gather-log">
              {outing.log.map((entry, i) => (
                <li key={i} ref={i === outing.log.length - 1 ? logEnd : undefined} className={i === outing.log.length - 1 ? "latest" : ""}>
                  {entry.check && <><span className="tag">{entry.check.label} · {entry.check.pct}%</span><Rolls rolls={entry.check.rolls} /></>}
                  <span>{entry.text}</span>
                  {Object.keys(entry.gained).length > 0 && <span className="good"> +{resourceText(entry.gained)}</span>}
                </li>
              ))}
              {outing.log.length === 0 && <li className="muted">{outing.spot === "felling" ? "Nine trees. Pick one." : outing.spot === "fishing" ? "Gulls are circling. The school is under them or right beside. Pick where to cast." : "Nine blocks. Read the dust, then pick one to cut."}</li>}
            </ol>

            {active ? (
              <div className="row">
                {words.push && <button className="primary" disabled={busy} onClick={() => step({ t: "push" })}>{words.push} · {outing.rolls} × {outing.pct}%</button>}
                <button disabled={busy} onClick={() => step({ t: "bank" })}>{words.bank}</button>
                <span className="muted">{outing.maxSteps - outing.step} more at most</span>
              </div>
            ) : (
              <div className="row">
                <strong className={outing.status === "banked" ? "good" : "bad"}>
                  {outing.status === "banked" ? `Added to your materials: ${resourceText(paid ?? outing.payout)}.` : "Nothing comes home this time."}
                </strong>
                <span className="spacer" />
                {left > 0 && <button className="primary" disabled={busy} onClick={() => run(() => api.gatherStart(spot))}>{outing.spot === spot ? "Go again" : WORDS[spot].start} · uses 1 stamina</button>}
                <button onClick={onClose}>Done</button>
              </div>
            )}
          </>
        )}
      </DragPanel>
    </div>
  );
}
