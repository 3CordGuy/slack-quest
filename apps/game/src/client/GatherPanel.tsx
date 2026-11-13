// A gathering outing: fishing, felling or the quarry. The server holds the
// outing and rolls every check; this panel shows what it sends back and
// posts the player's choice to push on or bank.

import { useEffect, useRef, useState, type RefObject } from "react";
import { GATHER_SPOTS, TIMING, STAT_LABEL, type FishSpot, type GatherChoice, type GatherSpot, type GatherView, type Resources } from "@gantt-quest/world";
import { api, type GatherStatus, type XpResult } from "./api";
import { DragPanel } from "./DragPanel";
import { FellingGame } from "./FellingGame";
import { Fishing } from "./Fishing";
import type { WorldRenderer } from "./render/WorldRenderer";
import { TimingBar } from "./TimingBar";
import { Quarry } from "./Quarry";
import { QuarryIntro } from "./QuarryIntro";
import { ResourceChips, resourceText } from "./hutDrops";
import "./gather.css";
import { StaminaBolts } from "./StaminaBolts";

const WORDS: Record<GatherSpot, { start: string; push: string; bank: string; meter: string }> = {
  fishing: { start: "Go fishing", push: "", bank: "Land what you have", meter: "Line tension" },
  felling: { start: "Start felling", push: "", bank: "Carry it home", meter: "" },
  quarry: { start: "Go to the face", push: "", bank: "Haul it out", meter: "" },
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

export function GatherPanel({ spot, pier, shipBeside = false, onRod, renderer, onClose, onStamina }: {
  spot: GatherSpot;
  /** Fishing: the pier (or the shore) the hero is standing on. */
  pier?: Exclude<FishSpot, "sea">;
  /** A crew's ship is moored off that pier. */
  shipBeside?: boolean;
  /** Fishing: show the hero with a rod in hand to everyone in the Harbor, or put it down. */
  onRod?(on: boolean): void;
  /** The Harbor's renderer: felling is played in it, through the hero's eyes. */
  renderer: RefObject<WorldRenderer | null>;
  onClose(): void;
  /** Told each time the outings left change, so the plate can follow. */
  onStamina?(s: { left: number; max: number }): void;
}) {
  const [status, setStatus] = useState<GatherStatus | null>(null);
  const [atPier] = useState(pier);
  const [shipAtOpen] = useState(shipBeside);
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

  const apply = (next: GatherStatus & { paid?: Resources; xp?: XpResult }) => {
    setStatus(next);
    setPaid(next.paid ?? null);
    setXp(next.xp ?? null);
  };
  const run = async (call: () => Promise<GatherStatus & { paid?: Resources; xp?: XpResult }>) => {
    setBusy(true);
    setError(null);
    try {
      apply(await call());
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
  // Fishing is played from the pier in the Harbor itself. An old shore outing still open, or an outing open
  // somewhere else, is finished in the panel first.
  // Where it was opened, held for as long as it is open: a reconnect to the Harbor puts the hero back where heroes
  // arrive, and the sitting must not fall back to the old panel because of it. An open sitting with no pier to hand
  // is fished from its own.
  const open = latest?.status === "active" ? latest : null;
  const sittingAt = open?.sitting && open.sitting.spot !== "sea" ? open.sitting.spot : undefined;
  const fishFrom = atPier ?? sittingAt;
  if (spot === "fishing" && fishFrom && renderer.current) {
    if (!status && !error) return null;
    if (!open || open.sitting) return <Fishing pier={fishFrom} world={renderer.current} shipBeside={shipAtOpen} onRod={onRod} onClose={onClose} onStamina={onStamina} />;
  }
  // Felling is played in the Harbor itself, through the hero's eyes: no panel over it.
  if (outing?.felling && outing.spot === spot) {
    return (
      <FellingGame
        outing={outing}
        busy={busy}
        error={error}
        paid={paid}
        xp={xp}
        staminaLeft={left}
        renderer={renderer}
        step={step}
        again={() => void run(() => api.gatherStart(spot))}
        onClose={onClose}
      />
    );
  }

  // The quarry is played at the face itself, in the Harbor: the panel gives way to the camera and a small HUD.
  if (outing?.mine && active && outing.spot === spot && renderer.current) return <Quarry outing={outing} world={renderer.current} apply={apply} onLeave={onClose} />;
  // Before a run, and after one, the quarry has its own card. (An old-style outing, or one open elsewhere, falls through to the panel.)
  if (spot === "quarry" && !active && !finishedElsewhere && (!outing || outing.mine)) {
    return (
      <QuarryIntro
        status={status}
        outing={outing}
        paid={paid}
        xp={xp}
        busy={busy}
        error={error}
        onStart={() => void run(() => api.gatherStart(spot))}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
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
        <p className="muted gather-blurb">{def.blurb}</p>

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
            {outing.spot === "fishing" && (
              <div className="gather-meter" aria-label={`Reel ${outing.step} of ${outing.maxSteps}`}>
                <span className="muted">{words.meter}</span>
                {Array.from({ length: outing.maxSteps }, (_, i) => <i key={i} className={i < outing.step ? "on" : ""} />)}
                <span className="muted">cast {outing.step} of {outing.maxSteps}</span>
              </div>
            )}
            {outing.spot === "felling" && !outing.felling && active && <p className="muted gather-hint">This outing was started before felling changed. Carry what you have home and start a new one.</p>}
            {outing.water && (
              <>
                <Water outing={outing} busy={busy || !!outing.aim} cast={(cell) => step({ t: "aim", cell })} />
                {active && <p className="muted gather-hint">On the school: +{outing.water.read}% a roll and one more fish. Two or more places off: −{outing.water.read}%. The school drifts a place at most between casts.</p>}
              </>
            )}
            {outing.spot === "quarry" && !outing.mine && active && <p className="muted gather-hint">This outing was started at the old face, before it was reworked. Haul out what you have and start again.</p>}
            {outing.spot === "quarry" && outing.mine && active && !renderer.current && <p className="muted gather-hint">The rock face can only be worked from the Harbor.</p>}

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
              {outing.log.length === 0 && <li className="muted">{outing.spot === "felling" ? "The old tree line." : outing.spot === "fishing" ? "Gulls are circling. The school is under them or right beside. Pick where to cast, then reel when the fish is on the hook." : "Thirty seconds at the rock face."}</li>}
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
