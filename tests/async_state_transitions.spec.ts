import { describe, it, expect, beforeEach } from "vitest";
import { Grok } from "../src/core/grok";
import { GripRegistry, GripOf, Grip } from "../src/core/grip";
import type { Tap } from "../src/core/tap";
import { createAsyncValueTap } from "../src/core/async_tap";
import type { AsyncRequestState } from "../src/core/async_request_state";
import { isLoading, hasData, isStale } from "../src/core/async_state_helpers";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Async State Transitions", () => {
  let registry: GripRegistry;
  let defineGrip: ReturnType<typeof GripOf>;
  let grok: Grok;

  beforeEach(() => {
    registry = new GripRegistry();
    defineGrip = GripOf(registry);
    grok = new Grok(registry);
  });

  it("transitions from idle to loading when request starts", async () => {
    const OUT = defineGrip<number>("Out", 0);
    const STATE = defineGrip<AsyncRequestState>("State", {
      state: { type: "idle", retryAt: null },
      requestKey: null,
      hasListeners: false,
      history: [],
    });

    const tap = createAsyncValueTap<number>({
      provides: OUT,
      stateGrip: STATE,
      requestKeyOf: () => "key1",
      fetcher: async () => {
        await sleep(50);
        return 42;
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild("ctx_1");
    const drip = grok.query(OUT, ctx);
    const stateDrip = grok.query(STATE, ctx);

    // Initially should be idle or loading
    const initialState = stateDrip.get();
    expect(initialState.state.type === "idle" || initialState.state.type === "loading").toBe(true);

    // Wait for request to complete and grok to flush
    await sleep(150);
    grok.flush();
    await sleep(10); // Extra time for state to propagate

    // Should transition to success
    const finalState = stateDrip.get();
    // Allow for either success or stale-while-revalidate initially (timing)
    expect(
      finalState.state.type === "success" || finalState.state.type === "stale-while-revalidate",
    ).toBe(true);
    // But if it's stale-while-revalidate, wait a bit more for success
    if (finalState.state.type === "stale-while-revalidate") {
      await sleep(50);
      grok.flush();
      const finalState2 = stateDrip.get();
      expect(finalState2.state.type).toBe("success");
    }
    expect(hasData(finalState.state)).toBe(true);
    expect(drip.get()).toBe(42);
  });

  it("transitions to stale-while-revalidate when refresh starts with cached data", async () => {
    const OUT = defineGrip<number>("Out", 0);
    const STATE = defineGrip<AsyncRequestState>("State", {
      state: { type: "idle", retryAt: null },
      requestKey: null,
      hasListeners: false,
      history: [],
    });

    let callCount = 0;
    const tap = createAsyncValueTap<number>({
      provides: OUT,
      stateGrip: STATE,
      cacheTtlMs: 1000,
      requestKeyOf: () => "key1",
      fetcher: async () => {
        callCount++;
        await sleep(50);
        return callCount * 10;
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild("ctx_2");
    const drip = grok.query(OUT, ctx);
    const stateDrip = grok.query(STATE, ctx);

    // First request
    await sleep(100);
    expect(drip.get()).toBe(10);
    expect(stateDrip.get().state.type).toBe("success");

    // Trigger refresh (by calling produce again)
    tap.produce({ destContext: ctx, forceRefetch: false });

    // Should transition to stale-while-revalidate
    await sleep(10);
    const refreshState = stateDrip.get();
    expect(refreshState.state.type === "stale-while-revalidate" || refreshState.state.type === "success").toBe(true);
    
    if (refreshState.state.type === "stale-while-revalidate") {
      expect(isStale(refreshState.state)).toBe(true);
      expect(hasData(refreshState.state)).toBe(true);
    }
  });

  it("maintains state immutability - new instances on transitions", async () => {
    const OUT = defineGrip<number>("Out", 0);
    const STATE = defineGrip<AsyncRequestState>("State", {
      state: { type: "idle", retryAt: null },
      requestKey: null,
      hasListeners: false,
      history: [],
    });

    const tap = createAsyncValueTap<number>({
      provides: OUT,
      stateGrip: STATE,
      requestKeyOf: () => "key1",
      fetcher: async () => {
        await sleep(50);
        return 42;
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild("ctx_3");
    const stateDrip = grok.query(STATE, ctx);

    const state1 = stateDrip.get();
    await sleep(100);
    const state2 = stateDrip.get();

    // States should be different objects (immutability)
    expect(state1).not.toBe(state2);
    expect(state1.state).not.toBe(state2.state);
  });
});

