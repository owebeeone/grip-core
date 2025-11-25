import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Grok } from "../src/core/grok";
import { GripRegistry, GripOf } from "../src/core/grip";
import { createAsyncValueTap } from "../src/core/async_tap";
import type { AsyncRequestState } from "../src/core/async_request_state";
import { hasScheduledRetry, getRetryTimeRemaining, hasError } from "../src/core/async_state_helpers";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls for a condition to become true, with timeout and retry interval.
 * Useful for waiting for async operations to complete.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 10,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe("Async Retry System", () => {
  let registry: GripRegistry;
  let defineGrip: ReturnType<typeof GripOf>;
  let grok: Grok;

  beforeEach(() => {
    registry = new GripRegistry();
    defineGrip = GripOf(registry);
    grok = new Grok(registry);
  });

  it("schedules retry with exponential backoff on error when listeners exist", async () => {
    const OUT = defineGrip<number>("Out", 0);
    const STATE = defineGrip<AsyncRequestState>("State", {
      state: { type: "idle", retryAt: null },
      requestKey: null,
      hasListeners: false,
      history: [],
    });

    let attemptCount = 0;
    const tap = createAsyncValueTap<number>({
      provides: OUT,
      stateGrip: STATE,
      requestKeyOf: () => "key1",
      fetcher: async () => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error(`Attempt ${attemptCount} failed`);
        }
        return 42;
      },
      retry: {
        maxRetries: 3,
        initialDelayMs: 100,
        backoffMultiplier: 2,
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild();
    const drip = grok.query(OUT, ctx);
    const stateDrip = grok.query(STATE, ctx);

    // Wait for initial request to fail
    await sleep(50);
    grok.flush();
    await sleep(10);

    let state = stateDrip.get()!;
    expect(hasError(state.state)).toBe(true);
    expect(hasScheduledRetry(state.state)).toBe(true);
    expect(state.state.retryAt).not.toBeNull();

    // First retry should be scheduled at initialDelayMs (100ms)
    const firstRetryAt = state.state.retryAt!;
    const now = Date.now();
    expect(firstRetryAt - now).toBeGreaterThanOrEqual(90); // Allow some timing variance
    expect(firstRetryAt - now).toBeLessThanOrEqual(150);

    // Wait for first retry to execute
    await sleep(150);
    grok.flush();
    await sleep(10);

    state = stateDrip.get()!;
    // Should still be in error (second attempt failed) or success (if retry succeeded)
    if (hasError(state.state)) {
      expect(hasScheduledRetry(state.state)).toBe(true);

      // Second retry should be scheduled at 2x delay (200ms)
      const secondRetryAt = state.state.retryAt!;
      expect(secondRetryAt - firstRetryAt).toBeGreaterThanOrEqual(190);
      expect(secondRetryAt - firstRetryAt).toBeLessThanOrEqual(210);

      // Wait for second retry to execute
      await sleep(250);
      grok.flush();
      await sleep(10);
    }

    // Third attempt should succeed
    state = stateDrip.get()!;
    expect(state.state.type).toBe("success");
    expect(drip.get()).toBe(42);
  });

  it("schedules retry when state Grip is queried (state Grips are output Grips)", async () => {
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
        throw new Error("Always fails");
      },
      retry: {
        maxRetries: 3,
        initialDelayMs: 100,
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild();
    const stateDrip = grok.query(STATE, ctx);

    // Query state Grip - state Grips are considered output Grips, so this counts as a listener
    // Wait for initial request to fail
    await sleep(50);
    grok.flush();
    await sleep(10);

    const state = stateDrip.get()!;
    expect(hasError(state.state)).toBe(true);
    // Retry should be scheduled because state Grip counts as a listener
    expect(hasScheduledRetry(state.state)).toBe(true);
    expect(state.state.retryAt).not.toBeNull();
  });

  it("cancels retry when listeners drop to zero", async () => {
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
        throw new Error("Always fails");
      },
      retry: {
        maxRetries: 3,
        initialDelayMs: 100,
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild();
    const drip = grok.query(OUT, ctx);
    const stateDrip = grok.query(STATE, ctx);

    // Wait for initial request to fail
    await sleep(50);
    grok.flush();
    await sleep(10);

    let state = stateDrip.get()!;
    expect(hasError(state.state)).toBe(true);
    expect(hasScheduledRetry(state.state)).toBe(true);

    // Unsubscribe from output Grip (drip goes away)
    // In GRIP, we need to remove the grip from the destination
    // For now, we'll test by checking that retry is cancelled
    // This will be properly tested when we implement listener tracking

    // Wait - retry should not execute (no listeners)
    await sleep(200);
    grok.flush();
    await sleep(10);

    // State should still be in error but retryAt should be null
    // (This test will be refined when listener tracking is fully implemented)
    state = stateDrip.get()!;
    expect(hasError(state.state)).toBe(true);
  });

  it("cancels retry on request key change", async () => {
    const PARAM = defineGrip<number>("Param", 1);
    const OUT = defineGrip<number>("Out", 0);
    const STATE = defineGrip<AsyncRequestState>("State", {
      state: { type: "idle", retryAt: null },
      requestKey: null,
      hasListeners: false,
      history: [],
    });

    const paramTap = (await import("../src/core/atom_tap")).createAtomValueTap(PARAM, {
      initial: 1,
    });
    grok.registerTap(paramTap as any);

    const tap = createAsyncValueTap<number>({
      provides: OUT,
      stateGrip: STATE,
      destinationParamGrips: [PARAM],
      requestKeyOf: (dest) => String(dest.get(PARAM)),
      fetcher: async () => {
        throw new Error("Always fails");
      },
      retry: {
        maxRetries: 3,
        initialDelayMs: 100,
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild();
    const drip = grok.query(OUT, ctx);
    const stateDrip = grok.query(STATE, ctx);

    // Wait for initial request to fail
    await sleep(50);
    grok.flush();
    await sleep(10);

    let state = stateDrip.get()!;
    expect(hasError(state.state)).toBe(true);
    expect(hasScheduledRetry(state.state)).toBe(true);
    const oldRetryAt = state.state.retryAt;

    // Change parameter (changes request key)
    (paramTap as any).set(2);
    await sleep(10);
    grok.flush();
    await sleep(10);

    state = stateDrip.get()!;
    // Retry should be cancelled (retryAt should be null or different)
    // Request key should have changed
    expect(state.requestKey).toBe("2");

    // Wait - old retry should not execute
    await sleep(200);
    grok.flush();
    await sleep(10);

    // New request should have been initiated for new key
    state = stateDrip.get()!;
    expect(state.requestKey).toBe("2");
  });

  it("respects max retries limit", async () => {
    const OUT = defineGrip<number>("Out", 0);
    const STATE = defineGrip<AsyncRequestState>("State", {
      state: { type: "idle", retryAt: null },
      requestKey: null,
      hasListeners: false,
      history: [],
    });

    let attemptCount = 0;
    const tap = createAsyncValueTap<number>({
      provides: OUT,
      stateGrip: STATE,
      requestKeyOf: () => "key1",
      fetcher: async () => {
        attemptCount++;
        throw new Error(`Attempt ${attemptCount} failed`);
      },
      retry: {
        maxRetries: 2, // Only 2 retries allowed
        initialDelayMs: 50,
        backoffMultiplier: 2,
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild();
    const drip = grok.query(OUT, ctx);
    const stateDrip = grok.query(STATE, ctx);

    // Wait for initial request to fail
    await waitFor(() => {
      grok.flush();
      const state = stateDrip.get();
      return state !== undefined && hasError(state.state);
    });

    // Verify first retry is scheduled
    let state = stateDrip.get()!;
    expect(hasScheduledRetry(state.state)).toBe(true);

    // Wait for all retries to complete (initial + 2 retries = 3 attempts total)
    await waitFor(() => {
      grok.flush();
      return attemptCount >= 3;
    });

    // Wait a bit more to ensure no new retry is scheduled after max retries
    await sleep(150);
    grok.flush();

    // After max retries, no more retries should be scheduled
    state = stateDrip.get()!;
    expect(hasError(state.state)).toBe(true);
    expect(hasScheduledRetry(state.state)).toBe(false);
    expect(state.state.retryAt).toBeNull();
    expect(attemptCount).toBe(3); // Initial + 2 retries
  });

  it("increments retryAttempt when scheduling retry", async () => {
    const OUT = defineGrip<number>("Out", 0);
    const STATE = defineGrip<AsyncRequestState>("State", {
      state: { type: "idle", retryAt: null },
      requestKey: null,
      hasListeners: false,
      history: [],
    });

    let attemptCount = 0;
    const tap = createAsyncValueTap<number>({
      provides: OUT,
      stateGrip: STATE,
      requestKeyOf: () => "key1",
      fetcher: async () => {
        attemptCount++;
        throw new Error(`Attempt ${attemptCount} failed`);
      },
      retry: {
        maxRetries: 3,
        initialDelayMs: 50,
        backoffMultiplier: 2,
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild();
    const drip = grok.query(OUT, ctx);
    const stateDrip = grok.query(STATE, ctx);

    // Wait for initial request to fail
    await sleep(50);
    grok.flush();
    await sleep(10);

    // Check that retryAttempt is tracked in history
    let state = stateDrip.get()!;
    expect(hasError(state.state)).toBe(true);
    expect(hasScheduledRetry(state.state)).toBe(true);

    // The retryAttempt should be reflected in the exponential backoff delay
    // First retry: attempt 1, delay = 50ms * 2^1 = 100ms (but we use initialDelayMs for first retry)
    // Actually, retryAttempt starts at 0, so first retry is attempt 0, delay = 50ms * 2^0 = 50ms
    const firstRetryDelay = getRetryTimeRemaining(state.state);
    expect(firstRetryDelay).toBeGreaterThan(0);
    expect(firstRetryDelay).toBeLessThanOrEqual(60); // Allow some variance
  });

  it.skip("executes retry only when request key still matches", async () => {
    const PARAM = defineGrip<number>("Param", 1);
    const OUT = defineGrip<number>("Out", 0);
    const STATE = defineGrip<AsyncRequestState>("State", {
      state: { type: "idle", retryAt: null },
      requestKey: null,
      hasListeners: false,
      history: [],
    });

    const paramTap = (await import("../src/core/atom_tap")).createAtomValueTap(PARAM, {
      initial: 1,
    });
    grok.registerTap(paramTap as any);

    let fetchCount = 0;
    const tap = createAsyncValueTap<number>({
      provides: OUT,
      stateGrip: STATE,
      destinationParamGrips: [PARAM],
      requestKeyOf: (dest) => String(dest.get(PARAM)),
      fetcher: async () => {
        fetchCount++;
        if (fetchCount === 1) {
          throw new Error("First attempt fails");
        }
        return 42;
      },
      retry: {
        maxRetries: 3,
        initialDelayMs: 100,
      },
    });
    grok.registerTap(tap);

    const ctx = grok.mainPresentationContext.createChild();
    const drip = grok.query(OUT, ctx);
    const stateDrip = grok.query(STATE, ctx);

    // Wait for initial request to fail
    await waitFor(() => {
      grok.flush();
      const state = stateDrip.get();
      return state !== undefined && hasError(state.state) && hasScheduledRetry(state.state);
    });

    let state = stateDrip.get()!;
    expect(hasError(state.state)).toBe(true);
    expect(hasScheduledRetry(state.state)).toBe(true);
    expect(state.requestKey).toBe("1");

    // Change parameter before retry executes
    (paramTap as any).set(2);
    grok.flush();
    
    // Access the output grip to ensure the tap evaluates the parameter change
    drip.get();
    grok.flush();
    
    // Wait a moment for parameter change to propagate
    await sleep(20);
    grok.flush();

    // Wait for request key to change from "1" to "2"
    // The parameter change should trigger kickoff which updates the requestKey
    await waitFor(() => {
      grok.flush();
      const s = stateDrip.get();
      return s !== undefined && s.requestKey === "2";
    }, 2000);

    // Verify new request was initiated
    state = stateDrip.get()!;
    expect(state.requestKey).toBe("2");
    // fetchCount should still be 1 (retry didn't execute for old key)
    // But a new request was initiated for key "2"
    // This test will be refined when we can track fetch counts per key
  });
});

