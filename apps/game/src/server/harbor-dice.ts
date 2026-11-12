// The Harbor's dice table, run inside the crew's HarborRoom.
//
// The rules are the pure reducer in packages/world/src/dice.ts. This file
// owns the table's state (in Durable Object storage, so it survives
// hibernation), moves the gold in D1, and sends each socket only its own
// view of the dice. There is no turn timer and no alarm: a seated player
// who is no longer standing at the table forfeits, which is checked
// whenever someone moves, leaves or connects.
//
// Gold: antes are taken in one statement when the game starts (everyone
// pays or nobody does), and the prize is paid in one statement when it
// ends. Both are written to D1 before the table's state is saved and
// before anyone is told.

import { DICE_MAX_PLAYERS, HARBOR_DICE, createDiceGame, diceSplit, diceView, isDiceAnte, stepDice, type DiceAction, type DiceGame, type DiceRequest, type HarborPlayer, type HarborServerMessage } from "@gantt-quest/world";
import type { Env } from "./db";

const KEY = "dice";
const REQUESTS = new Set(["open", "sit", "leave", "start", "bid", "call"]);

export class DiceTable {
  /** undefined: not read from storage yet. null: no table. */
  private game: DiceGame | null | undefined;
  /** D1 calls let other messages in, so everything that touches the table runs one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<DiceGame | null> {
    if (this.game === undefined) this.game = (await this.ctx.storage.get<DiceGame>(KEY)) ?? null;
    return this.game;
  }

  private async save(game: DiceGame | null): Promise<void> {
    this.game = game;
    if (game) await this.ctx.storage.put(KEY, game);
    else await this.ctx.storage.delete(KEY);
  }

  private send(ws: WebSocket, message: HarborServerMessage) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Socket is closing.
    }
  }

  /** Everyone connected, and whether they are standing at the table. */
  private sockets(except?: WebSocket): { ws: WebSocket; player: HarborPlayer; atTable: boolean }[] {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const player = ws.deserializeAttachment() as HarborPlayer | null;
      if (player) out.push({ ws, player, atTable: player.pos.q === HARBOR_DICE.q && player.pos.r === HARBOR_DICE.r });
    }
    return out;
  }

  /** Tell everyone in the Harbor what they may see of the table. */
  private publish(game: DiceGame | null, except?: WebSocket) {
    for (const { ws, player } of this.sockets(except)) this.send(ws, { type: "dice", table: game && diceView(game, player.id) });
  }

  private async gold(playerId: string): Promise<number> {
    const row = await this.env.DB.prepare("SELECT gold FROM characters WHERE player_id = ?").bind(playerId).first<{ gold: number }>();
    return row?.gold ?? 0;
  }

  /**
   * Take the ante from every seat, or from none: the one statement only
   * touches any row if every seated player can afford it.
   */
  private async takeAntes(game: DiceGame): Promise<boolean> {
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

  private async pay(game: DiceGame): Promise<void> {
    if (!game.winner) return;
    await this.env.DB.batch([this.env.DB.prepare("UPDATE characters SET gold = gold + ? WHERE player_id = ?").bind(diceSplit(game.pot).prize, game.winner)]);
  }

  /**
   * Apply one rules action, moving gold if it starts or ends the game.
   * Returns an error message, or null once the new state is saved.
   */
  private async apply(game: DiceGame, playerId: string, action: DiceAction): Promise<string | null> {
    const res = stepDice(game, playerId, action);
    if (!res.ok) return res.error;
    let next: DiceGame | null = res.state;
    if (game.phase === "open" && next.phase === "playing" && !(await this.takeAntes(game))) {
      // Someone spent their stake since sitting down. They lose the seat; the game does not start.
      next = game;
      const broke: string[] = [];
      for (const seat of game.seats) {
        if ((await this.gold(seat.id)) >= game.ante) continue;
        const left = stepDice(next, seat.id, { type: "leave" });
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
  handle(ws: WebSocket, player: HarborPlayer, request: DiceRequest): Promise<void> {
    return this.locked(async () => {
      if (!request || !REQUESTS.has(request.type)) return;
      // Read again: they may have walked while this request waited its turn.
      const error = await this.request((ws.deserializeAttachment() as HarborPlayer | null) ?? player, request);
      this.publish(await this.load());
      // After the table, which clears any earlier refusal on the client.
      if (error) this.send(ws, { type: "diceError", text: error });
    });
  }

  private async request(player: HarborPlayer, request: DiceRequest): Promise<string | null> {
    const game = await this.load();
    const atTable = player.pos.q === HARBOR_DICE.q && player.pos.r === HARBOR_DICE.r;
    if (!atTable) return "Walk up to the dice table first.";

    if (request.type === "open") {
      if (game && game.phase !== "done") return "There is already a table open.";
      if (!isDiceAnte(request.ante)) return "Pick a stake of 5, 10 or 20 gold.";
      if ((await this.gold(player.id)) < request.ante) return "You cannot afford that ante.";
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      await this.save(createDiceGame(seed, request.ante, { id: player.id, name: player.name }));
      return null;
    }
    if (!game) return "Nobody has opened a table.";
    if (request.type === "sit") {
      if (game.phase === "open" && game.seats.length < DICE_MAX_PLAYERS && (await this.gold(player.id)) < game.ante) return "You cannot afford the ante.";
      return this.apply(game, player.id, { type: "sit", name: player.name });
    }
    if (request.type === "bid") return this.apply(game, player.id, { type: "bid", count: Number(request.count), face: Number(request.face) });
    return this.apply(game, player.id, { type: request.type });
  }

  /**
   * Seated players must be standing at the table. Anyone who is not (they
   * walked off, left the Harbor, or dropped) gives up their seat, which
   * during a game is a forfeit. `gone` is a socket that is closing.
   */
  reconcile(gone?: WebSocket): Promise<void> {
    return this.locked(async () => {
      let game = await this.load();
      if (!game || game.phase === "done") return;
      const present = new Set(this.sockets(gone).filter((s) => s.atTable).map((s) => s.player.id));
      let changed = false;
      for (const seat of [...game.seats]) {
        if (present.has(seat.id) || (game.phase === "playing" && seat.dice.length === 0)) continue;
        if ((await this.apply(game, seat.id, { type: "leave" })) !== null) continue;
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
      this.send(ws, { type: "dice", table: game && diceView(game, player.id) });
    });
  }
}
