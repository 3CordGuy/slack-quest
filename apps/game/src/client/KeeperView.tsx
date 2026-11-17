// Inside the smithy, the apothecary or the galley: a small room drawn by the
// same renderer as the pub and the huts, with the keeper at their work (Greta
// hammering at her anvil, Ansel stirring his cauldron, Gorm chopping at his
// block), and still at it while they deal with you. Walk up to them (or click them) to see what they
// sell and do, and to haggle. The door at the front leads back to the Harbor.
//
// Unlike the pub, nobody else is in here: the room is this player's own copy
// and the walking is worked out in the browser (the rules are still
// packages/world/src/keepers.ts). Everything that costs anything goes
// through the server, as before.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { hexNeighbors, type HexPos } from "@gantt-quest/core";
import { KEEPER_GRID, KEEPER_PLACES, keeperPath, keeperRoom, keeperWallPieces, outfitOf, type KeeperShop } from "@gantt-quest/world";
import { api, type ApothecaryView, type GalleyKeeperView, type Me, type SmithyView } from "./api";
import { useAudioScene } from "./audio/useAudioScene";
import { InventoryScreen } from "./InventoryScreen";
import { toOwned } from "./items";
import { Logbook } from "./Logbook";
import { OptionsMenu } from "./OptionsMenu";
import { audio } from "./audio/engine";
import { SpellFx } from "./render/SpellFx";
import { WorldRenderer, hexToWorld, type RenderState } from "./render/WorldRenderer";
import { withLook } from "./render/sprites";
import { TileAction } from "./TileAction";
import { HudBar } from "./ui/Hud";
import { ApothecaryKeeperPanel, GalleyKeeperPanel, SmithyKeeperPanel } from "./works/KeeperPanels";
import "./hut.css";
import "./pub.css";

const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;

