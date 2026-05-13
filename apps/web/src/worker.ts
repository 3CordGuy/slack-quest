// Web app Worker. Handles /api/* routes; static assets and SPA fallback come
// from the ASSETS binding (configured in wrangler.jsonc). Shares the same D1
// instance as the Slack worker so codes issued by /sq web-login are visible
// here. The QuestRoom Durable Object (defined below) coordinates live web-mode
// combat over WebSocket.

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import {
  MAX_MANA_CAP,
  classByName,
  createCombatState,
  dropChance,
  findCatalogEntry,
  generateScar,
  rollDice,
  rollItem,
  step,
  xpForLevel,
  type CombatInit,
  type CombatState,
  type ItemRoll,
  type RollFn,
  type TurnAction,
} from "@gantt-quest/core";
import {
  addItem,
  applySoftDeath,
  awardSpoils,
  consumeWebLoginCode,
  createWebSession,
  deleteWebCombatState,
  deleteWebSession,
  getActiveQuestForCharacter,
  getCharacter,
  getEquipped,
  getInventory,
  getItem,
  getQuestParty,
  getRecentQuestsForCharacter,
  getWebCombatState,
  getWebSession,
  markQuestStatus,
  removeItem,
  saveWebCombatState,
  setCharacterHpAndShield,
  setQuestMode,
} from "@gantt-quest/db";

const DOWNED_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const VICTORY_BASE_XP_PER_TIER = 50;
const VICTORY_BASE_GOLD_PER_TIER = 20;
const BOSS_REWARD_MULTIPLIER = 2;
const ELITE_REWARD_MULTIPLIER = 1.5;

// Slack uses Workers AI to flavor non-catalog drops; web v1 names them
// deterministically off (rarity, type) so we don't depend on the AI binding.
// Tool / scroll drops still use the fixed catalog names + blurbs from core.
const RARITY_ADJ: Record<string, string> = {
  common: "Worn",
  uncommon: "Sturdy",
  rare: "Resplendent",
};
const TYPE_NOUN: Record<string, string> = {
  weapon: "Blade",
  armor: "Vest",
  consumable: "Elixir",
  magic: "Trinket",
  revive: "Vial",
  tool: "Tool",
  scroll: "Scroll",
};

function nameLoot(roll: ItemRoll, monsterName: string): { name: string; flavor: string } {
  if (roll.catalog_name) {
    const entry = findCatalogEntry(roll.catalog_name);
    if (entry) {
      return { name: `${entry.emoji} ${entry.name}`, flavor: entry.blurb };
    }
  }
  const adj = RARITY_ADJ[roll.rarity] ?? roll.rarity;
  const noun = TYPE_NOUN[roll.type] ?? roll.type;
  return { name: `${adj} ${noun}`, flavor: `Spoils from ${monsterName}.` };
}

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  QUEST_ROOM: DurableObjectNamespace<QuestRoom>;
}

const SESSION_COOKIE = "sq_session";
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

const app = new Hono<{ Bindings: Env }>();

// POST /api/auth/verify { code: "123456" } → sets session cookie on success.
app.post("/api/auth/verify", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    return c.json({ error: "invalid_code" }, 400);
  }

  const redeemed = await consumeWebLoginCode(c.env.DB, code);
  if (!redeemed) {
    return c.json({ error: "invalid_or_expired" }, 401);
  }

  const session = await createWebSession(
    c.env.DB,
    redeemed.slack_user_id,
    redeemed.slack_team_id,
  );

  setCookie(c, SESSION_COOKIE, session.session_id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
    maxAge: SESSION_MAX_AGE_SEC,
    path: "/",
  });
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await deleteWebSession(c.env.DB, sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// Returns the authenticated user's character (or null if they haven't created
// one yet via /sq quest in Slack).
app.get("/api/me", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const character = await getCharacter(c.env.DB, session.slack_user_id);
  return c.json({
    slack_user_id: session.slack_user_id,
    slack_team_id: session.slack_team_id,
    character,
  });
});

