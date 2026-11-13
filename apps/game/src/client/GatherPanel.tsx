// A gathering outing: fishing, felling or the quarry. The server holds the
// outing and rolls every check; this panel shows what it sends back and
// posts the player's choice to push on or bank.

import { useEffect, useRef, useState } from "react";
import { GATHER_SPOTS, QUARRY_SIDE, TIMING, STAT_LABEL, type GatherChoice, type GatherSpot, type GatherView, type Resources } from "@gantt-quest/world";
import { api, type GatherStatus, type XpResult } from "./api";
import { DragPanel } from "./DragPanel";
import { Grove, type GroveHero } from "./Grove";
import { TimingBar } from "./TimingBar";
import { ResourceChips, resourceText } from "./hutDrops";
import "./gather.css";
import { StaminaBolts } from "./StaminaBolts";

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

export function GatherPanel({ spot, hero, onClose, onStamina }: {
  spot: GatherSpot;
  /** How the hero looks, for the grove. */
  hero: GroveHero;
  onClose(): void;
  /** Told each time the outings left change, so the plate can follow. */
  onStamina?(s: { left: number; max: number }): void;
}) {
  const [status, setStatus] = useState<GatherStatus | null>(null);
  const [paid, setPaid] = useState<Resources | null>(null);
  /** What the outing just ended paid in XP. */
  const [xp, setXp] = useState<XpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.gather().then(setStatus, (e: Error) => setError(e.message));
  }, []);
  const tell = useRef(onStamina);
  tell.current = onStamina;
  useEffect(() => {
    if (status) tell.current?.({ left: status.stamina.left, max: status.stamina.max });
  }, [status?.stamina.left, status?.stamina.max]);

  const run = async (call: () => Promise<GatherStatus & { paid?: Resources; xp?: XpResult }>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await call();
      setStatus(next);
      setPaid(next.paid ?? null);
      setXp(next.xp ?? null);
    } catch (e) {
      setError((e as Error).message);
      // Whatever went wrong, show where the outing really stands.
      await api.gather().then(setStatus, () => undefined);
    } finally {
      setBusy(false);
    }
  };
  const step = (choice: GatherChoice) => run(() => api.gatherStep(choice));

  const latest = status?.outing ?? null;
  // An outing still open is shown wherever the player stands. One already finished at another spot is not:
  // this spot is shown instead, with a line saying what came home from there.
  const outing = latest && (latest.spot === spot || latest.status === "active") ? latest : null;
  const finishedElsewhere = latest && !outing ? latest : null;
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
  // Felling with a grove: the stand fills the screen and the panel floats over it, docked to one side.
  const groveMode = !!outing?.grove;
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  return (
    <div className={`overlay ${groveMode ? "grove-mode" : ""}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      {groveMode && <div className="grove-backdrop" ref={setHost} aria-label="The grove: tap a tree" />}
      <DragPanel id="harbor.gather" title={def.name} compact className={`panel gather ${shown}`} role="dialog" aria-label={def.name}>
        <header className="gather-head">
          <h2>{def.name}</h2>
          <span className="spacer" />
          <button className="small" onClick={onClose}>{active ? "Step away" : "Close"}</button>
        </header>
        {outing && outing.spot !== spot && active && (
          // Walked to another spot with an outing still open: say where it is and offer the way out, without alarm.
          <div className="gather-elsewhere">
            <p>
              You still have an outing open at <strong>{def.name.replace(/^The /, "the ")}</strong>. Carry on with it here, or {words.bank.toLowerCase()}
              {Object.keys(outing.haul).length > 0 ? <> ({resourceText(outing.haul)})</> : null} and then {WORDS[spot].start.toLowerCase()} here.
            </p>
            <button disabled={busy} onClick={() => step({ t: "bank" })}>{words.bank}</button>
          </div>
        )}
        {groveMode ? (
          <details className="gather-blurb">
            <summary className="muted">How it works</summary>
            <p className="muted">{def.blurb}</p>
          </details>
        ) : (
          <p className="muted gather-blurb">{def.blurb}</p>
        )}

        {status && (
          <div className="gather-facts">
            <div><span className="muted">Chance per roll</span><strong>{pct}%</strong><span className="muted">{STAT_LABEL[def.stat]} · {outing?.rolls ?? 2} rolls a check</span></div>
            <div>
              <span className="muted">Stamina</span>
              <strong className="gather-pips">
                <StaminaBolts left={left} max={status.stamina.max} size={21} />
              </strong>
              <span className="muted">{left} of {status.stamina.max} left · resets in {resetIn(status.stamina.resetsAt)}</span>
            </div>
            <div><span className="muted">Pays</span><strong>{def.pays.join(", ")}</strong><span className="muted">banking always pays at least 1</span></div>
            {status.harborXp && (
              <div>
                <span className="muted">Harbor XP</span>
                <strong>{status.harborXp.left} of {status.harborXp.cap}</strong>
                <span className="muted">left today, from any pastime · voyages are not capped</span>
              </div>
            )}
          </div>
        )}
        {error && <p className="bad">{error}</p>}
        {!status && !error && <p className="muted">Looking around…</p>}

        {finishedElsewhere && (
          <p className={finishedElsewhere.status === "banked" ? "good" : "muted"}>
            {finishedElsewhere.status === "banked"
              ? `Brought home from ${GATHER_SPOTS[finishedElsewhere.spot].name.replace(/^The /, "the ")}: ${resourceText(paid ?? finishedElsewhere.payout)}.`
              : `Nothing came home from ${GATHER_SPOTS[finishedElsewhere.spot].name.replace(/^The /, "the ")}.`}
          </p>
        )}
        {status && !outing && (
          left > 0
            ? <button className="primary" disabled={busy} onClick={() => run(() => api.gatherStart(spot))}>{words.start} · uses 1 stamina</button>
            : <p className="bad">You are worn out for today. A voyage or a rest in your own shack gives all three outings back, and a meal at the pub gives back one a day.</p>
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
            {outing.grove && <Grove outing={outing} busy={busy} hero={hero} host={host} step={step} />}
            {outing.spot === "felling" && !outing.grove && active && <p className="muted gather-hint">This outing was started in the old tree line, before the grove. Carry what you have home and start a new one.</p>}
            {outing.water && (
              <>
                <Water outing={outing} busy={busy || !!outing.aim} cast={(cell) => step({ t: "aim", cell })} />
                {active && <p className="muted gather-hint">On the school: +{outing.water.read}% a roll and one more fish. Two or more places off: −{outing.water.read}%. The school drifts a place at most between casts.</p>}
              </>
            )}
            {outing.face && (
              <>
                <Face outing={outing} busy={busy || !!outing.aim} cut={(cell) => step({ t: "aim", cell })} />
                {active && <p className="muted gather-hint">Dust marks a row or column with a weak block in it (two dots: both). A weak block is two cracks; missing both rolls is one.</p>}
              </>
            )}

            {outing.aim && active && outing.spot !== "felling" && <TimingBar aim={outing.aim} spot={outing.spot} busy={busy} stop={(at) => step({ t: "push", at })} />}

            <div className="gather-haul">
              <span className="muted">{active ? "Haul so far" : outing.status === "banked" ? "Brought home" : "Lost"}</span>
              {outing.status === "banked"
                ? <ResourceChips resources={paid ?? outing.payout} />
                : Object.keys(outing.haul).length > 0 ? <ResourceChips resources={outing.haul} /> : <span className="muted">Nothing {active ? "yet" : "to show for it"}.</span>}
            </div>

            <ol className="gather-log">
              {outing.log.map((entry, i) => (
                <li key={i} ref={i === outing.log.length - 1 ? logEnd : undefined} className={i === outing.log.length - 1 ? "latest" : ""}>
                  {entry.timing && <span className={`tag timing-${entry.timing}`}>{TIMING[entry.timing].label}{TIMING[entry.timing].bonus ? ` ${TIMING[entry.timing].bonus > 0 ? "+" : ""}${TIMING[entry.timing].bonus}%` : ""}</span>}
                  {entry.check && <><span className="tag">{entry.check.label} · {entry.check.pct}%</span><Rolls rolls={entry.check.rolls} /></>}
                  <span>{entry.text}</span>
                  {Object.keys(entry.gained).length > 0 && <span className="good"> +{resourceText(entry.gained)}</span>}
                </li>
              ))}
              {outing.log.length === 0 && <li className="muted">{outing.spot === "felling" ? "Nine trees. Read the wind, knock if you are unsure, and pick one to fell." : outing.spot === "fishing" ? "Gulls are circling. The school is under them or right beside. Pick where to cast, then reel when the fish is on the hook." : "Nine blocks. Read the dust, pick one to cut, then strike when the pick is on the mark."}</li>}
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
                {xp?.text && <span className={xp.granted > 0 ? "xp-gain" : "muted"}>{xp.text}</span>}
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
