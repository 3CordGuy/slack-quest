// Redraw an item icon: a 16x16 pixel editor (paint, erase, pick a colour,
// undo), with "start from the code art" and PNG upload into the same grid.
// Magenta and dark purple are the rarity markers: they are drawn in the
// item's rarity colour and its shade. The preview uses the game's own icon
// code, at every rarity and as the empty-slot silhouette.

import { useEffect, useRef, useState } from "react";
import { RARITIES, RARITY_COLOR } from "@gantt-quest/world";
import type { ImageValue } from "../../server/content";
import { decodeIcon, encodeIcon } from "../art";
import { ART_PIXELS, ICON_SIZE, MARKER_ACCENT, MARKER_SHADE, codeIconPixels, previewIconUrl, type IconPixels } from "../itemArt";
import { adminApi } from "./adminApi";
import { History, useRunner, type EditorProps } from "./shared";

const N = ICON_SIZE;
/** Mirrors the server's limit so a too-big upload is refused before sending. */
const PNG_MAX_BYTES = 4096;

const BASE_COLOURS = ["#c9d1dc", "#f1f5fa", "#8b95a5", "#8a5a2b", "#5a3d22", "#a0683a", "#6b4a2b", "#e0b12e", "#e8dcc0", "#eee6cf", "#2a2740", "#b9433d", "#3d7a4f", "#4b5fd1"];

type Tool = "paint" | "erase" | "pick";

const toHex = (p: IconPixels, i: number) => `#${[p[i], p[i + 1], p[i + 2]].map((n) => n.toString(16).padStart(2, "0")).join("")}`;

/** The distinct opaque colours in an icon, markers excluded, for the palette. */
function coloursIn(p: IconPixels): string[] {
  const out = new Set<string>();
  for (let i = 0; i < p.length; i += 4) if (p[i + 3] >= 128) out.add(toHex(p, i));
  out.delete(MARKER_ACCENT);
  out.delete(MARKER_SHADE);
  return [...out];
}