export function KeeperView({ shop, me, refresh, onLeave }: { shop: KeeperShop; me: Me; refresh(): Promise<unknown>; onLeave(): void }) {
  useAudioScene("hut");
  const place = KEEPER_PLACES[shop];
  const { keeper } = place;
  const room = useMemo(() => keeperRoom(shop), [shop]);
  const door = useMemo(() => room.pois.find((p) => p.kind === "door")!.pos, [room]);
  const c = me.character!;
  const you = me.player.id;

  const mount = useRef<HTMLDivElement>(null);
  const renderer = useRef<WorldRenderer | null>(null);
  const [hover, setHover] = useState<HexPos | null>(null);
  /** Where you stand. You come in at the door. */
  const [pos, setPos] = useState<HexPos>(door);
  const posRef = useRef(pos);
  posRef.current = pos;

  /** The shop as the server has it: what is for sale, what your gear would cost to work, and what you hold. */
  const [view, setView] = useState<ApothecaryView | SmithyView | GalleyKeeperView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(
    () => (shop === "apothecary" ? api.apothecary() : shop === "smithy" ? api.smithy() : api.galley()).then(setView, (e: Error) => setLoadError(e.message)),
    [shop],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  /** What you are wearing, for how you are drawn. */
  const outfit = useMemo(() => withLook(outfitOf(me.inventory.map(toOwned).filter((i) => i.equipped)), c.appearance), [me.inventory, c.appearance]);

  const scene = useMemo<RenderState>(
    () => ({
      code: shop,
      you,
      phase: "overworld",
      round: 0,
      map: room,
      heroes: [
        { id: you, classId: c.class_id, pos, label: c.name, outfit, level: c.level, xp: c.xp },
        // The keeper stands among their work and is drawn like anyone else.
        { id: keeper.id, classId: keeper.look, pos: place.keeperPos, label: keeper.name },
      ],
      turn: null,
      story: null,
      npcs: {},
      freeRoam: true,
      indoors: true,
      // Every keeper keeps the lamp out and the shop dim, lit in pools with dark between: the apothecary by candles,
      // the cauldron's fire and the green glow of the brew; the smithy by the forge, a lantern and a candle; the
      // galley by the range's fire, and candles and a lantern round the walls.
      lampOff: true,
      gloom: true,
      // Each shop's walls dressed to its trade: rough stone and sooted timber; green wainscot and old printed paper;
      // oxblood boards, a row of tiles and limewash.
      walls: shop,
      // A forge stands on stone: the smithy is flagged; the apothecary and the galley keep their boards.
      floor: shop === "smithy" ? "flags" : "planks",
      props: [
        ...place.fittings.map((f) => ({ id: f.id, model: f.model, pos: { q: f.q, r: f.r }, facing: f.facing, x: f.x, z: f.z })),
        // What hangs on the walls (the smith's weapons), each on its wall hex's side facing the room.
        ...keeperWallPieces(shop).map((w) => ({ id: w.id, model: w.model, pos: w.pos, facing: w.side, mount: true, x: 0, y: w.y })),
      ],
    }),
    [shop, you, room, c.class_id, c.name, c.level, c.xp, pos, outfit, keeper, place],
  );
  const latest = useRef(scene);
  latest.current = scene;

  /** Walk to a hex, if there is a way there. The renderer plays the walk once React has moved you. */
  const walk = useRef((_to: HexPos) => {});
  walk.current = (to) => {
    const path = keeperPath(shop, room, posRef.current, to);
    if (!path) return;
    setPos(path[path.length - 1]);
    queueMicrotask(() => renderer.current?.playEvents([{ t: "moved", heroId: you, path }]));
  };

  useEffect(() => {
    const r = new WorldRenderer(mount.current!, {
      // Clicking the keeper walks you up to stand in front of them.
      onHexClick: (to) => walk.current(same(to, place.keeperPos) ? place.stand : to),
      onHover: setHover,
    });
    renderer.current = r;
    r.setState(latest.current);
    const sparks = new SpellFx(r);
    // The keeper at their work the whole time, you there or not: Greta's hammer rings on the anvil about once a
    // second, with a spray of sparks off the work as it lands; Ansel goes round and round his cauldron; Gorm's
    // cleaver comes down on his block, the same blow as the hammer's with an edge on it, and a thump for a ring.
    const { how } = place.work;
    const piece = place.fittings.find((f) => f.id === place.work.fitting)!;
    const spot = hexToWorld(piece);
    const at = { x: spot.x + (piece.x ?? 0), z: spot.z + (piece.z ?? 0) };
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };
    // A blow about once a second; a stir runs half a minute, asked again just before it ends.
    const beat = how === "stir" ? 29_000 : how === "chop" ? 1300 : 1150;
    const go = () => {
      const wait = r.work(keeper.id, how === "stir" ? "stir" : "hammer", at);
      if (how !== "stir" && wait > 0) {
        later(() => {
          // Off the work on the anvil's face, which stands on the floor (its top, not 0). A cleaver strikes no sparks.
          if (how === "hammer") sparks.burst(new THREE.Vector3(at.x, r.floorTop() + 0.47, at.z), "#ffb84a", 7);
          audio.play(how === "hammer" ? "gather.pick" : "gather.chop", { at });
        }, wait * 1000);
      }
      // Now and then a breath between blows, so it is not a metronome (the cook stops to line up the next fish
      // more often than the smith stops at all). A stir just goes round and round.
      later(go, how === "stir" ? beat : beat + (Math.random() < (how === "chop" ? 0.35 : 0.2) ? 900 : Math.random() * 200));
    };
    later(go, 600);
    return () => {
      for (const t of timers) clearTimeout(t);
      sparks.dispose();
      r.dispose();
      renderer.current = null;
    };
  }, [place, keeper]);
  useEffect(() => {
    renderer.current?.setState(scene);
  }, [scene]);

  const atDoor = same(pos, door);
  const atKeeper = same(pos, place.stand);
  // Walking up to the keeper: a word of greeting.
  useEffect(() => {
    if (atKeeper) renderer.current?.say(keeper.id, keeper.hello);
  }, [atKeeper, keeper]);
  const say = useCallback((text: string) => renderer.current?.say(keeper.id, text), [keeper]);
  /** Dealing with the keeper: their panel is up, and the hotbar is put away so the list has the screen. */
  const dealing = !!view?.built && atKeeper;
  const panel = { reload, refresh, onSay: say, onDone: () => stepAway() };
  // While dealing, the camera brings the keeper clear of the panel so you can watch them work: to the right of it
  // on a wide screen (the panel is on the left), above it on a phone (it is docked along the bottom). Stepping
  // away puts the camera back on the middle of the room.
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    const k = place.keeperPos;
    const phone = typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches;
    r.lookAt(dealing ? (phone ? { q: k.q - 2, r: k.r + 3 } : { q: k.q - 1, r: k.r }) : { q: k.q, r: k.r + 1 });
  }, [dealing, place]);
  /** Step back from the keeper onto the floor beside the counter, toward the room: the panel goes, the hotbar comes back. */
  const stepAway = () => {
    const away = hexNeighbors(place.stand, KEEPER_GRID).filter((n) => !same(n, place.keeperPos) && keeperPath(shop, room, place.stand, n));
    away.sort((a, b) => b.r - a.r);
    if (away[0]) walk.current(away[0]);
  };

  const [bag, setBag] = useState(false);
  const [book, setBook] = useState(false);
  // The bag can change what is carried (and so what the smith can work on): read the shop again when it shuts.
  const closeBag = () => {
    setBag(false);
    void reload();
  };

  const tip = !hover ? null
    : same(hover, place.keeperPos) ? `${keeper.name}, ${keeper.trade}. Click to walk up.`
    : same(hover, place.stand) ? `Where you stand to deal with ${keeper.short}`
    : same(hover, door) ? "The door back to the Harbor"
    : null;
  const refused = loadError ?? (view && !view.built ? `The crew has not built ${place.title.toLowerCase()} yet. It is a crew project at the works.` : null);

  return (
    <div className={`run hut-view keeper-view keeper-view-${shop}`}>
      <div className="stage" ref={mount} />

      {dealing && (shop === "apothecary"
        ? <ApothecaryKeeperPanel view={view as ApothecaryView} setView={setView} {...panel} />
        : shop === "smithy" ? <SmithyKeeperPanel me={me} view={view as SmithyView} setView={setView} {...panel} />
        : <GalleyKeeperPanel view={view as GalleyKeeperView} setView={setView} {...panel} />)}

      {/* Put away while dealing with the keeper, as at the pub's game tables: the panel has the screen, and its own
          way back ("Step away"). It comes back as you step away. */}
      {!dealing && <HudBar
        me={me}
        place={
          atDoor ? <span>The door back to the Harbor.</span>
            : atKeeper ? <span>With {keeper.name}, {keeper.trade}.</span>
            : <span className="muted">{place.title}. Click {keeper.short} to walk up: {shop === "galley" ? "cook for the ship, buy from the pot" : "buy, have work done"}, or haggle.</span>
        }
        onBag={() => (bag ? closeBag() : setBag(true))}
        onBook={() => setBook(true)}
        menu={
          <OptionsMenu
            title={place.title}
            subtitle={me.crew?.name}
            actions={[{ label: "Leave", run: onLeave }]}
            reset={{
              to: "the door",
              run: () => {
                setPos(door);
                queueMicrotask(() => renderer.current?.playEvents([{ t: "moved", heroId: you, path: [] }]));
                renderer.current?.lookAt(door);
              },
            }}
          />
        }
      >
        {!atKeeper && !refused && <button className="primary" onClick={() => walk.current(place.stand)}>Talk to {keeper.short}</button>}
        <button className={atDoor ? "primary" : ""} onClick={onLeave}>Leave</button>
      </HudBar>}
      {bag && <InventoryScreen me={me} refresh={refresh} onClose={closeBag} />}
      {book && <Logbook me={me} refresh={refresh} onClose={() => setBook(false)} />}
      {atDoor && !refused && <TileAction renderer={renderer} pos={pos} unitId={you} label="Leave" run={onLeave} />}

      {tip && <div className="tip">{tip}</div>}
      {refused && (
        <div className="hut-refused panel">
          <p>{refused}</p>
          <button className="primary" onClick={onLeave}>Back to the Harbor</button>
        </div>
      )}
    </div>
  );
}
