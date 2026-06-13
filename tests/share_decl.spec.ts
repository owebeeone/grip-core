// Base-tap glade share feature (GLP-0005, P3.S1, GQ-5). A tap declares a glade
// `share` and thereby advertises as sharable via grok; the capture/apply hooks
// round-trip. grip-core imports no glade types — this is protocol-free.

import { describe, it, expect } from "vitest";

import { GripRegistry, GripOf } from "../src/core/grip";
import { Grok } from "../src/core/grok";
import { createAtomValueTap, AtomValueTap } from "../src/core/atom_tap";

function setup() {
  const registry = new GripRegistry();
  const defineGrip = GripOf(registry);
  const grok = new Grok(registry);
  return { defineGrip, grok };
}

describe("base-tap glade share (GQ-5)", () => {
  it("a tap with a share decl advertises; one without does not", () => {
    const { defineGrip, grok } = setup();
    const COUNT = defineGrip<number>("Count", 0);
    const TAB = defineGrip<string>("Tab", "clock");

    const shared = createAtomValueTap(COUNT, {
      initial: 0,
      share: { gladeId: "app:demo#count", shape: "value" },
    });
    const plain = createAtomValueTap(TAB, { initial: "clock" });
    grok.registerTap(shared);
    grok.registerTap(plain);

    const advertised = grok.listSharedTaps();
    expect(advertised).toContain(shared);
    expect(advertised).not.toContain(plain);
    expect(advertised.length).toBe(1);
    expect(shared.share?.gladeId).toBe("app:demo#count");
    expect(shared.share?.shape).toBe("value");
  });

  it("capture/apply hooks round-trip on an atom", () => {
    const { defineGrip } = setup();
    const COUNT = defineGrip<number>("Count2", 0);
    const tap = createAtomValueTap(COUNT, {
      initial: 5,
      share: { gladeId: "g", shape: "value" },
    });
    expect(tap.getShareValue!()).toBe(5);
    tap.applyShareValue!(9); // apply a "remote" value
    expect(tap.get()).toBe(9);
    expect(tap.getShareValue!()).toBe(9);
  });

  it("subscribeShare fires on a local change", () => {
    const { defineGrip } = setup();
    const COUNT = defineGrip<number>("Count3", 0);
    const tap = createAtomValueTap(COUNT, {
      initial: 0,
      share: { gladeId: "g", shape: "value" },
    });
    let fired = 0;
    const off = tap.subscribeShare!(() => {
      fired++;
    });
    tap.set(1);
    tap.set(2);
    off();
    tap.set(3);
    expect(fired).toBe(2); // unsubscribed before the third set
  });

  it("a share-free app advertises nothing (zero cost)", () => {
    const { defineGrip, grok } = setup();
    const A = defineGrip<number>("A", 0);
    grok.registerTap(createAtomValueTap(A, { initial: 0 }));
    expect(grok.listSharedTaps()).toEqual([]);
  });
});
