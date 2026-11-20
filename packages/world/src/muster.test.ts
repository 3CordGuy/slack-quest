import { describe, expect, it } from "vitest";
import { MUSTER_LINGER_MS, MUSTER_MS, MUSTER_PARTY, answerMuster, callMuster, musterAnswered, musterDue, musterOpen, musterShown, type Muster, type MusterMember } from "./muster";

const ann: MusterMember = { id: "a", name: "Ann" };
const bo: MusterMember = { id: "b", name: "Bo" };
const cy: MusterMember = { id: "c", name: "Cy" };
const NOW = 1_000_000;
const called = (asked: MusterMember[] = [bo, cy]) => callMuster("m1", ann, { node: "2,-1", place: "Petrel Spit", site: "Cove", level: 4 }, asked, NOW);
/** Answer, and expect it to be taken. */
function said(m: Muster, who: MusterMember, answer: Parameters<typeof answerMuster>[2], now = NOW + 1000) {
  const res = answerMuster(m, who, answer, now);
  if ("error" in res) throw new Error(res.error);
  return res;
}

describe("a muster", () => {
  it("is called by whoever sets out, who is ready from the first; it waits a minute for those who were in town", () => {
    const m = called([ann, bo, cy]);
    expect(m).toMatchObject({ id: "m1", by: ann, node: "2,-1", place: "Petrel Spit", site: "Cove", level: 4, deadline: NOW + MUSTER_MS, ready: [ann], declined: [] });
    // The caller is not among those asked, even if handed in with them.
    expect(m.asked).toEqual([bo, cy]);
    expect(MUSTER_MS).toBe(60_000);
    expect(musterOpen(m)).toBe(true);
    expect(musterAnswered(m)).toBe(false);
    expect(musterDue(m, NOW + 59_999)).toBe(false);
    expect(musterDue(m, NOW + MUSTER_MS)).toBe(true);
  });

  it("readying up and declining are taken, changed at will, and never change the muster handed in", () => {
    const m = called();
    const one = said(m, bo, "ready");
    expect(one.start).toBeUndefined();
    expect(one.muster.ready).toEqual([ann, bo]);
    expect(m.ready).toEqual([ann]);
    // Bo thinks better of it.
    const two = said(one.muster, bo, "no");
    expect(two.muster.ready).toEqual([ann]);
    expect(two.muster.declined).toEqual(["b"]);
    // And changes his mind again: he is ready, and no longer declined.
    const three = said(two.muster, bo, "ready");
    expect(three.muster.ready).toEqual([ann, bo]);
    expect(three.muster.declined).toEqual([]);
    // Saying the same thing twice changes nothing.
    expect(said(three.muster, bo, "ready").muster.ready).toEqual([ann, bo]);
  });

  it("starts the moment everyone asked has answered, whatever they said", () => {
    const m = said(called(), bo, "ready").muster;
    const last = said(m, cy, "no");
    expect(last.start).toBe(true);
    expect(last.muster.ready).toEqual([ann, bo]);
    expect(last.muster.declined).toEqual(["c"]);
    // Everyone declining starts it too: the caller goes alone.
    const alone = said(said(called(), bo, "no").muster, cy, "no");
    expect(alone.start).toBe(true);
    expect(alone.muster.ready).toEqual([ann]);
  });

  it("someone who was not asked (they walked into town after) can come too, and nobody waits for them", () => {
    const dee: MusterMember = { id: "d", name: "Dee" };
    const m = called([bo]);
    const one = said(m, dee, "ready");
    expect(one.muster.ready).toEqual([ann, dee]);
    expect(one.start).toBeUndefined();
    expect(said(one.muster, bo, "ready").start).toBe(true);
  });

  it("only the caller can start it early or call it off, and the caller cannot answer their own muster", () => {
    const m = called();
    expect(answerMuster(m, bo, "start", NOW)).toEqual({ error: "Only Ann can do that: it is their muster." });
    expect(answerMuster(m, bo, "cancel", NOW)).toHaveProperty("error");
    expect(said(m, ann, "start")).toMatchObject({ start: true });
    expect(said(m, ann, "cancel")).toMatchObject({ cancel: true });
    expect(answerMuster(m, ann, "no", NOW)).toHaveProperty("error");
    expect(answerMuster(m, ann, "ready", NOW)).toHaveProperty("error");
  });

  it("takes as many as a map is made for, and starts when it is full", () => {
    const more = Array.from({ length: 6 }, (_, i): MusterMember => ({ id: `p${i}`, name: `P${i}` }));
    let m = called(more);
    for (let i = 0; i < MUSTER_PARTY - 2; i++) m = said(m, more[i], "ready").muster;
    expect(m.ready).toHaveLength(MUSTER_PARTY - 1);
    const full = said(m, more[4], "ready");
    expect(full.muster.ready).toHaveLength(MUSTER_PARTY);
    expect(full.start).toBe(true);
    // No room for a fifth, though one of the four may still stand down.
    expect(answerMuster(full.muster, more[5], "ready", NOW)).toEqual({ error: `There is room for ${MUSTER_PARTY}, and they are spoken for.` });
  });

  it("once it has started or fallen through it takes no more answers, and is told a little while longer", () => {
    const gone: Muster = { ...called(), code: "ABCD", endedAt: NOW + 5000 };
    expect(musterOpen(gone)).toBe(false);
    expect(musterDue(gone, NOW + MUSTER_MS * 2)).toBe(false);
    expect(answerMuster(gone, bo, "ready", NOW)).toEqual({ error: "They have set out already." });
    const off: Muster = { ...called(), failed: "Ann called it off.", endedAt: NOW + 5000 };
    expect(answerMuster(off, bo, "ready", NOW)).toEqual({ error: "That muster is over." });
    expect(musterShown(gone, NOW + 5000 + MUSTER_LINGER_MS - 1)).toBe(true);
    expect(musterShown(gone, NOW + 5000 + MUSTER_LINGER_MS)).toBe(false);
    expect(musterShown(called(), NOW + MUSTER_MS * 5)).toBe(true);
    expect(musterShown(null, NOW)).toBe(false);
  });
});
