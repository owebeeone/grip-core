import { describe, expect, it } from "vitest";
import { Grok } from "../src/core/grok";
import { GripOf, GripRegistry } from "../src/core/grip";
import { createAtomValueTap } from "../src/core/atom_tap";
import { createFunctionTap } from "../src/core/function_tap";
import { MatchingContext } from "../src/core/matcher";
import { withOneOf } from "../src/core/query";

describe("keyed context helpers", () => {
  it("returns the same live child for the same key and runs init once", () => {
    const grok = new Grok(new GripRegistry());
    const parent = grok.mainPresentationContext;
    let initCount = 0;

    const first = parent.getOrCreateChildContext("column:A", () => {
      initCount += 1;
    });
    const second = parent.getOrCreateChildContext("column:A", () => {
      initCount += 1;
    });

    expect(second).toBe(first);
    expect(initCount).toBe(1);
  });

  it("scopes keyed children to their parent context", () => {
    const grok = new Grok(new GripRegistry());
    const firstParent = grok.mainPresentationContext.createChild({ id: "parent-a" });
    const secondParent = grok.mainPresentationContext.createChild({ id: "parent-b" });

    const first = firstParent.getOrCreateChildContext("shared");
    const second = secondParent.getOrCreateChildContext("shared");

    expect(first).not.toBe(second);
    expect(first.getParents().map((p) => p.ctx)).toContain(firstParent);
    expect(second.getParents().map((p) => p.ctx)).toContain(secondParent);
  });

  it("ignores stale weak-ref child entries", () => {
    const grok = new Grok(new GripRegistry());
    const parent = grok.mainPresentationContext;

    (parent as any).namedChildContexts.set("stale", { deref: () => undefined });

    const child = parent.getOrCreateChildContext("stale");

    expect(child).toBe(parent.getOrCreateChildContext("stale"));
    expect(child.getParents().map((p) => p.ctx)).toContain(parent);
  });
});

describe("keyed matching context helpers", () => {
  it("creates a cached MatchingContext with parent -> home -> presentation hierarchy", () => {
    const grok = new Grok(new GripRegistry());
    const parent = grok.mainPresentationContext;

    const first = parent.getOrCreateMatchingContext("coin:A");
    const second = parent.getOrCreateMatchingContext("coin:A");

    expect(first).toBe(second);
    expect(first).toBeInstanceOf(MatchingContext);
    expect(first.getGripHomeContext()).not.toBe(first.getGripConsumerContext());
    expect(first.getGripHomeContext().getParents().map((p) => p.ctx)).toContain(parent);
    expect(first.getGripConsumerContext().getParents().map((p) => p.ctx)).toContain(
      first.getGripHomeContext(),
    );
  });

  it("runs the matching initializer once and can install a binding", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const MODE = defineGrip<string>("Mode", "mock");
    const OUT = defineGrip<string>("Out");
    const grok = new Grok(registry);
    const parent = grok.mainPresentationContext;
    const selectedTap = createAtomValueTap(OUT, { initial: "live-value" });
    let initCount = 0;

    const matching = parent.getOrCreateMatchingContext("coin:A", (ctx) => {
      initCount += 1;
      ctx.getGripHomeContext().registerTap(createAtomValueTap(MODE, { initial: "live" }));
      ctx.addBinding({
        id: "live-source",
        query: withOneOf(MODE, "live", 10).build(),
        tap: selectedTap,
        baseScore: 0,
      });
    });
    parent.getOrCreateMatchingContext("coin:A", () => {
      initCount += 1;
    });

    const drip = grok.query(OUT, matching.getGripConsumerContext());
    grok.flush();

    expect(initCount).toBe(1);
    expect(drip.get()).toBe("live-value");
  });

  it("lets a parent fallback tap read destination params from matching home", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const PRODUCT = defineGrip<string>("Product");
    const OUT = defineGrip<string>("PriceLabel");
    const grok = new Grok(registry);
    const parent = grok.mainPresentationContext;
    const matching = parent.getOrCreateMatchingContext("coin:A");
    const productTap = createAtomValueTap(PRODUCT, { initial: "BTC-USD" });

    matching.getGripHomeContext().registerTap(productTap);
    parent.registerTap(
      createFunctionTap({
        provides: [OUT],
        destinationParamGrips: [PRODUCT],
        compute: ({ getDestParam }) => new Map([[OUT, `fallback:${getDestParam(PRODUCT)}`]]),
      }),
    );

    const drip = grok.query(OUT, matching.getGripConsumerContext());

    expect(drip.get()).toBe("fallback:BTC-USD");

    productTap.set("ETH-USD");

    expect(drip.get()).toBe("fallback:ETH-USD");
  });
});

describe("deterministic context id reuse (retire-and-replace)", () => {
  // Keyed context ids are DETERMINISTIC (parent.id + key). After a holder
  // unmounts, its context is collected (drips and tap handles hold their
  // context STRONGLY, so a context nobody reaches has no consumer that can
  // ever fire again) — but the graph node lingers until the sweep. A
  // remount recreating the same id must get a FRESH node: the old one is
  // retired, never rebound. The stale path used to throw "Context is gone"
  // (gryth-ui blank-tab crash).
  it("gives a reused id a fresh node once the old context is collected", () => {
    const grok = new Grok(new GripRegistry());
    const main = grok.mainPresentationContext;
    const first = main.createChild({ id: "dup-a" });
    const staleNode = first._getContextNode();
    // simulate the previous context having been GC'd (WeakRef cleared)
    (staleNode as { contextRef: unknown }).contextRef = { deref: () => undefined };

    const second = main.createChild({ id: "dup-a" });
    const freshNode = second._getContextNode();
    expect(freshNode).not.toBe(staleNode);
    expect(freshNode.get_context()).toBe(second);
  });

  it("serves consumers on the replacement context (the blank-tab crash)", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const VALUE = defineGrip<string>("Retire.Value", "fallback");
    const grok = new Grok(registry);
    const main = grok.mainPresentationContext;

    const first = main.createChild({ id: "dup-b" });
    first.getOrCreateConsumer(VALUE).subscribe(() => {});
    (first._getContextNode() as { contextRef: unknown }).contextRef = { deref: () => undefined };

    const second = main.createChild({ id: "dup-b" });
    const drip = second.getOrCreateConsumer(VALUE); // threw "Context is gone" before
    drip.subscribe(() => {});
    expect(drip.get()).toBe("fallback");

    const tap = createAtomValueTap(VALUE, { initial: "served" });
    grok.registerTapAt(second, tap);
    expect(second.getOrCreateConsumer(VALUE).get()).toBe("served");
  });

  it("never rebinds: a still-referenced previous context keeps its own node", () => {
    // WeakRef liveness lags reachability — the previous context may still
    // deref while pending GC. Last-one-wins the id slot; the old context
    // keeps functioning through the node object it already holds.
    const grok = new Grok(new GripRegistry());
    const main = grok.mainPresentationContext;
    const first = main.createChild({ id: "dup-c" });
    const n1 = first._getContextNode();
    const second = main.createChild({ id: "dup-c" });
    expect(second._getContextNode()).not.toBe(n1);
    expect(n1.get_context()).toBe(first);
    expect(second._getContextNode().get_context()).toBe(second);
  });
});
