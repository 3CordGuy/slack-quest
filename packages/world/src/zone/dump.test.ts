// Temporary: prints maps as text to look at while the generator is written.
import { it } from "vitest";
import { posKey } from "@gantt-quest/core";
import { layZone } from "./lay";
import { zoneOptions } from "./gen";
import { propOf } from "./props";

const GLYPH: Record<string, string> = { wall: "#", wall_broken: "%", tower: "O", arch: "A", pillar: "I", pillar_broken: "i", statue: "S", obelisk: "!", altar: "a", well: "w", stairs: "=", brazier: "*", campfire: "*", tent: "^", palisade: "|", cart: "c", banner: "f", barrels: "b", standing_stone: "T", boulder: "o", ribs: ")", skull: "@", crystal: "+", ice_spire: "+", dead_tree: "t", great_tree: "Y", mushrooms: "m", stilt_hut: "H", basalt: "B", waygate: "G", wall_torch: "&", throne: "Q", bookshelf: "B", table: "n", weapon_rack: "r", cage: "c", sarcophagus: "s", rug: "-", stalagmite: "^", bones: "," };

it("dumps", () => {
  const which = (process.env.DUMP ?? "keep:greenwood:medium:1").split(",");
  for (const one of which) {
    const [site, clime, size, seed] = one.split(":");
    const plan = layZone(`dump-${seed}`, zoneOptions({ size, biome: "meadow", groups: 4, elevation: 2, obstacles: 1, clear: 4, party: 2, site, clime, tier: 3 }));
    const tiles = new Map(plan.map.tiles.map((t) => [posKey(t), t]));
    const posts = new Map<string, string>();
    plan.groups.forEach((g, i) => g.posts.forEach((p) => posts.set(posKey(p), String(i + 1))));
    const chests = new Set(plan.map.pois.map((p) => posKey(p.pos)));
    const lines: string[] = [];
    for (let r = 0; r < plan.map.grid.rows; r++) {
      let line = r % 2 ? " " : "";
      for (let c = 0; c < plan.map.grid.cols; c++) {
        const p = { q: c - Math.floor(r / 2), r };
        const t = tiles.get(posKey(p));
        let ch = " ";
        if (t) {
          const e = t.elev ?? 0;
          ch = t.biome === "rock" ? "#" : t.biome === "water" ? "~" : t.biome === "forest" ? "\"" : t.biome === "dock" ? "=" : e === 0 ? "." : String(e);
          if (t.prop) ch = GLYPH[t.prop] ?? "?";
          if (t.ladder) ch = "L";
        }
        if (chests.has(posKey(p))) ch = "$";
        if (posts.has(posKey(p))) ch = posts.get(posKey(p))!;
        if (p.q === plan.start.q && p.r === plan.start.r) ch = "X";
        line += ch + " ";
      }
      lines.push(line);
    }
    const blocked = plan.map.tiles.filter((t) => propOf(t)?.blocks).length;
    console.log(`\n=== ${one} site=${plan.scene.site} backdrop=${plan.scene.backdrop} tiles=${plan.map.tiles.length} props=${blocked} groups=${plan.groups.map((g) => g.kinds.join("+")).join(" | ")} chests=${plan.map.pois.length}\n${lines.join("\n")}`);
  }
});