app.get("/api/inventory", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const items = await getInventory(c.env.DB, session.slack_user_id);
  return c.json({ items });
});

// Returns the user's currently-active quest (with scene state + party) or
// { quest: null } if they're not in one. Polled by the active-quest panel.
app.get("/api/quest/active", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest) return c.json({ quest: null });
  const party = await getQuestParty(c.env.DB, quest.id);
  return c.json({ quest, party });
});

// Most-recent completed/failed quests for the signed-in user. Used to render
// the history card.
app.get("/api/quests/recent", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const quests = await getRecentQuestsForCharacter(
    c.env.DB,
    session.slack_user_id,
    10,
  );
  return c.json({ quests });
});

// Starts (or resumes) web-mode combat for the user's active quest. Snapshots
// the party + monster from D1 into a CombatState, rolls initiative, and saves
// to web_combat_state. Idempotent: if a state already exists for this quest,
// the existing one is returned untouched so a refresh in the middle of a
// fight doesn't reset progress.
//
// v1 limits: standard + boss variants only. Gauntlet/dungeon stay on Slack.
app.post("/api/quest/:id/start_web_combat", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);

  const existing = await getWebCombatState(c.env.DB, questId);
  if (existing) return c.json({ quest_id: questId, state: existing });

  const quest = await getActiveQuestForCharacter(c.env.DB, session.slack_user_id);
  if (!quest || quest.id !== questId) {
    return c.json({ error: "quest_not_active_for_user" }, 404);
  }
  const variant = quest.scene.variant ?? "standard";
  if (variant !== "standard" && variant !== "boss" && variant !== "gauntlet") {
    return c.json({ error: "unsupported_variant", variant }, 400);
  }

  const party = await getQuestParty(c.env.DB, questId);
  const fighters: CombatInit["fighters"] = [];
  for (const member of party) {
    const [weapon, armor] = await Promise.all([
      getEquipped(c.env.DB, member.slack_user_id, "weapon"),
      getEquipped(c.env.DB, member.slack_user_id, "armor"),
    ]);
    const cls = classByName(member.class);
    fighters.push({
      id: member.slack_user_id,
      name: member.name,
      class: member.class,
      level: member.level,
      hp: member.hp,
      max_hp: member.max_hp,
      mana: member.mana,
      max_mana: member.max_mana,
      shield: member.shield,
      position: member.position,
      attack_mod: cls.attack_mod,
      magic_mod: cls.magic_mod,
      weapon_power: weapon?.power ?? 0,
      armor_power: armor?.power ?? 0,
    });
  }

  const init: CombatInit = {
    fighters,
    monster: {
      name: quest.scene.monster_name,
      hp: quest.scene.monster_hp,
      max_hp: quest.scene.monster_max_hp,
      tier: quest.scene.tier,
      is_boss: variant === "boss",
      boss_phase: quest.scene.boss_phase,
      // Gauntlet wave state — undefined for standard/boss; pulled straight
      // from scene_json which Slack populates when creating the quest.
      wave: quest.scene.wave,
      total_waves: quest.scene.total_waves,
      upcoming_waves: quest.scene.upcoming_waves?.map((w) => ({
        name: w.name,
        max_hp: w.max_hp,
      })),
    },
  };
  const initial = createCombatState(init);
  // Seed the monster's status effects from scene_json so an active Slack-mode
  // poison/burn carries into web combat. Fighters arrive via D1 with their
  // own .effects column (status effects already in core.MachineStatusEffect
  // shape).
  const seeded: CombatState = {
    ...initial,
    monster: {
      ...initial.monster,
      effects: quest.scene.monster_effects ?? [],
    },
    fighters: initial.fighters.map((f) => {
      const character = party.find((p) => p.slack_user_id === f.id);
      return character ? { ...f, effects: character.effects ?? [] } : f;
    }),
  };
  const begun = step(seeded, { kind: "begin" }, productionRoll);
  await saveWebCombatState(c.env.DB, questId, begun.state);
  // Lock the quest into web mode so Slack combat handlers refuse further
  // /sq attack actions on it. Once flipped to 'web' it stays there for the
  // life of this quest (no automatic unlock on web combat end — the quest
  // is over either way).
  await setQuestMode(c.env.DB, questId, "web");
  return c.json({ quest_id: questId, state: begun.state });
});

