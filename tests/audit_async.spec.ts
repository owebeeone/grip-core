import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtomValueTap } from "../src/core/atom_tap";
import { createAsyncValueTap, BaseAsyncTap } from "../src/core/async_tap";
import { createAsyncStreamMultiTap } from "../src/core/async_stream_tap";
import type { AsyncTapController } from "../src/core/async_request_state";
import { Grok } from "../src/core/grok";
import { GripRegistry } from "../src/core/grip";
import type { Tap } from "../src/core/tap";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function streamController<T>() {
  const queued: T[] = [];
  let waiting: ((value: IteratorResult<T>) => void) | undefined,
    closed = false;
  return {
    push(value: T) {
      if (waiting) {
        const done = waiting;
        waiting = undefined;
        done({ value, done: false });
      } else queued.push(value);
    },
    close() {
      closed = true;
      if (waiting) {
        const done = waiting;
        waiting = undefined;
        done({ value: undefined, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            if (queued.length) return Promise.resolve({ value: queued.shift()!, done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              waiting = resolve;
            });
          },
        };
      },
    } satisfies AsyncIterable<T>,
  };
}

const cleanups: Array<() => void> = [];
function setup() {
  const registry = new GripRegistry(),
    grok = new Grok(registry);
  const ctx = grok.mainPresentationContext.createChild();
  function register(tap: Tap) {
    grok.registerTap(tap);
    cleanups.push(() => grok.unregisterTap(tap));
    return tap as BaseAsyncTap;
  }
  return { registry, grok, ctx, register };
}
async function settle(grok: Grok) {
  for (let i = 0; i < 16; i++) {
    grok.flush();
    await Promise.resolve();
  }
}

