import { useEffect, useState } from "react";

import { CombatPage } from "./CombatPage";

// v0.4: read-only views + opt-in web-mode combat. When the active quest is
// a `standard` or `boss` variant, the player can open a dedicated combat
// page that drives a Durable-Object-backed turn-based loop via WebSocket.

interface Character {
  slack_user_id: string;
  name: string;
  class: string;
  level: number;
  xp: number;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  shield: number;
  gold: number;
  scars: string[];
  keys_bronze: number;
  keys_silver: number;
  keys_gold: number;
  position: "front" | "back";
  downed_until: number | null;
}

type ItemType =
  | "weapon"
  | "armor"
  | "consumable"
  | "magic"
  | "revive"
  | "tool"
  | "scroll";
type Rarity = "common" | "uncommon" | "rare";
type WeaponRange = "melee" | "ranged";

interface Item {
  id: number;
  character_id: string;
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string | null;
  equipped: boolean;
  weapon_range: WeaponRange | null;
}

type QuestVariant = "standard" | "boss" | "gauntlet" | "dungeon";
type EffectType = "regen" | "bleeding" | "burning" | "poisoned";

interface StatusEffect {
  type: EffectType;
  magnitude: number;
  remaining: number;
  source?: string;
}

type ExpeditionNodeType = "combat" | "trap" | "lockbox" | "npc" | "treasure" | "merchant";

type SkillType = "str" | "dex" | "int";
type KeyTier = "bronze" | "silver" | "gold";

interface TrapChoice {
  text: string;
  emoji: string;
  skill: SkillType;
  fail_damage: number;
}

interface LootOption {
  name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string;
  weapon_range?: WeaponRange | null;
}

interface NpcOffer {
  greeting: string;
  item: LootOption;
}

interface ExpeditionNode {
  type: ExpeditionNodeType;
  scene: string;
  monster_name?: string;
  monster_max_hp?: number;
  tier?: number;
  trap_choices?: TrapChoice[];
  loot_options?: LootOption[];
  lock_tier?: KeyTier;
  npc?: NpcOffer;
}

interface ExpeditionState {
  theme: string;
  current: number;
  nodes: ExpeditionNode[];
  pending_doors?: number[];
}

interface SceneJson {
  monster_name: string;
  monster_hp: number;
  monster_max_hp: number;
  tier: number;
  scene: string;
  variant?: QuestVariant;
  boss_phase?: 1 | 2;
  wave?: number;
  total_waves?: number;
  monster_effects?: StatusEffect[];
  expedition?: ExpeditionState;
}

interface ActiveQuest {
  id: number;
  elite: boolean;
  scene: SceneJson;
}

interface RecentQuest {
  id: number;
  status: "completed" | "failed";
  elite: boolean;
  monster_name: string;
  variant: QuestVariant;
  boss_phase?: 1 | 2;
  wave?: number;
  total_waves?: number;
  created_at: number;
  completed_at: number | null;
}

interface MeResponse {
  slack_user_id: string;
  slack_team_id: string;
  character: Character | null;
}

interface InventoryResponse {
  items: Item[];
}

interface ShopItem {
  id: number;
  item_name: string;
  item_type: ItemType;
  power: number;
  rarity: Rarity;
  flavor: string | null;
  price: number;
  bought_by: string | null;
  weapon_range: WeaponRange | null;
  haggled: "failed" | "15" | "25" | "30" | null;
}

interface ShopResponse {
  stock: ShopItem[];
  gold: number;
  channel_id?: string;
  needs_restock?: boolean;
  purchases_this_cycle?: number;
  purchase_cap?: number;
  error?: string;
}

interface ActiveQuestResponse {
  quest: ActiveQuest | null;
  party?: Character[];
}

interface JoinableQuest {
  quest_id: number;
  channel_id: string;
  variant: QuestVariant;
  elite: boolean;
  monster_name: string;
  monster_max_hp: number;
  scene: string;
}

