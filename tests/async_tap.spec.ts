import { describe, it, expect } from "vitest";
import { Grok } from "../src/core/grok";
import { GripRegistry, GripOf, Grip } from "../src/core/grip";
import type { Tap } from "../src/core/tap";
import { createAsyncValueTap, createAsyncMultiTap } from "../src/core/async_tap";

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => resolve(), ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    }
  });
}

describe("Async Tap basics", () => {
  it("latest-only delivery and cancellation work with out-of-order completions", async () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const PARAM = defineGrip<number>("Param", 0);
    const OUT = defineGrip<number>("Out", 0);
    const grok = new Grok(registry);
    const ctx = grok.mainPresentationContext.createChild();

    // Simple param handle
    const paramHandle = (await import("../src/core/atom_tap")).createAtomValueTap(PARAM, {
      initial: 1,
    }) as unknown as Tap;
    grok.registerTap(paramHandle);

    // Async tap: waits variable time based on param; older request arrives later (bigger sleep)
    const tap = createAsyncValueTap<number>({
      provides: OUT as Grip<number>,
      destinationParamGrips: [PARAM],
      requestKeyOf: (dest) => String(dest.get(PARAM)),
      fetcher: async (dest, signal) => {
        const n = dest.get(PARAM) ?? 0;
        // Larger n sleeps longer => older request will finish later when param changes quickly
        await sleep(50 * n, signal);
        return n * 10;
      },
      latestOnly: true,
      deadlineMs: 1000,
    });
    grok.registerTap(tap);

    // First value
    const d = grok.query(OUT, ctx);
    // Trigger chain: 1 -> 3 rapidly; the 1-request should be canceled/ignored, 3 wins
    (paramHandle as any).set(1);
    (paramHandle as any).set(2);
    (paramHandle as any).set(3);

    await sleep(200);
    expect(d.get()).toBe(30);

    // Change again to 1 (short delay), verify new value 10 appears
    (paramHandle as any).set(1);
    await sleep(80);
    expect(d.get()).toBe(10);
  });

  it("multi-output async tap publishes a typed map of outputs", async () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const PARAM = defineGrip<string>("Param", "A");
    const OUT1 = defineGrip<number>("Out1", 0);
    const OUT2 = defineGrip<string>("Out2", "");
    const STATE_X = defineGrip<number>("StateX", 1);
    const grok = new Grok(registry);
    const ctx = grok.mainPresentationContext.createChild();

    const paramHandle = (await import("../src/core/atom_tap")).createAtomValueTap(PARAM, {
      initial: "A",
    }) as unknown as Tap;
    grok.registerTap(paramHandle);

    const tap = createAsyncMultiTap<
      { A: typeof OUT1; B: typeof OUT2 },
      { x: number; y: string },
      { SX: typeof STATE_X }
    >({
      provides: [OUT1, OUT2],
      destinationParamGrips: [PARAM],
      handleGrip: undefined,
      initialState: [[STATE_X as any, 2]],
      requestKeyOf: (dest, getState) =>
        dest.get(PARAM)?.toLowerCase() + ":" + String(getState(STATE_X as any) ?? ""),
      fetcher: async (dest, signal, getState) => {
        const p = dest.get(PARAM) ?? "A";
        await sleep(20, signal);
        const mult = (getState(STATE_X as any) ?? 1) as number;
        return { x: p.length * mult, y: p + p };
      },
      mapResult: (_dest, r, _getState) =>
        new Map<any, any>([
          [OUT1 as any, r.x],
          [OUT2 as any, r.y],
        ]),
    });
    grok.registerTap(tap);

    const d1 = grok.query(OUT1, ctx);
    const d2 = grok.query(OUT2, ctx);
    await sleep(30);
    expect(d1.get()).toBe(2); // state multiplier = 2
    expect(d2.get()).toBe("AA");

    (paramHandle as any).set("Hi");
    await sleep(30);
    expect(d1.get()).toBe(4);
    expect(d2.get()).toBe("HiHi");

    // Change state and verify outputs recompute
    (tap as any).setState(STATE_X as any, 3);
    await sleep(30);
    expect(d1.get()).toBe(6);
  });
});