describe("audit async regressions", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("A1 retries a shared stream using a destination that still requests its key", async () => {
    const { registry, grok, ctx, register } = setup();
    const key = registry.defineGrip("key", "A"),
      out = registry.defineGrip<string>("out");
    const ctx2 = grok.mainPresentationContext.createChild();
    const first = new AtomValueTap(key, "A"),
      second = new AtomValueTap(key, "A");
    ctx.registerTap(first);
    ctx2.registerTap(second);
    const opened: string[] = [],
      streams: ReturnType<typeof streamController<string>>[] = [];
    register(
      createAsyncStreamMultiTap({
        provides: [out],
        destinationParamGrips: [key],
        cleanupDelayMs: 0,
        retry: { initialDelayMs: 20, jitterRatio: 0 },
        requestKeyOf: (p) => p.get(key),
        subscribe: (p, signal) => {
          const value = p.get(key)!;
          opened.push(value);
          const stream = streamController<string>();
          streams.push(stream);
          signal.addEventListener("abort", () => stream.close());
          return stream.iterable;
        },
        mapEvent: (_p, event) => new Map([[out, event]]),
      }),
    );
    const d1 = grok.query(out, ctx),
      d2 = grok.query(out, ctx2);
    d1.subscribe(() => {});
    d2.subscribe(() => {});
    await settle(grok);
    first.set("B");
    await settle(grok);
    streams[0].close();
    await settle(grok);
    await vi.advanceTimersByTimeAsync(20);
    await settle(grok);
    expect(opened).toEqual(["A", "B", "A"]);
    streams[2].push("A-value");
    await settle(grok);
    expect(d2.get()).toBe("A-value");
    expect(d1.get()).not.toBe("A-value");
  });

  it.each([false, true])(
    "A2 makes one initial request without cache (reject %s)",
    async (reject) => {
      const { registry, grok, ctx, register } = setup();
      const out = registry.defineGrip<number>("out");
      const fetcher = vi.fn(async () => {
        if (reject) throw Error("failed");
        return 1;
      });
      register(createAsyncValueTap({ provides: out, requestKeyOf: () => "key", fetcher }));
      const drip = grok.query(out, ctx);
      drip.subscribe(() => {});
      await settle(grok);
      expect(fetcher).toHaveBeenCalledTimes(1);
      if (!reject) expect(drip.get()).toBe(1);
    },
  );

  it("A3 actually refreshes before cache expiry and returns to success", async () => {
    const { registry, grok, ctx, register } = setup();
    const out = registry.defineGrip<number>("out"),
      refresh = deferred<number>();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(() => refresh.promise);
    const tap = register(
      createAsyncValueTap({
        provides: out,
        cacheTtlMs: 100,
        refreshBeforeExpiryMs: 60,
        requestKeyOf: () => "key",
        fetcher,
      }),
    );
    const drip = grok.query(out, ctx);
    drip.subscribe(() => {});
    await settle(grok);
    await vi.advanceTimersByTimeAsync(40);
    await settle(grok);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(drip.get()).toBe(1);
    expect(tap.getRequestState(ctx).state.type).toBe("stale-while-revalidate");
    refresh.resolve(2);
    await settle(grok);
    expect(drip.get()).toBe(2);
    expect(tap.getRequestState(ctx).state.type).toBe("success");
  });

  it("A4 ignores an old aborted A rejection after newer A success", async () => {
    const { registry, grok, ctx, register } = setup();
    const key = registry.defineGrip("key", "A"),
      out = registry.defineGrip<number>("out");
    const atom = new AtomValueTap(key, "A");
    grok.registerTap(atom);
    const requests: Array<
      ReturnType<typeof deferred<number>> & { key: string; signal: AbortSignal }
    > = [];
    const tap = register(
      createAsyncValueTap({
        provides: out,
        destinationParamGrips: [key],
        cacheTtlMs: 1000,
        requestKeyOf: (p) => p.get(key),
        fetcher: (p, signal) => {
          const d = deferred<number>();
          requests.push({ ...d, key: p.get(key)!, signal });
          return d.promise;
        },
      }),
    );
    const drip = grok.query(out, ctx);
    drip.subscribe(() => {});
    await settle(grok);
    atom.set("B");
    await settle(grok);
    atom.set("A");
    await settle(grok);
    expect(requests.map((r) => r.key)).toEqual(["A", "B", "A"]);
    requests[2].resolve(99);
    await settle(grok);
    expect(tap.getRequestState(ctx).state.type).toBe("success");
    requests[0].reject(Error("obsolete"));
    await settle(grok);
    expect(drip.get()).toBe(99);
    expect(tap.getRequestState(ctx).state.type).toBe("success");
  });

  it.each([1, 2, 4])("A5 shares retry budget across %s destinations", async (count) => {
    const { registry, grok, ctx, register } = setup();
    const out = registry.defineGrip<number>("out");
    const fetcher = vi.fn(async () => {
      throw Error("failed");
    });
    register(
      createAsyncValueTap({
        provides: out,
        cacheTtlMs: 1000,
        requestKeyOf: () => "key",
        fetcher,
        retry: { maxRetries: 2, initialDelayMs: 25 },
      }),
    );
    for (let i = 0; i < count; i++)
      grok.query(out, i ? grok.mainPresentationContext.createChild() : ctx).subscribe(() => {});
    await settle(grok);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    await settle(grok);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    await settle(grok);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("A4 keeps a shared request alive when its originating destination changes key", async () => {
    const { registry, grok, ctx, register } = setup();
    const key = registry.defineGrip("key", "A"),
      out = registry.defineGrip<number>("out");
    const ctx2 = grok.mainPresentationContext.createChild(),
      atom = new AtomValueTap(key, "A");
    ctx.registerTap(atom);
    const requests: Array<
      ReturnType<typeof deferred<number>> & { key: string; signal: AbortSignal }
    > = [];
    register(
      createAsyncValueTap({
        provides: out,
        destinationParamGrips: [key],
        requestKeyOf: (p) => p.get(key),
        fetcher: (p, signal) => {
          const d = deferred<number>();
          requests.push({ ...d, key: p.get(key)!, signal });
          return d.promise;
        },
      }),
    );
    const first = grok.query(out, ctx),
      second = grok.query(out, ctx2);
    first.subscribe(() => {});
    second.subscribe(() => {});
    await settle(grok);
    atom.set("B");
    await settle(grok);
    expect(requests[0].signal.aborted).toBe(false);
    requests[0].resolve(10);
    await settle(grok);
    expect(second.get()).toBe(10);
    expect(first.get()).not.toBe(10);
  });

  it("A4 old completion cannot remove the replacement pending entry", async () => {
    const { registry, grok, ctx, register } = setup();
    const key = registry.defineGrip("key", "A"),
      out = registry.defineGrip<number>("out"),
      atom = new AtomValueTap(key, "A");
    ctx.registerTap(atom);
    const requests: Array<ReturnType<typeof deferred<number>> & { key: string }> = [];
    register(
      createAsyncValueTap({
        provides: out,
        destinationParamGrips: [key],
        requestKeyOf: (p) => p.get(key),
        fetcher: (p) => {
          const d = deferred<number>();
          requests.push({ ...d, key: p.get(key)! });
          return d.promise;
        },
      }),
    );
    grok.query(out, ctx).subscribe(() => {});
    await settle(grok);
    atom.set("B");
    await settle(grok);
    atom.set("A");
    await settle(grok);
    requests[0].reject(Error("old"));
    await settle(grok);
    const second = grok.query(out, grok.mainPresentationContext.createChild());
    second.subscribe(() => {});
    await settle(grok);
    expect(requests).toHaveLength(3);
    requests[2].resolve(8);
    await settle(grok);
    expect(second.get()).toBe(8);
  });

  it("A6 preserves another destination's retry eligibility when one cancels", async () => {
    const { registry, grok, ctx, register } = setup();
    const out = registry.defineGrip<number>("out"),
      control = registry.defineGrip<AsyncTapController>("control");
    const fetcher = vi.fn(async () => {
      throw Error("failed");
    });
    const tap = register(
      createAsyncValueTap({
        provides: out,
        controllerGrip: control,
        requestKeyOf: () => "key",
        fetcher,
        retry: { maxRetries: 2, initialDelayMs: 50 },
      }),
    );
    const second = grok.mainPresentationContext.createChild();
    const controller = grok.query(control, ctx);
    controller.subscribe(() => {});
    grok.query(out, second).subscribe(() => {});
    await settle(grok);
    controller.get()!.cancelRetry();
    await vi.advanceTimersByTimeAsync(50);
    await settle(grok);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(tap.getRequestState(ctx).state.retryAt).toBeNull();
    expect(tap.getRequestState(second).state.retryAt).not.toBeNull();
  });

  it("A6 cancels the sole destination's scheduled retry", async () => {
    const { registry, grok, ctx, register } = setup();
    const out = registry.defineGrip<number>("out"),
      control = registry.defineGrip<AsyncTapController>("control");
    const fetcher = vi.fn(async () => {
      throw Error("failed");
    });
    register(
      createAsyncValueTap({
        provides: out,
        controllerGrip: control,
        cacheTtlMs: 1000,
        requestKeyOf: () => "key",
        fetcher,
        retry: { maxRetries: 3, initialDelayMs: 50 },
      }),
    );
    const controller = grok.query(control, ctx);
    controller.subscribe(() => {});
    await settle(grok);
    const before = fetcher.mock.calls.length;
    controller.get()!.cancelRetry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(before);
  });

  it("A7 replays the latest event for a new grip in an existing destination", async () => {
    const { registry, grok, ctx, register } = setup();
    const a = registry.defineGrip<number>("a"),
      b = registry.defineGrip<number>("b"),
      stream = streamController<number>();
    const subscribe = vi.fn((_p, signal: AbortSignal) => {
      signal.addEventListener("abort", () => stream.close());
      return stream.iterable;
    });
    register(
      createAsyncStreamMultiTap({
        provides: [a, b],
        requestKeyOf: () => "key",
        subscribe,
        mapEvent: (_p, value) =>
          new Map([
            [a, value],
            [b, value * 2],
          ]),
      }),
    );
    grok.query(a, ctx).subscribe(() => {});
    await settle(grok);
    stream.push(7);
    await settle(grok);
    const drip = grok.query(b, ctx);
    drip.subscribe(() => {});
    await settle(grok);
    expect(drip.get()).toBe(14);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "A8 initializes a late controller (fetch completed %s)",
    async (completed) => {
      const { registry, grok, ctx, register } = setup();
      const out = registry.defineGrip<number>("out"),
        control = registry.defineGrip<AsyncTapController>("control"),
        request = deferred<number>();
      const fetcher = vi.fn(() => request.promise);
      register(
        createAsyncValueTap({
          provides: out,
          controllerGrip: control,
          cacheTtlMs: 1000,
          requestKeyOf: () => "key",
          fetcher,
        }),
      );
      grok.query(out, ctx).subscribe(() => {});
      await settle(grok);
      if (completed) {
        request.resolve(1);
        await settle(grok);
      }
      const drip = grok.query(control, ctx);
      drip.subscribe(() => {});
      await settle(grok);
      expect(drip.get()?.refresh).toBeTypeOf("function");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("A9 treats a synchronous fetcher throw as a failed request", async () => {
    const { registry, grok, ctx, register } = setup();
    const out = registry.defineGrip<number>("out");
    const fetcher = vi.fn(() => {
      throw Error("sync-fetch");
    });
    const tap = register(
      createAsyncValueTap({ provides: out, requestKeyOf: () => "key", fetcher }),
    );
    expect(() => grok.query(out, ctx)).not.toThrow();
    await settle(grok);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(tap.getRequestState(ctx).state.type).toBe("error");
  });

  it("R1 undefined input leaves a peer's shared request alive", async () => {
    const { registry, grok, ctx, register } = setup();
    const key = registry.defineGrip<string | undefined>("key"),
      out = registry.defineGrip<number>("out");
    const peer = grok.mainPresentationContext.createChild();
    const atom = new AtomValueTap(key, "A");
    ctx.registerTap(atom);
    peer.registerTap(new AtomValueTap(key, "A"));
    const request = deferred<number>();
    let signal!: AbortSignal;
    const tap = register(
      createAsyncValueTap({
        provides: out,
        destinationParamGrips: [key],
        requestKeyOf: (p) => p.get(key),
        fetcher: (_p, s) => {
          signal = s;
          s.addEventListener("abort", () => request.reject(Error("aborted")));
          return request.promise;
        },
      }),
    );
    const first = grok.query(out, ctx),
      second = grok.query(out, peer);
    first.subscribe(() => {});
    second.subscribe(() => {});
    await settle(grok);
    atom.set(undefined);
    await settle(grok);
    expect(signal.aborted).toBe(false);
    expect(first.get()).toBeUndefined();
    expect(tap.getRequestState(ctx).state.type).toBe("idle");
    request.resolve(9);
    await settle(grok);
    expect(second.get()).toBe(9);
    expect(first.get()).toBeUndefined();
  });

  it.each([
    { action: "refresh", shared: false },
    { action: "retry", shared: false },
    { action: "refresh", shared: true },
    { action: "retry", shared: true },
  ] as const)(
    "R2 $action during loading replaces work (shared $shared)",
    async ({ action, shared }) => {
      const { registry, grok, ctx, register } = setup();
      const out = registry.defineGrip<number>("out"),
        control = registry.defineGrip<AsyncTapController>("control");
      const requests: ReturnType<typeof deferred<number>>[] = [];
      register(
        createAsyncValueTap({
          provides: out,
          controllerGrip: control,
          requestKeyOf: () => "key",
          fetcher: (_p, signal) => {
            const request = deferred<number>();
            requests.push(request);
            signal.addEventListener("abort", () => request.reject(Error("aborted")));
            return request.promise;
          },
        }),
      );
      const data = grok.query(out, ctx),
        controller = grok.query(control, ctx);
      const peer = shared ? grok.query(out, grok.mainPresentationContext.createChild()) : undefined;
      data.subscribe(() => {});
      controller.subscribe(() => {});
      peer?.subscribe(() => {});
      await settle(grok);
      controller.get()![action](true);
      await settle(grok);
      expect(requests).toHaveLength(2);
      requests[1].resolve(2);
      await settle(grok);
      expect(data.get()).toBe(2);
      if (peer) expect(peer.get()).toBe(2);
    },
  );

  it("R3 deadline failure leaves loading and obeys the retry budget", async () => {
    const { registry, grok, ctx, register } = setup();
    const out = registry.defineGrip<number>("out");
    const fetcher = vi.fn(
      (_p, signal: AbortSignal) =>
        new Promise<number>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(Error("deadline"))),
        ),
    );
    const tap = register(
      createAsyncValueTap({
        provides: out,
        deadlineMs: 10,
        requestKeyOf: () => "key",
        fetcher,
        retry: { maxRetries: 1, initialDelayMs: 10 },
      }),
    );
    grok.query(out, ctx).subscribe(() => {});
    await settle(grok);
    await vi.advanceTimersByTimeAsync(10);
    await settle(grok);
    expect(tap.getRequestState(ctx).state.type).toBe("error");
    expect(tap.getRequestState(ctx).state.retryAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    await settle(grok);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    await settle(grok);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(tap.getRequestState(ctx).state.type).toBe("error");
    expect(tap.getRequestState(ctx).state.retryAt).toBeNull();
  });

  it.each([false, true])(
    "R1 honors keepStaleDataOnTransition=%s for missing parameters",
    async (preserve) => {
      const { registry, grok, ctx, register } = setup();
      const key = registry.defineGrip<string | undefined>("key"),
        out = registry.defineGrip<number>("out"),
        atom = new AtomValueTap(key, "A");
      ctx.registerTap(atom);
      const tap = register(
        createAsyncValueTap({
          provides: out,
          destinationParamGrips: [key],
          keepStaleDataOnTransition: preserve,
          requestKeyOf: (p) => p.get(key),
          fetcher: async () => 7,
        }),
      );
      const drip = grok.query(out, ctx);
      drip.subscribe(() => {});
      await settle(grok);
      expect(drip.get()).toBe(7);
      atom.set(undefined);
      await settle(grok);
      expect(drip.get()).toBe(preserve ? 7 : undefined);
      expect(tap.getRequestState(ctx).state.type).toBe("idle");
    },
  );
});
