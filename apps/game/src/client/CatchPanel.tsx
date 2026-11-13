// Kept fish: the icebox and the trophy chest. Opened three ways: from the
// inventory (to look and to move fish between the two), at the fishmonger's
// stall on the shore (to sell at today's board), and at the bar (to sell to
// Old Tam, who only takes what he can cook).

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FISH, FISH_WANTED_BONUS, formatLength, formatLoad, formatWeight, type FishBuyer } from "@gantt-quest/world";
import { api, type FishStock } from "./api";
import { DragPanel } from "./DragPanel";
import { catchIcon } from "./render/catchArt";
import { units } from "./units";
import "./fishing.css";

type Kept = FishStock["icebox"][number];

const TITLE: Record<FishBuyer | "none", string> = { market: "The fishmonger", tam: "Old Tam buys fish", none: "Your catch" };

function until(at: number): string {
  const minutes = Math.max(1, Math.ceil((at - Date.now()) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

export function CatchPanel({ buyer, onClose, onGold }: {
  /** Who is buying; null to just look and move fish about. */
  buyer: FishBuyer | null;
  onClose(): void;
  /** Told when a sale changes the player's gold. */
  onGold?(): void;
}) {
  const u = useSyncExternalStore(units.subscribe, units.get);
  const [stock, setStock] = useState<FishStock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    api.fish().then(setStock, (e: Error) => setError(e.message));
  }, []);

  const price = (f: Kept) => (buyer ? f[buyer] : null);
  const sellable = useMemo(() => (stock ? [...stock.icebox, ...stock.trophy].filter((f) => buyer && f[buyer] !== null) : []), [stock, buyer]);
  const total = sellable.filter((f) => picked.has(f.id)).reduce((a, f) => a + (price(f) ?? 0), 0);

  const act = async (call: () => Promise<FishStock & { sold?: { id: string; gold: number }[] }>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const next = await call();
      setStock(next);
      setPicked(new Set());
      if (next.sold?.length) {
        setNote(`Sold ${next.sold.length} for ${next.sold.reduce((a, s) => a + s.gold, 0)} gold.`);
        onGold?.();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sell = (ids: string[]) => buyer && ids.length > 0 && void act(() => api.sellFish(ids, buyer));
  const move = (id: string, to: "trophy" | "icebox") => void act(() => api.moveFish(id, to));
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const row = (f: Kept) => {
    const def = FISH[f.species];
    const p = price(f);
    const wanted = buyer === "market" && stock?.board.wanted.includes(f.species);
    return (
      <li key={f.id} className={`catch-row ${picked.has(f.id) ? "picked" : ""}`}>
        {buyer && <input type="checkbox" checked={picked.has(f.id)} disabled={p === null || busy} onChange={() => toggle(f.id)} aria-label={`Pick ${def.name}`} />}
        <img src={catchIcon(f.species)} alt="" width={40} height={40} className="catch-row-icon" />
        <span className="grow">
          <strong>{def.name}</strong>
          {f.specimen && <span className="tag specimen">specimen</span>}
          {wanted && <span className="tag wanted">wanted</span>}
          <small className="muted"> {formatWeight(f.grams, u)}{def.kind !== "haul" ? ` · ${formatLength(f.mm, u)}` : ""}</small>
        </span>
        {buyer ? (
          <span className={p === null ? "muted catch-price" : "good catch-price"}>{p === null ? (buyer === "tam" ? "Won't cook it" : "No use") : `${p}g`}</span>
        ) : (
          <span className="muted catch-price" title="What the fishmonger and Old Tam would pay today">
            {f.market === null ? "stall —" : `stall ${f.market}g`} · {f.tam === null ? "Tam —" : `Tam ${f.tam}g`}
          </span>
        )}
        {f.place === "icebox" && f.specimen && def.kind !== "haul" && <button className="small" disabled={busy} onClick={() => move(f.id, "trophy")} title="Keep it for good, to mount or sell later">To chest</button>}
        {f.place === "trophy" && <button className="small" disabled={busy} onClick={() => move(f.id, "icebox")}>To icebox</button>}
      </li>
    );
  };

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <DragPanel id="harbor.catch" title={TITLE[buyer ?? "none"]} compact className="panel catch-panel" role="dialog" aria-label={TITLE[buyer ?? "none"]}>
        <header className="gather-head">
          <h2>{TITLE[buyer ?? "none"]}</h2>
          <span className="spacer" />
          {stock && <span className="gold">{stock.gold} gold</span>}
          <button className="small" onClick={onClose}>Close</button>
        </header>
        {!stock && !error && <p className="muted">Opening the icebox…</p>}
        {error && <p className="bad">{error}</p>}
        {note && <p className="good">{note}</p>}
        {stock && (
          <>
            {buyer === "market" && (
              <div className="catch-board">
                <span className="muted">Chalked up, until the board changes in {until(stock.board.endsAt)}:</span>
                <div className="catch-wanted">
                  {stock.board.wanted.map((id) => (
                    <span key={id} className="catch-wanted-one">
                      <img src={catchIcon(id)} alt="" width={32} height={32} className="catch-row-icon" />
                      <strong>{FISH[id].name}</strong>
                      <small className="good">pays {FISH_WANTED_BONUS}× today</small>
                    </span>
                  ))}
                </div>
                <p className="muted">Everything else at today's rate, by weight. Specimens fetch a quarter more.</p>
              </div>
            )}
            {buyer === "tam" && <p className="muted">"I'll take what goes in the stew, and pay the same for it every day. Anything fancy, take it to the fishmonger."</p>}

            <h3>
              Icebox <span className="muted">· {formatLoad(stock.iceboxG, u)} of {formatLoad(stock.iceboxCapG, u)}</span>
            </h3>
            <div className="fish-creel-bar catch-ice"><div style={{ width: `${Math.min(100, (stock.iceboxG / stock.iceboxCapG) * 100)}%` }} /></div>
            <ul className="catch-list">
              {stock.icebox.map(row)}
              {stock.icebox.length === 0 && <li className="muted">Empty. Catch something.</li>}
            </ul>

            <h3>
              Trophy chest <span className="muted">· {stock.trophy.length} of {stock.trophyCap}</span>
            </h3>
            <ul className="catch-list">
              {stock.trophy.map(row)}
              {stock.trophy.length === 0 && <li className="muted">Specimens kept here stay fresh for good, to mount or sell later.</li>}
            </ul>

            {buyer && (
              <div className="row catch-foot">
                <button disabled={busy || sellable.length === 0} onClick={() => setPicked(new Set(sellable.filter((f) => f.place === "icebox").map((f) => f.id)))}>Pick the icebox</button>
                <span className="spacer" />
                <button className="primary" disabled={busy || picked.size === 0} onClick={() => sell([...picked])}>
                  Sell {picked.size || ""} · {total}g
                </button>
              </div>
            )}
          </>
        )}
      </DragPanel>
    </div>
  );
}
