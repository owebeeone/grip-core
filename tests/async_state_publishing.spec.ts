import { describe, it, expect, beforeEach } from "vitest";
import { Grok } from "../src/core/grok";
import { GripRegistry, GripOf, Grip } from "../src/core/grip";
import type { Tap } from "../src/core/tap";
import { createAsyncValueTap } from "../src/core/async_tap";
import type { AsyncRequestState } from "../src/core/async_request_state";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Async State Publishing", () => {
  let registry: GripRegistry;
  let defineGrip: ReturnType<typeof GripOf>;
  let grok: Grok;

  beforeEach(() => {
    registry = new GripRegistry();
    defineGrip = GripOf(registry);
    grok = new Grok(registry);
  });

  it("publishes state per destination independently", async () => {
    const OUT = defineGrip<number>("Out", 0);
    const STATE1 = defineGrip<AsyncRequestState>("State1", {
      state: { type: "idle", retryAt: null },
      requestKey: null,
      hasListeners: false,
      history: [],
    });
    const STATE2 = defineGrip<AsyncRequestState>("State2", {
      state: { type: "idle", retryAt: null },
      requestKey: null,
      hasListeners: false,
      history: [],
    });

    const tap1 = createAsyncValueTap<number>({
      provides: OUT,
      stateGrip: STATE1,
      requestKeyOf: () => "key1",
      fetcher: async () => {
        await sleep(50);
        return 10;
      },
    });
    const tap2 = createAsyncValueTap<number>({
      provides: OUT,
      stateGrip: STATE2,
      requestKeyOf: () => "key2",
      fetcher: async () => {
        await sleep(50);
        return 20;
      },
    });
    grok.registerTap(tap1);
    grok.registerTap(tap2);

    const ctx1 = grok.mainPresentationContext.createChild("ctx_1");
    const ctx2 = grok.mainPresentationContext.createChild("ctx_2");
    const stateDrip1 = grok.query(STATE1, ctx1);
    const stateDrip2 = grok.query(STATE2, ctx2);

    await sleep(100);
    grok.flush();

    // Each destination should have independent state
    const state1 = stateDrip1.get();
    const state2 = stateDrip2.get();
    expect(state1).not.toBe(state2);
    expect(state1.state).not.toBe(state2.state);
  });

  it("persists state across request key changes", async () => {
    const OUT = defineGrip<number>("Out", 0);
    const PARAM = defineGrip<string>("Param", "");
    const STATE = defineGrip<AsyncRequestState>("State", {
      state: { type: "idle", retryAt: null },
      requestKey: null,
      hasListeners: false,
      history: [],
    });

    const paramHandle = (await import("../src/core/atom_tap")).createAtomValueTap(PARAM, {
      initial: "key1",
    }) as unknown as Tap;
    grok.registerTap(paramHandle);

    const tap = createAsyncValueTap<number>({
      provides: OUT,
      stateGrip: STATE,
      destinationParamGrips: [PARAM],
      requestKeyOf: (params) => params.get(PARAM) ?? undefined,
      fetcher: async () => {
        await sleep(50);
        return 42;
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild("ctx_3");
    const stateDrip = grok.query(STATE, ctx);

    // First request
    await sleep(100);
    grok.flush();
    const state1 = stateDrip.get();
    expect(state1.requestKey).toBe("key1");

    // Change parameter (request key changes)
    (paramHandle as any).set("key2");
    await sleep(100);
    grok.flush();

    const state2 = stateDrip.get();
    expect(state2.requestKey).toBe("key2");
    // State should persist (not reset to idle) - history should be preserved
    expect(state2.history.length).toBeGreaterThan(0);
  });
});

