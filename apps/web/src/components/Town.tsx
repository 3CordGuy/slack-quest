import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../icons";
import type {
  TownSection, TownArt, JobListing, BoardResponse,
  JoinableQuest, QuestVariant, Character, ActiveQuest, ActiveGatheringTask,
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
          padding: "7px 10px", borderRadius: "var(--radius-lg)",
          border: "1px solid var(--border-base)",
          background: "transparent",
          color: "var(--fg-mute-2)",
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
              padding: "7px 6px", borderRadius: "var(--radius-lg)",
              border: `1px solid ${isActive ? "var(--accent-gold)" : "var(--border-base)"}`,
              background: isActive ? "rgba(251,191,36,0.12)" : "transparent",
              color: isActive ? "var(--accent-flavor)" : "var(--fg-mute-2)",
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
  const dim = isTaken && !isMyClaim;
  const titleColor = dim ? "var(--fg-faint)" : "var(--fg-1)";
  const blurbColor = dim ? "var(--fg-faintest)" : "var(--accent-flavor)";

  return (
    <div style={{
      background: "var(--bg-card)",
      border: "1px solid var(--border-faint)",
      borderLeft: `3px solid ${dim ? "var(--border-base)" : vs.color}`,
      borderRadius: "var(--radius-lg)",
      padding: "14px 16px",
      opacity: dim ? 0.55 : 1,
      position: "relative",
      display: "grid",
      gridTemplateColumns: "44px 1fr",
      gap: 14,
      alignItems: "start",
    }}>
      {/* Variant icon disc — mirrors .offer .o-ico from the design kit */}
      <div style={{
        width: 44,
        height: 44,
        borderRadius: "var(--radius-md)",
        background: "var(--bg-void)",
        border: `1px solid ${dim ? "var(--border-base)" : vs.color + "55"}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}>
        <Icon name={vs.icon} size={22} color={dim ? "var(--fg-faint)" : vs.color} />
      </div>

      <div style={{ minWidth: 0 }}>
        {/* Variant badge + level row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <span style={{
            fontSize: 10, fontWeight: 700, color: dim ? "var(--fg-faint)" : vs.color,
            textTransform: "uppercase", letterSpacing: 0.7,
          }}>
            {vs.label}
          </span>
          {job.required_level > 1 && (
            <span style={{ fontSize: 11, color: "var(--fg-mute-3)", fontFamily: "var(--font-mono)" }}>
              · L{job.required_level}+
            </span>
          )}
          {job.variant === "bounty_pack" && job.monster_count && job.monster_count > 1 && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: "#fb923c",
              background: "#fb923c1a", border: "1px solid #fb923c44",
              borderRadius: "var(--radius-sm)", padding: "2px 7px",
            }}>
              ×{job.monster_count} enemies
            </span>
          )}
          {isMyClaim && (
            <span style={{ fontSize: 11, color: "var(--tone-good)", marginLeft: "auto" }}>✓ Claimed by you</span>
          )}
          {isTaken && !isMyClaim && (
            <span style={{ fontSize: 11, color: "var(--fg-faint)", marginLeft: "auto" }}>✓ Taken</span>
          )}
        </div>

        <div style={{
          fontFamily: "var(--font-display)",
          fontWeight: 400,
          color: titleColor,
          marginBottom: 4,
          fontSize: 16,
          lineHeight: 1.25,
        }}>
          {job.title}
        </div>

        <p style={{
          fontFamily: "var(--font-body)",
          fontStyle: "italic",
          fontSize: 12,
          margin: "0 0 12px",
          lineHeight: 1.5,
          color: blurbColor,
        }}>
          {job.blurb}
        </p>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span style={{
            fontSize: 12,
            color: dim ? "var(--fg-faint)" : "var(--accent-gold)",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}>
            <Icon name="gold-bar" size={12} color={dim ? "var(--fg-faint)" : "var(--accent-gold)"} />
            {job.reward_summary}
          </span>
          {!isTaken && !meetsLevel && (
            <span style={{ fontSize: 12, color: "var(--fg-faint)" }}>
              <Icon name="padlock" size={11} style={{ marginRight: 4 }} />
              Need L{job.required_level}
            </span>
          )}
          {!isTaken && meetsLevel && (
            <button
              className="btn btn-gold btn-sm"
              onClick={() => { setPending(true); onTake(); }}
              disabled={pending}
            >
              <Icon name="gold-bar" size={12} />
              {pending ? "Claiming…" : "Take Job"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Step picker (±1 numeric control)
// ─────────────────────────────────────────────────────────────

export function StepPicker({
  value, min, max, onChange, label, compact = false,
}: { value: number; min: number; max: number; onChange: (n: number) => void; label: string; compact?: boolean }) {
  const btnSize = compact ? 26 : 32;
  const valFont = compact ? 20 : 28;
  const minW    = compact ? 40 : 56;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: compact ? 6 : 10 }}>
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        style={{
          width: btnSize, height: btnSize, borderRadius: 6,
          border: "1px solid #2a2d33", background: "#1a1d22",
          color: value <= min ? "#3a3d44" : "#e5e7eb",
          cursor: value <= min ? "not-allowed" : "pointer",
          fontSize: compact ? 15 : 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >−</button>
      <div style={{ textAlign: "center", minWidth: minW }}>
        <div style={{ fontSize: valFont, fontWeight: 700, color: "#f1e8c8", lineHeight: 1, fontFamily: DISPLAY_FONT }}>
          {value}
        </div>
        <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{label}</div>
      </div>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        style={{
          width: btnSize, height: btnSize, borderRadius: 6,
          border: "1px solid #2a2d33", background: "#1a1d22",
          color: value >= max ? "#3a3d44" : "#e5e7eb",
          cursor: value >= max ? "not-allowed" : "pointer",
          fontSize: compact ? 15 : 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
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
  navOverlay?: ReactNode;
  onStartHunt: (tier: number, monsterCount: number, invitees: string[], isPrivate: boolean) => void;
}) {
  const [tier, setTier] = useState(characterLevel);
  const [monsterCount, setMonsterCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
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

  const narrow = useNarrowViewport(640);
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
    try { await onStartHunt(clampedTier, monsterCount, [...invitees], isPrivate); } finally { setBusy(false); }
  }

  return (
    <div style={{ ...card, padding: 0 }}>
      {navOverlay && (
        <LocationHero src={overviewArt} label="Outskirts" nav={navOverlay} flush />
      )}
      <div style={{ padding: "var(--card-pad, 32px)" }}>
        <div style={{ marginBottom: narrow ? 12 : 20 }}>
          <div style={{
            font: "10px/1 var(--font-body)",
            textTransform: "uppercase",
            letterSpacing: 1.4,
            fontWeight: 700,
            color: "var(--accent-gold)",
            marginBottom: 6,
          }}>
            Free Hunt
          </div>
          {!narrow && (
            <div style={{ fontSize: 12, color: "var(--fg-mute)", lineHeight: 1.5 }}>
              Pick a tier and head into the outskirts. No job board contract — rewards scale
              with the tier you choose, so lower tiers mean faster fights but smaller gains.
            </div>
          )}
        </div>

        {/* Two pickers side by side */}
        <div style={{ display: "flex", gap: narrow ? 16 : 32, marginBottom: narrow ? 10 : 16, flexWrap: "wrap" }}>
          <div>
            <div style={{
              fontSize: 10, color: "var(--fg-mute)", textTransform: "uppercase",
              letterSpacing: 1.2, marginBottom: narrow ? 6 : 10, fontWeight: 700,
            }}>
              Difficulty
            </div>
            <StepPicker value={clampedTier} min={1} max={characterLevel} onChange={setTier} label="TIER" compact={narrow} />
            <div style={{ fontSize: 11, color: "var(--fg-mute)", marginTop: 4 }}>{tierLabel}</div>
          </div>
          <div>
            <div style={{
              fontSize: 10, color: "var(--fg-mute)", textTransform: "uppercase",
              letterSpacing: 1.2, marginBottom: narrow ? 6 : 10, fontWeight: 700,
            }}>
              Pack size
            </div>
            <StepPicker value={monsterCount} min={1} max={3} onChange={setMonsterCount} label={HUNT_PACK_LABEL[monsterCount]} compact={narrow} />
            <div style={{ fontSize: 11, color: monsterCount > 1 ? "var(--accent-gold)" : "var(--fg-mute)", marginTop: 4 }}>
              {packLabel}
            </div>
          </div>
        </div>

        <div style={{
          display: "flex", gap: narrow ? 12 : 20, marginBottom: narrow ? 12 : 20,
          padding: narrow ? "8px 10px" : "10px 14px",
          background: "var(--bg-void)",
          borderRadius: "var(--radius-lg)",
          border: "1px solid var(--border-faint)",
          alignItems: "center",
        }}>
          <div style={{ textAlign: "center", flexShrink: 0 }}>
            <div style={{ fontSize: narrow ? 15 : 18, fontWeight: 700, color: "#a3e635" }}>~{xpEstimate}</div>
            <div style={{ fontSize: 10, color: "var(--fg-mute-3)", marginTop: 2, fontFamily: "var(--font-display)" }}>XP</div>
          </div>
          <div style={{ textAlign: "center", flexShrink: 0 }}>
            <div style={{ fontSize: narrow ? 15 : 18, fontWeight: 700, color: "var(--accent-gold)" }}>~{goldEstimate}</div>
            <div style={{ fontSize: 10, color: "var(--fg-mute-3)", marginTop: 2, fontFamily: "var(--font-display)" }}>Gold</div>
          </div>
          {!narrow && (
            <div style={{ fontSize: 11, color: "var(--fg-mute-3)", alignSelf: "center", lineHeight: 1.4 }}>
              Estimated single-fighter rewards.<br />Actual split across party members.
            </div>
          )}
        </div>

        {/* Party invite picker */}
        {teamMembers.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: 10, color: "var(--fg-mute)", textTransform: "uppercase",
              letterSpacing: 1.2, marginBottom: 8, fontWeight: 700,
            }}>
              Invite players (optional)
            </div>
            <div style={{
              display: "grid", gap: 5,
              maxHeight: 148, overflowY: "auto",
              WebkitOverflowScrolling: "touch",
              paddingRight: 2, /* room for scrollbar */
            }}>
              {teamMembers.map((tm) => {
                const checked = invitees.has(tm.slack_user_id);
                return (
                  <label
                    key={tm.slack_user_id}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "7px 10px",
                      background: checked ? "rgba(167,139,250,0.12)" : "var(--bg-input)",
                      border: `1px solid ${checked ? "var(--accent-arcane)" : "var(--border-faint)"}`,
                      borderRadius: "var(--radius-md)", cursor: "pointer", fontSize: 13,
                      color: "var(--fg-2)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleInvitee(tm.slack_user_id)}
                      style={{ accentColor: "var(--accent-arcane)", flexShrink: 0 }}
                    />
                    <span style={{ fontWeight: 600, color: "var(--fg-1)" }}>{tm.name}</span>
                    <span style={{ color: "var(--fg-mute-3)", marginLeft: "auto" }}>Lv{tm.level} {tm.class}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <label
          title="Private hunts don't announce to the channel — other players won't see a join prompt."
          style={{
            display: "flex", alignItems: "center", gap: 8,
            marginBottom: 12, fontSize: 13, color: "var(--fg-2)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
            style={{ accentColor: "var(--accent-arcane)", flexShrink: 0 }}
          />
          <span>
            <strong>Private hunt</strong>
            <span style={{ color: "var(--fg-mute)", marginLeft: 6, fontSize: 12 }}>
              (no channel notification)
            </span>
          </span>
        </label>

        <button
          onClick={handle}
          disabled={busy}
          className="btn btn-primary"
          style={{
            width: "100%",
            justifyContent: "center",
            fontSize: 14,
            padding: "12px 18px",
          }}
        >
          {busy ? "Scouting…"
            : invitees.size > 0
              ? `Start Lobby · Tier ${clampedTier} (${invitees.size + 1} players)`
              : `Hunt Tier ${clampedTier}${monsterCount > 1 ? ` · ${HUNT_PACK_LABEL[monsterCount]}` : ""}${isPrivate ? " · Private" : ""}`}
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
  const townName = board?.town_name ?? "Town";
  const jobCount = board?.jobs.length ?? 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Bulletin board card — matches the StartQuestCard / HuntSection
          rhythm: hero, eyebrow + display heading, body, no redundant
          footer chrome. */}
      <div style={{
        background: "var(--bg-card-2)",
        border: "1px solid var(--border-faint)",
        borderRadius: "var(--radius-2xl)",
        overflow: "hidden",
        boxSizing: "border-box",
      }}>
        <LocationHero flush src={overviewArt} label={`${townName} — Job Board`} nav={navOverlay} />

        {/* Header — eyebrow + h2, mirrors StartQuestCard */}
        <div style={{ padding: "20px 20px 6px" }}>
          <div style={{
            font: "10px/1 var(--font-body)",
            textTransform: "uppercase",
            letterSpacing: 1.4,
            fontWeight: 700,
            color: "var(--accent-gold)",
            marginBottom: 6,
          }}>
            Today's Contracts
          </div>
          <h2 style={{ ...h2, fontSize: 22, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            Posted on the board
            {jobCount > 0 && (
              <span style={{
                font: "11px/1 var(--font-mono)",
                color: "var(--fg-mute)",
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}>
                {jobCount} open · first come, first served
              </span>
            )}
          </h2>
        </div>

        {/* Job listings */}
        <div style={{ padding: "12px 20px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
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
            <div style={{
              background: "var(--bg-card)",
              border: "1px dashed var(--border-faint)",
              borderRadius: "var(--radius-lg)",
              padding: "20px 16px",
              textAlign: "center",
              color: "var(--fg-mute)",
              fontSize: 13,
              lineHeight: 1.5,
            }}>
              <Icon name="hourglass" size={18} color="var(--fg-faint)" style={{ marginBottom: 6 }} />
              <div>The board is bare.</div>
              <div style={{ fontSize: 12, marginTop: 2 }}>
                Run <code>/sq board</code> in Slack to seed today's postings.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Divider */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1, height: 1, background: "var(--border-faint)" }} />
        <span style={{
          font: "11px/1 var(--font-body)",
          color: "var(--fg-faintest)",
          textTransform: "uppercase",
          letterSpacing: 1.2,
        }}>
          or start any quest
        </span>
        <div style={{ flex: 1, height: 1, background: "var(--border-faint)" }} />
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
// Town map (district overview grid) — legacy, kept for compatibility
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
// Ward map — radial hub with central plaza + 8 nodes
// ─────────────────────────────────────────────────────────────

type WardNodeKind =
  | { kind: "location"; loc: Exclude<TownSection, "job_board"> }
  | { kind: "view"; view: "job_board" | "inventory" | "combat" };

interface WardNode {
  id: string;
  label: string;
  desc: string;
  icon: string;
  left: string;   // % of map width
  top: string;    // % of map height
  hot?: boolean;
  pin?: string;
  action: WardNodeKind;
  /** Active gathering task for the main character (slot 1). Drives the progress bar. */
  task?: ActiveGatheringTask;
}

// Central plaza disc — clickable, opens the player's inventory.
// Used on the desktop ward map; the mobile fallback uses a stacked variant.
function PlazaButton({
  character,
  onClick,
  variant = "disc",
}: {
  character: Character;
  onClick: () => void;
  variant?: "disc" | "card";
}) {
  const [hovered, setHovered] = useState(false);
  if (variant === "card") {
    return (
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title="Open inventory"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: 14,
          background: "var(--bg-panel)",
          border: `2px solid ${hovered ? "var(--accent-gold-warm)" : "var(--accent-ink-blue-2)"}`,
          borderRadius: "var(--radius-xl)",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
          color: "inherit",
          transition: "border-color 0.15s",
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: "var(--bg-void)",
            border: "1px solid var(--border-base)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon name="crystal-wand" size={32} color="var(--accent-arcane-2)" />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            font: "9px/1 var(--font-mono)",
            color: hovered ? "var(--accent-gold-warm)" : "var(--accent-ink-blue)",
            textTransform: "uppercase",
            letterSpacing: 1.5,
          }}>{hovered ? "Open inventory" : "You are here"}</div>
          <div style={{
            font: "18px/1 var(--font-display)",
            color: "var(--fg-1)",
            marginTop: 4,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>{character.name}</div>
          <div style={{
            font: "9px/1 var(--font-mono)",
            color: "var(--accent-arcane-2)",
            marginTop: 3,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}>{character.class} · L{character.level}</div>
          <div style={{ display: "flex", gap: 10, marginTop: 6, font: "11px/1 var(--font-mono)" }}>
            <span style={{ color: "var(--tone-good-2)" }}>♥ {character.hp}</span>
            <span style={{ color: "var(--accent-arcane)" }}>✦ {character.mana}</span>
            <span style={{ color: "var(--accent-gold)" }}>🪙 {character.gold}</span>
          </div>
        </div>
        <Icon name="knapsack" size={20} color={hovered ? "var(--accent-gold-warm)" : "var(--fg-faintest)"} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="Open inventory"
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: hovered ? "translate(-50%, -50%) scale(1.03)" : "translate(-50%, -50%)",
        width: 230,
        aspectRatio: "1 / 1",
        background: "var(--bg-panel)",
        border: `2px solid ${hovered ? "var(--accent-gold-warm)" : "var(--accent-ink-blue-2)"}`,
        borderRadius: "50%",
        zIndex: 3,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        boxShadow: hovered ? "var(--shadow-deep)" : "var(--shadow-pop)",
        textAlign: "center",
        cursor: "pointer",
        font: "inherit",
        color: "inherit",
        transition: "transform 0.15s, border-color 0.15s, box-shadow 0.15s",
      }}
    >
      <span style={{
        font: "9px/1 var(--font-mono)",
        color: hovered ? "var(--accent-gold-warm)" : "var(--accent-ink-blue)",
        textTransform: "uppercase",
        letterSpacing: 1.5,
      }}>{hovered ? "Open inventory" : "You are here"}</span>
      <div style={{
        width: 64, height: 64, margin: "10px 0 8px",
        borderRadius: "50%",
        background: "var(--bg-void)",
        border: "1px solid var(--border-base)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <Icon name="crystal-wand" size={38} color="var(--accent-arcane-2)" />
      </div>
      <div style={{
        font: "19px/1 var(--font-display)",
        color: "var(--fg-1)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "100%",
      }}>{character.name}</div>
      <div style={{
        font: "9px/1 var(--font-mono)",
        color: "var(--accent-arcane-2)",
        marginTop: 4,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}>{character.class} · L{character.level}</div>
      <div style={{ display: "flex", gap: 12, marginTop: 12, font: "11px/1 var(--font-mono)" }}>
        <span style={{ color: "var(--tone-good-2)" }}>♥ {character.hp}</span>
        <span style={{ color: "var(--accent-arcane)" }}>✦ {character.mana}</span>
        <span style={{ color: "var(--accent-gold)" }}>🪙 {character.gold}</span>
      </div>
    </button>
  );
}

// Zero-rerender progress bar. Uses a DOM ref ticker so only the inner <div>
// gets updated — the parent WardMapNode and WardMap never re-render per tick.
function NodeProgressBar({ task }: { task: ActiveGatheringTask }) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout>;

    function tick() {
      const el = barRef.current;
      if (!el) return;
      const nowMs  = Date.now();
      const total  = task.expires_at - task.started_at;
      const pct    = total > 0 ? Math.min(100, ((nowMs - task.started_at) / total) * 100) : 100;
      const done   = task.ready || pct >= 100;
      el.style.width      = `${pct}%`;
      el.style.background = done ? "var(--accent-go-1, #4ade80)" : "var(--accent-ink-blue-2)";
      if (!done) timerId = setTimeout(tick, 1000);
    }

    tick();
    return () => clearTimeout(timerId);
  }, [task.id, task.started_at, task.expires_at, task.ready]);

  // Compute synchronous initial values to avoid a flash of empty bar.
  const initTotal = task.expires_at - task.started_at;
  const initPct   = initTotal > 0 ? Math.min(100, ((Date.now() - task.started_at) / initTotal) * 100) : 100;
  const initDone  = task.ready || initPct >= 100;

  return (
    <div style={{
      position: "absolute", bottom: 0, left: 0, right: 0,
      height: 3, overflow: "hidden",
      borderRadius: "0 0 var(--radius-xl) var(--radius-xl)",
      background: "var(--bg-void)",
    }}>
      <div
        ref={barRef}
        style={{
          height: "100%",
          width: `${initPct}%`,
          background: initDone ? "var(--accent-go-1, #4ade80)" : "var(--accent-ink-blue-2)",
          transition: "width 1s linear",
        }}
      />
    </div>
  );
}

function WardMapNode({
  node,
  onClick,
}: {
  node: WardNode;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const borderColor = node.hot
    ? "var(--accent-gold)"
    : hovered
      ? "var(--border-muted)"
      : "var(--border-faint)";
  const discBorder = node.hot ? "var(--accent-gold)" : "var(--border-base)";
  const iconColor = node.hot ? "var(--accent-gold)" : "var(--fg-3)";
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "absolute",
        left: node.left,
        top: node.top,
        transform: "translate(-50%, -50%)",
        width: 168,
        background: "var(--bg-card-2)",
        border: `1px solid ${borderColor}`,
        borderRadius: "var(--radius-xl)",
        padding: 14,
        textAlign: "center",
        cursor: "pointer",
        transition: "border-color 0.15s",
        zIndex: 2,
      }}
    >
      {node.pin && (
        <span
          style={{
            position: "absolute",
            top: -10,
            left: "50%",
            transform: "translateX(-50%)",
            font: "700 9px/1 var(--font-body)",
            textTransform: "uppercase",
            letterSpacing: 0.6,
            background: "var(--accent-gold)",
            color: "#1a1300",
            padding: "4px 8px",
            borderRadius: 999,
            whiteSpace: "nowrap",
          }}
        >
          {node.pin}
        </span>
      )}
      <div
        style={{
          width: 52,
          height: 52,
          margin: "0 auto 9px",
          borderRadius: "50%",
          background: "var(--bg-void)",
          border: `1px solid ${discBorder}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: node.hot ? "0 0 14px rgba(251,191,36,0.25)" : undefined,
        }}
      >
        <Icon name={node.icon} size={28} color={iconColor} />
      </div>
      <div style={{ font: "15px/1.05 var(--font-display)", color: "var(--fg-1)" }}>
        {node.label}
      </div>
      <div style={{ font: "10px/1.35 var(--font-body)", color: "var(--fg-mute)", marginTop: 4 }}>
        {node.desc}
      </div>
      {node.task && <NodeProgressBar task={node.task} />}
    </div>
  );
}

