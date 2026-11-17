// Inside the smithy or the apothecary: a small room drawn by the same
// renderer as the pub and the huts, with the keeper at their work (Greta
// hammering at her anvil, Ansel stirring his cauldron), and still at it
// while they deal with you. Walk up to them (or click them) to see what they
// sell and do, and to haggle. The door at the front leads back to the Harbor.
//
// Unlike the pub, nobody else is in here: the room is this player's own copy
// and the walking is worked out in the browser (the rules are still
// packages/world/src/keepers.ts). Everything that costs anything goes
// through the server, as before.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { HexPos } from "@gantt-quest/core";
import { KEEPER_PLACES, keeperPath, keeperRoom, outfitOf, type KeeperShop } from "@gantt-quest/world";
import { api, type ApothecaryView, type Me, type SmithyView } from "./api";
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
import { ApothecaryKeeperPanel, SmithyKeeperPanel } from "./works/KeeperPanels";
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
  const [view, setView] = useState<ApothecaryView | SmithyView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(
    () => (shop === "apothecary" ? api.apothecary() : api.smithy()).then(setView, (e: Error) => setLoadError(e.message)),
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
      props: place.fittings.map((f) => ({ id: f.id, model: f.model, pos: { q: f.q, r: f.r }, facing: f.facing, x: f.x, z: f.z })),
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
    // second, with a spray of sparks off the work as it lands; Ansel goes round and round his cauldron.
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
    const beat = place.work.how === "hammer" ? 1150 : 2400;
    const go = () => {
      const wait = r.work(keeper.id, place.work.how, at);
      if (place.work.how === "hammer" && wait > 0) {
        later(() => {
          sparks.burst(new THREE.Vector3(at.x, 0.78, at.z), "#ffb84a", 7);
          audio.play("gather.pick", { at });
        }, wait * 1000);
      }
      // Now and then a breath between blows, so it is not a metronome. A stir just goes round and round.
      later(go, place.work.how === "hammer" ? beat + (Math.random() < 0.2 ? 900 : Math.random() * 200) : beat);
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

      {view?.built && atKeeper && (shop === "apothecary"
        ? <ApothecaryKeeperPanel view={view as ApothecaryView} setView={setView} reload={reload} refresh={refresh} onSay={say} />
        : <SmithyKeeperPanel me={me} view={view as SmithyView} setView={setView} reload={reload} refresh={refresh} onSay={say} />)}

      <HudBar
        me={me}
        place={
          atDoor ? <span>The door back to the Harbor.</span>
            : atKeeper ? <span>With {keeper.name}, {keeper.trade}.</span>
            : <span className="muted">{place.title}. Click {keeper.short} to walk up: buy, have work done, or haggle.</span>
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
      </HudBar>
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
