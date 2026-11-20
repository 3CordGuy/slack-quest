// Every kind of place that has a model, and the function that builds it. The renderer looks a place's kind up
// here (WorldRenderer.poiModel) and draws nothing for a kind that is not listed.
//
// To add a place:
//   1. Write its model, a `PlaceModel` (kit.ts says what it is given and what it may leave for the renderer),
//      in the module for where it stands, or in a new module beside them if it belongs with none of them.
//   2. List its kind here.
//   3. If it is not drawn at the size of its hex, standing a little behind its middle, say how in `PLACE`
//      (placing.ts).
// Three things are still said in WorldRenderer.ts, for the few kinds they are true of: which places are inked
// round as buildings (`BUILDINGS`), which are a hut's plot and stand a little askew (`HUT_KINDS`), and which
// stand in the sea (`buildPois`).

import type { PoiKind } from "@gantt-quest/world";
import { landing, cache, gate, cave, crate, glowcap } from "./maps";
import { lot, site, plot } from "./huts";
import { pub, shop, lapidary } from "./harborTown";
import { works, waygate, townchest, board } from "./harborSquare";
import { workshop } from "./workshops";
import { rocks, wreck, lighthouse } from "./shore";
import { ring, fishing, felling, quarry } from "./gathering";
import { shoals, trader, counter, crew, tide, dice, door } from "./rooms";
import type { PlaceModel, PlaceModels } from "./kit";

export const PLACE_MODELS: PlaceModels = new Map<PoiKind, PlaceModel>([
  ["landing", landing],
  ["cache", cache],
  ["gate", gate],
  ["cave", cave],
  ["crate", crate],
  ["glowcap", glowcap],
  ["lot", lot],
  ["site", site],
  ["plot", plot],
  ["pub", pub],
  ["shop", shop],
  ["lapidary", lapidary],
  ["works", works],
  ["waygate", waygate],
  ["townchest", townchest],
  ["board", board],
  ["apothecary", workshop],
  ["smithy", workshop],
  ["galley", workshop],
  ["rocks", rocks],
  ["wreck", wreck],
  ["lighthouse", lighthouse],
  ["ring", ring],
  ["fishing", fishing],
  ["felling", felling],
  ["quarry", quarry],
  ["shoals", shoals],
  ["trader", trader],
  ["counter", counter],
  ["crew", crew],
  ["tide", tide],
  ["dice", dice],
  ["door", door],
]);
