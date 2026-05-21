// Converts CombatEvent[] from @gantt-quest/core into Slack mrkdwn text +
// Block Kit blocks. Used by the engine-driven combat path (handleCombatViaEngine)
// to produce thread replies and pinned battlefield updates that mirror what
// the web client renders from the same event stream.
//
// Event vocabulary lives in packages/core/src/combat_machine.ts (search
// `export type CombatEvent`). Whenever a new event type lands there, add a
// case here. Unknown events are dropped silently — better than a "<unknown
// event>" line that would confuse a thread reader.

import type { CombatEvent, CombatState } from "@gantt-quest/core";
import { DAMAGE_TYPE_EMOJI, activeAbilities, classByName } from "@gantt-quest/core";

// Resolves an ActorId to user-facing markup. Fighter IDs are slack_user_ids
// → render as Slack mentions (Slack expands to a colored username chip).
// Anything we don't recognize as a party member falls back to the monster
// name; this matches the engine convention where the monster's id is a
// stable sentinel like "monster_0".
function nameOf(state: CombatState, actorId: string): string {
  const fighter = state.fighters.find((f) => f.id === actorId);
  if (fighter) return `<@${actorId}>`;
  const monster = state.monsters.find((m) => m.id === actorId) ?? state.monsters[0];
  return `*${monster?.name ?? "Monster"}*`;
}

// Returns the name of the first live monster, or the last monster if all are
// dead. Used for events that don't carry a monster actor ID (monster_attack,
// boss_phase_transition, etc.). When Track B adds actor IDs to those events
// this helper can be replaced with nameOf() calls.
function activeMonsterName(state: CombatState): string {
  const live = state.monsters.find((m) => m.hp > 0);
  return (live ?? state.monsters[0])?.name ?? "Monster";
}

// Compact HP bar — 10 segments, █ filled and ░ empty. Matches the web
// client's stat-card aesthetic for cross-surface visual continuity.
function hpBar(hp: number, maxHp: number, segments = 10): string {
  if (maxHp <= 0) return "";
  const filled = Math.max(0, Math.min(segments, Math.round((hp / maxHp) * segments)));
  return "█".repeat(filled) + "░".repeat(segments - filled);
}

