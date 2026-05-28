import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../icons";
import type {
  TownSection, TownArt, JobListing, BoardResponse,
  JoinableQuest, QuestVariant,
} from "../types";
import {
  DISTRICT_CONFIG, VARIANT_STYLE, HUNT_PACK_LABEL, QUEST_OPTIONS,
} from "../constants";
import { DISPLAY_FONT, card, h2, muted, button } from "../styles";
import { LocationHero, SmallBadge } from "./ui";

// ─────────────────────────────────────────────────────────────
// Persistent top navigation shown whenever a town section is active.
// ─────────────────────────────────────────────────────────────

export function TownNav({
  active,
  onNavigate,
}: {
  active: TownSection;
  onNavigate: (section: TownSection | null) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      <button
        onClick={() => onNavigate(null)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          padding: "7px 10px", borderRadius: 8,
          border: "1.5px solid #2a2d33",
          background: "transparent",
          color: "#9ca3af",
          cursor: "pointer", fontSize: 12, fontWeight: 400,
          flex: "0 0 auto",
        }}
        title="Town overview"
      >
        <Icon name="tower" size={13} />
      </button>
      {DISTRICT_CONFIG.map((d) => {
        const isActive = d.key === active;
        return (
          <button
            key={d.key}
            onClick={() => onNavigate(d.key)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
              padding: "7px 6px", borderRadius: 8,
              border: `1.5px solid ${isActive ? "#b89b3a" : "#2a2d33"}`,
              background: isActive ? "rgba(184,155,58,0.15)" : "transparent",
              color: isActive ? "#f1e8c8" : "#9ca3af",
              cursor: "pointer", fontSize: 12,
              fontWeight: isActive ? 600 : 400,
              flex: 1, minWidth: 0,
              transition: "all 0.15s",
              whiteSpace: "nowrap", overflow: "hidden",
            }}
          >
            <Icon name={d.icon} size={12} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{d.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Job board
// ─────────────────────────────────────────────────────────────

export function JobPostingCard({
  job,
  claim,
  characterLevel,
  selfId,
  onTake,
}: {
  job: JobListing;
  claim: { taken_by: string } | undefined;
  characterLevel: number;
  selfId: string;
  onTake: () => void;
}) {
  const [pending, setPending] = useState(false);
  const isTaken = !!claim;
  const isMyClaim = claim?.taken_by === selfId;
  const meetsLevel = characterLevel >= job.required_level;
  const vs = VARIANT_STYLE[job.variant] ?? VARIANT_STYLE.standard;

  return (
    <div style={{
      background: isTaken ? "#141416" : vs.bg,
      border: `1px solid ${isTaken ? "#22242a" : vs.color + "44"}`,
      borderRadius: 10,
      padding: "14px 16px",
      opacity: isTaken && !isMyClaim ? 0.6 : 1,
      position: "relative",
    }}>
      {/* Variant badge + level row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          background: vs.color + "1a", border: `1px solid ${vs.color}44`,
          borderRadius: 4, padding: "2px 8px",
        }}>
          <Icon name={vs.icon} size={11} color={vs.color} />
          <span style={{ fontSize: 10, fontWeight: 700, color: vs.color, letterSpacing: 0.6 }}>
            {vs.label}
          </span>
        </div>
        {job.required_level > 1 && (
          <span style={{ fontSize: 11, color: "#6a7080" }}>L{job.required_level}+</span>
        )}
        {job.variant === "bounty_pack" && job.monster_count && job.monster_count > 1 && (
          <span style={{
            fontSize: 10, fontWeight: 700, color: "#fb923c",
            background: "#fb923c1a", border: "1px solid #fb923c44",
            borderRadius: 4, padding: "2px 7px",
          }}>
            ×{job.monster_count} enemies
          </span>
        )}
        {isMyClaim && (
          <span style={{ fontSize: 11, color: "#86efac", marginLeft: "auto" }}>✓ Claimed by you</span>
        )}
        {isTaken && !isMyClaim && (
          <span style={{ fontSize: 11, color: "#6a7080", marginLeft: "auto" }}>✓ Taken</span>
        )}
      </div>

      <div style={{ fontWeight: 600, color: isTaken ? "#6a7080" : "#f1f5f9", marginBottom: 6, fontSize: 14, lineHeight: 1.3 }}>
        {job.title}
      </div>

      <p style={{ ...muted, fontSize: 12, margin: "0 0 10px", fontStyle: "italic", lineHeight: 1.5 }}>
        {job.blurb}
      </p>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "#9ca3af" }}>
          <Icon name="gold-bar" size={11} color="#f1c26b" style={{ marginRight: 4 }} />{job.reward_summary}
        </span>
        {!isTaken && !meetsLevel && (
          <span style={{ fontSize: 12, color: "#6a7080" }}>
            🔒 Need L{job.required_level}
          </span>
        )}
        {!isTaken && meetsLevel && (
          <button
            onClick={() => { setPending(true); onTake(); }}
            disabled={pending}
            style={{
              ...button, padding: "5px 14px", marginTop: 0, fontSize: 12,
              background: pending ? "#2a2d33" : "#2a1f0a",
              color: pending ? "#6a7080" : "#f1e8c8",
              border: `1px solid ${vs.color}55`,
            }}
          >
            {pending ? "Claiming…" : "🪙 Take Job"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Step picker (±1 numeric control)
// ─────────────────────────────────────────────────────────────

export function StepPicker({
  value, min, max, onChange, label,
}: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        style={{
          width: 32, height: 32, borderRadius: 6,
          border: "1px solid #2a2d33", background: "#1a1d22",
          color: value <= min ? "#3a3d44" : "#e5e7eb",
          cursor: value <= min ? "not-allowed" : "pointer",
          fontSize: 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >−</button>
      <div style={{ textAlign: "center", minWidth: 56 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: "#f1e8c8", lineHeight: 1, fontFamily: DISPLAY_FONT }}>
          {value}
        </div>
        <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{label}</div>
      </div>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        style={{
          width: 32, height: 32, borderRadius: 6,
          border: "1px solid #2a2d33", background: "#1a1d22",
          color: value >= max ? "#3a3d44" : "#e5e7eb",
          cursor: value >= max ? "not-allowed" : "pointer",
          fontSize: 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >+</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Hunt section (free hunt launcher)
// ─────────────────────────────────────────────────────────────

export function HuntSection({
  characterLevel,
  overviewArt,
  navOverlay,
  onStartHunt,
}: {
  characterLevel: number;
  overviewArt: string | null;
  navOverlay: ReactNode;
  onStartHunt: (tier: number, monsterCount: number, invitees: string[]) => void;
}) {
  const [tier, setTier] = useState(characterLevel);
  const [monsterCount, setMonsterCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [teamMembers, setTeamMembers] = useState<{ slack_user_id: string; name: string; class: string; level: number }[]>([]);
  const [invitees, setInvitees] = useState<Set<string>>(new Set());
  const clampedTier = Math.max(1, Math.min(tier, characterLevel));

  useEffect(() => {
    fetch("/api/characters", { credentials: "include" })
      .then((r) => r.json())
      .then((b) => {
        const body = b as { characters?: { slack_user_id: string; name: string; class: string; level: number }[] };
        setTeamMembers(body.characters ?? []);
      })
      .catch(() => {});
  }, []);

  function toggleInvitee(uid: string) {
    setInvitees((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

  const packMultiplier = monsterCount === 3 ? 2.2 : monsterCount === 2 ? 1.5 : 1;
  const xpEstimate = Math.round(15 * Math.pow(clampedTier, 1.2) * packMultiplier);
  const goldEstimate = Math.round(8 * Math.pow(clampedTier, 1.2) * packMultiplier);

  const atLevel = clampedTier === characterLevel;
  const tierLabel = atLevel
    ? "Your level — full rewards"
    : clampedTier >= characterLevel - 2
    ? `Tier ${clampedTier} — slightly easier`
    : `Tier ${clampedTier} — grinding territory`;

  const packLabel = monsterCount === 1
    ? "Solo fight — normal XP"
    : monsterCount === 2
    ? "Pair — harder, +50% rewards"
    : "Trio — brutal, ×2.2 rewards";

  async function handle() {
    setBusy(true);
    try { await onStartHunt(clampedTier, monsterCount, [...invitees]); } finally { setBusy(false); }
  }

  return (
    <div style={{ ...card, padding: 0 }}>
      <LocationHero src={overviewArt} label="Outskirts" nav={navOverlay} flush />
      <div style={{ padding: "var(--card-pad, 32px)" }}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#f1e8c8", marginBottom: 4 }}>
            Free Hunt
          </div>
          <div style={{ fontSize: 12, color: "#9ca3af", lineHeight: 1.5 }}>
            Pick a tier and head into the outskirts. No job board contract — rewards scale
            with the tier you choose, so lower tiers mean faster fights but smaller gains.
          </div>
        </div>

        {/* Two pickers side by side */}
        <div style={{ display: "flex", gap: 32, marginBottom: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
              Difficulty
            </div>
            <StepPicker value={clampedTier} min={1} max={characterLevel} onChange={setTier} label="TIER" />
            <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 6 }}>{tierLabel}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
              Pack size
            </div>
            <StepPicker value={monsterCount} min={1} max={3} onChange={setMonsterCount} label={HUNT_PACK_LABEL[monsterCount]} />
            <div style={{ fontSize: 12, color: monsterCount > 1 ? "#fbbf24" : "#9ca3af", marginTop: 6 }}>{packLabel}</div>
          </div>
        </div>

        <div style={{
          display: "flex", gap: 20, marginBottom: 20,
          padding: "10px 14px", background: "#0e1014", borderRadius: 8, border: "1px solid #2a2d33",
        }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#a3e635" }}>~{xpEstimate}</div>
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2, fontFamily: DISPLAY_FONT }}>XP</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#fbbf24" }}>~{goldEstimate}</div>
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2, fontFamily: DISPLAY_FONT }}>Gold</div>
          </div>
          <div style={{ fontSize: 11, color: "#6b7280", alignSelf: "center", lineHeight: 1.4 }}>
            Estimated single-fighter rewards.<br />Actual split across party members.
          </div>
        </div>

        {/* Party invite picker */}
        {teamMembers.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontWeight: 600 }}>
              Invite players (optional)
            </div>
            <div style={{ display: "grid", gap: 5 }}>
              {teamMembers.map((tm) => {
                const checked = invitees.has(tm.slack_user_id);
                return (
                  <label
                    key={tm.slack_user_id}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "7px 10px",
                      background: checked ? "#1a0f2e" : "#0e1014",
                      border: `1px solid ${checked ? "#7c3aed" : "#2a2d33"}`,
                      borderRadius: 7, cursor: "pointer", fontSize: 13,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleInvitee(tm.slack_user_id)}
                      style={{ accentColor: "#7c3aed", flexShrink: 0 }}
                    />
                    <span style={{ fontWeight: 600, color: "#f5f5f5" }}>{tm.name}</span>
                    <span style={{ color: "#6b7280", marginLeft: "auto" }}>Lv{tm.level} {tm.class}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <button
          onClick={handle}
          disabled={busy}
          style={{
            width: "100%", padding: "12px 0", borderRadius: 8,
            border: "none", background: busy ? "#2a2d33" : "#7c3aed",
            color: busy ? "#6b7280" : "#fff",
            fontSize: 15, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Scouting…"
            : invitees.size > 0
              ? `Start Lobby · Tier ${clampedTier} (${invitees.size + 1} players)`
              : `Hunt Tier ${clampedTier}${monsterCount > 1 ? ` · ${HUNT_PACK_LABEL[monsterCount]}` : ""}`}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Job board section
// ─────────────────────────────────────────────────────────────

export function JobBoardSection({
  board,
  overviewArt,
  selfId,
  characterLevel,
  joinable,
  navOverlay,
  onTakeJob,
  onStartQuest,
  onJoin,
}: {
  board: BoardResponse | null;
  overviewArt: string | null;
  selfId: string;
  characterLevel: number;
  joinable: JoinableQuest | null;
  navOverlay: ReactNode;
  onTakeJob: (jobId: string) => void;
  onStartQuest: (variant: QuestVariant, elite: boolean, invitees: string[]) => void;
  onJoin: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Bulletin board card */}
      <div style={{
        ...card,
        borderColor: "#5c4010",
        background: "linear-gradient(180deg, #1e1508 0%, #130f05 100%)",
        padding: 0,
        overflow: "hidden",
      }}>
        <LocationHero flush src={overviewArt} label={`${board?.town_name ?? "Town"} — Job Board`} nav={navOverlay} />

        {/* Board subheader */}
        <div style={{
          borderBottom: "1px solid #2a1c08",
          padding: "12px 20px",
        }}>
          <p style={{ ...muted, margin: 0, fontSize: 12 }}>
            Three contracts posted today. Each can only be claimed by one adventurer — first come, first served.
          </p>
        </div>

        {/* Job listings */}
        <div style={{ padding: "16px 20px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          {board && board.jobs.length > 0 ? (
            board.jobs.map((job) => (
              <JobPostingCard
                key={job.id}
                job={job}
                claim={board.claims[job.id]}
                characterLevel={characterLevel}
                selfId={selfId}
                onTake={() => onTakeJob(job.id)}
              />
            ))
          ) : (
            <p style={{ ...muted, fontSize: 13 }}>
              The board is bare — run <code>/sq board</code> in Slack to seed today's postings.
            </p>
          )}
        </div>

        <div style={{
          borderTop: "1px solid #2a1c08",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <span style={{ ...muted, fontSize: 11 }}>
            <Icon name="hourglass" size={11} style={{ marginRight: 4 }} />Postings refresh daily.
          </span>
        </div>
      </div>

      {/* Divider */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1, height: 1, background: "#22242a" }} />
        <span style={{ ...muted, fontSize: 12 }}>or start any quest</span>
        <div style={{ flex: 1, height: 1, background: "#22242a" }} />
      </div>

      {joinable ? (
        <JoinableQuestCard joinable={joinable} onJoin={onJoin} />
      ) : (
        <StartQuestCard characterLevel={characterLevel} onStart={onStartQuest} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// District tile (town map grid item)
// ─────────────────────────────────────────────────────────────

export function DistrictTile({
  label,
  icon,
  color,
  artUrl,
  onClick,
}: {
  label: string;
  icon: string;
  color: string;
  artUrl: string | null;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: "pointer" }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          width: "100%",
          aspectRatio: "1 / 1",
          borderRadius: 12,
          overflow: "hidden",
          border: `2px solid ${hovered ? "#7dd3fc" : "#2a2d33"}`,
          background: color,
          position: "relative",
          transition: "border-color 0.15s, transform 0.15s, box-shadow 0.15s",
          transform: hovered ? "scale(1.06)" : "scale(1)",
          boxShadow: hovered ? "0 4px 20px rgba(125,209,252,0.25)" : "none",
          flexShrink: 0,
        }}
      >
        {artUrl ? (
          <img
            src={artUrl}
            alt={label}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name={icon} size={36} color="#9ca3af" />
          </div>
        )}
        {artUrl && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.35)",
          }}>
            <Icon name={icon} size={28} color="rgba(255,255,255,0.85)" />
          </div>
        )}
      </div>
      <span style={{ fontSize: 12, color: "#cbd5e1", fontWeight: 500, textAlign: "center" }}>{label}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Town map (district overview grid)
// ─────────────────────────────────────────────────────────────

export function TownMap({
  art,
  onNavigate,
}: {
  art: TownArt | null;
  onNavigate: (section: TownSection) => void;
}) {
  return (
    <div style={{ ...card, padding: 0, overflow: "hidden" }}>
      {/* Town overview image */}
      <div style={{ position: "relative", width: "100%", aspectRatio: "16/7", background: "#111" }}>
        {art?.overview_art_url ? (
          <img
            src={art.overview_art_url}
            alt="Town of Heylets"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", background: "#111318", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="perspective-dice-six" size={52} color="#555b6a" style={{ opacity: 0.35 }} />
          </div>
        )}
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          background: "linear-gradient(transparent, rgba(14,15,18,0.95))",
          padding: "32px 20px 14px",
        }}>
          <h2 style={{ ...h2, margin: 0, color: "#f1e8c8", letterSpacing: 1 }}>Town of Heylets</h2>
          <p style={{ ...muted, margin: "2px 0 0", fontSize: 12 }}>Choose your destination</p>
        </div>
      </div>

      {/* District tiles */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
        gap: 12,
        padding: "16px 20px 20px",
      }}>
        {DISTRICT_CONFIG.map((d) => (
          <DistrictTile
            key={d.key}
            label={d.label}
            icon={d.icon}
            color={d.color}
            artUrl={art ? art[d.artKey] : null}
            onClick={() => onNavigate(d.key)}
          />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Quest start / join cards (used by JobBoardSection)
// ─────────────────────────────────────────────────────────────

export function StartQuestCard({
  characterLevel,
  onStart,
}: {
  characterLevel: number;
  onStart: (variant: QuestVariant, elite: boolean, invitees: string[]) => void;
}) {
  const [elite, setElite] = useState(false);
  const [selected, setSelected] = useState<QuestVariant | null>(null);
  const [pending, setPending] = useState<QuestVariant | null>(null);
  const [teamMembers, setTeamMembers] = useState<{ slack_user_id: string; name: string; class: string; level: number }[]>([]);
  const [invitees, setInvitees] = useState<Set<string>>(new Set());

  const selectedOption = QUEST_OPTIONS.find((o) => o.id === selected) ?? null;

  useEffect(() => {
    if (!selected) return;
    fetch("/api/characters", { credentials: "include" })
      .then((r) => r.json())
      .then((b) => {
        const body = b as { characters?: { slack_user_id: string; name: string; class: string; level: number }[] };
        setTeamMembers(body.characters ?? []);
      })
      .catch(() => {});
  }, [selected]);

  function toggleInvitee(uid: string) {
    setInvitees((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

  function go() {
    if (!selected || pending) return;
    setPending(selected);
    onStart(selected, elite, [...invitees]);
  }

  return (
    <div style={{ ...card, borderColor: "#b89b3a" }}>
      <h2 style={h2}>Start a new quest</h2>

      {/* 2×2 radio card grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
        {QUEST_OPTIONS.map((opt) => {
          const locked = characterLevel < opt.minLevel;
          const isSelected = selected === opt.id;
          return (
            <button
              key={opt.id}
              disabled={locked || pending !== null}
              onClick={() => setSelected(isSelected ? null : opt.id)}
              style={{
                background: isSelected ? opt.bg : "#16181c",
                border: `2px solid ${isSelected ? opt.border : locked ? opt.lockedBorder : "#2a2d33"}`,
                borderRadius: 8,
                padding: "12px 14px",
                cursor: locked ? "not-allowed" : "pointer",
                textAlign: "left",
                opacity: locked ? 0.45 : 1,
                transition: "border-color 0.15s, background 0.15s",
                position: "relative",
              }}
            >
              {isSelected && (
                <span style={{
                  position: "absolute", top: 6, right: 8,
                  fontSize: 11, color: opt.accentColor, fontWeight: 700,
                }}>✓</span>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                <Icon name={opt.icon} color={locked ? "#4a5060" : opt.accentColor} size={16} />
                <span style={{ fontWeight: 600, fontSize: 13, color: locked ? "#4a5060" : opt.accentColor, fontFamily: DISPLAY_FONT }}>
                  {opt.label}
                </span>
              </div>
              <div style={{ fontSize: 11, color: locked ? "#3a3d44" : "#6b7280" }}>
                {locked ? `Requires level ${opt.minLevel}` : opt.tag}
              </div>
            </button>
          );
        })}
      </div>

      {/* Description panel — expands when a variant is selected */}
      {selectedOption && (
        <div style={{
          marginTop: 12,
          padding: "14px 16px",
          background: selectedOption.bg,
          border: `1px solid ${selectedOption.border}`,
          borderRadius: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Icon name={selectedOption.icon} color={selectedOption.accentColor} size={18} />
            <span style={{ fontWeight: 700, fontSize: 14, color: selectedOption.accentColor, fontFamily: DISPLAY_FONT }}>
              {selectedOption.label}
            </span>
          </div>
          <p style={{ ...muted, fontSize: 13, margin: 0, lineHeight: 1.55 }}>
            {selectedOption.description}
          </p>
          <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af" }}>
            <Icon name="gold-bar" size={11} color="#fbbf24" /> {selectedOption.rewards}
          </div>

          {/* Party picker */}
          {teamMembers.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Invite players (optional)
              </div>
              <div style={{ display: "grid", gap: 5 }}>
                {teamMembers.map((tm) => {
                  const checked = invitees.has(tm.slack_user_id);
                  return (
                    <label
                      key={tm.slack_user_id}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "7px 10px",
                        background: checked ? "#0f1f3d" : "#0e1117",
                        border: `1px solid ${checked ? "#2563eb" : "#1f2937"}`,
                        borderRadius: 7,
                        cursor: "pointer",
                        fontSize: 13,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleInvitee(tm.slack_user_id)}
                        style={{ accentColor: "#2563eb", flexShrink: 0 }}
                      />
                      <span style={{ fontWeight: 600, color: "#f5f5f5" }}>{tm.name}</span>
                      <span style={{ color: "#6b7280", marginLeft: "auto" }}>Lv{tm.level} {tm.class}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Elite toggle + begin button */}
          <label style={{
            display: "flex", alignItems: "center", gap: 8,
            marginTop: 14, fontSize: 13, color: "#e6e6e6", cursor: "pointer",
          }}>
            <input
              type="checkbox"
              checked={elite}
              onChange={(e) => setElite(e.target.checked)}
              style={{ accentColor: "#dc2626" }}
            />
            <span>
              <strong>Elite mode</strong>
              <span style={{ ...muted, marginLeft: 6 }}>(perma-death; tier bumped by 1)</span>
            </span>
          </label>

          <button
            onClick={go}
            disabled={pending !== null}
            style={{
              ...button,
              marginTop: 12,
              width: "100%",
              background: elite ? "#3a1a1a" : selectedOption.bg,
              color: selectedOption.accentColor,
              border: `1px solid ${elite ? "#7f1d1d" : selectedOption.border}`,
              fontWeight: 700,
              opacity: pending ? 0.6 : 1,
            }}
          >
            {pending
              ? selectedOption.pendingLabel
              : invitees.size > 0
                ? <><Icon name="conversation" /> Start Lobby ({invitees.size + 1} players)</>
                : <><Icon name={selectedOption.icon} /> {selectedOption.beginLabel}</>}
          </button>
        </div>
      )}
    </div>
  );
}

export function JoinableQuestCard({
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
        <Icon name="shield" /> Join the fight
      </button>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Monster max HP scales by 40% for the joiner. Your mana refills on join.
      </p>
    </div>
  );
}
