import { describe, it, expect, beforeEach } from "vitest";
import { Grok } from "../src/core/grok";
import { GripRegistry, GripOf, Grip } from "../src/core/grip";
import type { Tap } from "../src/core/tap";
import { createAsyncValueTap } from "../src/core/async_tap";
import type { AsyncRequestState } from "../src/core/async_request_state";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Async State History", () => {
  let registry: GripRegistry;
  let defineGrip: ReturnType<typeof GripOf>;
  let grok: Grok;

  beforeEach(() => {
    registry = new GripRegistry();
    defineGrip = GripOf(registry);
    grok = new Grok(registry);
  });

  it("tracks state transitions in history", async () => {
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
      historySize: 10,
      requestKeyOf: () => "key1",
      fetcher: async () => {
        await sleep(50);
        return 42;
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild("ctx_1");
    const stateDrip = grok.query(STATE, ctx);

    await sleep(100);
    grok.flush();
    await sleep(10);

    const state = stateDrip.get();
    // Should have at least idle -> loading -> success transitions
    expect(state.history.length).toBeGreaterThanOrEqual(2);
    expect(state.history[0].state.type).toBe("idle"); // First entry should be idle (previous state)
  });

  it("maintains circular buffer when history size is exceeded", async () => {
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
      historySize: 3, // Small history size
      requestKeyOf: () => "key1",
      fetcher: async () => {
        await sleep(50);
        return 42;
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild("ctx_2");
    const stateDrip = grok.query(STATE, ctx);

    await sleep(100);
    grok.flush();
    await sleep(10);

    const state = stateDrip.get();
    // History should not exceed historySize
    expect(state.history.length).toBeLessThanOrEqual(3);
  });

  it("stores previous state in history entries", async () => {
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
      historySize: 10,
      requestKeyOf: () => "key1",
      fetcher: async () => {
        await sleep(50);
        return 42;
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild("ctx_3");
    const stateDrip = grok.query(STATE, ctx);

    await sleep(100);
    grok.flush();
    await sleep(10);

    const state = stateDrip.get();
    // History entries should store the state being exited
    if (state.history.length > 0) {
      // First entry should be idle (the state we exited from)
      expect(state.history[0].state.type).toBe("idle");
    }
    // Current state should be success (the state we entered)
    expect(state.state.type === "success" || state.state.type === "stale-while-revalidate").toBe(
      true,
    );
  });

  it("can disable history by setting historySize to 0", async () => {
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
      historySize: 0, // History disabled
      requestKeyOf: () => "key1",
      fetcher: async () => {
        await sleep(50);
        return 42;
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild("ctx_4");
    const stateDrip = grok.query(STATE, ctx);

    await sleep(100);
    grok.flush();
    await sleep(10);

    const state = stateDrip.get();
    // History should remain empty when disabled
    expect(state.history.length).toBe(0);
  });
});