/** Read an uploaded file as a 16x16 icon, or explain why not. */
async function readUpload(file: File): Promise<{ png: string; pixels: IconPixels } | { error: string }> {
  if (file.type !== "image/png") return { error: "Upload a PNG." };
  if (file.size > PNG_MAX_BYTES) return { error: `That PNG is ${file.size} bytes; the most is ${PNG_MAX_BYTES}.` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = btoa(String.fromCharCode(...bytes));
  const pixels = await decodeIcon(png);
  if (!pixels) return { error: `The icon must be exactly ${N}×${N} pixels.` };
  return { png, pixels };
}

export function IconEditor({ name, current, usedBy, ...props }: { name: string; current: ImageValue | undefined; usedBy: string[] } & EditorProps) {
  const [pixels, setPixels] = useState<IconPixels | null>(null);
  const [saved, setSaved] = useState<IconPixels | null>(null);
  const [undo, setUndo] = useState<IconPixels[]>([]);
  const [tool, setTool] = useState<Tool>("paint");
  const [colour, setColour] = useState(MARKER_ACCENT);
  const [dirty, setDirty] = useState(false);
  const { busy, run } = useRunner(props);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** The drag in progress: the icon before it (for undo), the pixels so far, and the last cell painted. */
  const stroke = useRef<{ before: IconPixels; work: IconPixels; last: [number, number] | null } | null>(null);

  // Start from the override in force, else the code-drawn art.
  useEffect(() => {
    let live = true;
    (async () => {
      const start = current ? await decodeIcon(current.png) : null;
      if (!live) return;
      setSaved(start);
      setPixels(new Uint8ClampedArray(start ?? codeIconPixels(name)));
      setUndo([]);
      setDirty(false);
    })();
    return () => void (live = false);
  }, [name, current]);

  // Draw the grid: a checkerboard under the pixels so transparency shows.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !pixels) return;
    const ctx = c.getContext("2d")!;
    const cell = c.width / N;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4;
        ctx.fillStyle = (x + y) % 2 ? "#3a3658" : "#2e2b48";
        ctx.fillRect(x * cell, y * cell, cell, cell);
        if (pixels[i + 3] >= 128) {
          ctx.fillStyle = toHex(pixels, i);
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    for (let k = 1; k < N; k++) {
      ctx.beginPath();
      ctx.moveTo(k * cell + 0.5, 0);
      ctx.lineTo(k * cell + 0.5, c.height);
      ctx.moveTo(0, k * cell + 0.5);
      ctx.lineTo(c.width, k * cell + 0.5);
      ctx.stroke();
    }
  }, [pixels]);

  function replace(next: IconPixels) {
    if (pixels) setUndo((u) => [...u.slice(-49), pixels]);
    setPixels(next);
    setDirty(true);
  }

  function cellAt(e: React.PointerEvent<HTMLCanvasElement>): [number, number] | null {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * N);
    const y = Math.floor(((e.clientY - r.top) / r.height) * N);
    return x >= 0 && y >= 0 && x < N && y < N ? [x, y] : null;
  }

  /** Paint or erase from the stroke's last cell to this one, so a fast drag leaves no gaps. */
  function apply(e: React.PointerEvent<HTMLCanvasElement>) {
    const cell = cellAt(e);
    const s = stroke.current;
    if (!cell || !s) return;
    const [x1, y1] = cell;
    if (tool === "pick") {
      const i = (y1 * N + x1) * 4;
      if (s.work[i + 3] >= 128) setColour(toHex(s.work, i));
      setTool("paint");
      stroke.current = null;
      return;
    }
    const n = parseInt(colour.slice(1), 16);
    const want = tool === "erase" ? [0, 0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
    const [x0, y0] = s.last ?? cell;
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let k = 0; k <= steps; k++) {
      const t = steps === 0 ? 0 : k / steps;
      const i = (Math.round(y0 + (y1 - y0) * t) * N + Math.round(x0 + (x1 - x0) * t)) * 4;
      s.work.set(want, i);
    }
    s.last = cell;
    setPixels(new Uint8ClampedArray(s.work));
    setDirty(true);
  }

  const save = () => pixels && run(() => adminApi.save("icon", name, { png: encodeIcon(pixels) }), `Saved the ${name} icon.`);

  if (!pixels) return <section className="admin-editor panel"><p className="muted">Loading…</p></section>;

  const palette = [...new Set([...BASE_COLOURS, ...coloursIn(pixels)])];

  return (
    <section className="admin-editor panel">
      <h2>{name}</h2>
      <p className="muted">icon:{name}{usedBy.length ? ` · used by ${usedBy.join(", ")}` : ""}</p>

      <div className="admin-icon-previews">
        {RARITIES.map((r) => (
          <figure key={r}>
            <img src={previewIconUrl(name, pixels, RARITY_COLOR[r])} alt={`${name}, ${r}`} className="pixel" width={ART_PIXELS * 3} height={ART_PIXELS * 3} />
            <figcaption className="muted">{r}</figcaption>
          </figure>
        ))}
        <figure>
          <img src={previewIconUrl(name, pixels, "#8a8f98", true)} alt={`${name}, empty slot`} className="pixel" width={ART_PIXELS * 3} height={ART_PIXELS * 3} />
          <figcaption className="muted">slot</figcaption>
        </figure>
        <figure>
          <img src={previewIconUrl(name, pixels, RARITY_COLOR.rare)} alt="" className="pixel" width={ART_PIXELS} height={ART_PIXELS} />
          <figcaption className="muted">1×</figcaption>
        </figure>
        <figure>
          <img src={previewIconUrl(name, saved, RARITY_COLOR.rare)} alt={`${name} as it is now`} className="pixel" width={ART_PIXELS * 3} height={ART_PIXELS * 3} />
          <figcaption className="muted">now</figcaption>
        </figure>
      </div>

      <div className="admin-pixel-wrap">
        <canvas
          ref={canvas}
          className={`admin-pixels tool-${tool}`}
          width={N * 20}
          height={N * 20}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            stroke.current = { before: pixels, work: new Uint8ClampedArray(pixels), last: null };
            apply(e);
          }}
          onPointerMove={(e) => stroke.current && e.buttons && apply(e)}
          onPointerUp={() => {
            const s = stroke.current;
            stroke.current = null;
            if (s && s.last) setUndo((u) => [...u.slice(-49), s.before]);
          }}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>

      <div className="admin-tools">
        {(["paint", "erase", "pick"] as Tool[]).map((t) => (
          <button key={t} className={`small ${tool === t ? "selected" : ""}`} onClick={() => setTool(t)}>{t === "pick" ? "eyedropper" : t}</button>
        ))}
        <button className="small" disabled={!undo.length} onClick={() => {
          setPixels(undo[undo.length - 1]);
          setUndo((u) => u.slice(0, -1));
          setDirty(true);
        }}>undo</button>
        <button className="small" onClick={() => replace(new Uint8ClampedArray(N * N * 4))}>clear</button>
        <button className="small" onClick={() => replace(new Uint8ClampedArray(codeIconPixels(name)))}>start from default</button>
        <label className="small button-like">
          upload PNG
          <input
            type="file"
            accept="image/png"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const r = await readUpload(file);
              if ("error" in r) props.onError(r.error);
              else replace(new Uint8ClampedArray(r.pixels));
            }}
          />
        </label>
      </div>

      <div className="admin-palette">
        <button className={`admin-chip is-marker ${colour === MARKER_ACCENT ? "selected" : ""}`} style={{ background: MARKER_ACCENT }} title="Rarity colour" onClick={() => (setColour(MARKER_ACCENT), setTool("paint"))}>rarity</button>
        <button className={`admin-chip is-marker ${colour === MARKER_SHADE ? "selected" : ""}`} style={{ background: MARKER_SHADE }} title="Rarity shade" onClick={() => (setColour(MARKER_SHADE), setTool("paint"))}>shade</button>
        {palette.map((c) => (
          <button key={c} className={`admin-chip ${colour === c ? "selected" : ""}`} style={{ background: c }} title={c} onClick={() => (setColour(c), setTool("paint"))} />
        ))}
        <label className="admin-chip custom" title="Any colour">
          <input type="color" value={colour} onChange={(e) => (setColour(e.target.value), setTool("paint"))} />
        </label>
      </div>
      <p className="muted">Paint with <b>rarity</b> and <b>shade</b> for the parts that take the item's rarity colour. The dark outline is added for you.</p>

      <div className="admin-actions">
        <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>Save</button>
        <button disabled={busy || !current} onClick={() => void run(() => adminApi.revert("icon", name), `The ${name} icon is back to its default.`)}>Revert to default</button>
      </div>

      <History<ImageValue>
        kind="icon"
        target={name}
        current={current}
        busy={busy}
        render={(v) => <IconThumb name={name} png={v.png} />}
        onRestore={(v) => void run(() => adminApi.save("icon", name, v), "Restored that version.")}
      />
    </section>
  );
}

/** A stored icon drawn as the game would draw it (rare tint, outline), for history and the change log. */
export function IconThumb({ name, png, size = 36 }: { name: string; png: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    decodeIcon(png).then((px) => live && setUrl(px ? previewIconUrl(name, px, RARITY_COLOR.rare) : null));
    return () => void (live = false);
  }, [name, png]);
  return url ? <img src={url} alt="" className="pixel" width={size} height={size} /> : <span className="muted">(image)</span>;
}