// Clears the web combat state for a quest. Used when the player exits the
// combat page. Doesn't touch the underlying quest row — quest outcome
// resolution (XP/gold/loot) lives in Phase 2d.
app.post("/api/quest/:id/end_web_combat", async (c) => {
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.json({ error: "bad_quest_id" }, 400);
  const party = await getQuestParty(c.env.DB, questId);
  if (!party.some((p) => p.slack_user_id === session.slack_user_id)) {
    return c.json({ error: "not_in_party" }, 403);
  }
  await deleteWebCombatState(c.env.DB, questId);
  return c.json({ ok: true });
});

// WS upgrade for live combat. Session-gated and party-membership-checked
// (the user must be in this quest's party). The DO is keyed by quest_id so
// every party member talking about quest 42 lands in the same instance.
app.get("/api/ws/quest/:id", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("expected websocket", 426);
  }
  const session = await currentSession(c.env.DB, c.req.header("cookie"));
  if (!session) return c.text("unauthenticated", 401);

  const questId = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(questId)) return c.text("bad quest id", 400);

  // Party-membership gate. We won't ship action authorization from inside
  // the DO; that's the worker's job before we hand off the WS.
  const party = await getQuestParty(c.env.DB, questId);
  if (!party.some((p) => p.slack_user_id === session.slack_user_id)) {
    return c.text("not in party", 403);
  }

  const doId = c.env.QUEST_ROOM.idFromName(`quest:${questId}`);
  const stub = c.env.QUEST_ROOM.get(doId);
  // Pass quest_id + user_id along so the DO knows who connected.
  const url = new URL(c.req.url);
  url.searchParams.set("quest", String(questId));
  url.searchParams.set("user", session.slack_user_id);
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// Health check. Anything else falls through to the ASSETS binding via the
// wrangler `not_found_handling: single-page-application` config.
app.get("/api/health", (c) => c.json({ ok: true }));

async function currentSession(db: D1Database, cookieHeader: string | undefined) {
  if (!cookieHeader) return null;
  const match = /(?:^|;\s*)sq_session=([^;]+)/.exec(cookieHeader);
  if (!match) return null;
  return getWebSession(db, decodeURIComponent(match[1]));
}

export default app;

// ─── Durable Object ─────────────────────────────────────────────────────────
//
// QuestRoom owns one quest's live combat. Followed rules (per
// memory/feedback_durable_objects.md):
//   1. WebSocket Hibernation API — ctx.acceptWebSocket() lets the DO sleep
//      between turns without dropping the connection or billing active.
//   2. D1 is the system of record — every step() result is persisted via
//      saveWebCombatState before broadcasting. Instance-variable caches
//      (this.cache*) survive only within an active execution; on wake we
//      rehydrate from D1.
//   3. No setTimeout/setInterval — DO Alarms or lazy-on-action timing only.
//   4. No background tickers — status effects apply on the actor's next turn.
//   5. Idle WS disconnect — connection inactivity is fine; the DO closes
//      sockets the runtime tells it have gone away. (No explicit timer here
//      — adding it would need DO Alarms, deferred until we see real abuse.)

// Item-use action lives outside the engine (it does D1 I/O for inventory
// load + delete, which the pure machine can't do). The DO dispatches it
// before falling through to step() for engine-handled actions.
type UseItemAction = {
  kind: "use_item";
  actor: string;
  item_id: number;
  target_id?: string;
};

interface ClientToServer {
  type: "action";
  action: TurnAction | UseItemAction;
}

