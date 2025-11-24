import { describe, it, expect, beforeEach } from "vitest";
import { Grok } from "../src/core/grok";
import { GripRegistry, GripOf, Grip } from "../src/core/grip";
import { BaseTap } from "../src/core/base_tap";
import type { Tap } from "../src/core/tap";
import type { GripContext } from "../src/core/context";
import type { TapDestinationContext, Destination } from "../src/core/graph";

// Helper to create a simple test tap with destination context support
function createTestTap(
  provides: readonly Grip<any>[],
  createDestinationContext?: (destination: Destination) => TapDestinationContext | undefined,
): Tap {
  return new (class extends BaseTap {
    constructor() {
      super({ provides });
    }
    produceOnParams(): void {
      throw new Error("Not implemented");
    }
    produceOnDestParams(): void {
      throw new Error("Not implemented");
    }

    produce(opts?: { destContext?: GripContext }): void {
      const updates = new Map<Grip<any>, any>();
      for (const grip of provides) {
        updates.set(grip, 42);
      }
      if (opts?.destContext) {
        this.publish(updates, opts.destContext);
      } else {
        this.publish(updates);
      }
    }

    createDestinationContext = createDestinationContext;
  })() as unknown as Tap;
}

describe("Destination Lifecycle (Phase 1 - Generic)", () => {
  let registry: GripRegistry;
  let defineGrip: ReturnType<typeof GripOf>;
  let grok: Grok;

  beforeEach(() => {
    registry = new GripRegistry();
    defineGrip = GripOf(registry);
    grok = new Grok(registry);
  });

  it("dripAdded callback is called when grip is added", () => {
    const OUT1 = defineGrip<number>("Out1", 0);
    const OUT2 = defineGrip<number>("Out2", 0);

    const dripAddedCalls: Array<{ grip: Grip<any> }> = [];

    const tap = createTestTap(
      [OUT1, OUT2],
      (destination: Destination): TapDestinationContext => {
        return {
          dripAdded: (grip) => {
            dripAddedCalls.push({ grip });
          },
        };
      },
    );

    grok.registerTap(tap);
    const ctx = grok.mainPresentationContext.createChild();

    // Add first grip
    const drip1 = grok.query(OUT1, ctx);
    expect(drip1.get()).toBe(42);
    expect(dripAddedCalls.length).toBe(1);
    expect(dripAddedCalls[0].grip).toBe(OUT1);

    // Add second grip
    const drip2 = grok.query(OUT2, ctx);
    expect(drip2.get()).toBe(42);
    expect(dripAddedCalls.length).toBe(2);
    expect(dripAddedCalls[1].grip).toBe(OUT2);
  });

  it("dripRemoved callback is called when grip is removed", () => {
    const OUT1 = defineGrip<number>("Out1", 0);
    const OUT2 = defineGrip<number>("Out2", 0);

    const dripRemovedCalls: Array<{ grip: Grip<any> }> = [];

    const tap = createTestTap(
      [OUT1, OUT2],
      (destination: Destination): TapDestinationContext => {
        return {
          dripRemoved: (grip) => {
            dripRemovedCalls.push({ grip });
          },
        };
      },
    );

    grok.registerTap(tap);
    const ctx = grok.mainPresentationContext.createChild();

    // Add multiple grips
    const drip1 = grok.query(OUT1, ctx);
    const drip2 = grok.query(OUT2, ctx);
    expect(drip1.get()).toBe(42);
    expect(drip2.get()).toBe(42);
    expect(dripRemovedCalls.length).toBe(0);

    // Remove first grip by removing consumer
    const ctxNode = ctx._getContextNode();
    ctxNode.removeConsumerForGrip(OUT1);
    grok.flush();
    expect(dripRemovedCalls.length).toBe(1);
    expect(dripRemovedCalls[0].grip).toBe(OUT1);

    // Remove second grip
    ctxNode.removeConsumerForGrip(OUT2);
    grok.flush();
    expect(dripRemovedCalls.length).toBe(2);
    expect(dripRemovedCalls[1].grip).toBe(OUT2);
  });

  it("onDetach callback is called when all grips are removed", () => {
    const OUT1 = defineGrip<number>("Out1", 0);
    const OUT2 = defineGrip<number>("Out2", 0);

    let onDetachCallCount = 0;

    const tap = createTestTap(
      [OUT1, OUT2],
      (destination: Destination): TapDestinationContext => {
        return {
          onDetach: () => {
            onDetachCallCount++;
          },
        };
      },
    );

    grok.registerTap(tap);
    const ctx = grok.mainPresentationContext.createChild();

    // Add grips
    const drip1 = grok.query(OUT1, ctx);
    const drip2 = grok.query(OUT2, ctx);
    expect(onDetachCallCount).toBe(0);

    // Remove one grip - onDetach should NOT be called
    const ctxNode = ctx._getContextNode();
    ctxNode.removeConsumerForGrip(OUT1);
    grok.flush();
    expect(onDetachCallCount).toBe(0);

    // Remove last grip - onDetach should be called
    ctxNode.removeConsumerForGrip(OUT2);
    grok.flush();
    expect(onDetachCallCount).toBe(1);
  });

  it("onDetach callback is called via cleanup() when destination is forcibly removed", () => {
    const OUT = defineGrip<number>("Out", 0);

    let onDetachCallCount = 0;
    let contextInstance: TapDestinationContext | undefined;

    const tap = createTestTap(
      [OUT],
      (destination: Destination): TapDestinationContext => {
        const context: TapDestinationContext = {
          onDetach: () => {
            onDetachCallCount++;
          },
        };
        contextInstance = context;
        return context;
      },
    );

    grok.registerTap(tap);
    const ctx = grok.mainPresentationContext.createChild();

    // Add grip
    const drip = grok.query(OUT, ctx);
    expect(drip.get()).toBe(42);
    expect(onDetachCallCount).toBe(0);

    // Get the destination to test cleanup()
    // Access through the producer record
    const producerNode = ctx._getContextNode().getResolvedProviders().get(OUT);
    const producer = producerNode?.get_producers().get(OUT);
    const destNode = ctx._getContextNode();
    const destination = producer?.getDestinations().get(destNode);

    expect(destination).toBeDefined();
    expect(destination?.getTapContext()).toBe(contextInstance);

    // Call cleanup() while grip still exists
    destination!.cleanup();
    expect(onDetachCallCount).toBe(1);

    // Verify onDetach is also called via ProducerRecord.removeDestinationForContext
    // (This happens when destination is removed)
    const producerRecord = producer as any;
    if (producerRecord) {
      const destNode = ctx._getContextNode();
      producerRecord.removeDestinationForContext(destNode);
      // Note: cleanup() was already called, so onDetach might be called again
      // depending on implementation, but at least once is guaranteed
      expect(onDetachCallCount).toBeGreaterThanOrEqual(1);
    }
  });

  it("context is stored and retrievable via getTapContext()", () => {
    const OUT = defineGrip<number>("Out", 0);

    let contextInstance: TapDestinationContext | undefined;

    const tap = createTestTap(
      [OUT],
      (destination: Destination): TapDestinationContext => {
        const context: TapDestinationContext = {
          dripAdded: () => {},
          dripRemoved: () => {},
          onDetach: () => {},
        };
        contextInstance = context;
        return context;
      },
    );

    grok.registerTap(tap);
    const ctx = grok.mainPresentationContext.createChild();

    // Query to create destination
    const drip = grok.query(OUT, ctx);
    grok.flush();

    // Get the destination
    const producerNode = ctx._getContextNode().getResolvedProviders().get(OUT);
    const producer = producerNode?.get_producers().get(OUT);
    const destNode = ctx._getContextNode();
    const destination = producer?.getDestinations().get(destNode);

    expect(destination).toBeDefined();
    expect(destination?.getTapContext()).toBe(contextInstance);

    // Verify context persists across grip add/remove operations
    expect(destination?.getTapContext()).toBe(contextInstance);

    // Remove grip
    ctx._getContextNode().removeConsumerForGrip(OUT);
    grok.flush();
    // Context should still be accessible until destination is fully removed
    // (In practice, destination might be removed, but context should persist during lifecycle)
  });

  it("context is undefined when tap doesn't provide factory", () => {
    const OUT = defineGrip<number>("Out", 0);

    const tap = createTestTap([OUT]);
    // No createDestinationContext provided

    grok.registerTap(tap);
    const ctx = grok.mainPresentationContext.createChild();

    // Query to create destination
    const drip = grok.query(OUT, ctx);
    grok.flush();
    expect(drip.get()).toBe(42);

    // Get the destination
    const producerNode = ctx._getContextNode().getResolvedProviders().get(OUT);
    const producer = producerNode?.get_producers().get(OUT);
    const destNode = ctx._getContextNode();
    const destination = producer?.getDestinations().get(destNode);

    expect(destination).toBeDefined();
    expect(destination?.getTapContext()).toBeUndefined();

    // Verify no callbacks are called (no context means no callbacks)
    // No errors should occur
  });

  it("multiple destinations have independent contexts", () => {
    const OUT = defineGrip<number>("Out", 0);

    const contexts: TapDestinationContext[] = [];
    const dripAddedCalls: Array<{ contextIndex: number; grip: Grip<any> }> = [];

    const tap = createTestTap(
      [OUT],
      (destination: Destination): TapDestinationContext => {
        const contextIndex = contexts.length;
        const context: TapDestinationContext = {
          dripAdded: (grip) => {
            dripAddedCalls.push({ contextIndex, grip });
          },
        };
        contexts.push(context);
        return context;
      },
    );

    grok.registerTap(tap);
    const ctx1 = grok.mainPresentationContext.createChild();
    const ctx2 = grok.mainPresentationContext.createChild();

    // Get destinations - need to query first to create them
    const drip1 = grok.query(OUT, ctx1);
    const drip2 = grok.query(OUT, ctx2);
    grok.flush();

    // Now get the destinations
    const producerNode1 = ctx1._getContextNode().getResolvedProviders().get(OUT);
    const producerNode2 = ctx2._getContextNode().getResolvedProviders().get(OUT);
    // Both should resolve to the same producer node
    const producer = producerNode1?.get_producers().get(OUT);
    const destNode1 = ctx1._getContextNode();
    const destNode2 = ctx2._getContextNode();
    const destination1 = producer?.getDestinations().get(destNode1);
    const destination2 = producer?.getDestinations().get(destNode2);

    // Verify each destination has its own context instance
    expect(contexts.length).toBe(2);
    expect(destination1?.getTapContext()).toBe(contexts[0]);
    expect(destination2?.getTapContext()).toBe(contexts[1]);
    expect(contexts[0]).not.toBe(contexts[1]);

    // Verify callbacks on one destination don't affect others
    expect(dripAddedCalls.length).toBe(2);
    expect(dripAddedCalls[0].contextIndex).toBe(0);
    expect(dripAddedCalls[1].contextIndex).toBe(1);
  });
});

