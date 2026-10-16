import { describe, expect, it } from "vitest";
import { createAtomValueTap, MultiAtomValueTap } from "../src/core/atom_tap";
import { GripRegistry } from "../src/core/grip";
import { Grok } from "../src/core/grok";
import type { TapAttribution } from "../src/core/query_evaluator";
import type { Tap, TapFactory } from "../src/core/tap";

function registrationScenario() {
  const registry = new GripRegistry();
  const value = registry.defineGrip<number>("RegistrationValue", -1);
  const grok = new Grok(registry);
  const home = grok.mainHomeContext.createChild();
  const consumer = home.createChild();
  const first = createAtomValueTap(value, { initial: 10 });
  const second = createAtomValueTap(value, { initial: 20 });
  return { registry, value, grok, home, consumer, first, second };
}

describe("same-context provider uniqueness", () => {
  it("rejects a second tap for an occupied grip without disturbing the original provider", () => {
    const { value, grok, home, consumer, first, second } = registrationScenario();
    grok.registerTapAt(home, first);
    const drip = grok.query(value, consumer);
    const seen: Array<number | undefined> = [];
    const unsubscribe = drip.subscribe((next) => seen.push(next));

    try {
      grok.flush();
      expect(drip.get()).toBe(10);
      seen.length = 0;

      // GRIP_RESOLVER.md: a second tap for the same grip in the same context
      // is an error, rather than an implicit provider replacement.
      expect.soft(() => grok.registerTapAt(home, second)).toThrow();
      grok.flush();
      expect(grok.query(value, consumer)).toBe(drip);
      expect.soft(drip.get()).toBe(10);
      expect.soft(second.getHomeContext() === undefined, "rejected tap must remain unattached").toBe(true);

      first.set(11);
      grok.flush();
      expect.soft(drip.get()).toBe(11);
      expect.soft(seen).toEqual([11]);
      // Existing delivery and fresh resolution must agree after rejection.
      expect.soft(grok.query(value, home.createChild()).get()).toBe(11);
    } finally {
      unsubscribe();
      grok.flush();
    }
  });

  it("rejects an overlapping multi-output tap before installing any of its outputs", () => {
    const { registry, value, grok, home, consumer, first } = registrationScenario();
    const extra = registry.defineGrip<number>("UnoccupiedValue", -2);
    // Put the unoccupied output first to catch validation that mutates the
    // graph incrementally and only discovers a later output's collision.
    const overlapping = new MultiAtomValueTap(
      [extra, value],
      new Map([
        [extra, 300],
        [value, 20],
      ]),
    );
    grok.registerTapAt(home, first);
    expect.soft(() => grok.registerTapAt(home, overlapping)).toThrow();
    grok.flush();

    const drip = grok.query(value, consumer);
    const unsubscribe = drip.subscribe(() => {});
    try {
      grok.flush();
      expect.soft(drip.get()).toBe(10);
      expect.soft(grok.query(extra, consumer).get()).toBe(-2);
      expect.soft(overlapping.getHomeContext() === undefined, "rejected tap must remain unattached").toBe(true);
      first.set(11);
      grok.flush();
      expect.soft(drip.get()).toBe(11);
    } finally {
      unsubscribe();
      grok.flush();
    }
  });

  it("rejects a matcher delta assigning one grip to two winners before changing the graph", () => {
    const { value, grok, home, consumer, first, second } = registrationScenario();
    const third = createAtomValueTap(value, { initial: 30 });
    grok.registerTapAt(home, first);
    const drip = grok.query(value, consumer);
    const unsubscribe = drip.subscribe(() => {});
    const attribution = (tap: Tap, bindingId: string): TapAttribution => ({
      producerTap: tap,
      score: 1,
      bindingId,
      attributedGrips: new Set([value]),
    });
    try {
      grok.flush();
      expect.soft(() => grok.applyProducerDelta(home, {
        removed: new Map<Tap | TapFactory, TapAttribution>([[first, attribution(first, "old")]]),
        added: new Map<Tap | TapFactory, TapAttribution>([
          [second, attribution(second, "second")],
          [third, attribution(third, "third")],
        ]),
      })).toThrow();
      grok.flush();
      expect.soft(drip.get()).toBe(10);
      expect.soft(second.getHomeContext() === undefined).toBe(true);
      expect.soft(third.getHomeContext() === undefined).toBe(true);
      first.set(11);
      grok.flush();
      expect.soft(drip.get()).toBe(11);
      expect.soft(grok.query(value, home.createChild()).get()).toBe(11);
    } finally {
      unsubscribe();
      grok.flush();
    }
  });
});
