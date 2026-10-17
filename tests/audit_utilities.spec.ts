import { describe, expect, it, vi } from "vitest";
import {
  AtomValueTap,
  createAtomValueTap,
  createMultiAtomValueTap,
  MultiAtomValueTap,
} from "../src/core/atom_tap";
import { GripRegistry } from "../src/core/grip";
import { Grok } from "../src/core/grok";
import { GripGraphDumper } from "../src/core/graph_dump";
import { LruTtlCache } from "../src/core/async_cache";

describe("audit utility regressions", () => {
  it("U1 preserves explicit null in constructor and factory, retaining omitted defaults", () => {
    const grip = new GripRegistry().defineGrip<string | null>("value", "default");
    expect(new AtomValueTap(grip, null).get()).toBeNull();
    expect(createAtomValueTap(grip, { initial: null }).get()).toBeNull();
    expect(new AtomValueTap(grip).get()).toBe("default");
    expect(createAtomValueTap(grip).get()).toBe("default");
  });

  it.each(["factory", "constructor"])(
    "U2 advertises and publishes the full multi-atom union through %s",
    (mode) => {
      const registry = new GripRegistry(),
        grok = new Grok(registry);
      const x = registry.defineGrip("x", 0),
        y = registry.defineGrip("y", 0);
      const values = new Map([[y, 42]]);
      const tap =
        mode === "factory"
          ? createMultiAtomValueTap({ grips: [x], gripMap: values })
          : new MultiAtomValueTap([x], values);
      grok.registerTap(tap);
      const drip = grok.query(y, grok.mainContext);
      drip.subscribe(() => {});
      grok.flush();
      expect(tap.provides).toContain(y);
      expect(drip.get()).toBe(42);
      tap.set(y, 43);
      grok.flush();
      expect(drip.get()).toBe(43);
    },
  );

  it("U3 omits atom state and avoids reading it when dump values are disabled", () => {
    const registry = new GripRegistry(),
      grok = new Grok(registry);
    const grip = registry.defineGrip("private", "marker");
    const tap = new AtomValueTap(grip, "private-marker");
    grok.registerTap(tap);
    grok.query(grip, grok.mainContext).subscribe(() => {});
    grok.flush();
    const get = vi.spyOn(tap, "get");
    const dump = new GripGraphDumper({
      grok,
      opts: { includeValues: false, includeTapValues: true },
    }).dump();
    expect(JSON.stringify(dump)).not.toContain("private-marker");
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(new GripGraphDumper({ grok }).dump())).toContain("private-marker");
  });

  it("U4 bounds LRU capacity with undefined as the oldest key", () => {
    const cache = new LruTtlCache<string | undefined, number>(1);
    cache.set(undefined, 1, 0);
    cache.set("second", 2, 0);
    expect(cache.size()).toBe(1);
    expect(cache.get(undefined)).toBeUndefined();
    cache.set("third", 3, 0);
    expect(cache.size()).toBe(1);
    expect(cache.get("third")?.value).toBe(3);
  });
});
