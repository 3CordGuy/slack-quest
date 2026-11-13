// The Harbor's notice board: what changed in each release of the game, newest
// first (see src/releases.ts). Reading it marks the newest release as read, so
// the "!" over the board goes until the next one.
//
// Contracts and the crew's goal moved to the contract dealer in the pub.
//
// Above the releases, the crew's newest fishing records: who landed what, and
// when. Every kind's full list is on the Record Board at the bar.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FISH, formatLength, formatWeight } from "@gantt-quest/world";
import { RELEASES, releaseTitle, unseenCount, type Release } from "../../releases";
import { api, type PubWall } from "../api";
import { catchIcon } from "../render/catchArt";
import { units } from "../units";
import { DragPanel } from "../DragPanel";
import "./board.css";

/** Releases shown before "Older notices". */
const SHOWN = 5;
/** Crew records pinned up: the newest few. */
const RECORDS_SHOWN = 5;

const ago = (at: number): string => {
  const mins = Math.max(1, Math.round((Date.now() - at) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/** The crew's newest fishing records, one line each. */
function CrewRecords() {
  const u = useSyncExternalStore(units.subscribe, units.get);
  const [wall, setWall] = useState<PubWall | null>(null);
  useEffect(() => {
    // A crewless hero has no records to show; say nothing rather than an error.
    api.pubWall().then(setWall, () => undefined);
  }, []);
  const newest = (wall?.records ?? []).slice(0, RECORDS_SHOWN);
  if (newest.length === 0) return null;
  return (
    <section className="crew-records">
      <h3>Crew records</h3>
      <ul>
        {newest.map((r) => (
          <li key={r.species}>
            <img src={catchIcon(r.species)} alt="" width={32} height={32} />
            <span>
              <strong>{r.name}</strong> {FISH[r.species].rarity === "mythic" ? "landed" : "set the record for"} <strong>{FISH[r.species].name}</strong>: {formatWeight(r.grams, u)}, {formatLength(r.mm, u)}.
            </span>
            <small className="muted">{ago(r.caughtAt)}</small>
          </li>
        ))}
      </ul>
      <p className="muted">Every record, and the fish on the pub's wall, are on the Record Board at the bar.</p>
    </section>
  );
}

function ReleaseNotes({ release, fresh }: { release: Release; fresh: boolean }) {
  return (
    <li className={`release ${fresh ? "fresh" : ""} ${release.unreleased ? "unreleased" : ""}`}>
      <h3>
        {releaseTitle(release)}
        {fresh && <span className="release-new">New</span>}
      </h3>
      {release.first ? (
        <p className="muted">The Harbor of Heylets opens its doors. Everything before this is the game itself.</p>
      ) : release.notes.length === 0 ? (
        <p className="muted">Fixes and small changes behind the scenes.</p>
      ) : (
        <ul className="release-notes">
          {release.notes.map((n, i) => (
            <li key={i}>
              {n.area && <strong>{n.area}: </strong>}
              {n.text}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function NoticeBoard({ seen, onSeen, onClose }: {
  /** The newest release this player had read before opening the board. */
  seen: string | null | undefined;
  /** Called once the server has the newest release down as read. */
  onSeen(): void;
  onClose(): void;
}) {
  // What was new when the board was opened stays marked while it is open, though it is now read.
  const [fresh] = useState(() => unseenCount(seen));
  const [older, setOlder] = useState(false);
  const marked = useRef(false);
  const latest = RELEASES[0];
  useEffect(() => {
    if (!latest || latest.id === seen || marked.current) return;
    marked.current = true;
    api.releaseSeen(latest.id).then(onSeen, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = older ? RELEASES : RELEASES.slice(0, Math.max(SHOWN, fresh));
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <DragPanel id="harbor.notices" title="Notice board" compact className="panel notice-board" role="dialog" aria-label="Notice board">
        <header className="notice-head">
          <h2>Notice board</h2>
          <span className="spacer" />
          <button className="small" onClick={onClose}>Close</button>
        </header>
        <p className="muted">News from the Harbor: what has changed with each new release. Contracts and the crew's goal are with the dealer in the pub now.</p>
        <CrewRecords />
        {RELEASES.length === 0 ? (
          <p className="muted">Nothing pinned up yet.</p>
        ) : (
          <ul className="release-list">
            {shown.map((r, i) => <ReleaseNotes key={r.id} release={r} fresh={i < fresh} />)}
          </ul>
        )}
        {!older && RELEASES.length > shown.length && (
          <button className="small release-older" onClick={() => setOlder(true)}>Older notices ({RELEASES.length - shown.length})</button>
        )}
      </DragPanel>
    </div>
  );
}
