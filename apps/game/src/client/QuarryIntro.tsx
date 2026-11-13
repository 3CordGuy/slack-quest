// The quarry's own card, before a run and after one: a picture of the face,
// the rules as four pictures with a few words each, what the face can give,
// and the way in. The run itself is played in the Harbor (Quarry.tsx).

import { MINE_MS, MINE_RARITY, STALL_GEM_PRICE, type GatherView, type Resources } from "@gantt-quest/world";
import type { GatherStatus, XpResult } from "./api";
import { ResourceChips } from "./hutDrops";
import { StaminaBolts } from "./StaminaBolts";
import { ThingIcon, resourceIcon } from "./thingIcons";
import "./quarry.css";

const FINDS = ["stone", "iron", "copper", "gem"] as const;

/** A small fixed noise, so the picture is the same every time. */
const jit = (i: number, salt: number) => {
  const n = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

/** The face, drawn small: rocks in rows, a seam of ore wandering across, a geode beside it, and glints that twinkle. */
function FaceArt() {
  const cols = 11;
  const rows = 3;
  const w = 340 / cols;
  const h = 84 / rows;
  // The seam's row in each column, and the one geode.
  const seam = [-1, 1, 1, 2, 2, 1, 1, 0, 1, -1, -1];
  const geode = { c: 4, r: 1 };
  const rocks = [];
  const glints = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const cx = c * w + w / 2 + (r % 2 ? w * 0.18 : -w * 0.1) + (jit(i, 1) - 0.5) * 4;
      const cy = 10 + r * h + h / 2 + (jit(i, 2) - 0.5) * 4;
      const rx = w * (0.56 + jit(i, 3) * 0.1);
      const ry = h * (0.55 + jit(i, 4) * 0.08);
      const pts = Array.from({ length: 7 }, (_, k) => {
        const a = (k / 7) * Math.PI * 2 + jit(i, 5);
        const s = 0.82 + jit(i * 7 + k, 6) * 0.22;
        return `${(cx + Math.cos(a) * rx * s).toFixed(1)},${(cy + Math.sin(a) * ry * s).toFixed(1)}`;
      }).join(" ");
      const isSeam = seam[c] === r;
      const isGeode = geode.c === c && geode.r === r;
      const kind = isGeode ? "geode" : isSeam ? "seam" : jit(i, 7) > 0.7 ? "hard" : "junk";
      rocks.push(<polygon key={i} points={pts} className={`qa-rock ${kind}`} />);
      const flecks = isGeode ? 4 : isSeam ? 3 : jit(i, 8) > 0.82 ? 1 : 0;
      for (let f = 0; f < flecks; f++) {
        glints.push(
          <rect
            key={`${i}-${f}`}
            className={`qa-fleck ${isGeode ? "gem" : isSeam ? "ore" : ""}`}
            x={(cx + (jit(i * 5 + f, 9) - 0.5) * rx).toFixed(1)}
            y={(cy + (jit(i * 5 + f, 10) - 0.5) * ry).toFixed(1)}
            width="2"
            height="2"
            style={{ animationDelay: `${(jit(i * 3 + f, 11) * 2.4).toFixed(2)}s` }}
          />,
        );
      }
    }
  }
  const gx = geode.c * w + w / 2 - w * 0.1;
  const gy = 10 + geode.r * h + h / 2;
  return (
    <svg className="qa-art" viewBox="0 0 340 100" aria-hidden>
      <defs>
        <radialGradient id="qa-lamp" cx="18%" cy="90%" r="85%">
          <stop offset="0" stopColor="#5a3d22" stopOpacity="0.9" />
          <stop offset="1" stopColor="#141226" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="340" height="100" fill="#141226" />
      <rect width="340" height="100" fill="url(#qa-lamp)" />
      {rocks}
      {glints}
      <g className="qa-star" transform={`translate(${gx.toFixed(1)} ${(gy - 4).toFixed(1)})`}>
        <path d="M0 -7 Q0 0 7 0 Q0 0 0 7 Q0 0 -7 0 Q0 0 0 -7Z" />
      </g>
      <rect y="94" width="340" height="6" fill="#2a2018" />
    </svg>
  );
}