export type ItemEffect =
  | { kind: "heal"; target: string; amount: number; rolled: number }
  | { kind: "mana_bump"; target: string; added: number; new_max_mana: number }
  | { kind: "revive"; target: string; hp_restored: number };

export interface ItemUsedEvent {
  type: "item_used";
  actor: string;
  item_id: number;
  item_name: string;
  item_type: string;
  effect: ItemEffect;
}

export interface LootDrop {
  item_name: string;
  item_type: string;
  power: number;
  rarity: string;
  flavor: string;
  weapon_range: "melee" | "ranged" | null;
}

export interface FighterReward {
  user_id: string;
  damage_dealt: number;
  xp_awarded: number;
  gold_awarded: number;
  level_up: boolean;
  new_level: number;
  loot: LootDrop[];
  // Populated only on defeat for fighters at 0 HP.
  soft_death: { gold_lost: number; item_lost: string | null; scar: string } | null;
}

export interface OutcomeSummary {
  status: "victory" | "defeat";
  rewards: FighterReward[];
  monster_name: string;
  monster_tier: number;
  total_pool_xp: number;
  total_pool_gold: number;
  elite: boolean;
  is_boss: boolean;
}

interface ServerToClient {
  type: "state" | "events" | "error" | "outcome";
  state?: CombatState;
  events?: unknown[];
  message?: string;
  outcome?: OutcomeSummary;
}

