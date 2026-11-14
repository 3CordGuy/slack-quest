// The pub's leaderboard: how each player in a crew has done at the three
// game tables. A finished game is written into `pub_scores` in the same D1
// batch that pays its pot (see stake-table.ts), so the board never shows a
// win whose gold did not move, or the other way round.

import { crewFor } from "./db";

export type PubGame = "dice" | "shoals" | "crew";
export const PUB_GAMES: readonly PubGame[] = ["dice", "shoals", "crew"];

/** How a game ended, as the board needs to know it. */
export interface PubResult {
  game: PubGame;
  ante: number;
  /** Everyone who played it to the end; a forfeit still counts as a game played. */
  seats: { id: string }[];
  winner: string | null;
  /** What the winner took, after the house's cut. */
  prize: number;
  /** Cargo and Krakens: each seat's cargo for the game, where there is one. */
  cargo?: (seatId: string) => number | null;
}

/**
 * The statements that add one finished game to the board, one per seat.
 * Nothing when the crew is not known (an old room that nobody has walked
 * into since this was added).
 */
export function scoreStatements(db: D1Database, crewId: string | null, result: PubResult): D1PreparedStatement[] {
  if (!crewId) return [];
  return result.seats.map((seat) => {
    const won = seat.id === result.winner ? 1 : 0;
    const best = result.cargo?.(seat.id) ?? null;
    return db
      .prepare(
        `INSERT INTO pub_scores (crew_id, game, player_id, played, wins, gold_won, staked, streak, best_streak, best)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?4, ?4, ?7)
         ON CONFLICT (crew_id, game, player_id) DO UPDATE SET
           played = played + 1,
           wins = wins + excluded.wins,
           gold_won = gold_won + excluded.gold_won,
           staked = staked + excluded.staked,
           streak = CASE WHEN excluded.wins > 0 THEN streak + 1 ELSE 0 END,
           best_streak = MAX(best_streak, CASE WHEN excluded.wins > 0 THEN streak + 1 ELSE 0 END),
           best = MAX(COALESCE(best, excluded.best), COALESCE(excluded.best, best))`,
      )
      .bind(crewId, result.game, seat.id, won, won ? result.prize : 0, result.ante, best);
  });
}

/** One player's line on the board, for one game. */
export interface PubScore {
  playerId: string;
  name: string;
  played: number;
  wins: number;
  goldWon: number;
  /** Gold won less antes paid. */
  net: number;
  streak: number;
  bestStreak: number;
  /** Cargo and Krakens: the most cargo in one game. */
  best: number | null;
  /** Still in the crew. */
  member: boolean;
}

export type PubLeaderboard = Record<PubGame, PubScore[]>;

/** Most players shown per game. A crew is small; this only bounds the read. */
const BOARD_ROWS = 50;

/** The crew's board: each game's players, the most wins first, then the most gold won. */
export async function pubLeaderboard(db: D1Database, playerId: string): Promise<PubLeaderboard | string> {
  const crew = await crewFor(db, playerId);
  if (!crew) return "The pub is for crews. Join one first.";
  const rows = await db
    .prepare(
      `SELECT * FROM (
         SELECT s.game, s.player_id AS playerId, COALESCE(c.name, '?') AS name, s.played, s.wins, s.gold_won AS goldWon,
                s.gold_won - s.staked AS net, s.streak, s.best_streak AS bestStreak, s.best,
                (m.player_id IS NOT NULL) AS member,
                ROW_NUMBER() OVER (PARTITION BY s.game ORDER BY s.wins DESC, s.gold_won DESC, s.played ASC, c.name ASC) AS place
         FROM pub_scores s
         LEFT JOIN characters c ON c.player_id = s.player_id
         LEFT JOIN crew_members m ON m.player_id = s.player_id AND m.crew_id = s.crew_id
         WHERE s.crew_id = ?1
       ) WHERE place <= ?2 ORDER BY game, place`,
    )
    .bind(crew.id, BOARD_ROWS)
    .all<Omit<PubScore, "member"> & { game: PubGame; place: number; member: number }>();
  const board: PubLeaderboard = { dice: [], shoals: [], crew: [] };
  for (const { game, place: _place, member, ...row } of rows.results) board[game]?.push({ ...row, member: !!member });
  return board;
}
