// The leaderboard on the pub's wall: how everyone in the crew has done at the
// four game tables. Read from the server when it opens, and again whenever a
// game in the pub starts or ends while it is open.

import { useEffect, useState } from "react";
import { api, type PubGame, type PubLeaderboard as Board, type PubScore } from "./api";
import { DragPanel } from "./DragPanel";

const GAMES: { id: PubGame; name: string; short: string }[] = [
  { id: "dice", name: "Dice", short: "Dice" },
  { id: "shoals", name: "Shoals", short: "Shoals" },
  { id: "crew", name: "Cargo and Krakens", short: "Cargo" },
  { id: "tide", name: "Turn the Tide", short: "Tide" },
];

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function PubLeaderboard({ you, version, onClose }: { you: string; version: string; onClose(): void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [game, setGame] = useState<PubGame>("dice");
  useEffect(() => {
    api.pubLeaderboard().then((b) => (setBoard(b), setError(null)), (e: Error) => setError(e.message));
  }, [version]);

  const rows: PubScore[] = board?.[game] ?? [];
  const leaders = GAMES.flatMap((g) => {
    const top = board?.[g.id][0];
    return top && top.wins > 0 ? [`${top.playerId === you ? "you" : top.name} at ${g.name}`] : [];
  });

  return (
    <DragPanel id="pub.leaderboard" title="Leaderboard" className="story panel pub-bar pub-board" role="dialog" aria-label="The crew's leaderboard">
      <header className="gather-head">
        <h3>The tables' board</h3>
        <span className="spacer" />
        <button className="small" onClick={onClose}>Close</button>
      </header>
      <p className="muted">{leaders.length > 0 ? `Chalked at the top: ${leaders.join(", ")}.` : "Nothing chalked up yet. Win a game at one of the tables to get on the board."}</p>
      <div className="pub-board-tabs" role="tablist">
        {GAMES.map((g) => (
          <button key={g.id} role="tab" aria-selected={game === g.id} className={`small${game === g.id ? " primary" : ""}`} onClick={() => setGame(g.id)}>
            <span className="long">{g.name}</span>
            <span className="short">{g.short}</span>
          </button>
        ))}
      </div>
      {error && <p className="bad">{error}</p>}
      {!board && !error && <p className="muted">Reading the board…</p>}
      {board && rows.length === 0 && <p className="muted">Nobody has finished a game of {GAMES.find((g) => g.id === game)!.name} here yet.</p>}
      {rows.length > 0 && (
        <div className="pub-board-scroll">
          <table className="pub-board-table">
            <thead>
              <tr>
                <th className="rank">#</th>
                <th className="who">Player</th>
                <th title="Games won">Wins</th>
                <th title="Games played to the end">Played</th>
                <th title="Gold taken in prizes, after the house's cut">Gold</th>
                <th className="wide" title="Gold won less antes paid">Net</th>
                <th className="wide" title="Most wins in a row (wins in a row now)">Run</th>
                {game === "crew" && <th title="Most cargo in one game">Cargo</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.playerId} className={`${r.playerId === you ? "mine" : ""}${r.member ? "" : " gone"}`}>
                  <td className="rank">{i + 1}</td>
                  <td className="who">
                    {r.playerId === you ? "You" : r.name}
                    {!r.member && <small className="muted"> (left)</small>}
                  </td>
                  <td>{r.wins}</td>
                  <td>{r.played}</td>
                  <td className="won">{r.goldWon}</td>
                  <td className={`wide ${r.net > 0 ? "good" : r.net < 0 ? "bad" : ""}`}>{signed(r.net)}</td>
                  <td className="wide">{r.bestStreak}{r.streak > 1 && <small className="muted"> ({r.streak} now)</small>}</td>
                  {game === "crew" && <td>{r.best ?? "–"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DragPanel>
  );
}
