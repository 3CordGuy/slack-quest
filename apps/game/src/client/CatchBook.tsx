// The Catch Book: a page per water, a slot per kind. A slot is a dark shape
// until that kind is caught (outlined, with a sharper hint, if one got away),
// then the catch in colour with the best one landed. Finishing a page earns
// a wall piece for home; the whole book, a title. Old Ironjaw is a bonus
// slot at the back, outside the count.
//
// Also here: the crew's Record Board, shown at the bar, where a record
// holder can hang their fish on the pub's wall.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { aFish, BOOK_PAGES, BOOK_SLOTS, BOOK_TITLE, COUNTED_PAGES, FISH, FURNISHINGS, PAGE_REWARD, PAGE_XP, biteHint, bookPage, bookProgress, formatLength, formatWeight, type BookPage } from "@gantt-quest/world";
import { api, type CatchBook as Book, type PubWall } from "./api";
import { DragPanel } from "./DragPanel";
import { catchIcon, catchPicture } from "./render/catchArt";
import { units } from "./units";
import "./fishing.css";

const PAGE_NAME: Record<BookPage, string> = { shallows: "Shallows", mouth: "Harbor Mouth", deep: "Deep & Rocky", sea: "Open Sea", strays: "Strays", flotsam: "Flotsam", bonus: "Bonus" };

const day = (at: number | null) => (at ? new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

export function CatchBookPanel({ onClose }: { onClose(): void }) {
  const u = useSyncExternalStore(units.subscribe, units.get);
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<BookPage>("shallows");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api.catchBook().then(setBook, (e: Error) => setError(e.message));
  }, []);

  const entries = useMemo(() => new Map((book?.entries ?? []).map((e) => [e.species, e])), [book]);
  const caught = useMemo(() => new Set((book?.entries ?? []).filter((e) => e.caught > 0).map((e) => e.species)), [book]);
  const records = useMemo(() => new Map((book?.records ?? []).map((r) => [r.species, r])), [book]);
  const progress = useMemo(() => new Map(bookProgress(caught).map((p) => [p.page, p])), [caught]);
  const total = COUNTED_PAGES.reduce((a, p) => a + (progress.get(p)?.have ?? 0), 0);
  const slots = bookPage(page);
  const p = progress.get(page);
  const reward = FURNISHINGS[PAGE_REWARD[page]];
  const chosen = open ? FISH[open] : null;
  const e = open ? entries.get(open) : undefined;
  const rec = open ? records.get(open) : undefined;

  return (
    <div className="overlay" onClick={(ev) => ev.target === ev.currentTarget && onClose()}>
      <DragPanel id="catch.book" title="Catch Book" compact className="panel catch-book" role="dialog" aria-label="Catch Book">
        <header className="gather-head">
          <h2>Catch Book</h2>
          <span className="muted">{total} of {BOOK_SLOTS}{book?.title ? ` · ${book.title}` : ""}</span>
          <span className="spacer" />
          <button className="small" onClick={onClose}>Close</button>
        </header>
        {error && <p className="bad">{error}</p>}
        {!book && !error && <p className="muted">Turning the pages…</p>}
        {book && (
          <>
            <nav className="book-tabs">
              {BOOK_PAGES.map((pg) => {
                const pr = progress.get(pg)!;
                return (
                  <button key={pg} className={`small ${pg === page ? "selected" : ""} ${pr.done ? "done" : ""}`} onClick={() => (setPage(pg), setOpen(null))}>
                    {PAGE_NAME[pg]} <span className="muted">{pr.have}/{pr.of}</span>
                  </button>
                );
              })}
            </nav>
            <p className="muted book-reward">
              {page === "bonus" ? "Outside the count. Landing him earns " : "Finish this page for "}
              <strong>{reward.name}</strong> for your wall{page === "bonus" ? "" : ` and +${PAGE_XP} XP`}.
              {book.claimed.includes(page) && <span className="good"> Earned.</span>}
              {!book.claimed.includes(page) && p?.done && <span className="good"> Done.</span>}
            </p>
            <div className="book-grid">
              {slots.map((f) => {
                const en = entries.get(f.id);
                const state = (en?.caught ?? 0) > 0 ? "caught" : (en?.lost ?? 0) > 0 ? "lost" : "unknown";
                const r = records.get(f.id);
                return (
                  <button key={f.id} className={`book-slot ${state} ${f.rarity} ${open === f.id ? "selected" : ""}`} onClick={() => setOpen(open === f.id ? null : f.id)} title={state === "unknown" ? "Not caught yet" : f.name}>
                    <img src={catchIcon(f.id)} alt="" width={64} height={64} />
                    {state === "caught" && en?.specimen && <span className="book-star" title="A specimen landed">★</span>}
                    {state === "caught" && r?.mine && <span className="book-crown" title="You hold the crew's record">♛</span>}
                    <small>{state === "unknown" ? "?" : f.name}</small>
                  </button>
                );
              })}
            </div>
            {chosen && (
              <div className="book-detail">
                {(e?.caught ?? 0) > 0 ? <img src={catchPicture(chosen.id, 160, "three")} alt="" width={120} height={120} /> : <img className={`book-shadow ${(e?.lost ?? 0) > 0 ? "lost" : ""}`} src={catchIcon(chosen.id)} alt="" width={96} height={96} />}
                <div>
                  <strong>{(e?.caught ?? 0) > 0 ? chosen.name : "Not caught yet"}</strong> <span className="muted">· {chosen.rarity}</span>
                  {(e?.caught ?? 0) > 0 ? (
                    <>
                      <p>Best: {formatWeight(e!.grams, u)}{chosen.kind !== "haul" ? `, ${formatLength(e!.mm, u)}` : ""}. Caught {e!.caught}, first on {day(e!.firstAt)}.</p>
                      <p className="muted">{chosen.blurb}</p>
                    </>
                  ) : (e?.lost ?? 0) > 0 ? (
                    <p>One got away: it was {aFish(chosen.id)}. {biteHint(chosen.id)}</p>
                  ) : (
                    <p className="muted">{biteHint(chosen.id)}</p>
                  )}
                  {rec && (e?.caught ?? 0) > 0 && <p className="muted">Crew record: {formatWeight(rec.grams, u)}, {rec.mine ? "yours" : rec.name}.</p>}
                </div>
              </div>
            )}
            {!book.title && total === BOOK_SLOTS && <p className="good">The book is full: you are a {BOOK_TITLE}.</p>}
          </>
        )}
      </DragPanel>
    </div>
  );
}

