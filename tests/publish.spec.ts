import { describe, it, expect } from "vitest";
import { Grok } from "../src/core/grok";
import { GripRegistry, GripOf } from "../src/core/grip";
import { Drip } from "../src/core/drip";
import {
  createMultiAtomValueTap,
  createAtomValueTap,
  MultiAtomTap,
  MultiAtomValueTap,
  AtomTap,
  AtomValueTap,
} from "../src/core/atom_tap";
import type { Tap } from "../src/core/tap";

describe("Engine publish()", () => {
  it("does not affect destinations overshadowed by a closer provider", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const OUT = defineGrip<number>("Pub.Out2", 0);
    const grok = new Grok(registry);
    const home = grok.mainPresentationContext;
    const A = home.createChild();
    const B = home.createChild();

    const ancestorTap = createAtomValueTap(OUT, { initial: 10 });
    grok.registerTapAt(home, ancestorTap);
    expect(grok.query(OUT, A).get()).toBe(10);
    expect(grok.query(OUT, B).get()).toBe(10);

    const localTap = createAtomValueTap(OUT, { initial: 7 });
    grok.registerTapAt(B, localTap); // local tap overshadows ancestor tap

    // B now uses local provider
    expect(grok.query(OUT, B).get()).toBe(7);

    ancestorTap.set(42);

    expect(grok.query(OUT, A).get()).toBe(42);
    // B remains from local tap
    expect(grok.query(OUT, B).get()).toBe(7);
  });

  it("supports publishing multiple grips in one call", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const G1 = defineGrip<number>("Pub.G1", 1);
    const G2 = defineGrip<number>("Pub.G2", 2);
    const HANDLE = defineGrip<MultiAtomTap>("Pub.Handle");
    const grok = new Grok(registry);
    const home = grok.mainPresentationContext;
    const D = home.createChild();

    const tap1 = createMultiAtomValueTap({
      gripMap: new Map([
        [G1, 1],
        [G2, 2],
      ]),
      handleGrip: HANDLE,
    });
    grok.registerTapAt(home, tap1 as unknown as Tap);

    const drip1 = grok.query(G1, D);
    const drip2 = grok.query(G2, D);
    const handle = grok.query(HANDLE, D);
    expect(drip1.get()).toBe(1);
    expect(drip2.get()).toBe(2);
    expect(handle.get()).toBe(tap1);

    tap1.setAll(
      new Map([
        [G1, 11],
        [G2, 22],
      ]),
    );

    expect(grok.query(G1, D).get()).toBe(11);
    expect(grok.query(G2, D).get()).toBe(22);
  });
});

