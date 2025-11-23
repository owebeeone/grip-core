/**
 * @file matcher.spec.ts
 * @description Unit tests for the TapMatcher class.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Grok } from "../src/core/grok";
import { Grip, GripRegistry } from "../src/core/grip";
import { QueryBuilderFactory } from "../src/core/query";
import { TapMatcher } from "../src/core/matcher";
import { DualContextContainer } from "../src/core/containers";
import { createAtomValueTap, createMultiAtomValueTap, AtomTap } from "../src/core/atom_tap";
import type { Tap } from "../src/core/tap";

// ---[ Test Helpers ]------------------------------------------------------------

const qb = () => new QueryBuilderFactory().newQuery();

describe("TapMatcher", () => {
  let grok: Grok;
  let container: DualContextContainer;
  let matcher: TapMatcher;
  let applyDeltaSpy: any;

  // Input Grips (for home context)
  const MODE = new Grip<string>({ name: "mode" });
  const REGION = new Grip<string>({ name: "region" });

  // Output Grips (for presentation context)
  const DATA_A = new Grip<string>({ name: "data_a" });
  const DATA_B = new Grip<string>({ name: "data_b" });

  // Taps - Corrected casting to 'unknown' first.
  const tapA = createMultiAtomValueTap({ grips: [DATA_A] }) as unknown as Tap;
  const tapB = createMultiAtomValueTap({ grips: [DATA_B] }) as unknown as Tap;
  const tapAB = createMultiAtomValueTap({ grips: [DATA_A, DATA_B] }) as unknown as Tap;

  // Input controllers
  let modeController: AtomTap<string>;
  let regionController: AtomTap<string>;

  beforeEach(() => {
    grok = new Grok(new GripRegistry());
    container = grok.createDualContext(grok.mainPresentationContext);
    matcher = new TapMatcher(container);

    // Spy on applyAttributionDelta to check its output without a full implementation
    applyDeltaSpy = vi.spyOn(matcher, "applyAttributionDelta");

    // Setup input controllers in the home context
    modeController = createAtomValueTap(MODE, { initial: "off" });
    regionController = createAtomValueTap(REGION, { initial: "us" });
    container.getGripHomeContext().registerTap(modeController as unknown as Tap);
    container.getGripHomeContext().registerTap(regionController as unknown as Tap);
  });

  it("should add a binding, evaluate on change, and call applyDelta", () => {
    const query = qb().oneOf(MODE, "on", 10).build();
    matcher.addBinding({ id: "A", query, tap: tapA, baseScore: 0 });

    // An initial evaluation is triggered by the first change, not by adding a binding.
    // The spy has not been called yet.
    expect(applyDeltaSpy).not.toHaveBeenCalled();

    // Change input to match the query, this triggers the first evaluation.
    modeController.set("on");
    grok.flush();

    // Check that the delta was applied
    expect(applyDeltaSpy).toHaveBeenCalledTimes(1);
    const lastCall = applyDeltaSpy.mock.calls[0][0];
    expect(lastCall.added.size).toBe(1);
    expect(lastCall.removed.size).toBe(0);
    const addedAttribution = lastCall.added.get(tapA);
    expect(addedAttribution.bindingId).toBe("A");
    expect(Array.from(addedAttribution.attributedGrips)).toEqual([DATA_A]);
  });

  it("should remove a binding and stop reacting to its inputs", () => {
    const query = qb().oneOf(MODE, "on", 10).build();
    matcher.addBinding({ id: "A", query, tap: tapA, baseScore: 0 });

    // Activate the tap, triggering the first evaluation
    modeController.set("on");
    grok.flush();
    expect(applyDeltaSpy).toHaveBeenCalledTimes(1);

    // Remove the binding. This should trigger an evaluation to remove the attribution.
    matcher.removeBinding("A");
    grok.flush();
    expect(applyDeltaSpy).toHaveBeenCalledTimes(2);

    // Change the input again. This should NOT trigger a new evaluation
    // because the matcher is no longer subscribed to the MODE grip.
    modeController.set("off");
    grok.flush();
    expect(applyDeltaSpy).toHaveBeenCalledTimes(2); // The count should not increase
  });

  it("should handle partition merging and splitting via attribution changes", () => {
    // Setup: tapA provides DATA_A, tapB provides DATA_B.
    // A high-scoring tapAB will be added to bridge them.
    const queryA = qb().oneOf(MODE, "a", 10).build();
    const queryB = qb().oneOf(MODE, "b", 10).build();
    const queryAB = qb().oneOf(REGION, "eu", 20).build(); // Higher score

    matcher.addBinding({ id: "A", query: queryA, tap: tapA, baseScore: 0 });
    matcher.addBinding({ id: "B", query: queryB, tap: tapB, baseScore: 0 });

    // 1. Activate A.
    modeController.set("a");
    grok.flush(); // Eval #1: A is added.
    expect(applyDeltaSpy).toHaveBeenCalledTimes(1);

    // 2. Activate B, which deactivates A.
    modeController.set("b");
    grok.flush(); // Eval #2: A is removed, B is added.
    expect(applyDeltaSpy).toHaveBeenCalledTimes(2);

    let lastCall = applyDeltaSpy.mock.calls[1][0];
    expect(lastCall.added.get(tapB)?.bindingId).toBe("B");
    expect(lastCall.removed.get(tapA)?.bindingId).toBe("A");

    // 3. Add the high-scoring bridge tap and activate it.
    // This requires a new subscription, which needs its initial value to be read.
    // A change to any existing subscribed grip will trigger an evaluation that considers all inputs.
    matcher.addBinding({ id: "AB", query: queryAB, tap: tapAB, baseScore: 0 });
    regionController.set("eu");
    modeController.set("b"); // Re-assert mode to ensure evaluation context is complete
    grok.flush(); // Eval #3

    expect(applyDeltaSpy).toHaveBeenCalledTimes(3);
    lastCall = applyDeltaSpy.mock.calls[2][0];
    // tapAB should win both DATA_A and DATA_B due to higher score
    expect(lastCall.added.get(tapAB)?.bindingId).toBe("AB");
    expect(Array.from(lastCall.added.get(tapAB).attributedGrips)).toEqual([DATA_A, DATA_B]);
    // B should be removed because it lost attribution. A was already inactive.
    expect(lastCall.removed.get(tapA)).toBeUndefined();
    expect(lastCall.removed.get(tapB)?.bindingId).toBe("B");

    // 4. Deactivate the bridge tap; attribution should revert to B being active ('b' is still the mode)
    regionController.set("us");
    grok.flush(); // Eval #4

    expect(applyDeltaSpy).toHaveBeenCalledTimes(4);
    lastCall = applyDeltaSpy.mock.calls[3][0];
    // tapAB is removed
    expect(lastCall.removed.get(tapAB)?.bindingId).toBe("AB");
    // B is added back because MODE is still 'b'
    expect(lastCall.added.get(tapA)).toBeUndefined();
    expect(lastCall.added.get(tapB)?.bindingId).toBe("B");
  });

  it("should clean up subscriptions for grips that are no longer needed", () => {
    const queryA = qb().oneOf(MODE, "on").build();
    const queryB = qb().oneOf(REGION, "eu").build();

    matcher.addBinding({ id: "A", query: queryA, tap: tapA, baseScore: 0 });
    matcher.addBinding({ id: "B", query: queryB, tap: tapB, baseScore: 0 });

    // @ts-ignore - Access private property for testing
    expect(matcher.dripSubscriptions.has(MODE)).toBe(true);
    // @ts-ignore
    expect(matcher.dripSubscriptions.has(REGION)).toBe(true);

    matcher.removeBinding("A");
    // @ts-ignore
    expect(matcher.dripSubscriptions.has(MODE)).toBe(false);
    // @ts-ignore
    expect(matcher.dripSubscriptions.has(REGION)).toBe(true);

    matcher.removeBinding("B");
    // @ts-ignore
    expect(matcher.dripSubscriptions.has(REGION)).toBe(false);
  });
});
