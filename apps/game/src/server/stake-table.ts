// The pub's game tables, run inside the crew's PubRoom.
//
// Each game's rules are a pure reducer in packages/world (dice.ts,
// shoals.ts). This file owns a table's state (in Durable Object storage, so
// it survives hibernation), moves the gold in D1, and sends each socket only
// its own view of the game. There is no turn timer and no alarm: a seated
// player who is no longer standing at the table forfeits, which is checked
// whenever someone moves, leaves or connects.
//
// Gold: antes are taken in one statement when a game starts (everyone pays
// or nobody does), and the prize is paid in one statement when it ends.
// Both are written to D1 before the table's state is saved and before
// anyone is told.

import type { HexPos } from "@gantt-quest/core";
import {
  DICE_MAX_PLAYERS,
  PUB_DICE,
  PUB_SHOALS,
  SHOALS_MAX_PLAYERS,
  createDiceGame,
  createShoalsGame,
  diceSplit,
  diceView,
  isDiceAnte,
  isShoalsAnte,
  shoalsSplit,
  shoalsView,
  stepDice,
  stepShoals,
  type DiceGame,
  type DiceRequest,
  type HarborPlayer,
  type ShoalsGame,
  type ShoalsRequest,
  HARBOR_XP,
} from "@gantt-quest/world";
import type { Env } from "./db";
import { prepareXp, relayXp, xpMessage, xpOutcome } from "./harbor-xp";

/** What every table game's state has in common. */
interface StakeGame {
  ante: number;
  phase: "open" | "playing" | "done";
  seats: { id: string; name: string }[];
  winner: string | null;
  pot: number;
}

type Outcome<G> = { ok: true; state: G } | { ok: false; error: string };

/** One game, as the table needs to know it. */
interface Rules<G extends StakeGame, R extends { type: string }> {
  /** Storage key, and the `type` of the messages that carry the table to clients. */
  name: "dice" | "shoals";
  /** Where a player stands to be at this table. */
  spot: HexPos;
  maxPlayers: number;
  requests: ReadonlySet<string>;
  isAnte(n: unknown): boolean;
  create(seed: number, ante: number, host: { id: string; name: string }): G;
  /** Apply a seated player's request (anything but "open"). */
  step(game: G, player: HarborPlayer, request: R): Outcome<G>;
  leave(game: G, playerId: string): Outcome<G>;
  view(game: G, viewerId: string): unknown;
  prize(pot: number): number;
  /** Seated, but already out of the game: they need not stay at the table. */
  isOut(game: G, seatId: string): boolean;
}

export const DICE_RULES: Rules<DiceGame, DiceRequest> = {
  name: "dice",
  spot: PUB_DICE,
  maxPlayers: DICE_MAX_PLAYERS,
  requests: new Set(["open", "sit", "leave", "start", "bid", "call"]),
  isAnte: isDiceAnte,
  create: createDiceGame,
  step(game, player, request) {
    if (request.type === "sit") return stepDice(game, player.id, { type: "sit", name: player.name });
    if (request.type === "bid") return stepDice(game, player.id, { type: "bid", count: Number(request.count), face: Number(request.face) });
    if (request.type === "open") return { ok: false, error: "There is already a table open." };
    return stepDice(game, player.id, { type: request.type });
  },
  leave: (game, playerId) => stepDice(game, playerId, { type: "leave" }),
  view: diceView,
  prize: (pot) => diceSplit(pot).prize,
  isOut: (game, seatId) => game.seats.find((s) => s.id === seatId)?.dice.length === 0,
};

