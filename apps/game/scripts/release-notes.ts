// Release notes from git: every `game-v*` tag is a release, and its notes are
// the commits between it and the tag before it.
//
// Used two ways:
//   - by the Vite plugin below, which hands the list to the game as
//     `virtual:release-notes` (see src/releases.ts) at build and dev time;
//   - from the command line, by the production deploy, to write the GitHub
//     release for a tag:  node apps/game/scripts/release-notes.ts --markdown game-v2026.11.13.9
//
// A commit makes a line when it changes code that ships in the game (the
// game's src, public and audio, and the world and core packages, tests left
// out), so CI, docs and test-only commits stay off the board. Its subject is
// the line, without the "(#123)" GitHub adds; "Felling: chops cut a notch"
// becomes the area "Felling" and the text "Chops cut a notch".
//
// A commit (or the PR description it was squashed from) can say better with a
// trailer line in its message:
//   Release-note: Fishing pays out a little more on a perfect catch.
//   Release-note: skip
// Several Release-note lines make several lines; "skip" leaves it out.
// Commits already merged are corrected in release-note-overrides.ts instead.
//
// Needs the whole history and the tags (actions/checkout with fetch-depth: 0).
// Without git it returns no releases rather than failing the build.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import type { Release, ReleaseNote } from "../src/releases.ts";
import { OVERRIDES } from "./release-note-overrides.ts";

const TAG_GLOB = "game-v*";
/** Code that ships in the game, from the repository root. */
const SHIPPED = /^(apps\/game\/(src|public|audio)\/|apps\/game\/index\.html$|packages\/(world|core)\/src\/)/;
const TEST = /(\.test\.[cm]?[jt]sx?$|(^|\/)(test|tests|__tests__)\/)/;
/** The most releases a build carries; older ones drop off the board. */
const KEEP = 40;

export interface ReadOptions {
  /** Any directory inside the repository. */
  cwd?: string;
  /** Add a "Coming next" release for shipped commits after the newest tag. */
  unreleased?: boolean;
}