interface RecentQuestsResponse {
  quests: RecentQuest[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "anon" }
  | {
      kind: "auth";
      me: MeResponse;
      inventory: Item[];
      activeQuest: { quest: ActiveQuest; party: Character[] } | null;
      recent: RecentQuest[];
      shop: ShopResponse | null;
      joinable: JoinableQuest | null;
    };

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeCombat, setActiveCombat] = useState<{ questId: number } | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    const meRes = await fetch("/api/me", { credentials: "include" });
    if (meRes.status === 401) {
      setState({ kind: "anon" });
      return;
    }
    const me = (await meRes.json()) as MeResponse;

    let inventory: Item[] = [];
    let activeQuest: { quest: ActiveQuest; party: Character[] } | null = null;
    let recent: RecentQuest[] = [];
    let shop: ShopResponse | null = null;
    let joinable: JoinableQuest | null = null;
    if (me.character) {
      const [invRes, qRes, recentRes, shopRes, joinableRes] = await Promise.all([
        fetch("/api/inventory", { credentials: "include" }),
        fetch("/api/quest/active", { credentials: "include" }),
        fetch("/api/quests/recent", { credentials: "include" }),
        fetch("/api/shop", { credentials: "include" }),
        fetch("/api/quest/joinable", { credentials: "include" }),
      ]);
      if (invRes.ok) {
        inventory = ((await invRes.json()) as InventoryResponse).items;
      }
      if (qRes.ok) {
        const body = (await qRes.json()) as ActiveQuestResponse;
        if (body.quest) {
          activeQuest = { quest: body.quest, party: body.party ?? [] };
        }
      }
      if (recentRes.ok) {
        recent = ((await recentRes.json()) as RecentQuestsResponse).quests;
      }
      if (shopRes.ok) {
        shop = (await shopRes.json()) as ShopResponse;
      } else {
        const body = (await shopRes.json().catch(() => ({}))) as ShopResponse;
        shop = body.error ? body : null;
      }
      if (joinableRes.ok) {
        const body = (await joinableRes.json()) as { joinable: JoinableQuest | null };
        joinable = body.joinable;
      }
    }
    setState({ kind: "auth", me, inventory, activeQuest, recent, shop, joinable });
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setState({ kind: "anon" });
  }

  async function startCombat(questId: number) {
    const res = await fetch(`/api/quest/${questId}/start_web_combat`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return;
    setActiveCombat({ questId });
  }

  async function chooseDoor(questId: number, pick: number) {
    const res = await fetch(`/api/quest/${questId}/dungeon/choose_door`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ pick }),
    });
    if (res.ok) void refresh();
  }

  async function trapChoose(questId: number, pick: number) {
    const res = await fetch(`/api/quest/${questId}/dungeon/trap_choose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ pick }),
    });
    if (res.ok) void refresh();
  }

  async function lockboxChoose(questId: number, pick: number) {
    const res = await fetch(`/api/quest/${questId}/dungeon/lockbox_choose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ pick }),
    });
    if (res.ok) void refresh();
  }

  async function npcChoose(questId: number, pick: number) {
    const res = await fetch(`/api/quest/${questId}/dungeon/npc_choose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ pick }),
    });
    if (res.ok) void refresh();
  }

  async function equipItem(itemId: number) {
    const res = await fetch(`/api/inventory/${itemId}/equip`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) void refresh();
  }

  async function sellItem(itemId: number) {
    const res = await fetch(`/api/inventory/${itemId}/sell`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) void refresh();
  }

  async function useItem(itemId: number) {
    const res = await fetch(`/api/inventory/${itemId}/use`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) void refresh();
  }

  async function rest(kind: "short" | "long") {
    const res = await fetch(`/api/character/rest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ kind }),
    });
    if (res.ok) void refresh();
  }

  async function shopBuy(itemId: number) {
    const res = await fetch(`/api/shop/${itemId}/buy`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) void refresh();
  }

  async function shopHaggle(itemId: number) {
    const res = await fetch(`/api/shop/${itemId}/haggle`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) void refresh();
  }

  async function sellKey(tier: "bronze" | "silver" | "gold") {
    const res = await fetch(`/api/keys/sell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ tier }),
    });
    if (res.ok) void refresh();
  }

  async function transmuteKey(fromTier: "bronze" | "silver") {
    const res = await fetch(`/api/keys/transmute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ from_tier: fromTier }),
    });
    if (res.ok) void refresh();
  }

  async function joinQuest() {
    const res = await fetch(`/api/quest/join`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) void refresh();
  }

  async function startQuest(variant: "standard" | "boss", elite: boolean) {
    const res = await fetch(`/api/quest/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ variant, elite }),
    });
    if (res.ok) void refresh();
  }

  async function treasureTake(questId: number, pick: number) {
    const res = await fetch(`/api/quest/${questId}/dungeon/treasure_take`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ pick }),
    });
    if (res.ok) void refresh();
  }

  if (state.kind === "loading") return <Centered>Loading…</Centered>;
  if (state.kind === "anon") return <Login onSuccess={refresh} />;
  if (activeCombat) {
    return (
      <CombatPage
        questId={activeCombat.questId}
        selfId={state.me.slack_user_id}
        onExit={() => {
          setActiveCombat(null);
          void refresh();
        }}
      />
    );
  }
  return (
    <Centered>
      <Stack>
        {!state.activeQuest && state.joinable && (
          <JoinableQuestCard joinable={state.joinable} onJoin={joinQuest} />
        )}
        {!state.activeQuest && !state.joinable && state.me.character && (
          <StartQuestCard
            characterLevel={state.me.character.level}
            onStart={startQuest}
          />
        )}
        {state.activeQuest && (
          <ActiveQuestCard
            quest={state.activeQuest.quest}
            party={state.activeQuest.party}
            selfId={state.me.slack_user_id}
            onStartCombat={() => startCombat(state.activeQuest!.quest.id)}
            onChooseDoor={(pick) => chooseDoor(state.activeQuest!.quest.id, pick)}
            onTrapChoose={(pick) => trapChoose(state.activeQuest!.quest.id, pick)}
            onLockboxChoose={(pick) => lockboxChoose(state.activeQuest!.quest.id, pick)}
            onNpcChoose={(pick) => npcChoose(state.activeQuest!.quest.id, pick)}
            onTreasureTake={(pick) => treasureTake(state.activeQuest!.quest.id, pick)}
            myKeys={state.me.character ? {
              bronze: state.me.character.keys_bronze,
              silver: state.me.character.keys_silver,
              gold: state.me.character.keys_gold,
            } : null}
          />
        )}
        <CharacterCard
          me={state.me}
          inQuest={!!state.activeQuest}
          onRest={rest}
          onSellKey={sellKey}
          onTransmuteKey={transmuteKey}
        />
        {state.me.character && (
          <InventoryCard
            items={state.inventory}
            inQuest={!!state.activeQuest}
            onEquip={equipItem}
            onSell={sellItem}
            onUse={useItem}
          />
        )}
        {state.me.character && state.shop && !state.activeQuest && (
          <ShopCard
            shop={state.shop}
            onBuy={shopBuy}
            onHaggle={shopHaggle}
          />
        )}
        {state.me.character && state.recent.length > 0 && (
          <RecentQuestsCard quests={state.recent} />
        )}
        <SignOutRow onLogout={logout} />
      </Stack>
    </Centered>
  );
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("Enter a 6-digit code.");
      return;
    }
    setPending(true);
    setError(null);
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code }),
    });
    setPending(false);
    if (res.ok) {
      onSuccess();
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(
      body.error === "invalid_or_expired"
        ? "Invalid or expired code. Run /sq web-login in Slack for a new one."
        : "Couldn't verify. Try again.",
    );
  }

  return (
    <Centered>
      <div style={card}>
        <h1 style={h1}>Slack Quest</h1>
        <p style={muted}>
          Run <code style={kbd}>/sq web-login</code> in Slack to get a 6-digit
          code, then paste it below.
        </p>
        <form onSubmit={submit}>
          <input
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            style={input}
            autoFocus
          />
          <button type="submit" disabled={pending} style={button}>
            {pending ? "Verifying…" : "Sign in"}
          </button>
        </form>
        {error && <p style={{ ...muted, color: "#c0392b" }}>{error}</p>}
      </div>
    </Centered>
  );
}

function StartQuestCard({
  characterLevel,
  onStart,
}: {
  characterLevel: number;
  onStart: (variant: "standard" | "boss", elite: boolean) => void;
}) {
  const [elite, setElite] = useState(false);
  const [pending, setPending] = useState<"standard" | "boss" | null>(null);
  const bossAllowed = characterLevel >= 3;

  function go(variant: "standard" | "boss") {
    setPending(variant);
    onStart(variant, elite);
  }

  return (
    <div style={{ ...card, borderColor: "#b89b3a" }}>
      <h2 style={h2}>Start a new quest</h2>
      <p style={muted}>
        The dungeon master will roll a fresh foe via Workers AI. Web supports
        standard + boss right now; gauntlet / dungeon variants land in a
        follow-up.
      </p>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 12,
          fontSize: 13,
          color: "#e6e6e6",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={elite}
          onChange={(e) => setElite(e.target.checked)}
          style={{ accentColor: "#dc2626" }}
        />
        <span>
          <strong>Elite mode</strong>
          <span style={{ ...muted, marginLeft: 6 }}>
            (perma-death; tier bumped by 1)
          </span>
        </span>
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button
          onClick={() => go("standard")}
          disabled={pending !== null}
          style={{
            ...button,
            marginTop: 0,
            flex: "1 1 160px",
            background: pending === "standard" ? "#33363d" : "#1f3a1f",
            color: "#86efac",
          }}
        >
          {pending === "standard" ? "Rolling…" : "⚔ Standard"}
        </button>
        <button
          onClick={() => go("boss")}
          disabled={pending !== null || !bossAllowed}
          style={{
            ...button,
            marginTop: 0,
            flex: "1 1 160px",
            background:
              pending === "boss" ? "#33363d" : bossAllowed ? "#5c1f1f" : "#2a2d33",
            color: bossAllowed ? "#fca5a5" : "#6a7080",
          }}
          title={bossAllowed ? "Climactic single foe" : "Requires character level 3"}
        >
          {pending === "boss" ? "Rolling…" : bossAllowed ? "👑 Boss" : "👑 Boss (need L3)"}
        </button>
      </div>
    </div>
  );
}

function JoinableQuestCard({
  joinable,
  onJoin,
}: {
  joinable: JoinableQuest;
  onJoin: () => void;
}) {
  return (
    <div style={{ ...card, borderColor: "#7dd3fc" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={h2}>Quest in progress</h2>
        <SmallBadge>{joinable.variant}</SmallBadge>
        {joinable.elite && <SmallBadge>elite</SmallBadge>}
      </div>
      <p style={{ ...muted, fontSize: 13, marginTop: 8 }}>
        <strong style={{ color: "#f5f5f5" }}>{joinable.monster_name}</strong> ({joinable.monster_max_hp} HP)
      </p>
      {joinable.scene && (
        <p style={{ ...muted, fontSize: 13, fontStyle: "italic", marginTop: 4 }}>{joinable.scene}</p>
      )}
      <button
        onClick={onJoin}
        style={{ ...button, marginTop: 16, background: "#1f2a3a", color: "#7dd3fc" }}
      >
        🛡 Join the fight
      </button>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Monster max HP scales by 40% for the joiner. Your mana refills on join.
      </p>
    </div>
  );
}

function ActiveQuestCard({
  quest,
  party,
  selfId,
  onStartCombat,
  onChooseDoor,
  onTrapChoose,
  onLockboxChoose,
  onNpcChoose,
  onTreasureTake,
  myKeys,
}: {
  quest: ActiveQuest;
  party: Character[];
  selfId: string;
  onStartCombat: () => void;
  onChooseDoor: (pick: number) => void;
  onTrapChoose: (pick: number) => void;
  onLockboxChoose: (pick: number) => void;
  onNpcChoose: (pick: number) => void;
  onTreasureTake: (pick: number) => void;
  myKeys: { bronze: number; silver: number; gold: number } | null;
}) {
  const s = quest.scene;
  const variant = s.variant ?? "standard";

  return (
    <div style={{ ...card, borderColor: "#b89b3a", borderWidth: 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={h2}>Active Quest</h2>
        <VariantBadge variant={variant} />
        {quest.elite && <SmallBadge>elite</SmallBadge>}
        {variant === "boss" && s.boss_phase === 2 && (
          <SmallBadge>phase 2</SmallBadge>
        )}
        {variant === "gauntlet" && s.wave && s.total_waves && (
          <SmallBadge>
            wave {s.wave}/{s.total_waves}
          </SmallBadge>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, color: "#f5f5f5" }}>
            {s.monster_name || "—"}
          </div>
          <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
            {s.monster_hp} / {s.monster_max_hp} HP
          </div>
        </div>
        <HpBar current={s.monster_hp} max={s.monster_max_hp} flavor="monster" />
        {s.monster_effects && s.monster_effects.length > 0 && (
          <EffectChips effects={s.monster_effects} />
        )}
      </div>

      {s.scene && (
        <div
          style={{
            ...muted,
            marginTop: 12,
            fontStyle: "italic",
            lineHeight: 1.5,
          }}
        >
          {s.scene}
        </div>
      )}

      {party.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div
            style={{
              ...muted,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 1.5,
              marginBottom: 8,
            }}
          >
            Party ({party.length})
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {party.map((p) => (
              <PartyMember key={p.slack_user_id} fighter={p} self={p.slack_user_id === selfId} />
            ))}
          </div>
        </div>
      )}
      {(() => {
        const currentNode = s.expedition?.nodes[s.expedition.current];
        const pendingDoors = s.expedition?.pending_doors ?? [];
        if (variant === "dungeon" && pendingDoors.length > 0) {
          return (
            <DoorPicker
              doors={pendingDoors.map((idx) => s.expedition!.nodes[idx])}
              onPick={onChooseDoor}
            />
          );
        }
        if (variant === "dungeon" && currentNode?.type === "trap" && currentNode.trap_choices) {
          return <TrapPicker choices={currentNode.trap_choices} onPick={onTrapChoose} />;
        }
        if (
          variant === "dungeon" &&
          currentNode?.type === "lockbox" &&
          currentNode.loot_options &&
          currentNode.lock_tier
        ) {
          return (
            <LockboxPicker
              options={currentNode.loot_options}
              lockTier={currentNode.lock_tier}
              myKeys={myKeys}
              onPick={onLockboxChoose}
            />
          );
        }
        if (variant === "dungeon" && currentNode?.type === "npc" && currentNode.npc) {
          return <NpcPicker npc={currentNode.npc} onPick={onNpcChoose} />;
        }
        if (
          variant === "dungeon" &&
          currentNode?.type === "treasure" &&
          currentNode.loot_options
        ) {
          return <TreasurePicker options={currentNode.loot_options} onPick={onTreasureTake} />;
        }
        const combatAvailable =
          variant === "standard" ||
          variant === "boss" ||
          variant === "gauntlet" ||
          (variant === "dungeon" && currentNode?.type === "combat" && s.monster_hp > 0);
        if (combatAvailable) {
          return (
            <button
              onClick={onStartCombat}
              style={{ ...button, marginTop: 20, background: "#b89b3a", color: "#0e0f12" }}
            >
              ⚔ Open Web Combat
            </button>
          );
        }
        if (variant === "dungeon") {
          return (
            <p style={{ ...muted, fontSize: 13, marginTop: 20 }}>
              Current room: <strong>{currentNode?.type ?? "?"}</strong> — resolve in Slack with{" "}
              <code style={kbd}>/sq choose</code> or <code style={kbd}>/sq take</code>.
            </p>
          );
        }
        return null;
      })()}
    </div>
  );
}

const SKILL_LABEL: Record<SkillType, string> = { str: "STR", dex: "DEX", int: "INT" };

function TrapPicker({
  choices,
  onPick,
}: {
  choices: TrapChoice[];
  onPick: (pick: number) => void;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        🪤 Trap — choose your approach
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {choices.map((c, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            style={{
              padding: "12px 14px",
              background: "#1d1f23",
              border: "1px solid #2a2d33",
              borderRadius: 8,
              textAlign: "left",
              cursor: "pointer",
              color: "#e6e6e6",
              fontFamily: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 20 }}>{c.emoji}</span>
              <span style={{ fontWeight: 600 }}>{c.text}</span>
              <span style={{ ...muted, fontSize: 11 }}>
                · {SKILL_LABEL[c.skill]} check · fail = −{c.fail_damage} HP
              </span>
            </div>
          </button>
        ))}
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Class experts auto-pass their skill. Others roll d6 — pass on 4+.
      </p>
    </div>
  );
}

const KEY_RANK: Record<KeyTier, number> = { bronze: 0, silver: 1, gold: 2 };
const KEY_EMOJI: Record<KeyTier, string> = { bronze: "🥉", silver: "🥈", gold: "🥇" };

function hasMatchingKey(
  myKeys: { bronze: number; silver: number; gold: number } | null,
  lock: KeyTier,
): boolean {
  if (!myKeys) return false;
  return (
    (KEY_RANK.bronze >= KEY_RANK[lock] && myKeys.bronze > 0) ||
    (KEY_RANK.silver >= KEY_RANK[lock] && myKeys.silver > 0) ||
    (KEY_RANK.gold >= KEY_RANK[lock] && myKeys.gold > 0)
  );
}

function LockboxPicker({
  options,
  lockTier,
  myKeys,
  onPick,
}: {
  options: LootOption[];
  lockTier: KeyTier;
  myKeys: { bronze: number; silver: number; gold: number } | null;
  onPick: (pick: number) => void;
}) {
  const canUnlock = hasMatchingKey(myKeys, lockTier);
  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        📦 Lockbox — {KEY_EMOJI[lockTier]} {lockTier} lock {canUnlock ? "(you have a key)" : "(no matching key)"}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            disabled={!canUnlock}
            style={{
              padding: "12px 14px",
              background: canUnlock ? "#1d1f23" : "#15171b",
              border: "1px solid " + (canUnlock ? "#2a2d33" : "#222428"),
              borderRadius: 8,
              textAlign: "left",
              cursor: canUnlock ? "pointer" : "not-allowed",
              color: canUnlock ? "#e6e6e6" : "#6a7080",
              fontFamily: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600 }}>{opt.name}</span>
              <span style={{ ...muted, fontSize: 11 }}>
                · {opt.rarity} {opt.item_type} +{opt.power}
              </span>
            </div>
            {opt.flavor && (
              <div style={{ ...muted, fontSize: 12, marginTop: 4, fontStyle: "italic" }}>
                {opt.flavor}
              </div>
            )}
          </button>
        ))}
        <button
          onClick={() => onPick(options.length + 1)}
          style={{
            padding: "12px 14px",
            background: "transparent",
            border: "1px solid #2a2d33",
            borderRadius: 8,
            cursor: "pointer",
            color: "#9aa0a6",
            fontFamily: "inherit",
          }}
        >
          Skip (no key spent)
        </button>
      </div>
    </div>
  );
}

function TreasurePicker({
  options,
  onPick,
}: {
  options: LootOption[];
  onPick: (pick: number) => void;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        💰 Treasure — pick one. Sealing the dungeon.
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            style={{
              padding: "12px 14px",
              background: "#1d1f23",
              border: "1px solid #b89b3a",
              borderRadius: 8,
              textAlign: "left",
              cursor: "pointer",
              color: "#e6e6e6",
              fontFamily: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600 }}>{opt.name}</span>
              <span style={{ ...muted, fontSize: 11 }}>
                · {opt.rarity} {opt.item_type} +{opt.power}
              </span>
            </div>
            {opt.flavor && (
              <div style={{ ...muted, fontSize: 12, marginTop: 4, fontStyle: "italic" }}>
                {opt.flavor}
              </div>
            )}
          </button>
        ))}
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Other option is left in the chest. Quest completes; spoils awarded to the party.
      </p>
    </div>
  );
}

function NpcPicker({ npc, onPick }: { npc: NpcOffer; onPick: (pick: number) => void }) {
  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        🧙 Stranger
      </div>
      <p style={{ ...muted, fontSize: 13, fontStyle: "italic", marginBottom: 8 }}>
        “{npc.greeting}”
      </p>
      <p style={{ ...muted, fontSize: 12, marginBottom: 12 }}>
        Offers: <strong>{npc.item.name}</strong> ({npc.item.rarity} {npc.item.item_type} +
        {npc.item.power})
      </p>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr" }}>
        <button
          onClick={() => onPick(1)}
          style={{
            ...button,
            marginTop: 0,
            background: "#1f3a1f",
            color: "#86efac",
            border: "1px solid #2a5a2a",
          }}
        >
          Trust
        </button>
        <button
          onClick={() => onPick(2)}
          style={{
            ...button,
            marginTop: 0,
            background: "#33363d",
            color: "#e6e6e6",
          }}
        >
          Refuse
        </button>
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Trust rolls d6 + class trust mod — 1-2 betrayed, 3 tainted (item + bleed),
        4+ clean.
      </p>
    </div>
  );
}

const ROOM_TYPE_ICON: Record<ExpeditionNodeType, string> = {
  combat: "⚔️",
  trap: "🪤",
  lockbox: "📦",
  npc: "🧙",
  treasure: "💰",
  merchant: "🏪",
};

function DoorPicker({
  doors,
  onPick,
}: {
  doors: ExpeditionNode[];
  onPick: (pick: number) => void;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        Pick a door
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {doors.map((node, i) => (
          <button
            key={i}
            onClick={() => onPick(i + 1)}
            style={{
              padding: "12px 14px",
              background: "#1d1f23",
              border: "1px solid #b89b3a",
              borderRadius: 8,
              textAlign: "left",
              cursor: "pointer",
              color: "#e6e6e6",
              fontFamily: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 20 }}>{ROOM_TYPE_ICON[node.type]}</span>
              <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{node.type}</span>
              {node.type === "combat" && node.monster_name && (
                <span style={{ ...muted, fontSize: 12 }}>· {node.monster_name}</span>
              )}
            </div>
            {node.scene && (
              <div style={{ ...muted, fontSize: 12, marginTop: 4, fontStyle: "italic" }}>
                {node.scene}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function PartyMember({ fighter, self }: { fighter: Character; self: boolean }) {
  const downed =
    fighter.downed_until !== null && fighter.downed_until > Date.now();
  return (
    <div
      style={{
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
        border: self ? "1px solid #3a7bd5" : "1px solid transparent",
        opacity: downed ? 0.6 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15 }}>
            {fighter.name}
          </span>
          <span style={{ ...muted, fontSize: 12 }}>
            {fighter.class} • Lv {fighter.level}
          </span>
          {self && <SmallBadge>you</SmallBadge>}
          {downed && (
            <span style={{ ...smallBadge, background: "#3a1f1f", color: "#ff7676", borderColor: "#5a2a2a" }}>
              downed
            </span>
          )}
          <PositionBadge position={fighter.position} />
        </div>
        <div style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
          {fighter.hp}/{fighter.max_hp}
          {fighter.shield > 0 && (
            <span style={{ color: "#7c83ff", marginLeft: 8 }}>+{fighter.shield} sh</span>
          )}
        </div>
      </div>
      <HpBar current={fighter.hp} max={fighter.max_hp} flavor="player" />
      {fighter.max_mana > 0 && (
        <div style={{ marginTop: 6 }}>
          <ManaBar current={fighter.mana} max={fighter.max_mana} />
        </div>
      )}
    </div>
  );
}

function HpBar({
  current,
  max,
  flavor,
}: {
  current: number;
  max: number;
  flavor: "monster" | "player";
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  let color = "#16a34a";
  if (pct < 0.25) color = "#dc2626";
  else if (pct < 0.5) color = "#d97706";
  if (flavor === "monster") {
    if (pct < 0.25) color = "#fca5a5";
    else if (pct < 0.5) color = "#fbbf24";
    else color = "#ef4444";
  }
  return (
    <div
      style={{
        marginTop: 6,
        width: "100%",
        height: 8,
        background: "#0e0f12",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct * 100}%`,
          height: "100%",
          background: color,
          transition: "width 200ms ease",
        }}
      />
    </div>
  );
}

function ManaBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <div style={{ ...muted, fontSize: 11, minWidth: 36 }}>
        {current}/{max}
      </div>
      <div
        style={{
          flex: 1,
          height: 6,
          background: "#0e0f12",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct * 100}%`,
            height: "100%",
            background: "#6366f1",
          }}
        />
      </div>
    </div>
  );
}

function EffectChips({ effects }: { effects: StatusEffect[] }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        marginTop: 8,
      }}
    >
      {effects.map((eff, i) => (
        <span
          key={i}
          style={{
            ...smallBadge,
            background: EFFECT_COLOR[eff.type] + "22",
            color: EFFECT_COLOR[eff.type],
            borderColor: EFFECT_COLOR[eff.type] + "55",
          }}
        >
          {EFFECT_ICON[eff.type]} {eff.type} {eff.remaining}t
        </span>
      ))}
    </div>
  );
}

function VariantBadge({ variant }: { variant: QuestVariant }) {
  return <SmallBadge>{variant}</SmallBadge>;
}

function PositionBadge({ position }: { position: "front" | "back" }) {
  return (
    <span
      style={{
        ...smallBadge,
        background: position === "front" ? "#3a2d1f" : "#1f2a3a",
        color: position === "front" ? "#fbbf24" : "#7dd3fc",
        borderColor: position === "front" ? "#5a432a" : "#2a3a5a",
      }}
    >
      {position}
    </span>
  );
}

function CharacterCard({
  me,
  inQuest,
  onRest,
  onSellKey,
  onTransmuteKey,
}: {
  me: MeResponse;
  inQuest: boolean;
  onRest: (kind: "short" | "long") => void;
  onSellKey: (tier: "bronze" | "silver" | "gold") => void;
  onTransmuteKey: (fromTier: "bronze" | "silver") => void;
}) {
  const c = me.character;
  if (!c) {
    return (
      <div style={card}>
        <h1 style={h1}>No character yet</h1>
        <p style={muted}>
          Roll one up in Slack with <code style={kbd}>/sq quest</code>, then
          reload here.
        </p>
      </div>
    );
  }
  const fullyRecovered = c.hp >= c.max_hp && c.mana >= c.max_mana;
  const downed = c.downed_until !== null && c.downed_until > Date.now();
  const restDisabled = inQuest || downed || fullyRecovered;
  return (
    <div style={card}>
      <h1 style={h1}>{c.name}</h1>
      <p style={muted}>
        {c.class} • Lv {c.level} • {c.xp} XP
      </p>
      <Stats>
        <Stat label="HP" value={`${c.hp} / ${c.max_hp}`} />
        <Stat label="Mana" value={`${c.mana} / ${c.max_mana}`} />
        <Stat label="Shield" value={c.shield.toString()} />
        <Stat label="Gold" value={c.gold.toString()} />
        <Stat label="Scars" value={c.scars.length.toString()} />
        <Stat
          label="Keys"
          value={`🥉${c.keys_bronze} 🥈${c.keys_silver} 🥇${c.keys_gold}`}
        />
      </Stats>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          onClick={() => onRest("short")}
          disabled={restDisabled}
          style={smallActionBtn(restDisabled ? "#2a2d33" : "#1f3a1f", restDisabled ? "#6a7080" : "#86efac")}
        >
          🛏 Short rest
        </button>
        <button
          onClick={() => onRest("long")}
          disabled={restDisabled}
          style={smallActionBtn(restDisabled ? "#2a2d33" : "#1f2a3a", restDisabled ? "#6a7080" : "#7dd3fc")}
        >
          🛌 Long rest
        </button>
      </div>
      {downed && (
        <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>You're downed — wait the cooldown.</p>
      )}
      {!downed && inQuest && (
        <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>Rest is disabled mid-quest.</p>
      )}
      {!inQuest && (c.keys_bronze + c.keys_silver + c.keys_gold > 0) && (
        <KeyActions
          keys={{ bronze: c.keys_bronze, silver: c.keys_silver, gold: c.keys_gold }}
          onSellKey={onSellKey}
          onTransmuteKey={onTransmuteKey}
        />
      )}
    </div>
  );
}

function KeyActions({
  keys,
  onSellKey,
  onTransmuteKey,
}: {
  keys: { bronze: number; silver: number; gold: number };
  onSellKey: (tier: "bronze" | "silver" | "gold") => void;
  onTransmuteKey: (fromTier: "bronze" | "silver") => void;
}) {
  return (
    <div style={{ marginTop: 16, padding: 12, background: "#1d1f23", borderRadius: 8 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        Keys
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {(["bronze", "silver", "gold"] as const).map((tier) => {
          const count = keys[tier];
          if (count === 0) return null;
          const sellPrice = tier === "bronze" ? 5 : tier === "silver" ? 25 : 100;
          const canTransmute = tier !== "gold" && count >= 3;
          return (
            <div
              key={tier}
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
            >
              <span style={{ fontSize: 16 }}>{KEY_EMOJI[tier]}</span>
              <span style={{ fontWeight: 600, color: "#f5f5f5" }}>{count}</span>
              <span style={{ ...muted, fontSize: 12, flex: 1 }}>{tier}</span>
              <button onClick={() => onSellKey(tier)} style={smallActionBtn("#33363d", "#e6e6e6")}>
                Sell · {sellPrice}g
              </button>
              {tier !== "gold" && (
                <button
                  onClick={() => onTransmuteKey(tier as "bronze" | "silver")}
                  disabled={!canTransmute}
                  style={smallActionBtn(
                    canTransmute ? "#1f2a3a" : "#2a2d33",
                    canTransmute ? "#7dd3fc" : "#6a7080",
                  )}
                >
                  Transmute · 3→1
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InventoryCard({
  items,
  inQuest,
  onEquip,
  onSell,
  onUse,
}: {
  items: Item[];
  inQuest: boolean;
  onEquip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
}) {
  if (items.length === 0) {
    return (
      <div style={card}>
        <h2 style={h2}>Inventory</h2>
        <p style={muted}>Empty. Win a quest or visit the shop in Slack.</p>
      </div>
    );
  }

  const equipped = items.filter((i) => i.equipped);
  const stowed = items.filter((i) => !i.equipped);
  const groups = groupByType(stowed);

  return (
    <div style={card}>
      <h2 style={h2}>Inventory</h2>
      {inQuest && (
        <p style={{ ...muted, fontSize: 12, marginTop: 8 }}>
          Selling is disabled while a quest is active.
        </p>
      )}
      {equipped.length > 0 && (
        <Section title="Equipped">
          {equipped.map((it) => (
            <ItemRow key={it.id} item={it} inQuest={inQuest} onEquip={onEquip} onSell={onSell} onUse={onUse} />
          ))}
        </Section>
      )}
      {ITEM_TYPE_ORDER.filter((t) => groups[t]?.length).map((t) => (
        <Section key={t} title={ITEM_TYPE_LABELS[t]}>
          {groups[t]!.map((it) => (
            <ItemRow key={it.id} item={it} inQuest={inQuest} onEquip={onEquip} onSell={onSell} onUse={onUse} />
          ))}
        </Section>
      ))}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          ...muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      <div style={{ display: "grid", gap: 8 }}>{children}</div>
    </div>
  );
}

function ItemRow({
  item,
  inQuest,
  onEquip,
  onSell,
  onUse,
}: {
  item: Item;
  inQuest: boolean;
  onEquip: (itemId: number) => void;
  onSell: (itemId: number) => void;
  onUse: (itemId: number) => void;
}) {
  const canEquip =
    !item.equipped &&
    item.item_type !== "consumable" &&
    item.item_type !== "magic" &&
    item.item_type !== "revive" &&
    item.item_type !== "tool" &&
    item.item_type !== "scroll";
  const canSell = !item.equipped && !inQuest;
  // Out-of-combat use: consumable (heal user) + magic (bump max_mana).
  // Tools / scrolls / revives require combat context — disabled here.
  const canUse =
    !item.equipped && (item.item_type === "consumable" || item.item_type === "magic");
  return (
    <div
      style={{
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
        border: item.equipped ? "1px solid #b89b3a" : "1px solid transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 24, lineHeight: 1 }}>{ITEM_TYPE_ICON[item.item_type]}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15 }}>{item.item_name}</div>
            <RarityBadge rarity={item.rarity} />
            {item.item_type === "weapon" && item.weapon_range === "ranged" && (
              <SmallBadge>ranged</SmallBadge>
            )}
          </div>
          {item.flavor && (
            <div style={{ ...muted, fontSize: 12, fontStyle: "italic", marginTop: 2 }}>
              {item.flavor}
            </div>
          )}
        </div>
        <div style={{ fontVariantNumeric: "tabular-nums", color: "#f5f5f5", fontWeight: 600 }}>
          +{item.power}
        </div>
      </div>
      {(canEquip || canSell || canUse) && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
          {canEquip && (
            <button onClick={() => onEquip(item.id)} style={smallActionBtn("#1f3a1f", "#86efac")}>
              Equip
            </button>
          )}
          {canUse && (
            <button onClick={() => onUse(item.id)} style={smallActionBtn("#1f2a3a", "#7dd3fc")}>
              Use
            </button>
          )}
          {canSell && (
            <button onClick={() => onSell(item.id)} style={smallActionBtn("#33363d", "#e6e6e6")}>
              Sell
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function smallActionBtn(bg: string, fg: string): React.CSSProperties {
  return {
    background: bg,
    color: fg,
    border: "1px solid #2a2d33",
    borderRadius: 6,
    padding: "4px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

function RarityBadge({ rarity }: { rarity: Rarity }) {
  const color = RARITY_COLOR[rarity];
  return (
    <span
      style={{
        ...smallBadge,
        background: `${color}22`,
        color,
        borderColor: `${color}55`,
      }}
    >
      {rarity}
    </span>
  );
}

function SmallBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        ...smallBadge,
        background: "#2a2d33",
        color: "#c4c4c4",
        borderColor: "#3a3d44",
      }}
    >
      {children}
    </span>
  );
}

const HAGGLE_LABEL: Record<"failed" | "15" | "25" | "30", string> = {
  failed: "haggle failed",
  "15": "15% off",
  "25": "25% off",
  "30": "30% off",
};

function ShopCard({
  shop,
  onBuy,
  onHaggle,
}: {
  shop: ShopResponse;
  onBuy: (id: number) => void;
  onHaggle: (id: number) => void;
}) {
  if (shop.error === "mid_quest") {
    return (
      <div style={card}>
        <h2 style={h2}>Shop</h2>
        <p style={muted}>The shopkeep is afraid of monsters. Finish the quest first.</p>
      </div>
    );
  }
  if (shop.error === "no_channel" || !shop.channel_id) {
    return (
      <div style={card}>
        <h2 style={h2}>Shop</h2>
        <p style={muted}>
          No shop channel yet — start a quest in Slack first so we know which channel's shop to show.
        </p>
      </div>
    );
  }
  if (shop.needs_restock) {
    return (
      <div style={card}>
        <h2 style={h2}>Shop</h2>
        <p style={muted}>
          Stock is dry. Run <code style={kbd}>/sq shop</code> in Slack to kick off a restock, then refresh here.
        </p>
      </div>
    );
  }
  const available = shop.stock.filter((s) => !s.bought_by);
  const capUsed = shop.purchases_this_cycle ?? 0;
  const cap = shop.purchase_cap ?? 2;
  const atCap = capUsed >= cap;
  return (
    <div style={card}>
      <h2 style={h2}>Shop</h2>
      <p style={muted}>
        {available.length}/{shop.stock.length} items available · you have{" "}
        <strong style={{ color: "#fbbf24" }}>{shop.gold}g</strong> · {capUsed}/{cap} bought
        this cycle.
      </p>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {shop.stock.map((s) => (
          <ShopRow
            key={s.id}
            item={s}
            playerGold={shop.gold}
            atCap={atCap}
            onBuy={onBuy}
            onHaggle={onHaggle}
          />
        ))}
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Haggle is a free action (per item, once per cycle). Bards / Sages / Rogues get a
        bonus on the d6.
      </p>
    </div>
  );
}

function ShopRow({
  item,
  playerGold,
  atCap,
  onBuy,
  onHaggle,
}: {
  item: ShopItem;
  playerGold: number;
  atCap: boolean;
  onBuy: (id: number) => void;
  onHaggle: (id: number) => void;
}) {
  const sold = !!item.bought_by;
  const canAfford = playerGold >= item.price;
  const canBuy = !sold && canAfford && !atCap;
  const canHaggle = !sold && !item.haggled;
  return (
    <div
      style={{
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
        opacity: sold ? 0.5 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 24, lineHeight: 1 }}>{ITEM_TYPE_ICON[item.item_type]}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15 }}>{item.item_name}</span>
            <RarityBadge rarity={item.rarity} />
            {item.item_type === "weapon" && item.weapon_range === "ranged" && (
              <SmallBadge>ranged</SmallBadge>
            )}
            {item.haggled && (
              <SmallBadge>{HAGGLE_LABEL[item.haggled]}</SmallBadge>
            )}
          </div>
          {item.flavor && (
            <div style={{ ...muted, fontSize: 12, fontStyle: "italic", marginTop: 2 }}>
              {item.flavor}
            </div>
          )}
        </div>
        <div
          style={{
            fontVariantNumeric: "tabular-nums",
            color: canAfford ? "#fbbf24" : "#c0392b",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          +{item.power} · {item.price}g
        </div>
      </div>
      {!sold && (
        <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
          {canHaggle && (
            <button onClick={() => onHaggle(item.id)} style={smallActionBtn("#33363d", "#e6e6e6")}>
              Haggle
            </button>
          )}
          <button
            onClick={() => onBuy(item.id)}
            disabled={!canBuy}
            style={smallActionBtn(canBuy ? "#1f3a1f" : "#2a2d33", canBuy ? "#86efac" : "#6a7080")}
          >
            {atCap ? "Cap reached" : !canAfford ? "Need more gold" : "Buy"}
          </button>
        </div>
      )}
      {sold && (
        <div style={{ ...muted, fontSize: 11, marginTop: 6 }}>Sold.</div>
      )}
    </div>
  );
}

function RecentQuestsCard({ quests }: { quests: RecentQuest[] }) {
  return (
    <div style={card}>
      <h2 style={h2}>Recent Quests</h2>
      <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
        {quests.map((q) => (
          <RecentQuestRow key={q.id} q={q} />
        ))}
      </div>
    </div>
  );
}

function RecentQuestRow({ q }: { q: RecentQuest }) {
  const won = q.status === "completed";
  const when = q.completed_at ?? q.created_at;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: 12,
        background: "#1d1f23",
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 20, lineHeight: 1 }}>{won ? "🏆" : "💀"}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15 }}>
            {q.monster_name}
          </span>
          <SmallBadge>{q.variant}</SmallBadge>
          {q.elite && <SmallBadge>elite</SmallBadge>}
          {q.variant === "boss" && q.boss_phase === 2 && (
            <SmallBadge>phase 2</SmallBadge>
          )}
          {q.variant === "gauntlet" && q.wave && q.total_waves && (
            <SmallBadge>
              wave {q.wave}/{q.total_waves}
            </SmallBadge>
          )}
        </div>
        <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>
          {won ? "Won" : "Lost"} · {formatRelative(when)}
        </div>
      </div>
    </div>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function SignOutRow({ onLogout }: { onLogout: () => void }) {
  return (
    <button onClick={onLogout} style={{ ...button, background: "#33363d" }}>
      Sign out
    </button>
  );
}

function Stats({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
        marginTop: 16,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 12, background: "#1d1f23", borderRadius: 8 }}>
      <div style={{ ...muted, fontSize: 12, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: "#f5f5f5" }}>
        {value}
      </div>
    </div>
  );
}

function Stack({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        width: "100%",
        maxWidth: 560,
      }}
    >
      {children}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        background: "#0e0f12",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#e6e6e6",
        padding: 32,
      }}
    >
      {children}
    </div>
  );
}

const ITEM_TYPE_ORDER: ItemType[] = [
  "weapon",
  "armor",
  "magic",
  "consumable",
  "revive",
  "tool",
  "scroll",
];

const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  weapon: "Weapons",
  armor: "Armor",
  magic: "Magic",
  consumable: "Consumables",
  revive: "Revives",
  tool: "Tools",
  scroll: "Scrolls",
};

const ITEM_TYPE_ICON: Record<ItemType, string> = {
  weapon: "⚔️",
  armor: "🛡️",
  magic: "🔮",
  consumable: "🧪",
  revive: "💖",
  tool: "🔧",
  scroll: "📜",
};

const RARITY_COLOR: Record<Rarity, string> = {
  common: "#8a8f98",
  uncommon: "#16a34a",
  rare: "#7c83ff",
};

const EFFECT_COLOR: Record<EffectType, string> = {
  regen: "#16a34a",
  bleeding: "#dc2626",
  burning: "#f97316",
  poisoned: "#a855f7",
};

const EFFECT_ICON: Record<EffectType, string> = {
  regen: "💚",
  bleeding: "🩸",
  burning: "🔥",
  poisoned: "☠️",
};

function groupByType(items: Item[]): Partial<Record<ItemType, Item[]>> {
  const out: Partial<Record<ItemType, Item[]>> = {};
  for (const it of items) {
    (out[it.item_type] ??= []).push(it);
  }
  for (const t of Object.keys(out) as ItemType[]) {
    out[t]!.sort((a, b) => RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity]);
  }
  return out;
}

const RARITY_RANK: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2 };

const card: React.CSSProperties = {
  background: "#15171b",
  padding: 32,
  borderRadius: 12,
  width: "100%",
  border: "1px solid #2a2d33",
  boxSizing: "border-box",
};
const h1: React.CSSProperties = { margin: 0, fontSize: 28, color: "#f5f5f5" };
const h2: React.CSSProperties = { margin: 0, fontSize: 20, color: "#f5f5f5" };
const muted: React.CSSProperties = { color: "#9aa0a6", fontSize: 14 };
const input: React.CSSProperties = {
  width: "100%",
  fontSize: 24,
  padding: "12px 14px",
  borderRadius: 8,
  border: "1px solid #2a2d33",
  background: "#0e0f12",
  color: "#f5f5f5",
  marginTop: 16,
  letterSpacing: 4,
  textAlign: "center",
  boxSizing: "border-box",
};
const button: React.CSSProperties = {
  marginTop: 12,
  width: "100%",
  padding: "12px 14px",
  fontSize: 16,
  fontWeight: 600,
  borderRadius: 8,
  border: "none",
  background: "#3a7bd5",
  color: "#fff",
  cursor: "pointer",
};
const kbd: React.CSSProperties = {
  background: "#222428",
  padding: "2px 6px",
  borderRadius: 4,
  fontSize: 13,
};
const smallBadge: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 1,
  padding: "2px 6px",
  borderRadius: 4,
  border: "1px solid",
  fontWeight: 600,
};