export const SHOALS_RULES: Rules<ShoalsGame, ShoalsRequest> = {
  name: "shoals",
  spot: PUB_SHOALS,
  maxPlayers: SHOALS_MAX_PLAYERS,
  requests: new Set(["open", "sit", "leave", "start", "lay", "bid", "pass", "flip"]),
  isAnte: isShoalsAnte,
  create: createShoalsGame,
  step(game, player, request) {
    if (request.type === "sit") return stepShoals(game, player.id, { type: "sit", name: player.name });
    if (request.type === "lay") return stepShoals(game, player.id, { type: "lay", marker: request.marker });
    if (request.type === "bid") return stepShoals(game, player.id, { type: "bid", count: Number(request.count) });
    if (request.type === "flip") return stepShoals(game, player.id, { type: "flip", seat: String(request.seat) });
    if (request.type === "open") return { ok: false, error: "There is already a table open." };
    return stepShoals(game, player.id, { type: request.type });
  },
  leave: (game, playerId) => stepShoals(game, playerId, { type: "leave" }),
  view: shoalsView,
  prize: (pot) => shoalsSplit(pot).prize,
  isOut(game, seatId) {
    const seat = game.seats.find((s) => s.id === seatId);
    return !!seat && seat.own.channel + seat.own.shoal === 0;
  },
};

