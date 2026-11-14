// What a seat at one of the pub's game tables costs (dice, Shoals, Cargo and
// Krakens). The host picks it when opening a table: nothing at all, for a
// friendly game, or any whole amount of gold up to STAKE_MAX. Every seat
// pays the same, the pot is the stakes added up, and the house keeps its cut.

/** The most a seat can cost. */
export const STAKE_MAX = 1000;

/** Stakes offered with one click; any other amount can be typed. 0 is a free game. */
export const STAKE_PICKS = [0, 10, 25, 50, 100] as const;

/** A stake a table can be opened at: a whole number of gold from 0 (free) to STAKE_MAX. */
export const isStake = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= STAKE_MAX;

/** "free", or "25 gold": what a seat costs, for buttons. */
export const stakeLabel = (ante: number): string => (ante > 0 ? `${ante} gold` : "free");

/** "25 gold a seat", or "no charge": the stake in a sentence ("A table is open at …"). */
export const stakeText = (ante: number): string => (ante > 0 ? `${ante} gold a seat` : "no charge");

/** "The pot is 40 gold.", or a free game's word for it: for the table's log as the game starts. */
export const potText = (pot: number): string => (pot > 0 ? `The pot is ${pot} gold.` : "Playing for the glory of it.");

/** "36 gold", or "the game" when there was no stake: what a winner takes, after "wins". */
export const prizeText = (prize: number): string => (prize > 0 ? `${prize} gold` : "the game");