function git(cwd: string | undefined, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One line from a commit subject or a Release-note trailer. */
export function noteFrom(line: string): ReleaseNote | null {
  const text = line.replace(/\s*\(#\d+\)\s*$/, "").trim();
  if (!text) return null;
  // "Felling: chops cut a notch" names its area; a long run-up before the colon is a sentence, not an area.
  const m = /^([A-Za-z][\w' -]{0,23}):\s+(.+)$/.exec(text);
  if (m && m[1].trim().split(/\s+/).length <= 3) return { area: m[1].trim(), text: capital(m[2].trim()) };
  return { area: null, text: capital(text) };
}

interface Commit {
  /** Full hash, to look up an override. */
  hash?: string;
  subject: string;
  body: string;
  files: string[];
}

/** What one commit adds to its release's notes: nothing, its subject, or its Release-note lines. */
export function notesFor(c: Commit, overrides: Record<string, string[]> = OVERRIDES): ReleaseNote[] {
  const fixed = c.hash ? overrides[c.hash] : undefined;
  if (fixed) return fixed.map(noteFrom).filter((n): n is ReleaseNote => !!n);
  if (/^(Revert|Merge|Bump) /.test(c.subject)) return [];
  const trailers = [...c.body.matchAll(/^Release-note:[ \t]*(.*)$/gim)].map((m) => m[1].trim());
  if (trailers.some((t) => /^skip\.?$/i.test(t))) return [];
  if (trailers.length > 0) return trailers.map(noteFrom).filter((n): n is ReleaseNote => !!n);
  if (!c.files.some((f) => SHIPPED.test(f) && !TEST.test(f))) return [];
  const note = noteFrom(c.subject);
  return note ? [note] : [];
}

/** Commits in a range, oldest first. */
function commits(cwd: string | undefined, range: string): Commit[] {
  // Each commit: RS, hash, US, subject, US, body, GS, then --name-only's file list.
  const out = git(cwd, ["log", "--no-merges", "--reverse", "--name-only", "--format=%x1e%H%x1f%s%x1f%B%x1d", range]);
  return out
    .split("\x1e")
    .slice(1)
    .map((chunk) => {
      const [head, files = ""] = chunk.split("\x1d");
      const [hash, subject, body = ""] = head.split("\x1f");
      return { hash: hash.trim(), subject: subject.trim(), body, files: files.split("\n").map((f) => f.trim()).filter(Boolean) };
    });
}

/** Every release reachable from HEAD, newest first. */
export function readReleases(opts: ReadOptions = {}): Release[] {
  const { cwd } = opts;
  const tags = git(cwd, ["tag", "--list", TAG_GLOB, "--merged", "HEAD", "--sort=v:refname"]).split("\n").map((t) => t.trim()).filter(Boolean);
  const dateOf = (ref: string) => git(cwd, ["log", "-1", "--format=%cI", ref]).trim();

  const releases: Release[] = tags.map((tag, i) =>
    i === 0
      ? { id: tag, date: dateOf(tag), notes: [], first: true }
      : { id: tag, date: dateOf(tag), notes: commits(cwd, `${tags[i - 1]}..${tag}`).flatMap((c) => notesFor(c)) },
  );

  if (opts.unreleased) {
    const range = tags.length > 0 ? `${tags.at(-1)}..HEAD` : "HEAD";
    const notes = commits(cwd, range).flatMap((c) => notesFor(c));
    if (notes.length > 0) {
      const head = git(cwd, ["rev-parse", "--short", "HEAD"]).trim();
      releases.push({ id: `next-${head}`, date: dateOf("HEAD"), notes, unreleased: true });
    }
  }
  return releases.reverse().slice(0, KEEP);
}

/** readReleases, or none (with a warning) when there is no git or no history to read. */
export function readReleasesSafely(opts: ReadOptions = {}, warn: (msg: string) => void = console.warn): Release[] {
  try {
    return readReleases(opts);
  } catch (e) {
    warn(`release notes: could not read git history, so the notice board will be empty (${(e as Error).message.split("\n")[0]})`);
    return [];
  }
}

/** One release as Markdown, for a GitHub release. */
export function releaseMarkdown(r: Release): string {
  if (r.first) return "The first release of The Harbor of Heylets.\n";
  if (r.notes.length === 0) return "Fixes and small changes behind the scenes.\n";
  return r.notes.map((n) => `- ${n.area ? `**${n.area}:** ` : ""}${n.text}`).join("\n") + "\n";
}

const VIRTUAL = "virtual:release-notes";
/** This script's folder: inside the repository wherever the build runs from. */
const HERE = fileURLToPath(new URL(".", import.meta.url));

/**
 * The Vite plugin: `import { RELEASES } from "virtual:release-notes"` in the
 * client or the Worker. Development and staging builds also list the commits
 * not yet tagged, as "Coming next"; production lists tagged releases only.
 */
export function releaseNotes(opts: { unreleased?: boolean } = {}): Plugin {
  const resolved = "\0" + VIRTUAL;
  let json: string | null = null;
  return {
    name: "gantt-quest:release-notes",
    resolveId: (id) => (id === VIRTUAL ? resolved : undefined),
    load(id) {
      if (id !== resolved) return undefined;
      json ??= JSON.stringify(readReleasesSafely({ cwd: HERE, unreleased: opts.unreleased ?? process.env.CLOUDFLARE_ENV !== "production" }, (m) => this.warn(m)));
      return `export const RELEASES = ${json};`;
    },
  };
}

// ---------- command line ----------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--markdown");
  if (at >= 0) {
    const tag = args[at + 1];
    // Fails loudly here: a deploy that cannot read the history should say so.
    const release = readReleases({ cwd: HERE }).find((r) => r.id === tag);
    if (!release) {
      console.error(`No release ${tag} reachable from HEAD.`);
      process.exit(1);
    }
    process.stdout.write(releaseMarkdown(release));
  } else {
    process.stdout.write(JSON.stringify(readReleases({ cwd: HERE, unreleased: args.includes("--unreleased") }), null, 2) + "\n");
  }
}
