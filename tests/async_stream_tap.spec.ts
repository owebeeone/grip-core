import { afterEach, describe, expect, it, vi } from "vitest";
import { createAtomValueTap } from "../src/core/atom_tap";
import { createAsyncStreamMultiTap } from "../src/core/async_stream_tap";
import { GripOf, GripRegistry } from "../src/core/grip";
import { Grok } from "../src/core/grok";
import type { Tap } from "../src/core/tap";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamController<T>() {
  const queue: T[] = [];
  let waiting: ((value: IteratorResult<T>) => void) | null = null;
  let closed = false;
  return {
    push(value: T) {
      if (closed) return;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value, done: false });
      } else {
        queue.push(value);
      }
    },
    close() {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => {
              waiting = resolve;
            });
          },
        };
      },
    } satisfies AsyncIterable<T>,
  };
}

describe("Async stream multi tap", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes stream events and aborts when the last listener leaves", async () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const PARAM = defineGrip<string>("Param", "a");
    const OUT = defineGrip<string>("Out", "");
    const grok = new Grok(registry);
    const ctx = grok.mainPresentationContext.createChild();
    const paramTap = createAtomValueTap(PARAM, { initial: "a" }) as unknown as Tap;
    grok.registerTap(paramTap);

    const streams = new Map<string, ReturnType<typeof streamController<string>>>();
    const aborts: string[] = [];
    const tap = createAsyncStreamMultiTap<{ O: typeof OUT }, string>({
      provides: [OUT],
      destinationParamGrips: [PARAM],
      cleanupDelayMs: 0,
      requestKeyOf: (params) => params.get(PARAM),
      subscribe: (params, signal) => {
        const key = params.get(PARAM)!;
        const stream = streamController<string>();
        streams.set(key, stream);
        signal.addEventListener("abort", () => {
          aborts.push(key);
          stream.close();
        });
        return stream.iterable;
      },
      mapEvent: (_params, event) => new Map([[OUT, event]]),
    });
    grok.registerTap(tap);

    const drip = grok.query(OUT, ctx);
    const unsub = drip.subscribe(() => {});
    await sleep(0);
    streams.get("a")!.push("one");
    await sleep(0);
    expect(drip.get()).toBe("one");

    unsub();
    await sleep(0);
    await sleep(0);
    expect(aborts).toEqual(["a"]);
  });

  it("shares one stream for destinations with the same request key", async () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const PARAM = defineGrip<string>("Param", "shared");
    const OUT = defineGrip<string>("Out", "");
    const grok = new Grok(registry);
    const c1 = grok.mainPresentationContext.createChild();
    const c2 = grok.mainPresentationContext.createChild();
    const paramTap = createAtomValueTap(PARAM, { initial: "shared" }) as unknown as Tap;
    grok.registerTap(paramTap);

    const stream = streamController<string>();
    let subscribeCount = 0;
    grok.registerTap(
      createAsyncStreamMultiTap<{ O: typeof OUT }, string>({
        provides: [OUT],
        destinationParamGrips: [PARAM],
        cleanupDelayMs: 0,
        requestKeyOf: (params) => params.get(PARAM),
        subscribe: () => {
          subscribeCount += 1;
          return stream.iterable;
        },
        mapEvent: (_params, event) => new Map([[OUT, event]]),
      }),
    );

    const d1 = grok.query(OUT, c1);
    const d2 = grok.query(OUT, c2);
    d1.subscribe(() => {});
    d2.subscribe(() => {});
    await sleep(0);
    stream.push("shared-value");
    await sleep(0);

    expect(subscribeCount).toBe(1);
    expect(d1.get()).toBe("shared-value");
    expect(d2.get()).toBe("shared-value");
  });

  it("switches streams when destination params change", async () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const PARAM = defineGrip<string>("Param", "a");
    const OUT = defineGrip<string>("Out", "");
    const grok = new Grok(registry);
    const ctx = grok.mainPresentationContext.createChild();
    const paramTap = createAtomValueTap(PARAM, { initial: "a" }) as any;
    grok.registerTap(paramTap as Tap);

    const streams = new Map<string, ReturnType<typeof streamController<string>>>();
    const aborts: string[] = [];
    grok.registerTap(
      createAsyncStreamMultiTap<{ O: typeof OUT }, string>({
        provides: [OUT],
        destinationParamGrips: [PARAM],
        cleanupDelayMs: 0,
        requestKeyOf: (params) => params.get(PARAM),
        subscribe: (params, signal) => {
          const key = params.get(PARAM)!;
          const stream = streamController<string>();
          streams.set(key, stream);
          signal.addEventListener("abort", () => {
            aborts.push(key);
            stream.close();
          });
          return stream.iterable;
        },
        mapEvent: (_params, event) => new Map([[OUT, event]]),
      }),
    );

    const drip = grok.query(OUT, ctx);
    drip.subscribe(() => {});
    await sleep(0);
    streams.get("a")!.push("from-a");
    await sleep(0);
    expect(drip.get()).toBe("from-a");

    paramTap.set("b");
    await sleep(0);
    streams.get("b")!.push("from-b");
    await sleep(0);

    expect(aborts).toEqual(["a"]);
    expect(drip.get()).toBe("from-b");
  });

  it("replays the latest event to a later destination sharing the same key", async () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const PARAM = defineGrip<string>("Param", "shared");
    const OUT = defineGrip<string>("Out", "");
    const grok = new Grok(registry);
    const c1 = grok.mainPresentationContext.createChild();
    const c2 = grok.mainPresentationContext.createChild();
    const paramTap = createAtomValueTap(PARAM, { initial: "shared" }) as unknown as Tap;
    grok.registerTap(paramTap);

    const stream = streamController<string>();
    grok.registerTap(
      createAsyncStreamMultiTap<{ O: typeof OUT }, string>({
        provides: [OUT],
        destinationParamGrips: [PARAM],
        cleanupDelayMs: 0,
        requestKeyOf: (params) => params.get(PARAM),
        subscribe: () => stream.iterable,
        mapEvent: (_params, event) => new Map([[OUT, event]]),
      }),
    );

    const d1 = grok.query(OUT, c1);
    d1.subscribe(() => {});
    await sleep(0);
    stream.push("latest");
    await sleep(0);

    const d2 = grok.query(OUT, c2);
    d2.subscribe(() => {});
    await sleep(0);
    expect(d2.get()).toBe("latest");
  });

  it("retries failed streams with bounded jittered backoff", async () => {
    vi.useFakeTimers();
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const PARAM = defineGrip<string>("Param", "shared");
    const OUT = defineGrip<string>("Out", "");
    const grok = new Grok(registry);
    const ctx = grok.mainPresentationContext.createChild();
    grok.registerTap(createAtomValueTap(PARAM, { initial: "shared" }) as unknown as Tap);

    const stream = streamController<string>();
    const errors: string[] = [];
    let subscribeCount = 0;
    grok.registerTap(
      createAsyncStreamMultiTap<{ O: typeof OUT }, string>({
        provides: [OUT],
        destinationParamGrips: [PARAM],
        cleanupDelayMs: 0,
        retry: {
          initialDelayMs: 1000,
          maxDelayMs: 1000,
          jitterRatio: 0,
          random: () => 1,
        },
        requestKeyOf: (params) => params.get(PARAM),
        subscribe: () => {
          subscribeCount += 1;
          if (subscribeCount === 1) throw new Error("temporary");
          return stream.iterable;
        },
        mapEvent: (_params, event) => new Map([[OUT, event]]),
        onError: (error) => {
          errors.push((error as Error).message);
        },
      }),
    );

    const drip = grok.query(OUT, ctx);
    drip.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(subscribeCount).toBe(1);
    expect(errors).toEqual(["temporary"]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(subscribeCount).toBe(2);

    stream.push("after-retry");
    await vi.advanceTimersByTimeAsync(0);
    expect(drip.get()).toBe("after-retry");
  });

  it("cancels a pending retry when the last destination detaches", async () => {
    vi.useFakeTimers();
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const PARAM = defineGrip<string>("Param", "shared");
    const OUT = defineGrip<string>("Out", "");
    const grok = new Grok(registry);
    const ctx = grok.mainPresentationContext.createChild();
    grok.registerTap(createAtomValueTap(PARAM, { initial: "shared" }) as unknown as Tap);

    let subscribeCount = 0;
    grok.registerTap(
      createAsyncStreamMultiTap<{ O: typeof OUT }, string>({
        provides: [OUT],
        destinationParamGrips: [PARAM],
        cleanupDelayMs: 0,
        retry: {
          initialDelayMs: 1000,
          maxDelayMs: 1000,
          jitterRatio: 0,
          random: () => 1,
        },
        requestKeyOf: (params) => params.get(PARAM),
        subscribe: () => {
          subscribeCount += 1;
          throw new Error("temporary");
        },
        mapEvent: (_params, event) => new Map([[OUT, event]]),
      }),
    );

    const drip = grok.query(OUT, ctx);
    const unsubscribe = drip.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(subscribeCount).toBe(1);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(subscribeCount).toBe(1);
  });
});