/** Four rules, each a little picture on a 12×12 grid. */
const RULES: { icon: string; title: string; sub: string; tone?: string }[] = [
  {
    // A pick: the haft from bottom left, the head across the top.
    icon: "M2 9h1v1h-1zM3 8h1v1h-1zM4 7h1v1h-1zM5 6h1v1h-1zM6 5h1v1h-1z|M3 2h7v1h-7zM2 3h2v1h-2zM9 3h2v1h-2zM6 3h2v2h-2z",
    title: "Tap or hold",
    sub: "Hold to hit harder",
  },
  {
    // A rock, and glints on it.
    icon: "M3 3h6v1h-6zM2 4h8v4h-8zM3 8h6v1h-6z|M4 5h1v1h-1zM7 4h1v1h-1zM6 7h1v1h-1zM9 1h1v1h-1z",
    title: "Find the glint",
    sub: "The seam shines through",
    tone: "ore",
  },
  {
    // A rock dropping into a gap, with a crack.
    icon: "M3 0h6v4h-6z|M5 5h2v2h-2zM3 7h6v1h-6zM4 8h4v1h-4zM5 9h2v1h-2z|M0 11h12v1h-12z",
    title: "Mind the drop",
    sub: "Falling rocks crush finds",
    tone: "bad",
  },
  {
    // A cut gem.
    icon: "M4 2h4v1h-4zM3 3h6v2h-6zM4 5h4v2h-4zM5 7h2v2h-2z|M4 3h1v1h-1z",
    title: "Gems sparkle",
    sub: `Rare · ${STALL_GEM_PRICE}g at the stall`,
    tone: "gem",
  },
];

function RuleIcon({ d, tone }: { d: string; tone?: string }) {
  const [a, b, c] = d.split("|");
  return (
    <svg className={`qa-icon ${tone ?? ""}`} viewBox="0 0 12 12" width="34" height="34" shapeRendering="crispEdges" aria-hidden>
      <path className="p1" d={a} />
      {b && <path className="p2" d={b} />}
      {c && <path className="p3" d={c} />}
    </svg>
  );
}

function Finds() {
  return (
    <div className="qa-finds" aria-label="What the face gives, commonest first">
      {FINDS.map((k) => (
        <div key={k} className={`qa-find ${k}`}>
          <ThingIcon icon={resourceIcon(k)} size={30} />
          <strong>{k === "gem" ? "Gem" : k[0].toUpperCase() + k.slice(1)}</strong>
          <small style={{ color: MINE_RARITY[k].color }}>{MINE_RARITY[k].label}</small>
        </div>
      ))}
    </div>
  );
}

export function QuarryIntro({ status, outing, paid, xp, busy, error, onStart, onClose }: {
  status: GatherStatus | null;
  /** The quarry outing that just ended, to show what came of it; null before a run. */
  outing: GatherView | null;
  paid: Resources | null;
  xp: XpResult | null;
  busy: boolean;
  error: string | null;
  onStart(): void;
  onClose(): void;
}) {
  const left = status?.stamina.left ?? 0;
  const max = status?.stamina.max ?? 3;
  const over = outing && outing.status !== "active" ? outing : null;
  const rocks = over?.mine?.rocks ?? [];
  const broken = rocks.filter((r) => r.broken && !r.lost).length;
  const smashed = rocks.filter((r) => r.lost).length;
  const lostOre = rocks.filter((r) => r.lost && (r.kind === "seam" || r.kind === "geode")).length;

  return (
    <div className="overlay quarry-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="quarry-intro" role="dialog" aria-label="The quarry">
        <FaceArt />
        <button className="small qa-close" onClick={onClose} aria-label="Close">✕</button>
        <header className="qa-head">
          <h2>{over ? "Hauled out" : "The Quarry"}</h2>
          <span className="qa-sub">{over ? `${broken === 0 ? "Nothing broken" : broken === 1 ? "1 rock broken" : `${broken} rocks broken`}${smashed ? ` · ${smashed} lost to falls` : ""}` : `${Math.round(MINE_MS / 1000)} seconds to find the seam`}</span>
        </header>

        {over ? (
          <div className="qa-result">
            <ResourceChips resources={paid ?? over.payout} />
            {lostOre > 0 && <p className="bad">{lostOre === 1 ? "A piece of the seam was lost to a fall." : `${lostOre} pieces of the seam were lost to falls.`}</p>}
            {xp?.text && <p className={xp.granted > 0 ? "xp-gain" : "muted"}>{xp.text}</p>}
          </div>
        ) : (
          <>
            <ul className="qa-rules">
              {RULES.map((r) => (
                <li key={r.title} className={r.tone ?? ""}>
                  <RuleIcon d={r.icon} tone={r.tone} />
                  <span>
                    <strong>{r.title}</strong>
                    <small>{r.sub}</small>
                  </span>
                </li>
              ))}
            </ul>
            <Finds />
          </>
        )}

        {error && <p className="bad qa-error">{error}</p>}

        <footer className="qa-foot">
          <span className="qa-stamina" title={`${left} of ${max} outings left today`}>
            <StaminaBolts left={left} max={max} size={20} />
          </span>
          <span className="spacer" />
          {over && <button onClick={onClose}>Done</button>}
          {left > 0 ? (
            <button className="primary big" disabled={busy || !status} onClick={onStart} autoFocus>
              {over ? "Dig again" : "Dig in"} <span className="qa-cost">−1 ⚡</span>
            </button>
          ) : (
            <span className="muted qa-tired">Worn out today. Rest or eat to go again.</span>
          )}
        </footer>
      </section>
    </div>
  );
}