// End-of-combat side-effects:
//   - Victory: contribution-proportional XP + gold split, scaled for boss
//     (×2) / elite (×1.5); awardSpoils handles level-ups; per-fighter loot
//     roll using existing dropChance / rollItem helpers.
//   - Defeat: applySoftDeath for any fighter at 0 HP (25% gold loss, 1
//     random item drop, downed timer, +1 scar). Survivors keep their final
//     HP and shield from the combat state.
//   - Either way: mark the quest completed/failed.
async function applyWebCombatOutcome(
  env: Env,
  questId: number,
  state: CombatState,
): Promise<OutcomeSummary> {
  const won = state.status === "victory";
  const tier = state.monster.tier;
  const isBoss = state.monster.is_boss;
  const eliteRow = await env.DB.prepare("SELECT elite FROM quests WHERE id = ?")
    .bind(questId)
    .first<{ elite: number }>();
  const elite = eliteRow?.elite === 1;

  const multiplier =
    (isBoss ? BOSS_REWARD_MULTIPLIER : 1) * (elite ? ELITE_REWARD_MULTIPLIER : 1);
  const totalPoolXp = won ? Math.round(tier * VICTORY_BASE_XP_PER_TIER * multiplier) : 0;
  const totalPoolGold = won ? Math.round(tier * VICTORY_BASE_GOLD_PER_TIER * multiplier) : 0;

  // Contribution split: proportional to damage dealt; remainder goes to top
  // contributor. Equal split when nobody dealt damage (degenerate but
  // possible if the fight ended on monster status-effect ticks).
  const totalDmg = state.fighters.reduce(
    (s, f) => s + (state.contribution[f.id] ?? 0),
    0,
  );
  const xpShares: Record<string, number> = {};
  const goldShares: Record<string, number> = {};
  if (won) {
    let xpRemainder = totalPoolXp;
    let goldRemainder = totalPoolGold;
    for (const f of state.fighters) {
      const dmg = state.contribution[f.id] ?? 0;
      const xpShare = totalDmg > 0
        ? Math.floor((dmg / totalDmg) * totalPoolXp)
        : Math.floor(totalPoolXp / state.fighters.length);
      const goldShare = totalDmg > 0
        ? Math.floor((dmg / totalDmg) * totalPoolGold)
        : Math.floor(totalPoolGold / state.fighters.length);
      xpShares[f.id] = xpShare;
      goldShares[f.id] = goldShare;
      xpRemainder -= xpShare;
      goldRemainder -= goldShare;
    }
    // Hand any rounding remainder to the top contributor (or first fighter).
    const top = [...state.fighters]
      .sort((a, b) => (state.contribution[b.id] ?? 0) - (state.contribution[a.id] ?? 0))[0];
    if (top) {
      xpShares[top.id] += Math.max(0, xpRemainder);
      goldShares[top.id] += Math.max(0, goldRemainder);
    }
  }

  const rewards: FighterReward[] = [];

  for (const fighter of state.fighters) {
    const dmg = state.contribution[fighter.id] ?? 0;
    let xpAwarded = 0;
    let goldAwarded = 0;
    let levelUp = false;
    let newLevel = fighter.level;
    let loot: LootDrop[] = [];
    let softDeath: FighterReward["soft_death"] = null;

    // Sync HP, shield, AND mana to D1 first so subsequent helpers see fresh
    // state. Mana isn't covered by setCharacterHpAndShield so we add a small
    // follow-up query.
    await setCharacterHpAndShield(env.DB, fighter.id, fighter.hp, fighter.shield);
    await env.DB
      .prepare(
        "UPDATE characters SET mana = ?, last_active = ? WHERE slack_user_id = ?",
      )
      .bind(fighter.mana, Date.now(), fighter.id)
      .run();

    const character = await getCharacter(env.DB, fighter.id);
    if (!character) {
      rewards.push({
        user_id: fighter.id,
        damage_dealt: dmg,
        xp_awarded: 0,
        gold_awarded: 0,
        level_up: false,
        new_level: fighter.level,
        loot: [],
        soft_death: null,
      });
      continue;
    }

    if (won) {
      xpAwarded = xpShares[fighter.id] ?? 0;
      goldAwarded = goldShares[fighter.id] ?? 0;
      const result = await awardSpoils(
        env.DB,
        character,
        xpAwarded,
        goldAwarded,
        () => rollDice(6),
        xpForLevel,
        MAX_MANA_CAP,
      );
      levelUp = result.levelsGained > 0;
      newLevel = result.newLevel;

      // Loot roll — per-fighter chance using the existing tier-scaled
      // dropChance + rollItem helpers (same probabilities as Slack drops).
      // Web mode names items deterministically (no AI flavor pass yet).
      if (Math.random() < dropChance(tier)) {
        const roll = rollItem(tier);
        const named = nameLoot(roll, state.monster.name);
        const created = await addItem(env.DB, {
          character_id: fighter.id,
          item_name: named.name,
          item_type: roll.type,
          power: roll.power,
          rarity: roll.rarity,
          flavor: named.flavor,
          weapon_range: roll.weapon_range ?? null,
        });
        loot.push({
          item_name: created.item_name,
          item_type: created.item_type,
          power: created.power,
          rarity: created.rarity,
          flavor: created.flavor ?? named.flavor,
          weapon_range: created.weapon_range,
        });
      }
    } else if (fighter.hp <= 0) {
      // Soft death: only triggers on actual defeat AND for the fighters
      // that fell. Survivors of a wipe (none here, since defeat means full
      // wipe) would skip this branch.
      const scar = generateScar(state.monster.name);
      const death = await applySoftDeath(env.DB, character, scar, DOWNED_COOLDOWN_MS);
      softDeath = {
        gold_lost: death.goldLost,
        item_lost: death.itemLost,
        scar,
      };
    }

    rewards.push({
      user_id: fighter.id,
      damage_dealt: dmg,
      xp_awarded: xpAwarded,
      gold_awarded: goldAwarded,
      level_up: levelUp,
      new_level: newLevel,
      loot,
      soft_death: softDeath,
    });
  }

  await markQuestStatus(env.DB, questId, won ? "completed" : "failed");

  return {
    status: state.status as "victory" | "defeat",
    rewards,
    monster_name: state.monster.name,
    monster_tier: tier,
    total_pool_xp: totalPoolXp,
    total_pool_gold: totalPoolGold,
    elite,
    is_boss: isBoss,
  };
}