export class StakeTable<G extends StakeGame, R extends { type: string }> {
  /** undefined: not read from storage yet. null: no table. */
  private game: G | null | undefined;
  /** D1 calls let other messages in, so everything that touches the table runs one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private rules: Rules<G, R>,
  ) {}

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<G | null> {
    if (this.game === undefined) this.game = (await this.ctx.storage.get<G>(this.rules.name)) ?? null;
    return this.game;
  }

  private async save(game: G | null): Promise<void> {
    this.game = game;
    if (game) await this.ctx.storage.put(this.rules.name, game);
    else await this.ctx.storage.delete(this.rules.name);
  }

  private send(ws: WebSocket, message: object) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Socket is closing.
    }
  }

  private at(player: HarborPlayer): boolean {
    return player.pos.q === this.rules.spot.q && player.pos.r === this.rules.spot.r;
  }

  /** Everyone connected, and whether they are standing at the table. */
  private sockets(except?: WebSocket): { ws: WebSocket; player: HarborPlayer; atTable: boolean }[] {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const player = ws.deserializeAttachment() as HarborPlayer | null;
      if (player) out.push({ ws, player, atTable: this.at(player) });
    }
    return out;
  }

  /** Tell everyone in the pub what they may see of the table. */
  private publish(game: G | null, except?: WebSocket) {
    for (const { ws, player } of this.sockets(except)) this.send(ws, { type: this.rules.name, table: game && this.rules.view(game, player.id) });
  }

  private async gold(playerId: string): Promise<number> {
    const row = await this.env.DB.prepare("SELECT gold FROM characters WHERE player_id = ?").bind(playerId).first<{ gold: number }>();
    return row?.gold ?? 0;
  }

  /**
   * Take the ante from every seat, or from none: the one statement only
   * touches any row if every seated player can afford it.
   */
  private async takeAntes(game: G): Promise<boolean> {
    const ids = game.seats.map((s) => s.id);
    const marks = ids.map((_, i) => `?${i + 2}`).join(",");
    const [res] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE characters SET gold = gold - ?1 WHERE player_id IN (${marks})
         AND (SELECT COUNT(*) FROM characters WHERE player_id IN (${marks}) AND gold >= ?1) = ${ids.length}`,
      ).bind(game.ante, ...ids),
    ]);
    return res.meta.changes === ids.length;
  }

  /** The pot to the winner, and a little Harbor XP with it, in one batch. Everyone in the pub sees the XP. */
  private async pay(game: G): Promise<void> {
    if (!game.winner) return;
    const xp = await prepareXp(this.env.DB, game.winner, HARBOR_XP.pubWin);
    const results = await this.env.DB.batch([
      this.env.DB.prepare("UPDATE characters SET gold = gold + ? WHERE player_id = ?").bind(this.rules.prize(game.pot), game.winner),
      ...(xp?.statements() ?? []),
    ]);
    const earned = xpOutcome(xp, results);
    if (earned && earned.granted > 0) relayXp(this.ctx, xpMessage(game.winner, earned), (m) => this.publishRaw(m));
  }

  private publishRaw(message: object) {
    for (const { ws } of this.sockets()) this.send(ws, message);
  }

  /**
   * Settle one step of the rules, moving gold if it starts or ends the game.
   * Returns an error message, or null once the new state is saved.
   */
  private async settle(game: G, res: Outcome<G>): Promise<string | null> {
    if (!res.ok) return res.error;
    let next: G | null = res.state;
    if (game.phase === "open" && next.phase === "playing" && !(await this.takeAntes(game))) {
      // Someone spent their stake since sitting down. They lose the seat; the game does not start.
      next = game;
      const broke: string[] = [];
      for (const seat of game.seats) {
        if ((await this.gold(seat.id)) >= game.ante) continue;
        const left: Outcome<G> = this.rules.leave(next, seat.id);
        if (left.ok) next = left.state;
        broke.push(seat.name);
      }
      await this.save(next.seats.length > 0 ? next : null);
      return `${broke.join(" and ") || "Someone"} cannot cover the ante any more.`;
    }
    if (game.phase === "playing" && next.phase === "done") await this.pay(next);
    // A table everyone got up from before the start is cleared away. No ante was taken, so there is nothing to return.
    if (next.seats.length === 0) next = null;
    await this.save(next);
    return null;
  }

  /** A request from a player's socket. */
  handle(ws: WebSocket, player: HarborPlayer, request: R): Promise<void> {
    return this.locked(async () => {
      if (!request || !this.rules.requests.has(request.type)) return;
      // Read again: they may have walked while this request waited its turn.
      const error = await this.request((ws.deserializeAttachment() as HarborPlayer | null) ?? player, request);
      this.publish(await this.load());
      // After the table, which clears any earlier refusal on the client.
      if (error) this.send(ws, { type: `${this.rules.name}Error`, text: error });
    });
  }

  private async request(player: HarborPlayer, request: R): Promise<string | null> {
    const game = await this.load();
    if (!this.at(player)) return "Walk up to the table first.";

    if (request.type === "open") {
      const ante = (request as { ante?: unknown }).ante;
      if (game && game.phase !== "done") return "There is already a table open.";
      if (!this.rules.isAnte(ante)) return "Pick a stake of 5, 10 or 20 gold.";
      if ((await this.gold(player.id)) < (ante as number)) return "You cannot afford that ante.";
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      await this.save(this.rules.create(seed, ante as number, { id: player.id, name: player.name }));
      return null;
    }
    if (!game) return "Nobody has opened a table.";
    if (request.type === "sit" && game.phase === "open" && game.seats.length < this.rules.maxPlayers && (await this.gold(player.id)) < game.ante) return "You cannot afford the ante.";
    return this.settle(game, this.rules.step(game, player, request));
  }

  /**
   * Seated players must be standing at the table. Anyone who is not (they
   * walked off, left the pub, or dropped) gives up their seat, which
   * during a game is a forfeit. `gone` is a socket that is closing.
   */
  reconcile(gone?: WebSocket): Promise<void> {
    return this.locked(async () => {
      let game = await this.load();
      if (!game || game.phase === "done") return;
      const present = new Set(this.sockets(gone).filter((s) => s.atTable).map((s) => s.player.id));
      let changed = false;
      for (const seat of [...game.seats]) {
        if (present.has(seat.id) || (game.phase === "playing" && this.rules.isOut(game, seat.id))) continue;
        if ((await this.settle(game, this.rules.leave(game, seat.id))) !== null) continue;
        changed = true;
        game = await this.load();
        if (!game || game.phase === "done") break;
      }
      if (changed) this.publish(game, gone);
    });
  }

  /** A player just connected: settle anything left over from a restart, then show them the table. */
  async welcome(ws: WebSocket, player: HarborPlayer): Promise<void> {
    await this.reconcile();
    await this.locked(async () => {
      const game = await this.load();
      this.send(ws, { type: this.rules.name, table: game && this.rules.view(game, player.id) });
    });
  }
}