export interface WardMapProps {
  character: Character;
  activeQuest: {
    quest: ActiveQuest;
    hasWebCombat: boolean;
  } | null;
  jobsOpen: number;         // job board pin count, 0 hides the pin
  /** Optional hand-painted world-map artwork (Ghibli/Tolkien-style) shown
      behind the radial graph. Falls back to solid bg-void when null. */
  overviewArtUrl?: string | null;
  /** Active gathering tasks. Slot-1 task drives the progress bar on the camp node. */
  activeTasks?: ActiveGatheringTask[];
  onOpenLocation: (loc: Exclude<TownSection, "job_board">) => void;
  onOpenJobBoard: () => void;
  onOpenInventory: () => void;
  onResumeCombat: () => void;
}

function useNarrowViewport(breakpoint = 720) {
  const [narrow, setNarrow] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(`(max-width: ${breakpoint}px)`).matches;
  });
  useEffect(() => {
    const m = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    m.addEventListener("change", handler);
    return () => m.removeEventListener("change", handler);
  }, [breakpoint]);
  return narrow;
}

export function WardMap({
  character,
  activeQuest,
  jobsOpen,
  overviewArtUrl,
  activeTasks = [],
  onOpenLocation,
  onOpenJobBoard,
  onOpenInventory,
  onResumeCombat,
}: WardMapProps) {
  // Slot-1 task = main character gathering. Used for the camp node progress bar.
  const campTask = activeTasks.find((t) => t.worker_slot === 1) ?? null;
  const narrow = useNarrowViewport(720);
  // Coords below come from design layouts/town-b.html. The SVG viewBox is
  // 1232×712 and the nodes are positioned by % so the map can rescale.
  const nodes: WardNode[] = [
    {
      id: "job_board",
      label: "Job Board",
      desc: jobsOpen > 0 ? `${jobsOpen} contracts posted` : "Pick a contract",
      icon: "scroll-quill",
      left: "50%",
      top: "16.5%",
      hot: true,
      pin: jobsOpen > 0 ? `${jobsOpen} New Contract${jobsOpen === 1 ? "" : "s"}` : undefined,
      action: { kind: "view", view: "job_board" },
    },
    {
      id: "smithy",
      label: "Smithy",
      desc: "Sharpen & repair",
      icon: "anvil",
      left: "24.8%",
      top: "23.6%",
      action: { kind: "location", loc: "smithy" },
    },
    {
      id: "shop",
      label: "Shop",
      desc: "Rotating gear",
      icon: "cash",
      left: "75.2%",
      top: "23.6%",
      action: { kind: "location", loc: "shop" },
    },
    {
      id: "pub",
      label: "Pub",
      desc: "Ale · Whiskey",
      icon: "beer-stein",
      left: "14.3%",
      top: "51.7%",
      action: { kind: "location", loc: "pub" },
    },
    {
      id: "apothecary",
      label: "Apothecary",
      desc: "Potions & vials",
      icon: "health-potion",
      left: "85.7%",
      top: "51.7%",
      action: { kind: "location", loc: "apothecary" },
    },
    {
      id: "inn",
      label: "Inn",
      desc: "Skip rest cd",
      icon: "bed",
      left: "24.8%",
      top: "82.3%",
      action: { kind: "location", loc: "inn" },
    },
    {
      id: "outskirts",
      label: "Outskirts",
      desc: "Free hunt",
      icon: "spinning-sword",
      left: "75.2%",
      top: "82.3%",
      action: { kind: "location", loc: "hunt" },
    },
    {
      id: "camp",
      label: "My Camp",
      desc: campTask?.ready
        ? "Ready to collect!"
        : campTask
          ? (({ mine: "Mining…", forage: "Foraging…", fish: "Fishing…" } as Record<string, string>)[campTask.node] ?? "Gathering…")
          : activeTasks.length > 0
            ? `${activeTasks.length} task${activeTasks.length > 1 ? "s" : ""} active`
            : "Mine · Forage · Fish",
      icon: "camping-tent",
      left: "50%",
      top: "86%",
      hot: campTask?.ready === true,
      action: { kind: "location", loc: "camp" },
      task: campTask ?? undefined,
    },
  ];

  function handleClick(action: WardNodeKind) {
    if (action.kind === "location") {
      onOpenLocation(action.loc);
    } else if (action.view === "job_board") {
      onOpenJobBoard();
    } else if (action.view === "inventory") {
      onOpenInventory();
    } else if (action.view === "combat") {
      onResumeCombat();
    }
  }

  const questBanner = activeQuest;

  // Mobile / narrow fallback — the radial 168px nodes overlap below ~720px,
  // so swap for a stacked plaza card + 2-col tile grid that mirrors the
  // same destinations and the same quest banner.
  if (narrow) {
    return (
      <div
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "var(--bg-void)",
          border: "1px solid var(--border-base)",
          borderRadius: "var(--radius-2xl)",
          overflow: "hidden",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {/* Plaza card — character header, also opens inventory on tap */}
        <PlazaButton character={character} onClick={onOpenInventory} variant="card" />

        {/* Quest banner */}
        {questBanner && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "rgba(14,15,18,0.78)",
              border: "1px solid var(--tone-bad-3)",
              borderRadius: "var(--radius-lg)",
              padding: "10px 12px",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
              <Icon name="death-skull" size={16} color="var(--tone-bad-2)" />
              <div style={{ minWidth: 0 }}>
                <div style={{
                  font: "13px/1 var(--font-display)",
                  color: "var(--fg-1)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}>
                  {questBanner.quest.scene.monster_name ?? "Active Quest"}
                </div>
                <div style={{
                  font: "9px/1 var(--font-mono)",
                  color: "var(--fg-mute)",
                  marginTop: 3,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}>
                  Active · {questBanner.quest.scene.variant ?? "standard"}
                </div>
              </div>
            </div>
            {questBanner.hasWebCombat && (
              <button
                onClick={onResumeCombat}
                style={{
                  background: "var(--tone-bad-3)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "var(--radius-md)",
                  padding: "8px 12px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  font: "700 11px/1 var(--font-body)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <Icon name="broadsword" size={12} color="#fff" /> Resume
              </button>
            )}
          </div>
        )}

        {/* 2-col tile grid */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}>
          {nodes.map((node) => {
            const hot = node.hot;
            return (
              <button
                key={node.id}
                onClick={() => handleClick(node.action)}
                style={{
                  background: "var(--bg-card-2)",
                  border: `1px solid ${hot ? "var(--accent-gold)" : "var(--border-faint)"}`,
                  borderRadius: "var(--radius-xl)",
                  padding: "12px 10px",
                  textAlign: "center",
                  cursor: "pointer",
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  font: "inherit",
                  color: "inherit",
                }}
              >
                {node.pin && (
                  <span
                    style={{
                      position: "absolute",
                      top: -8,
                      left: "50%",
                      transform: "translateX(-50%)",
                      font: "700 9px/1 var(--font-body)",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      background: "var(--accent-gold)",
                      color: "#1a1300",
                      padding: "3px 6px",
                      borderRadius: 999,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {node.pin}
                  </span>
                )}
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: "50%",
                    background: "var(--bg-void)",
                    border: `1px solid ${hot ? "var(--accent-gold)" : "var(--border-base)"}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name={node.icon} size={24} color={hot ? "var(--accent-gold)" : "var(--fg-3)"} />
                </div>
                <div style={{
                  font: "13px/1.05 var(--font-display)",
                  color: "var(--fg-1)",
                }}>{node.label}</div>
                <div style={{
                  font: "10px/1.3 var(--font-body)",
                  color: "var(--fg-mute)",
                }}>{node.desc}</div>
                {node.task && <NodeProgressBar task={node.task} />}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        background: "var(--bg-void)",
        border: "1px solid var(--border-base)",
        borderRadius: "var(--radius-2xl)",
        overflow: "hidden",
        aspectRatio: "1232 / 712",
        minHeight: 540,
      }}
    >
      {/* Hand-painted world map backdrop. Light CSS treatment so the dashed
          roads / nodes / plaza disc stay legible on top:
          - opacity 0.8 — mostly visible, town art legible
          - saturate 0.78 — slight pull toward night-tinted palette
          - brightness 0.9 — mild dim so node chips still pop
          - blur 0.5px — softens raster details
          - bottom-vignette gradient — darker near nodes/plaza area
          When overviewArtUrl is null the dark void shows through.
          Below 720px the mobile fallback layout doesn't render this. */}
      {overviewArtUrl && (
        <>
          <img
            src={overviewArtUrl}
            alt=""
            aria-hidden
            loading="lazy"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: 0.8,
              filter: "saturate(0.78) brightness(0.9) blur(0.5px)",
              pointerEvents: "none",
              zIndex: 0,
            }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(14,15,18,0.1), rgba(14,15,18,0.35))",
              pointerEvents: "none",
              zIndex: 1,
            }}
          />
        </>
      )}
      {/* Dashed road SVG */}
      <svg
        viewBox="0 0 1232 712"
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      >
        {/* Hot path → Job Board (top) */}
        <line
          x1="616" y1="356" x2="616" y2="118"
          stroke="rgba(251,191,36,0.4)" strokeWidth={2}
          strokeDasharray="3 7" strokeLinecap="round"
        />
        {/* Smithy (upper L) */}
        <line x1="616" y1="356" x2="306" y2="168" stroke="var(--border-base)" strokeWidth={2} strokeDasharray="2 7" strokeLinecap="round" />
        {/* Shop (upper R) */}
        <line x1="616" y1="356" x2="926" y2="168" stroke="var(--border-base)" strokeWidth={2} strokeDasharray="2 7" strokeLinecap="round" />
        {/* Pub (left) */}
        <line x1="616" y1="356" x2="176" y2="368" stroke="var(--border-base)" strokeWidth={2} strokeDasharray="2 7" strokeLinecap="round" />
        {/* Apothecary (right) */}
        <line x1="616" y1="356" x2="1056" y2="368" stroke="var(--border-base)" strokeWidth={2} strokeDasharray="2 7" strokeLinecap="round" />
        {/* Inn (lower L) */}
        <line x1="616" y1="356" x2="306" y2="586" stroke="var(--border-base)" strokeWidth={2} strokeDasharray="2 7" strokeLinecap="round" />
        {/* Outskirts (lower R) */}
        <line x1="616" y1="356" x2="926" y2="586" stroke="var(--border-base)" strokeWidth={2} strokeDasharray="2 7" strokeLinecap="round" />
        {/* Inventory (bottom) */}
        <line x1="616" y1="356" x2="616" y2="612" stroke="var(--border-base)" strokeWidth={2} strokeDasharray="2 7" strokeLinecap="round" />
      </svg>

      {/* Quest banner */}
      {questBanner && (
        <div
          style={{
            position: "absolute",
            top: 18,
            left: 24,
            right: 24,
            zIndex: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "rgba(14,15,18,0.78)",
            border: "1px solid var(--tone-bad-3)",
            borderRadius: "var(--radius-lg)",
            padding: "10px 16px",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
            <Icon name="death-skull" size={18} color="var(--tone-bad-2)" />
            <div style={{ minWidth: 0 }}>
              <div style={{
                font: "15px/1 var(--font-display)",
                color: "var(--fg-1)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}>
                {questBanner.quest.scene.monster_name ?? "Active Quest"}
              </div>
              <div style={{
                font: "10px/1 var(--font-mono)",
                color: "var(--fg-mute)",
                marginTop: 3,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}>
                Active Quest · {questBanner.quest.scene.variant ?? "standard"}
              </div>
            </div>
          </div>
          {questBanner.hasWebCombat && (
            <button
              onClick={onResumeCombat}
              style={{
                background: "var(--tone-bad-3)",
                color: "#fff",
                border: "none",
                borderRadius: "var(--radius-md)",
                padding: "9px 16px",
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                font: "700 12px/1 var(--font-body)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <Icon name="broadsword" size={14} color="#fff" /> Resume Combat
            </button>
          )}
        </div>
      )}

      {/* Central Plaza — clickable, opens inventory */}
      <PlazaButton character={character} onClick={onOpenInventory} />


      {/* Location nodes */}
      {nodes.map((node) => (
        <WardMapNode key={node.id} node={node} onClick={() => handleClick(node.action)} />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Top bar — brand + crumb + character stat chip
// ─────────────────────────────────────────────────────────────

export function TownTopBar({
  crumb,
  character,
}: {
  crumb: string;
  character: Character | null;
}) {
  return (
    <header className="gq-topbar">
      <div className="gq-brand">
        <Icon name="tower-flag" size={28} color="var(--accent-gold)" />
        <div>
          <div className="gq-wordmark">
            Gantt Quest<sup>™</sup>
          </div>
          <div className="gq-crumb">{crumb}</div>
        </div>
      </div>
      {character && (
        <div className="gq-charchip">
          <span className="stat" style={{ color: "var(--tone-good-2)" }}>
            <Icon name="health-normal" size={14} color="var(--tone-good-2)" />
            {character.hp}/{character.max_hp}
          </span>
          <span className="stat" style={{ color: "var(--accent-arcane)" }}>
            ✦ {character.mana}/{character.max_mana}
          </span>
          <span className="stat" style={{ color: "var(--accent-gold)" }}>
            <Icon name="gold-bar" size={14} color="var(--accent-gold)" />
            {character.gold.toLocaleString()}
          </span>
        </div>
      )}
    </header>
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

  const narrow = useNarrowViewport(640);

  return (
    <div style={{
      background: "var(--bg-card-2)",
      border: "1px solid var(--border-faint)",
      borderRadius: "var(--radius-2xl)",
      padding: "var(--card-pad, 32px)",
      boxSizing: "border-box",
      width: "100%",
    }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{
          font: "10px/1 var(--font-body)",
          textTransform: "uppercase",
          letterSpacing: 1.4,
          fontWeight: 700,
          color: "var(--accent-gold)",
          marginBottom: 6,
        }}>
          Forge Your Own Path
        </div>
        <h2 style={{ ...h2, fontSize: 22 }}>Start a new quest</h2>
      </div>

      {/* Variant grid — 2×2 desktop, 1 col on narrow */}
      <div style={{
        display: "grid",
        gridTemplateColumns: narrow ? "1fr" : "1fr 1fr",
        gap: 10,
      }}>
        {QUEST_OPTIONS.map((opt) => {
          const locked = characterLevel < opt.minLevel;
          const isSelected = selected === opt.id;
          const borderColor = isSelected
            ? "var(--accent-gold)"
            : locked
              ? "var(--border-faint)"
              : "var(--border-faint)";
          const fgColor = locked ? "var(--fg-faint)" : opt.accentColor;
          return (
            <button
              key={opt.id}
              disabled={locked || pending !== null}
              onClick={() => setSelected(isSelected ? null : opt.id)}
              style={{
                background: "var(--bg-card)",
                border: `1px solid ${borderColor}`,
                borderLeft: `3px solid ${locked ? "var(--border-base)" : opt.accentColor}`,
                borderRadius: "var(--radius-lg)",
                padding: "13px 14px",
                cursor: locked ? "not-allowed" : "pointer",
                textAlign: "left",
                opacity: locked ? 0.5 : 1,
                transition: "border-color 0.15s, background 0.15s",
                position: "relative",
                boxShadow: isSelected ? "0 0 0 1px var(--accent-gold)" : "none",
              }}
            >
              {isSelected && (
                <span style={{
                  position: "absolute", top: 8, right: 10,
                  fontSize: 11, color: "var(--accent-gold)", fontWeight: 700,
                }}>✓</span>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                <Icon name={opt.icon} color={fgColor} size={16} />
                <span style={{
                  fontWeight: 400,
                  fontSize: 15,
                  color: fgColor,
                  fontFamily: "var(--font-display)",
                }}>
                  {opt.label}
                </span>
              </div>
              <div style={{
                fontSize: 11,
                color: locked ? "var(--fg-faint)" : "var(--fg-mute)",
                lineHeight: 1.4,
              }}>
                {locked ? `Requires level ${opt.minLevel}` : opt.tag}
              </div>
            </button>
          );
        })}
      </div>

      {/* Description panel */}
      {selectedOption && (
        <div style={{
          marginTop: 14,
          padding: "14px 16px",
          background: "var(--bg-card)",
          border: "1px solid var(--border-faint)",
          borderLeft: `3px solid ${selectedOption.accentColor}`,
          borderRadius: "var(--radius-lg)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Icon name={selectedOption.icon} color={selectedOption.accentColor} size={18} />
            <span style={{
              fontWeight: 400,
              fontSize: 16,
              color: selectedOption.accentColor,
              fontFamily: "var(--font-display)",
            }}>
              {selectedOption.label}
            </span>
          </div>
          <p style={{
            fontFamily: "var(--font-body)",
            fontStyle: "italic",
            fontSize: 13,
            margin: 0,
            lineHeight: 1.55,
            color: "var(--accent-flavor)",
          }}>
            {selectedOption.description}
          </p>
          <div style={{
            marginTop: 10,
            fontSize: 12,
            color: "var(--accent-gold)",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontWeight: 600,
          }}>
            <Icon name="gold-bar" size={12} color="var(--accent-gold)" /> {selectedOption.rewards}
          </div>

          {/* Party picker */}
          {teamMembers.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{
                fontSize: 10,
                color: "var(--fg-mute)",
                marginBottom: 8,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}>
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
                        background: checked ? "var(--accent-ink-deep)" : "var(--bg-input)",
                        border: `1px solid ${checked ? "var(--accent-ink-blue-2)" : "var(--border-faint)"}`,
                        borderRadius: "var(--radius-md)",
                        cursor: "pointer",
                        fontSize: 13,
                        color: "var(--fg-2)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleInvitee(tm.slack_user_id)}
                        style={{ accentColor: "var(--accent-ink-blue-2)", flexShrink: 0 }}
                      />
                      <span style={{ fontWeight: 600, color: "var(--fg-1)" }}>{tm.name}</span>
                      <span style={{ color: "var(--fg-mute-3)", marginLeft: "auto" }}>Lv{tm.level} {tm.class}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Elite toggle */}
          <label style={{
            display: "flex", alignItems: "center", gap: 8,
            marginTop: 14, fontSize: 13, color: "var(--fg-2)", cursor: "pointer",
          }}>
            <input
              type="checkbox"
              checked={elite}
              onChange={(e) => setElite(e.target.checked)}
              style={{ accentColor: "#dc2626" }}
            />
            <span>
              <strong>Elite mode</strong>
              <span style={{ color: "var(--fg-mute)", marginLeft: 6, fontSize: 12 }}>
                (perma-death; tier bumped by 1)
              </span>
            </span>
          </label>

          <button
            onClick={go}
            disabled={pending !== null}
            className="btn btn-primary"
            style={{
              marginTop: 14,
              width: "100%",
              justifyContent: "center",
              fontSize: 14,
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
    <div style={{
      background: "var(--bg-card-2)",
      border: "1px solid var(--accent-ink-blue)",
      borderRadius: "var(--radius-2xl)",
      padding: "var(--card-pad, 32px)",
      boxSizing: "border-box",
      width: "100%",
    }}>
      <div style={{
        font: "10px/1 var(--font-body)",
        textTransform: "uppercase",
        letterSpacing: 1.4,
        fontWeight: 700,
        color: "var(--accent-ink-blue)",
        marginBottom: 6,
      }}>
        Quest in progress · Joinable{joinable.starter_name ? ` · ${joinable.starter_name}` : ""}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{
          margin: 0,
          fontSize: 22,
          color: "var(--fg-1)",
          fontFamily: "var(--font-display)",
          fontWeight: 400,
        }}>
          {joinable.monster_name}
        </h2>
        <SmallBadge>{joinable.variant}</SmallBadge>
        {joinable.elite && <SmallBadge>elite</SmallBadge>}
      </div>
      <p style={{
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        marginTop: 6,
        marginBottom: 0,
        color: "var(--fg-mute)",
      }}>
        {joinable.monster_max_hp} HP
      </p>
      {joinable.scene && (
        <p style={{
          fontFamily: "var(--font-body)",
          fontStyle: "italic",
          color: "var(--accent-flavor)",
          fontSize: 13,
          marginTop: 10,
          marginBottom: 0,
          lineHeight: 1.55,
        }}>
          {joinable.scene}
        </p>
      )}
      <button
        onClick={onJoin}
        className="btn btn-primary"
        style={{
          marginTop: 16,
          width: "100%",
          justifyContent: "center",
          fontSize: 14,
        }}
      >
        <Icon name="shield" /> Join the fight
      </button>
      <p style={{
        color: "var(--fg-faintest)",
        fontSize: 11,
        marginTop: 10,
        marginBottom: 0,
        lineHeight: 1.5,
      }}>
        Monster max HP scales by 40% for the joiner. Your mana refills on join.
      </p>
    </div>
  );
}