interface WsAttachment {
  quest_id: number;
  user_id: string;
}

const productionRoll: RollFn = (sides) => Math.floor(Math.random() * sides) + 1;

export class QuestRoom extends DurableObject<Env> {
  // We hold a best-effort in-memory cache of the combat state, but always
  // reload from D1 when uncertain (post-hibernate) and always persist back
  // to D1 before broadcasting.
  private cacheState: CombatState | null = null;
  private cacheQuestId: number | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const questId = parseInt(url.searchParams.get("quest") ?? "", 10);
    const userId = url.searchParams.get("user") ?? "";
    if (!Number.isFinite(questId) || !userId) {
      return new Response("bad params", { status: 400 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation: tells the runtime to deliver future messages to
    // this.webSocketMessage()/Close() even if the DO hibernates between them.
    this.ctx.acceptWebSocket(server);
    // `this.ctx` is the DurableObjectState provided by the DurableObject base.
    const attach: WsAttachment = { quest_id: questId, user_id: userId };
    server.serializeAttachment(attach);

    // Send initial state snapshot if combat already exists for this quest.
    const state = await this.loadState(questId);
    if (state) {
      this.sendOne(server, { type: "state", state });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // Called by the runtime when a client sends a frame. Survives hibernation.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attach = ws.deserializeAttachment() as WsAttachment | null;
    if (!attach) {
      ws.close(1008, "missing attachment");
      return;
    }

    let parsed: ClientToServer | null = null;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      parsed = JSON.parse(text) as ClientToServer;
    } catch {
      this.sendOne(ws, { type: "error", message: "invalid json" });
      return;
    }

    if (!parsed || parsed.type !== "action" || !parsed.action) {
      this.sendOne(ws, { type: "error", message: "expected { type: 'action', action: {...} }" });
      return;
    }

    const state = await this.loadState(attach.quest_id);
    if (!state) {
      this.sendOne(ws, { type: "error", message: "no combat in progress" });
      return;
    }

    // use_item lives outside the engine (it reads + deletes inventory in D1).
    if (parsed.action.kind === "use_item") {
      await this.handleUseItem(ws, attach.quest_id, state, parsed.action);
      return;
    }

    const result = step(state, parsed.action, productionRoll);
    // Persist even on rejected actions? No — state didn't change. Only save
    // when the state actually advanced.
    const stateChanged = result.state !== state;
    if (stateChanged) {
      await saveWebCombatState(this.env.DB, attach.quest_id, result.state);
      this.cacheState = result.state;
    }

    // Broadcast events + the new state to every connected client.
    this.broadcast({ type: "events", events: result.events });
    if (stateChanged) {
      this.broadcast({ type: "state", state: result.state });
    }

    // Terminal status transition — apply outcome side-effects exactly once.
    const becameTerminal =
      stateChanged &&
      state.status === "active" &&
      (result.state.status === "victory" || result.state.status === "defeat");
    if (becameTerminal) {
      try {
        const outcome = await applyWebCombatOutcome(this.env, attach.quest_id, result.state);
        this.broadcast({ type: "outcome", outcome });
      } catch (err) {
        this.broadcast({
          type: "error",
          message: `outcome failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // Inventory-driven combat action. Validates the item belongs to the
  // actor, applies the effect to CombatState, deletes the item from D1,
  // then reuses the engine's "wait" handler to advance the turn so the
  // turn-cycling logic stays in one place.
  //
  // Supported types for v1: consumable (heal user), magic (+max_mana on
  // user), revive (raise a downed party member). Tools are dungeon-only;
  // scrolls have named effects (rebase, etc.) we'll plumb in a follow-up.
  private async handleUseItem(
    ws: WebSocket,
    questId: number,
    state: CombatState,
    action: UseItemAction,
  ): Promise<void> {
    if (state.status !== "active") {
      this.sendOne(ws, { type: "error", message: "combat ended" });
      return;
    }
    const currentActor =
      state.turn_order[state.turn_index % state.turn_order.length] ?? "";
    if (currentActor !== action.actor) {
      this.sendOne(ws, { type: "error", message: "not your turn" });
      return;
    }
    const actor = state.fighters.find((f) => f.id === action.actor);
    if (!actor || actor.hp <= 0) {
      this.sendOne(ws, { type: "error", message: "actor downed" });
      return;
    }

    const item = await getItem(this.env.DB, action.item_id, action.actor);
    if (!item) {
      this.sendOne(ws, { type: "error", message: "item not found" });
      return;
    }

    let updatedFighters = state.fighters;
    let effect: ItemEffect | null = null;

    switch (item.item_type) {
      case "consumable": {
        const before = actor.hp;
        const after = Math.min(actor.max_hp, before + item.power);
        const amount = after - before;
        updatedFighters = state.fighters.map((f) =>
          f.id === actor.id ? { ...f, hp: after } : f,
        );
        effect = { kind: "heal", target: actor.id, amount, rolled: item.power };
        break;
      }
      case "magic": {
        const newMax = Math.min(5 /* MAX_MANA_CAP */, actor.max_mana + item.power);
        const added = newMax - actor.max_mana;
        updatedFighters = state.fighters.map((f) =>
          f.id === actor.id
            ? { ...f, max_mana: newMax, mana: Math.min(newMax, f.mana + added) }
            : f,
        );
        effect = {
          kind: "mana_bump",
          target: actor.id,
          added,
          new_max_mana: newMax,
        };
        break;
      }
      case "revive": {
        const target = state.fighters.find((f) => f.id === action.target_id);
        if (!target) {
          this.sendOne(ws, { type: "error", message: "no revive target" });
          return;
        }
        if (target.hp > 0) {
          this.sendOne(ws, { type: "error", message: "target not downed" });
          return;
        }
        // Item power is a % of max_hp restored (matches Slack convention).
        const restored = Math.max(1, Math.floor((target.max_hp * item.power) / 100));
        updatedFighters = state.fighters.map((f) =>
          f.id === target.id ? { ...f, hp: restored } : f,
        );
        effect = { kind: "revive", target: target.id, hp_restored: restored };
        break;
      }
      default:
        this.sendOne(ws, {
          type: "error",
          message: `cannot use ${item.item_type} in combat yet`,
        });
        return;
    }

    if (!effect) return;

    // Apply effect, then advance turn via engine's "wait" handler so the
    // turn_start / round-bump logic stays unified.
    const withEffect: CombatState = { ...state, fighters: updatedFighters };
    const waitResult = step(withEffect, { kind: "wait", actor: action.actor }, productionRoll);

    const itemUsed: ItemUsedEvent = {
      type: "item_used",
      actor: action.actor,
      item_id: item.id,
      item_name: item.item_name,
      item_type: item.item_type,
      effect,
    };

    await saveWebCombatState(this.env.DB, questId, waitResult.state);
    await removeItem(this.env.DB, item.id);
    this.cacheState = waitResult.state;

    this.broadcast({ type: "events", events: [itemUsed, ...waitResult.events] });
    this.broadcast({ type: "state", state: waitResult.state });
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Nothing to do — the runtime removes the closed socket from
    // getWebSockets() on its own. No alarms or timers to clean up.
  }

  private async loadState(questId: number): Promise<CombatState | null> {
    if (this.cacheState && this.cacheQuestId === questId) return this.cacheState;
    const state = await getWebCombatState(this.env.DB, questId);
    if (state) {
      this.cacheState = state;
      this.cacheQuestId = questId;
    }
    return state;
  }

  private sendOne(ws: WebSocket, msg: ServerToClient): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Closed socket; let the runtime clean up.
    }
  }

  private broadcast(msg: ServerToClient): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // Closed socket; runtime cleans up.
      }
    }
  }
}