// Turn-summary thread reply. Walks the engine event stream once and
// converts each event to a single mrkdwn line. Empty-string lines are
// dropped via the final filter+join so we don't render blank rows for
// events we intentionally skip (e.g. raw dice rolls — too noisy as a
// thread post; the kept events already describe the outcome).
//
// Returns null when no events warrant a thread post (e.g. a rejected
// action with no state change). Callers can use that to decide whether
// to skip posting entirely.
export function renderTurnToThread(
  state: CombatState,
  events: CombatEvent[],
): string | null {
  if (events.length === 0) return null;

  const lines: string[] = [];
  for (const e of events) {
    const line = renderEvent(state, e);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return null;
  return lines.join("\n");
}

function renderEvent(state: CombatState, e: CombatEvent): string {
  switch (e.type) {
    case "begin":
      // Initiative reveal. Order the names so the thread reader sees who's
      // up first. The engine has already sorted turn_order by initiative
      // descending.
      return `🎲 *Initiative rolled.* Order: ${e.turn_order.map((id) => nameOf(state, id)).join(" → ")}`;

    case "turn_start":
      return `— ${nameOf(state, e.actor)}'s turn (round ${e.round}) —`;

    case "hit_check":
      // Hits are described in the player_hit / monster_attack lines; skip
      // the raw d20-vs-AC line as a thread post (the dice would crowd the
      // narrative beat). Misses still emit hit_check with hit=false but no
      // follow-up event — surface those as a single "swing and miss" line.
      if (!e.hit) {
        return `❌ ${nameOf(state, e.actor)} swings at ${nameOf(state, e.target)} but misses (rolled ${e.total} vs AC ${e.ac}).`;
      }
      return "";

    case "player_hit":
      return `${e.crit ? "💥 *CRIT!* " : ""}${nameOf(state, e.actor)} hits ${nameOf(state, e.target)} for *${e.damage}* \`${e.formula}\`.`;

    case "monster_attack": {
      const typeEmoji = e.damage_type !== "physical" ? ` ${DAMAGE_TYPE_EMOJI[e.damage_type]}` : "";
      const mitigationNote = e.shield_absorbed > 0
        ? ` \`${e.raw_damage}−${e.shield_absorbed} armor\``
        : e.resistance_reduction > 0
          ? ` \`${e.raw_damage}−${e.resistance_reduction} resist\``
          : "";
      if (e.shield_absorbed > 0 && e.hp_damage === 0) {
        return `🛡 *${activeMonsterName(state)}* hits${typeEmoji} ${nameOf(state, e.target)} for *${e.damage_after_mitigation}*${mitigationNote} — armor absorbs all.`;
      }
      if (e.shield_absorbed > 0) {
        return `🩸 *${activeMonsterName(state)}* hits${typeEmoji} ${nameOf(state, e.target)} for *${e.hp_damage}* HP (armor absorbed ${e.shield_absorbed})${mitigationNote}.`;
      }
      return `🩸 *${activeMonsterName(state)}* hits${typeEmoji} ${nameOf(state, e.target)} for *${e.hp_damage}* HP${mitigationNote}.`;
    }

    case "monster_splash": {
      const splashEmoji = e.damage_type !== "physical" ? ` ${DAMAGE_TYPE_EMOJI[e.damage_type]}` : "";
      const parts = e.targets.map((t) =>
        t.shield_absorbed > 0
          ? `${nameOf(state, t.target)} *${t.hp_damage}* HP (shield −${t.shield_absorbed})`
          : `${nameOf(state, t.target)} *${t.hp_damage}* HP`
      );
      return `💥 *${activeMonsterName(state)}* splashes${splashEmoji} everyone — ${parts.join(", ")}.`;
    }

    case "monster_dodged":
      return `💨 ${nameOf(state, e.target)} sidesteps the blow — dodged!`;

    case "monster_target_blocked":
      return `👁 *${activeMonsterName(state)}* lashes out but finds nothing to strike — vanish holds.`;

    case "monster_target_redirected":
      return `🎯 ${nameOf(state, e.from)} draws the swing onto themself (${e.reason}).`;

    case "monster_swing_skipped":
      return `📦 *${activeMonsterName(state)}* is stunned — its swing fizzles.`;

    case "boss_phase_transition":
      return `👑 *${activeMonsterName(state)}* shifts — *phase ${e.new_phase}*!`;

    case "fighter_down":
      return `💀 ${nameOf(state, e.target)} falls.`;

    case "monster_down":
      return `⚔️ ${nameOf(state, e.killed_by)} fells *${activeMonsterName(state)}*.`;

    case "wave_transition":
      return `🌊 *Wave ${e.new_wave}/${e.total_waves}* — ${e.from_monster} falls, *${e.to_monster}* steps up (${e.to_max_hp} HP).`;

    case "heal_applied":
      return `💚 ${nameOf(state, e.actor)} heals ${nameOf(state, e.target)} for *${e.amount}* HP \`${e.rolled}\`.`;

    case "shield_applied":
      return e.restored > 0
        ? `🛡️ ${nameOf(state, e.actor)} fortifies — armor restored to *${e.new_armor}* (+${e.restored}). Physical attacks blocked; magic bypasses.`
        : `🛡️ ${nameOf(state, e.actor)} braces — armor already at full (${e.new_armor}).`;

    case "flee_check":
      return e.success
        ? `🏃 ${nameOf(state, e.actor)} cracks the line (rolled ${e.total} vs DC ${e.dc}).`
        : `💢 ${nameOf(state, e.actor)} can't break free (rolled ${e.total} vs DC ${e.dc}) — *${activeMonsterName(state)}* gets a free swing.`;

    case "fled":
      return `🏃 The party flees.`;

    case "position_changed":
      return `↔️ ${nameOf(state, e.actor)} moves *${e.from}* → *${e.to}*.`;

    case "effect_tick": {
      const sign = e.hp_delta >= 0 ? "+" : "−";
      const verb = e.hp_delta >= 0 ? "regenerates" : "suffers";
      const emoji =
        e.effect === "bleeding" ? "🩸"
        : e.effect === "burning" ? "🔥"
        : e.effect === "poisoned" ? "🟢"
        : "✨";
      return `${emoji} ${nameOf(state, e.actor)} ${verb} ${sign}${Math.abs(e.hp_delta)} HP (${e.effect}${e.source ? ` from ${e.source}` : ""}).`;
    }

    case "ability_used":
      return `🌀 ${nameOf(state, e.actor)} uses *${e.name}* (cost: ${e.mana_spent} mana).`;

    case "ability_taunt":
      return `🛡 ${nameOf(state, e.actor)} taunts — next ${e.swings} swings forced.`;

    case "ability_containerize":
      return `📦 *Containerize* — *${activeMonsterName(state)}* is locked in a stasis container.`;

    case "monster_stun_broken":
      return `💥 *${activeMonsterName(state)}* breaks free from the stasis container after ${e.turns_active} stunned turn${e.turns_active === 1 ? "" : "s"}!`;

    case "ability_regression_shield":
      return `🛡 ${nameOf(state, e.actor)} ripples regression shields: ${e.grants.map((g) => `${nameOf(state, g.target)} +${g.amount}`).join(", ")}.`;

    case "ability_vanish":
      return `👻 ${nameOf(state, e.actor)} vanishes for ${e.swings} swings.`;

    case "ability_soul_drain":
      return `🩸 ${nameOf(state, e.actor)} drains *${e.damage}* and heals *${e.healed}* \`${e.formula}\`.`;

    case "ability_battle_hymn":
      return `🎶 ${nameOf(state, e.actor)} kicks off *Battle Hymn* — +${e.charges_added} charged auras incoming.`;

    case "ability_foresee":
      return e.predicted_target
        ? `🔮 ${nameOf(state, e.actor)} foresees: *${activeMonsterName(state)}* targets ${nameOf(state, e.predicted_target)} for ${e.damage_lo}–${e.damage_hi} damage.`
        : `🔮 ${nameOf(state, e.actor)} foresees — but the target is unreadable.`;

    case "ability_migrate":
      return `🔁 ${nameOf(state, e.actor)} migrates ${nameOf(state, e.target)} to *${e.to}*.`;

    case "battle_hymn_consumed":
      return `🎵 Hymn-charged aura fires — ${nameOf(state, e.actor)} hits +${e.bonus} (${e.remaining} charges left).`;

    case "mark_applied":
      return `🎯 ${nameOf(state, e.actor)} *marks* the monster — partymates deal +${e.bonus} until round ${e.expires_after_round}.`;

    case "mark_bonus":
      return `🎯 Focus-fire +${e.bonus} (mark).`;

    case "passive_warden_shield":
      return `🛡 *SRE Warden* passive: ${nameOf(state, e.actor)} hardens up — +${e.amount} shield.`;

    case "passive_mage_mana_font":
      return `🧙 *Mana Font*: ${nameOf(state, e.actor)} regenerates +${e.amount} mana (every 3 turns).`;

    case "passive_druid_regen":
      return `🌿 *Druid* passive: ${nameOf(state, e.actor)} regenerates +${e.amount} HP.`;

    case "passive_rogue_first_crit":
      return `🗡 *Refactor Rogue* passive: ${nameOf(state, e.actor)} first-strike crit.`;

    case "passive_bard_aura":
      return `🎵 *Bard aura*: ${nameOf(state, e.actor)} +${e.bonus} damage (from ${nameOf(state, e.source)}).`;

    case "passive_warlock_bleed":
      return `💀 *Data Warlock* passive: critical strike inflicts 🩸 *Bleeding* (${e.magnitude}/turn × ${e.duration}).`;

    case "passive_paladin_auto_heal":
      return `✨ *Paladin* passive: ${nameOf(state, e.paladin)} mends ${nameOf(state, e.target)} for +${e.amount} HP.`;

    case "drink_buff_consumed": {
      // Drink IDs map to emoji+name in apps/slack/src/flavor.ts DRINKS (and
      // apps/web/src/worker.ts DRINKS). We don't import the catalog here to
      // avoid a render-side dep on slack-internal data — instead surface the
      // mechanic in plain terms and let the drink_id ride along for any
      // future enrichment. Lucky Sip (buff_next_crit) gets its own framing
      // since it doesn't add flat damage — it forces the crit.
      const tail = e.remaining > 0
        ? ` _(${e.remaining} charge${e.remaining === 1 ? "" : "s"} left)_`
        : ` _(buff wears off)_`;
      if (e.kind === "buff_next_crit") {
        return `💧 *Lucky Sip* fires — guaranteed crit, +${e.bonus} damage.${tail}`;
      }
      const label = e.kind === "buff_attack" ? "attack" : "magic";
      return `🍺 ${nameOf(state, e.actor)} drink buff: +${e.bonus} ${label}.${tail}`;
    }

    case "victory":
      return `🏆 *Victory!* The party stands triumphant.`;

    case "defeat":
      return `☠️ *Defeat.* The party falls.`;

    case "rejected":
      // Rejection events don't get a thread post — they surface as an
      // ephemeral to the actor only. Caller handles this via the
      // serverAction result.
      return "";

    case "roll":
      // Dice rolls are noise in a thread context — the resulting hit_check
      // and damage events already describe the outcome. Web client uses
      // these for live dice animation; Slack thread doesn't need them.
      return "";

    case "turn_skip":
      return `_${e.actor} is frozen and loses their turn._`;

    case "elemental_proc":
      if (e.resisted) return `_${e.target} resisted the ${e.element} proc._`;
      return `_${e.element === "fire" ? "🔥" : e.element === "ice" ? "❄️" : "🌩️"} ${e.target} is ${e.effect}!_`;

    case "monster_elemental_proc":
      return `_${e.element === "fire" ? "🔥" : e.element === "ice" ? "❄️" : "🌩️"} Monster proc: ${e.target} is ${e.effect}!_`;

    default: {
      // Exhaustiveness check: if a new CombatEvent member is added without
      // a case here, TypeScript flags this assignment. Falls through to a
      // dropped line (silently) at runtime so a new event doesn't break
      // combat in prod while we ship the matching case.
      const _exhaustive: never = e;
      void _exhaustive;
      return "";
    }
  }
}

// Compact one-line monster summary for the battlefield header. Used by
// renderBattlefieldBlocks below.
export function monsterStatusLine(state: CombatState): string {
  return state.monsters.map((m) => {
    const bar = hpBar(m.hp, m.max_hp);
    const dead = m.hp <= 0 ? " ☠️" : "";
    const wave = m.wave && m.total_waves ? ` _(wave ${m.wave}/${m.total_waves})_` : "";
    return `*${m.name}* — ${m.hp}/${m.max_hp} HP \`${bar}\`${wave}${dead}`;
  }).join(" │ ");
}

// Compact party roster. One short line per fighter. Marks the current
// actor with a ➤ so the thread reader sees who's up at a glance.
export function partyRosterLines(state: CombatState): string[] {
  const currentActor =
    state.status === "active" && state.turn_order.length > 0
      ? state.turn_order[state.turn_index % state.turn_order.length]
      : null;
  return state.fighters.map((f) => {
    const marker = f.id === currentActor ? "➤ " : "  ";
    const downed = f.hp <= 0 ? " 💀" : "";
    const shield = f.shield > 0 ? ` 🛡${f.shield}` : "";
    const mana = f.max_mana > 0 ? ` ✨${f.mana}/${f.max_mana}` : "";
    return `${marker}<@${f.id}> — ${f.hp}/${f.max_hp}${shield}${mana}${downed}`;
  });
}

// Pinned-battlefield Block Kit blocks. Goes through chat.update each turn
// against quests.battlefield_ts so spectators always see current state in
// one place. Action buttons surface only the four PR-3-MVP actions for
// the current actor; heal/shield/ability/etc. arrive as follow-ups.
//
// `questId` is encoded into each action_id (per the in-block uniqueness
// rule) so the dispatcher can route without parsing block_id.
export function renderBattlefieldBlocks(
  state: CombatState,
  questId: number,
): unknown[] {
  const currentActor =
    state.status === "active" && state.turn_order.length > 0
      ? state.turn_order[state.turn_index % state.turn_order.length]
      : null;
  const currentFighter = currentActor
    ? state.fighters.find((f) => f.id === currentActor)
    : null;

  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: monsterStatusLine(state) },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: partyRosterLines(state).join("\n") },
    },
  ];

  // Action row — only when an actor is up. Out-of-combat states (victory,
  // defeat, fled) omit the buttons so spectators can't click stale ones.
  if (currentActor && currentFighter && currentFighter.hp > 0) {
    const elements: unknown[] = [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "⚔️ Attack" },
        action_id: `turn_attack_${questId}_${currentActor}`,
        value: String(questId),
      },
      {
        type: "button",
        text: { type: "plain_text", text: "✨ Cast" },
        action_id: `turn_cast_${questId}_${currentActor}`,
        value: String(questId),
      },
    ];
    const sigAbility = activeAbilities(classByName(currentFighter.class).abilities)[0];
    if (currentFighter.mana > 0 && sigAbility) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: `💫 ${sigAbility.name}` },
        action_id: `turn_ability_${questId}_${currentActor}`,
        value: String(questId),
      });
    }
    elements.push({
      type: "button",
      style: "danger",
      text: { type: "plain_text", text: "🏃 Flee" },
      action_id: `turn_flee_${questId}_${currentActor}`,
      value: String(questId),
    });
    blocks.push({ type: "actions", elements });
  }

  return blocks;
}
