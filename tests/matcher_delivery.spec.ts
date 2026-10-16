import { describe, expect, it } from "vitest";
import { createAtomValueTap, MultiAtomValueTap } from "../src/core/atom_tap";
import { GripRegistry } from "../src/core/grip";
import { Grok } from "../src/core/grok";
import { TapMatcher } from "../src/core/matcher";
import { QueryBuilderFactory } from "../src/core/query";

function matcherScenario(partialTransfer: boolean) {
  const registry = new GripRegistry();
  const mode = registry.defineGrip<string>("Mode", "low");
  const retained = registry.defineGrip<number>("Retained", -1);
  const transferred = registry.defineGrip<number>("Transferred", -2);
  const grok = new Grok(registry);
  const context = grok.createDualContext(grok.mainPresentationContext);
  const control = createAtomValueTap(mode, { initial: "low" });
  grok.registerTapAt(context.home, control);
  const low = new MultiAtomValueTap(
    partialTransfer ? [retained, transferred] : [transferred],
    new Map(partialTransfer ? [[retained, 100], [transferred, 10]] : [[transferred, 10]]),
  );
  const high = createAtomValueTap(transferred, { initial: 20 });
  const matcher = new TapMatcher(context);
  const query = () => new QueryBuilderFactory().newQuery();
  matcher.addBinding({
    id: "low",
    query: query().oneOf(mode, "low", 1).oneOf(mode, "high", 1).build(),
    tap: low,
    baseScore: 0,
  });
  matcher.addBinding({
    id: "high",
    query: query().oneOf(mode, "high", 20).build(),
    tap: high,
    baseScore: 0,
  });
  grok.flush();
  return { grok, context, control, low, high, retained, transferred };
}

describe("matcher live output ownership", () => {
  it("switches a whole output between taps and back without delivery from the inactive tap", () => {
    const { grok, context, control, low, high, transferred } = matcherScenario(false);
    const drip = grok.query(transferred, context);
    const unsubscribe = drip.subscribe(() => {});
    try {
      grok.flush();
      expect(drip.get()).toBe(10);
      control.set("high");
      grok.flush();
      expect(drip.get()).toBe(20);
      high.set(21);
      grok.flush();
      expect(drip.get()).toBe(21);
      low.set(transferred, 11);
      grok.flush();
      expect(drip.get()).toBe(21);
      control.set("low");
      grok.flush();
      expect(drip.get()).toBe(11);
      control.set("high");
      grok.flush();
      expect(drip.get()).toBe(21);
    } finally {
      unsubscribe();
      grok.flush();
    }
  });

  it("keeps a partially displaced tap active only for its remaining output", () => {
    const { grok, context, control, low, high, retained, transferred } = matcherScenario(true);
    const retainedDrip = grok.query(retained, context);
    const transferredDrip = grok.query(transferred, context);
    const offRetained = retainedDrip.subscribe(() => {});
    const offTransferred = transferredDrip.subscribe(() => {});
    try {
      grok.flush();
      expect([retainedDrip.get(), transferredDrip.get()]).toEqual([100, 10]);
      control.set("high");
      grok.flush();
      expect([retainedDrip.get(), transferredDrip.get()]).toEqual([100, 20]);
      high.set(21);
      low.set(retained, 101);
      grok.flush();
      expect([retainedDrip.get(), transferredDrip.get()]).toEqual([101, 21]);

      // The old tap remains live, but this output is now owned by high.
      low.set(transferred, 11);
      grok.flush();
      expect.soft([retainedDrip.get(), transferredDrip.get()]).toEqual([101, 21]);

      high.set(22);
      grok.flush();
      expect(transferredDrip.get()).toBe(22);
      // A full production must also respect the matcher's per-grip attribution.
      low.produce();
      grok.flush();
      expect.soft([retainedDrip.get(), transferredDrip.get()]).toEqual([101, 22]);
    } finally {
      offRetained();
      offTransferred();
      grok.flush();
    }
  });

  it("does not reclaim a transferred output when the old tap reconnects for its remaining output", () => {
    const { grok, context, control, low, high, retained, transferred } = matcherScenario(true);
    // Only the transferred grip is initially observed. Losing it detaches low.
    const transferredDrip = grok.query(transferred, context);
    const offTransferred = transferredDrip.subscribe(() => {});
    let offRetained: (() => void) | undefined;
    try {
      grok.flush();
      control.set("high");
      grok.flush();
      expect(transferredDrip.get()).toBe(20);

      const retainedDrip = grok.query(retained, context);
      offRetained = retainedDrip.subscribe(() => {});
      grok.flush();
      expect(retainedDrip.get()).toBe(100);
      low.set(transferred, 11);
      grok.flush();
      expect.soft(transferredDrip.get()).toBe(20);
      // A fresh destination must still resolve the high-scoring winner.
      expect.soft(grok.query(transferred, context.presentation.createChild()).get()).toBe(20);
      high.set(21);
      grok.flush();
      expect.soft(transferredDrip.get()).toBe(21);
    } finally {
      offRetained?.();
      offTransferred();
      grok.flush();
    }
  });
});
