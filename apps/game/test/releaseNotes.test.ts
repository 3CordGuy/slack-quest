// Release notes read out of git: a throwaway repository with a few tagged
// releases, and the rules for which commits make a line.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noteFrom, notesFor, readReleases, releaseMarkdown } from "../scripts/release-notes.ts";
import { hasUnseen, releaseTitle, unseenCount, type Release } from "../src/releases";

describe("noteFrom", () => {
  it("takes the area off the front and the PR number off the end", () => {
    expect(noteFrom("Felling: chops cut a notch, and splits fill a pile (#372)")).toEqual({ area: "Felling", text: "Chops cut a notch, and splits fill a pile" });
    expect(noteFrom("Buildings hide heroes standing behind them (#371)")).toEqual({ area: null, text: "Buildings hide heroes standing behind them" });
  });

  it("does not mistake a long lead-in for an area", () => {
    expect(noteFrom("When the tide is out and nobody is looking: fish bite")?.area).toBeNull();
  });
});

describe("notesFor", () => {
  const game = ["apps/game/src/client/App.tsx"];
  it("lists commits that change shipped game code", () => {
    expect(notesFor({ subject: "Quarry: gems (#1)", body: "", files: game })).toEqual([{ area: "Quarry", text: "Gems" }]);
    expect(notesFor({ subject: "Rules", body: "", files: ["packages/world/src/gather.ts"] })).toHaveLength(1);
  });

  it("leaves out tests, docs, CI and other apps", () => {
    for (const files of [["packages/world/src/gather.test.ts"], ["apps/game/test/art.test.ts"], ["docs/x.md"], [".github/workflows/ci.yml"], ["apps/web/src/main.tsx"]]) {
      expect(notesFor({ subject: "Something", body: "", files })).toEqual([]);
    }
  });

  it("follows Release-note trailers", () => {
    expect(notesFor({ subject: "Big change", body: "Words.\n\nRelease-note: skip\n", files: game })).toEqual([]);
    expect(notesFor({ subject: "Big change", body: "Release-note: Fishing: bigger fish\nrelease-note: Smaller boats\n", files: ["docs/x.md"] })).toEqual([
      { area: "Fishing", text: "Bigger fish" },
      { area: null, text: "Smaller boats" },
    ]);
  });

  it("leaves out reverts", () => {
    expect(notesFor({ subject: 'Revert "Quarry: gems"', body: "", files: game })).toEqual([]);
  });
});

describe("readReleases", () => {
  let repo: string;
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  const commit = (subject: string, file: string, body = "") => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), `${subject}\n${Math.random()}`);
    run("add", "-A");
    run("commit", "-q", "-m", subject, ...(body ? ["-m", body] : []));
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "release-notes-"));
    run("init", "-q", "-b", "main");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    run("config", "commit.gpgsign", "false");
    run("config", "tag.gpgsign", "false");
    commit("The game", "apps/game/src/a.ts");
    run("tag", "game-v2026.11.12");
    commit("Fishing: bigger fish (#2)", "packages/world/src/fish.ts");
    commit("Tests for fish", "packages/world/src/fish.test.ts");
    run("tag", "game-v2026.11.13");
    commit("Docs only", "docs/readme.md");
    run("tag", "game-v2026.11.13.2");
    commit("Pub: a contract dealer (#3)", "apps/game/src/client/PubView.tsx");
    run("tag", "other-v1");
    commit("Stall: cheaper boots", "apps/game/src/b.ts", "Release-note: The stall sells boots for less.");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("makes one release per tag, newest first, from the commits since the last", () => {
    const list = readReleases({ cwd: repo });
    expect(list.map((r) => r.id)).toEqual(["game-v2026.11.13.2", "game-v2026.11.13", "game-v2026.11.12"]);
    expect(list[0].notes).toEqual([]);
    expect(list[1].notes).toEqual([{ area: "Fishing", text: "Bigger fish" }]);
    expect(list[2]).toMatchObject({ first: true, notes: [] });
  });

  it("adds what is not tagged yet only when asked", () => {
    const list = readReleases({ cwd: repo, unreleased: true });
    expect(list[0]).toMatchObject({ unreleased: true, notes: [{ area: "Pub", text: "A contract dealer" }, { area: null, text: "The stall sells boots for less." }] });
    expect(list[0].id).toMatch(/^next-[0-9a-f]+$/);
    expect(list).toHaveLength(4);
  });

  it("writes Markdown for a GitHub release", () => {
    const [, fish, first] = readReleases({ cwd: repo });
    expect(releaseMarkdown(fish)).toBe("- **Fishing:** Bigger fish\n");
    expect(releaseMarkdown(first)).toMatch(/first release/);
  });
});

describe("what a player has seen", () => {
  const r = (id: string): Release => ({ id, date: "2026-11-13T00:00:00Z", notes: [] });
  const list = [r("game-v2026.11.13.3"), r("game-v2026.11.13.2"), r("game-v2026.11.13")];

  it("shows the mark until the newest is read", () => {
    expect(hasUnseen(null, list)).toBe(true);
    expect(hasUnseen("game-v2026.11.13", list)).toBe(true);
    expect(hasUnseen("game-v2026.11.13.3", list)).toBe(false);
    expect(hasUnseen(null, [])).toBe(false);
  });

  it("marks the releases since the one last read, or only the newest for a first read", () => {
    expect(unseenCount("game-v2026.11.13", list)).toBe(2);
    expect(unseenCount("game-v2026.11.13.3", list)).toBe(0);
    expect(unseenCount(null, list)).toBe(1);
    expect(unseenCount("gone", list)).toBe(1);
  });

  it("titles a release by its date and update number", () => {
    expect(releaseTitle(r("game-v2026.11.13.9"))).toBe("13 November 2026 · update 9");
    expect(releaseTitle(r("game-v2026.11.13"))).toBe("13 November 2026");
    expect(releaseTitle({ ...r("next-abc"), unreleased: true })).toBe("Coming next");
  });
});