/** The crew's records, at the bar: every kind's heaviest, who caught it, and the fish hung on the pub's wall. */
export function RecordBoard({ you, onClose }: { you: string; onClose(): void }) {
  const u = useSyncExternalStore(units.subscribe, units.get);
  const [wall, setWall] = useState<PubWall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.pubWall().then(setWall, (e: Error) => setError(e.message));
  }, []);
  const act = async (fishId: string, down: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setWall(await api.wallFish(fishId, down));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const hung = new Set((wall?.mounts ?? []).map((m) => m.fishId));
  return (
    <div className="overlay" onClick={(ev) => ev.target === ev.currentTarget && onClose()}>
      <DragPanel id="pub.records" title="Crew records" compact className="panel catch-panel" role="dialog" aria-label="Crew records">
        <header className="gather-head">
          <h2>Crew records</h2>
          {wall && <span className="muted">{wall.mounts.length} of {wall.slots} on the wall</span>}
          <span className="spacer" />
          <button className="small" onClick={onClose}>Close</button>
        </header>
        {error && <p className="bad">{error}</p>}
        {!wall && !error && <p className="muted">Reading the board…</p>}
        {wall && (
          <ul className="catch-list records">
            {wall.records.map((r) => (
              <li key={r.species} className="catch-row">
                <img src={catchIcon(r.species)} alt="" width={40} height={40} className="catch-row-icon" />
                <span className="grow">
                  <strong>{FISH[r.species].name}</strong>
                  <small className="muted"> {formatWeight(r.grams, u)} · {formatLength(r.mm, u)} · {r.playerId === you ? "you" : r.name}, {day(r.caughtAt)}</small>
                </span>
                {r.fishId && hung.has(r.fishId) && <span className="tag wanted">on the wall</span>}
                {r.playerId === you && r.fishId && !hung.has(r.fishId) && (
                  <button className="small" disabled={busy} onClick={() => void act(r.fishId!, false)} title="Hang it on the pub's wall, while it is the record. If it was sold, it cannot be hung.">Hang it up</button>
                )}
                {r.playerId === you && r.fishId && hung.has(r.fishId) && (
                  <button className="small" disabled={busy} onClick={() => void act(r.fishId!, true)}>Take it down</button>
                )}
              </li>
            ))}
            {wall.records.length === 0 && <li className="muted">No records yet. Every fish anyone in the crew keeps is a record until someone keeps a bigger one.</li>}
          </ul>
        )}
      </DragPanel>
    </div>
  );
}
