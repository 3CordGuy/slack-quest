// The pictures on a fight's bar: every class ability has one of its own, not
// shared with any other ability, common action or item from the pack.

import { describe, expect, it } from "vitest";
import { ABILITY_POOLS } from "@gantt-quest/world";
import { ACTION_ART } from "../src/client/actionArt";
import { ABILITY_ICON, COMMON_ICON, ITEM_ICON } from "../src/client/zone/actionIcons";

describe("class ability icons", () => {
  const classAbilities = [...new Set(Object.values(ABILITY_POOLS).flatMap((pool) => pool.map((e) => e.id)))];

  it("each has a drawing", () => {
    for (const id of classAbilities) expect(ACTION_ART[ABILITY_ICON[id]?.name], id).toBeTypeOf("function");
  });

  it("no drawing of a class ability is used for anything else", () => {
    const uses = new Map<string, string[]>();
    const add = (name: string, who: string) => uses.set(name, [...(uses.get(name) ?? []), who]);
    for (const [id, icon] of Object.entries(ABILITY_ICON)) add(icon.name, id);
    for (const [id, icon] of Object.entries(COMMON_ICON)) add(icon.name, `common:${id}`);
    for (const [id, icon] of Object.entries(ITEM_ICON)) add(icon.name, `item:${id}`);
    for (const id of classAbilities) expect(uses.get(ABILITY_ICON[id].name), id).toEqual([id]);
  });
});
