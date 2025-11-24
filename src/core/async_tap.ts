/**
 * GRIP Async Tap System - Asynchronous data fetching with caching and cancellation
 *
 * Provides base classes and factory functions for creating Taps that fetch data
 * asynchronously from external sources (APIs, databases, etc.). Handles complex
 * scenarios like request deduplication, caching, cancellation, and stale-while-revalidate.
 *
 * Key Features:
 * - Per-destination request cancellation and state management
 * - LRU-TTL caching with configurable TTL
 * - Request deduplication and coalescing
 * - Deadline-based request timeouts
 * - Stale-while-revalidate pattern
 * - Latest-only request filtering
 * - Home-only and destination-aware variants
 *
 * Architecture:
 * - BaseAsyncTap: Abstract base with async lifecycle management
 * - SingleOutputAsyncTap: Single Grip output with destination parameters
 * - SingleOutputHomeAsyncTap: Single Grip output with home parameters only
 * - MultiOutputAsyncTap: Multiple Grip outputs with optional state management
 * - MultiOutputHomeAsyncTap: Multi-output with home parameters only
 */

import { BaseTap } from "./base_tap";
import { Grip } from "./grip";
import type { GripContext } from "./context";
import type { DestinationParams } from "./graph";
import type { AsyncCache } from "./async_cache";
import { LruTtlCache } from "./async_cache";
import type { Tap } from "./tap";
import type { GripRecord, GripValue, Values, FunctionTapHandle } from "./function_tap";
import type {
  RequestState,
  AsyncRequestState,
  AsyncTapController,
  RetryConfig,
  StateHistoryEntry,
} from "./async_request_state";
import { consola } from "./logger";

const logger = consola.withTag("core/async_tap.ts");

/**
 * Per-destination state tracking for async operations.
 *
 * Manages:
 * - AbortController for request cancellation
 * - Request sequence numbers for latest-only filtering
 * - Request keys for caching and deduplication
 * - Deadline timers for request timeouts
 * - Retry state for failed requests
 * - Phase 2: State tracking fields
 */
interface DestState {
  controller?: AbortController; // Phase 2: Keep for backward compatibility, will use abortController
  abortController?: AbortController; // Phase 2: Dedicated AbortController for in-flight requests
  seq: number;
  key?: string; // Phase 2: Keep for backward compatibility, will use requestKey
  requestKey?: string | null; // Phase 2: The cache key for this request
  deadlineTimer?: any;
  pendingRetryArmed?: boolean;
  // Phase 2: State tracking fields
  currentState: RequestState;
  listenerCount: number;
  retryAttempt: number;
  retryTimer?: any | null;
  refreshTimer?: any | null;
  history: StateHistoryEntry[];
  historySize: number;
  tapController?: AsyncTapController; // Controller instance (different from AbortController)
}

/**
 * Configuration options for async Taps.
 *
 * @param debounceMs - Debounce parameter changes (apply at caller site)
 * @param cache - Custom cache implementation (default: LruTtlCache)
 * @param cacheTtlMs - Cache TTL in milliseconds (0 = no caching)
 * @param latestOnly - Only process latest request per destination (default: true)
 * @param deadlineMs - Request timeout in milliseconds (0 = no timeout)
 * @param historySize - Number of state transitions to keep in history (default: 10, 0 = disabled)
 * @param retry - Retry configuration for exponential backoff
 * @param refreshBeforeExpiryMs - Refresh data before TTL expires (milliseconds before expiry)
 */
export interface BaseAsyncTapOptions {
  debounceMs?: number;
  cache?: AsyncCache<string, unknown>;
  cacheTtlMs?: number;
  latestOnly?: boolean;
  deadlineMs?: number;
  historySize?: number; // Phase 0: Number of state transitions to keep in history (default: 10, 0 = disabled)
  retry?: RetryConfig; // Phase 0: Retry configuration for exponential backoff
  refreshBeforeExpiryMs?: number; // Phase 0: Refresh data before TTL expires (milliseconds before expiry)
}

/**
 * Base class for async Taps with comprehensive async lifecycle management.
 *
 * Handles:
 * - Per-destination request cancellation and state tracking
 * - Request deduplication and caching
 * - Stale-while-revalidate pattern
 * - Deadline-based timeouts
 * - Latest-only request filtering
 *
 * Subclasses implement:
 * - getRequestKey: Generate cache key from parameters
 * - buildRequest: Execute async request
 * - mapResultToUpdates: Convert result to Grip updates
 * - getResetUpdates: Generate reset values when request fails
 */
export abstract class BaseAsyncTap extends BaseTap {
  protected readonly asyncOpts: Required<Omit<BaseAsyncTapOptions, "retry">> & {
    retry?: RetryConfig;
  };
  private readonly destState = new WeakMap<GripContext, DestState>();
  private readonly cache: AsyncCache<string, unknown>;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly allControllers = new Set<AbortController>();
  private readonly allTimers = new Set<any>();
  // Phase 0: Optional state and controller Grips
  readonly stateGrip?: Grip<AsyncRequestState>;
  readonly controllerGrip?: Grip<AsyncTapController>;

  constructor(opts: {
    provides: readonly Grip<any>[];
    destinationParamGrips?: readonly Grip<any>[];
    homeParamGrips?: readonly Grip<any>[];
    async?: BaseAsyncTapOptions;
    // Phase 0: Optional state and controller Grips
    stateGrip?: Grip<AsyncRequestState>;
    controllerGrip?: Grip<AsyncTapController>;
  }) {
    // Phase 2: Add state and controller Grips to provides if they exist
    const providesList: Grip<any>[] = [...opts.provides];
    if (opts.stateGrip) {
      providesList.push(opts.stateGrip);
    }
    if (opts.controllerGrip) {
      providesList.push(opts.controllerGrip);
    }

    super({
      provides: providesList,
      destinationParamGrips: opts.destinationParamGrips,
      homeParamGrips: opts.homeParamGrips,
    });
    const a = opts.async ?? {};
    this.asyncOpts = {
      debounceMs: a.debounceMs ?? 0,
      cache: a.cache ?? new LruTtlCache<string, unknown>(200),
      cacheTtlMs: a.cacheTtlMs ?? 0,
      latestOnly: a.latestOnly ?? true,
      deadlineMs: a.deadlineMs ?? 0,
      historySize: a.historySize ?? 10, // Phase 0: Default history size
      retry: a.retry, // Phase 0: Retry config (optional)
      refreshBeforeExpiryMs: a.refreshBeforeExpiryMs ?? 0, // Phase 0: Default no refresh before expiry
    };
    this.cache = this.asyncOpts.cache;
    // Phase 0: Store optional state and controller Grips
    this.stateGrip = opts.stateGrip;
    this.controllerGrip = opts.controllerGrip;
  }

  /**
   * Get or create destination state for async operations.
   */
  protected getDestState(dest: GripContext): DestState {
    let s = this.destState.get(dest);
    if (!s) {
      // Phase 2: Initialize state tracking fields
      s = {
        seq: 0,
        currentState: { type: "idle", retryAt: null },
        listenerCount: 0,
        retryAttempt: 0,
        retryTimer: null,
        refreshTimer: null,
        history: [],
        historySize: this.asyncOpts.historySize,
        requestKey: null,
      };
      this.destState.set(dest, s);
    }
    return s;
  }

  /**
   * Generate request key from destination parameters.
   *
   * Return undefined if parameters are insufficient for request.
   * Used for caching and request deduplication.
   */
  protected abstract getRequestKey(params: DestinationParams): string | undefined;

  /**
   * Execute async request with abort signal.
   *
   * Should respect the AbortSignal for cancellation.
   */
  protected abstract buildRequest(params: DestinationParams, signal: AbortSignal): Promise<unknown>;

  /**
   * Convert request result to Grip value updates.
   */
  protected abstract mapResultToUpdates(
    params: DestinationParams,
    result: unknown,
  ): Map<Grip<any>, any>;

  /**
   * Generate reset values when request fails or parameters are insufficient.
   */
  protected abstract getResetUpdates(params: DestinationParams): Map<Grip<any>, any>;

  // Phase 2: State management methods
  /**
   * Get current request state for a destination context.
   */
  getRequestState(dest: GripContext): AsyncRequestState {
    const state = this.getDestState(dest);
    return {
      state: state.currentState,
      requestKey: state.requestKey ?? null,
      hasListeners: state.listenerCount > 0,
      history: Object.freeze([...state.history]) as ReadonlyArray<StateHistoryEntry>,
    };
  }

  /**
   * Manually trigger a retry for a destination context.
   */
  protected retry(dest: GripContext, forceRefetch?: boolean): void {
    throw new Error("Not implemented - Phase 0");
  }

  /**
   * Manually trigger a refresh for a destination context.
   */
  protected refresh(dest: GripContext, forceRefetch?: boolean): void {
    throw new Error("Not implemented - Phase 0");
  }

  /**
   * Reset the state for a destination context.
   */
  protected reset(dest: GripContext): void {
    const state = this.getDestState(dest);

    // Abort any in-flight request
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = undefined;
    }

    // Cancel any scheduled retries/refreshes
    this.cancelRetry(dest);
    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      this.allTimers.delete(state.refreshTimer);
      state.refreshTimer = null;
    }

    // Clear history
    state.history = [];
    state.retryAttempt = 0;

    // Reset state to idle
    state.currentState = { type: "idle", retryAt: null };
    state.requestKey = null;

    // Clear outputs
    const params = this.getDestinationParams(dest);
    if (params) {
      const resets = this.getResetUpdates(params);
      if (resets.size > 0) this.publish(resets, dest);
    }

    this.publishState(dest);
  }

  /**
   * Cancel any scheduled retries for a destination context.
   */
  protected cancelRetry(dest: GripContext): void {
    const state = this.getDestState(dest);

    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      this.allTimers.delete(state.retryTimer);
      state.retryTimer = null;
    }

    // Clear retryAt in state
    if (state.currentState.retryAt !== null) {
      state.currentState = { ...state.currentState, retryAt: null };
      this.publishState(dest);
    }
  }

  /**
   * Publish state to state Grip for a destination.
   */
  private publishState(dest: GripContext): void {
    if (!this.stateGrip || !this.engine || !this.homeContext || !this.producer) {
      return;
    }

    // Phase 3: Recalculate listener count based on current destination state
    // The Destination record is removed when there are no more listeners, so if it doesn't exist, count is 0
    const state = this.getDestState(dest);
    const destination = this.getDestination(dest);
    if (destination) {
      // Count only output Grips (not state or controller Grips)
      let outputGripCount = 0;
      for (const g of destination.getGrips()) {
        if (this.isOutputGrip(g)) {
          outputGripCount++;
        }
      }
      state.listenerCount = outputGripCount;
    } else {
      // Destination doesn't exist = no listeners
      state.listenerCount = 0;
    }

    const asyncState = this.getRequestState(dest);
    const updates = new Map<Grip<any>, any>([[this.stateGrip, asyncState]]);
    this.publish(updates, dest);
  }

  /**
   * Publish controller to controller Grip for a destination.
   */
  private publishController(dest: GripContext): void {
    if (!this.controllerGrip || !this.producer) {
      return;
    }

    const state = this.getDestState(dest);
    const controller = state.tapController || this.createNoOpController();

    const updates = new Map<Grip<any>, any>([[this.controllerGrip, controller]]);
    this.publish(updates, dest);
  }

  /**
   * Create controller closure for a destination.
   */
  private createController(dest: GripContext): AsyncTapController {
    return {
      retry: (forceRefetch?: boolean) => {
        const state = this.getDestState(dest);

        // Abort any in-flight request
        if (state.abortController) {
          state.abortController.abort();
          state.abortController = undefined;
        }

        // Cancel any scheduled retries/refreshes
        this.cancelRetry(dest);
        if (state.refreshTimer) {
          clearTimeout(state.refreshTimer);
          this.allTimers.delete(state.refreshTimer);
          state.refreshTimer = null;
        }

        // Increment retry attempt (for exponential backoff)
        state.retryAttempt += 1;

        // Initiate new request
        this.kickoff(dest, forceRefetch === true);
      },
      refresh: (forceRefetch?: boolean) => {
        // Refresh doesn't increment retryAttempt
        // Abort any in-flight request
        const state = this.getDestState(dest);
        if (state.abortController) {
          state.abortController.abort();
          state.abortController = undefined;
        }

        // Cancel any scheduled retries/refreshes
        this.cancelRetry(dest);
        if (state.refreshTimer) {
          clearTimeout(state.refreshTimer);
          this.allTimers.delete(state.refreshTimer);
          state.refreshTimer = null;
        }

        // Initiate new request (will use stale-while-revalidate if data exists)
        this.kickoff(dest, forceRefetch === true);
      },
      reset: () => {
        this.reset(dest);
      },
      cancelRetry: () => {
        this.cancelRetry(dest);
      },
      abort: () => {
        const state = this.getDestState(dest);
        if (state.abortController) {
          state.abortController.abort();
          state.abortController = undefined;
        }
      },
    };
  }

  /**
   * Create a no-op controller for destinations without active listeners.
   */
  private createNoOpController(): AsyncTapController {
    return {
      retry: () => {},
      refresh: () => {},
      reset: () => {},
      cancelRetry: () => {},
      abort: () => {},
    };
  }

  /**
   * Add history entry for state transition.
   * Captures the previous state (state being exited) with the timestamp of transition.
   */
  private addHistoryEntry(
    dest: GripContext,
    newState: RequestState,
    reason?: string,
  ): void {
    const state = this.getDestState(dest);

    if (state.historySize === 0) {
      // History disabled, just update current state
      state.currentState = newState;
      this.publishState(dest);
      return;
    }

    // Create history entry with previous state (state being exited)
    const entry: StateHistoryEntry = {
      state: state.currentState, // Previous state
      timestamp: Date.now(),
      requestKey: state.requestKey ?? null,
      transitionReason: reason,
    };

    state.history.push(entry);

    // Maintain circular buffer
    if (state.history.length > state.historySize) {
      state.history.shift(); // Remove oldest entry
    }

    // Update current state
    state.currentState = newState;

    this.publishState(dest);
  }

  /**
   * Calculate retry delay using exponential backoff.
   * Returns the timestamp when retry should occur, or null if max retries reached.
   */
  private calculateRetryDelay(attempt: number, baseTime: number = Date.now()): number | null {
    const retryConfig = this.asyncOpts.retry;
    if (!retryConfig) {
      return null; // No retry config, no retry
    }

    const maxRetries = retryConfig.maxRetries ?? 3;
    if (attempt >= maxRetries) {
      return null; // Max retries reached
    }

    // Check if error is retryable (if predicate provided)
    // Note: We can't check the error here since we're scheduling, not executing
    // The error check will happen in executeRetry if needed

    const initialDelay = retryConfig.initialDelayMs ?? 1000;
    const backoffMultiplier = retryConfig.backoffMultiplier ?? 2;
    const maxDelay = retryConfig.maxDelayMs ?? 30000;

    const delay = Math.min(
      initialDelay * Math.pow(backoffMultiplier, attempt),
      maxDelay,
    );

    return baseTime + delay;
  }

  /**
   * Schedule retry with exponential backoff.
   * Only schedules if listeners exist and retry config is provided.
   */
  private scheduleRetry(dest: GripContext): void {
    const state = this.getDestState(dest);

    // Recalculate listener count to ensure it's accurate
    // (Destination might have been updated since last publishState call)
    const destination = this.getDestination(dest);
    if (destination) {
      let outputGripCount = 0;
      for (const g of destination.getGrips()) {
        if (this.isOutputGrip(g)) {
          outputGripCount++;
        }
      }
      state.listenerCount = outputGripCount;
    } else {
      // Destination doesn't exist = no listeners
      state.listenerCount = 0;
    }

    // Don't schedule retry if no listeners
    if (state.listenerCount === 0) {
      return;
    }

    // Don't schedule if no retry config
    if (!this.asyncOpts.retry) {
      return;
    }

    // Cancel any existing retry timer
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      this.allTimers.delete(state.retryTimer);
      state.retryTimer = null;
    }

    // Calculate retry delay
    const retryAt = this.calculateRetryDelay(state.retryAttempt, Date.now());
    if (retryAt === null) {
      // Max retries reached, don't schedule
      return;
    }

    // Increment retry attempt (for next retry calculation)
    state.retryAttempt += 1;

    // Update state with retryAt
    const newState: RequestState = {
      ...state.currentState,
      retryAt,
    };
    this.addHistoryEntry(dest, newState, "retry_scheduled");

    // Schedule retry timer
    const delay = retryAt - Date.now();
    const requestKey = state.requestKey;
    if (requestKey) {
      state.retryTimer = setTimeout(() => {
        this.allTimers.delete(state.retryTimer!);
        state.retryTimer = null;
        this.executeRetry(dest, requestKey);
      }, delay);
      this.allTimers.add(state.retryTimer);
    }
  }

  /**
   * Execute scheduled retry.
   * Checks listeners and request key before executing.
   */
  private executeRetry(dest: GripContext, requestKey: string): void {
    const state = this.getDestState(dest);

    // Check if listeners still exist
    if (state.listenerCount === 0) {
      // No listeners, cancel retry
      state.currentState = { ...state.currentState, retryAt: null };
      this.publishState(dest);
      return;
    }

    // Check if request key still matches
    const params = this.getDestinationParams(dest);
    const currentKey = params ? this.getRequestKey(params) : null;
    if (currentKey !== requestKey) {
      // Request key changed, cancel retry
      // handleRequestKeyChange will be called elsewhere
      state.currentState = { ...state.currentState, retryAt: null };
      this.publishState(dest);
      return;
    }

    // Check if error is retryable (if predicate provided)
    const retryConfig = this.asyncOpts.retry;
    if (retryConfig?.retryOnError) {
      const error = state.currentState.type === "error" || state.currentState.type === "stale-with-error"
        ? (state.currentState as any).error
        : null;
      if (error && !retryConfig.retryOnError(error)) {
        // Error is not retryable, don't retry
        state.currentState = { ...state.currentState, retryAt: null };
        this.publishState(dest);
        return;
      }
    }

    // Execute retry - transition to loading and kickoff
    if (state.currentState.type === "error") {
      // Transition from error to loading
      this.addHistoryEntry(
        dest,
        {
          type: "loading",
          initiatedAt: Date.now(),
          retryAt: null, // Will be set by scheduleRetry if this retry fails
        },
        "retry_executed",
      );
    } else if (state.currentState.type === "stale-with-error") {
      // Transition from stale-with-error to stale-while-revalidate
      const retrievedAt = state.currentState.retrievedAt;
      this.addHistoryEntry(
        dest,
        {
          type: "stale-while-revalidate",
          retrievedAt,
          refreshInitiatedAt: Date.now(),
          retryAt: null, // Will be set by scheduleRetry if this retry fails
        },
        "retry_executed",
      );
    }

    // Kickoff new request (force refetch to bypass cache)
    this.kickoff(dest, true);
  }

  /**
   * Handle request key change (abort old, preserve history, reset counters).
   */
  /**
   * Calculate TTL refresh time.
   * Returns the timestamp when refresh should occur, or null if no refresh needed.
   */
  private calculateRefreshTime(
    retrievedAt: number,
    ttlMs: number,
    refreshBeforeExpiryMs: number = 0,
  ): number | null {
    if (ttlMs <= 0) return null; // No TTL, no scheduled refresh

    const expiryTime = retrievedAt + ttlMs;
    const refreshTime = expiryTime - refreshBeforeExpiryMs;

    return refreshTime > Date.now() ? refreshTime : null;
  }

  /**
   * Schedule TTL-based refresh.
   * Only schedules if listeners exist and TTL is configured.
   */
  private scheduleRefresh(dest: GripContext): void {
    const state = this.getDestState(dest);

    // Don't schedule if no listeners
    if (state.listenerCount === 0) {
      return;
    }

    // Don't schedule if no TTL configured
    if (this.asyncOpts.cacheTtlMs <= 0) {
      return;
    }

    // Only schedule for states with data
    let retrievedAt: number | null = null;
    if (state.currentState.type === "success") {
      retrievedAt = state.currentState.retrievedAt;
    } else if (state.currentState.type === "stale-while-revalidate") {
      retrievedAt = state.currentState.retrievedAt;
    } else if (state.currentState.type === "stale-with-error") {
      retrievedAt = state.currentState.retrievedAt;
    } else {
      return; // No data, no refresh to schedule
    }

    // Cancel any existing refresh timer
    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      this.allTimers.delete(state.refreshTimer);
      state.refreshTimer = null;
    }

    // Calculate refresh time
    const refreshAt = this.calculateRefreshTime(
      retrievedAt,
      this.asyncOpts.cacheTtlMs,
      this.asyncOpts.refreshBeforeExpiryMs,
    );
    if (refreshAt === null) {
      return; // No refresh needed
    }

    // Schedule refresh timer
    const delay = refreshAt - Date.now();
    const requestKey = state.requestKey;
    if (requestKey && delay > 0) {
      state.refreshTimer = setTimeout(() => {
        this.allTimers.delete(state.refreshTimer!);
        state.refreshTimer = null;
        this.executeRefresh(dest, requestKey);
      }, delay);
      this.allTimers.add(state.refreshTimer);
    }
  }

  /**
   * Execute scheduled TTL refresh.
   * Checks listeners and request key before executing.
   */
  private executeRefresh(dest: GripContext, requestKey: string): void {
    const state = this.getDestState(dest);

    // Check if listeners still exist
    if (state.listenerCount === 0) {
      // No listeners, cancel refresh
      return;
    }

    // Check if request key still matches
    const params = this.getDestinationParams(dest);
    const currentKey = params ? this.getRequestKey(params) : null;
    if (currentKey !== requestKey) {
      // Request key changed, cancel refresh
      return;
    }

    // Execute refresh - use stale-while-revalidate
    if (state.currentState.type === "success" || state.currentState.type === "stale-with-error") {
      const retrievedAt = state.currentState.retrievedAt;
      this.addHistoryEntry(
        dest,
        {
          type: "stale-while-revalidate",
          retrievedAt,
          refreshInitiatedAt: Date.now(),
          retryAt: null,
        },
        "ttl_refresh_executed",
      );
    }

    // Kickoff refresh (use stale-while-revalidate pattern)
    this.kickoff(dest, false); // Don't force refetch, use cache if available
  }

  private handleRequestKeyChange(
    dest: GripContext,
    oldKey: string,
    newKey: string | null,
  ): void {
    const state = this.getDestState(dest);

    // Guard against recursion: if keys already match, no change needed
    const currentKey = state.key ?? state.requestKey ?? null;
    if (currentKey === newKey) {
      return;
    }

    // Cancel old retry/refresh timers
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      this.allTimers.delete(state.retryTimer);
      state.retryTimer = null;
    }
    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      this.allTimers.delete(state.refreshTimer);
      state.refreshTimer = null;
    }

    // Abort any in-flight request for old key
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = undefined;
    }

    // Reset retry attempt counter for new key
    state.retryAttempt = 0;

    // Update both key and requestKey to prevent recursion
    state.key = newKey ?? undefined;
    state.requestKey = newKey;

    // Add history entry for key change (preserve history, mark with new key)
    this.addHistoryEntry(
      dest,
      { ...state.currentState, retryAt: null },
      "request_key_changed",
    );

    // If new key is available, initiate new request
    if (newKey) {
      // Transition to loading (no cached data for new key yet)
      this.addHistoryEntry(
        dest,
        { type: "loading", initiatedAt: Date.now(), retryAt: null },
        "request_initiated",
      );
      // Call kickoff with a flag to skip key change detection since we've already handled it
      this.kickoff(dest, false);
    } else {
      // No key available, reset to idle
      const params = this.getDestinationParams(dest);
      if (params) {
        const resets = this.getResetUpdates(params);
        if (resets.size > 0) this.publish(resets, dest);
      }
      state.currentState = { type: "idle", retryAt: null };
      this.publishState(dest);
    }
  }

  /**
   * Check if a grip is an output Grip (data Grip, not state or controller Grip).
   * Only output Grips count toward listenerCount for retry/refresh scheduling.
   */
  private isOutputGrip(grip: Grip<any>): boolean {
    // State and controller Grips don't count as listeners
    if (grip === this.stateGrip || grip === this.controllerGrip) {
      return false;
    }
    // Output Grips are in the provides array (data Grips)
    return this.provides.includes(grip);
  }

  /**
   * Called when destination parameters change.
   *
   * Triggers request if parameters are sufficient for request key generation.
   */
  produceOnDestParams(destContext: GripContext | undefined): void {
    if (!destContext) return;
    const params = this.getDestinationParams(destContext);
    if (!params) return;
    // Only kickoff when requestKey is resolvable
    const key = this.getRequestKey(params);
    if (!key) return;
    this.kickoff(destContext);
  }

  /**
   * Produce for all destinations or specific destination.
   *
   * @param opts.forceRefetch - Bypass cache and force new request
   */
  produce(opts?: { destContext?: GripContext; forceRefetch?: boolean }): void {
    if (opts?.destContext) {
      this.kickoff(opts.destContext, opts.forceRefetch === true);
      return;
    }
    const destinations = Array.from(this.producer?.getDestinations().keys() ?? []);
    for (const destNode of destinations) {
      const destCtx = destNode.get_context();
      if (!destCtx) continue;
      this.kickoff(destCtx, opts?.forceRefetch === true);
    }
  }

  /**
   * Home parameters changed - update all destinations.
   */
  produceOnParams(): void {
    this.produce();
  }

  /**
   * Override to trigger produce only on first destination connection.
   *
   * Prevents unnecessary requests when multiple destinations connect simultaneously.
   */
  onConnect(dest: GripContext, grip: Grip<any>): void {
    if ((this.producer?.getDestinations().size ?? 0) === 1) {
      super.onConnect(dest, grip);
    }

    // Phase 3: Track listeners - only output Grips count
    // Note: In GRIP, onConnect is called when a destination is first created.
    // The Destination record contains all grips for this destination context.
    // We count only output Grips (not state or controller Grips) as listeners.
    const state = this.getDestState(dest);
    const destination = this.getDestination(dest);
    if (destination) {
      // Count output Grips in this destination
      let outputGripCount = 0;
      for (const g of destination.getGrips()) {
        if (this.isOutputGrip(g)) {
          outputGripCount++;
        }
      }
      state.listenerCount = outputGripCount;
    } else {
      // Destination doesn't exist yet (shouldn't happen in onConnect, but handle it)
      state.listenerCount = 0;
    }

    // Track per-request-key
    const params = this.getDestinationParams(dest);
    if (params) {
      const key = this.getRequestKey(params);
      if (key) {
        const oldKey = state.requestKey;
        if (oldKey !== null && oldKey !== undefined && oldKey !== key) {
          // Request key changed
          this.handleRequestKeyChange(dest, oldKey, key);
        } else {
          // Update both key and requestKey
          state.key = key;
          state.requestKey = key;
        }
      }
    }

    // Phase 8: Create controller if controller Grip is provided
    if (this.controllerGrip && !state.tapController) {
      state.tapController = this.createController(dest);
      this.publishController(dest);
    }

    this.publishState(dest);

    // Phase 2: Publish initial state when destination connects (after listener count is updated)
    this.publishState(dest);
    this.kickoff(dest);
  }

  /**
   * Clean up destination state on disconnect.
   *
   * Aborts in-flight requests and clears timers.
   */
  onDisconnect(dest: GripContext, grip: Grip<any>): void {
    try {
      // Call super first to remove the grip from destination
      super.onDisconnect(dest, grip);

      const s = this.destState.get(dest);
      if (s) {
        // Phase 3: Track listeners - only output Grips count
        // Recalculate listener count based on remaining output Grips in destination
        const isOutputGrip = this.isOutputGrip(grip);
        if (isOutputGrip) {
          const destination = this.getDestination(dest);
          if (destination) {
            // Recalculate based on remaining Grips (grip has been removed by super.onDisconnect)
            let outputGripCount = 0;
            for (const g of destination.getGrips()) {
              if (this.isOutputGrip(g)) {
                outputGripCount++;
              }
            }
            s.listenerCount = outputGripCount;
          } else {
            // Destination removed - no listeners
            s.listenerCount = 0;
          }

          // Phase 3: Zero-listener behavior - cancel retries and TTL refreshes
          if (s.listenerCount === 0) {
            // Cancel retry timer (will be implemented in Phase 4)
            if (s.retryTimer) {
              clearTimeout(s.retryTimer);
              this.allTimers.delete(s.retryTimer);
              s.retryTimer = null;
            }
            // Cancel refresh timer (will be implemented in Phase 5)
            if (s.refreshTimer) {
              clearTimeout(s.refreshTimer);
              this.allTimers.delete(s.refreshTimer);
              s.refreshTimer = null;
            }
            // Clear retryAt in state
            s.currentState = { ...s.currentState, retryAt: null };
            // Phase 8: Clear controller (make no-op) when listeners drop to zero
            if (this.controllerGrip && s.tapController) {
              s.tapController = undefined;
              this.publishController(dest);
            }
          }
        }

        if (s.abortController) {
          s.abortController.abort();
          this.allControllers.delete(s.abortController);
          s.abortController = undefined;
        }
        if (s.deadlineTimer) {
          clearTimeout(s.deadlineTimer);
          this.allTimers.delete(s.deadlineTimer);
          s.deadlineTimer = undefined;
        }

        // Phase 3: Publish updated state with listener count
        this.publishState(dest);

        // Only delete state if destination is removed (will be handled in later phases)
        // For now, keep state for debugging
      }
    } catch (error) {
      // Ignore errors during disconnect
    }
  }

  /**
   * Clean up all async operations on detach.
   *
   * Aborts all controllers and clears all timers.
   */
  onDetach(): void {
    try {
      for (const c of this.allControllers) {
        try {
          c.abort();
        } catch {}
      }
      for (const t of this.allTimers) {
        try {
          clearTimeout(t);
        } catch {}
      }
      this.allControllers.clear();
      this.allTimers.clear();
    } finally {
      super.onDetach();
    }
  }

  /**
   * Core async request orchestration.
   *
   * Handles:
   * - Request key generation and validation
   * - Cache lookup and stale-while-revalidate
   * - Request deduplication
   * - AbortController and deadline management
   * - Result publishing to all matching destinations
   */
  private kickoff(dest: GripContext, forceRefetch?: boolean): void {
    const state = this.getDestState(dest);
    const prevKey = state.key ?? state.requestKey ?? undefined;

    const params = this.getDestinationParams(dest);
    if (!params) {
      // Can't get params, abort and clear outputs
      if (state.controller) state.controller.abort();
      if (state.abortController) state.abortController.abort();
      state.key = undefined;
      state.requestKey = null;
      return;
    }

    const key = this.getRequestKey(params);

    // Parameters insufficient - abort and reset outputs
    if (!key) {
      if (state.abortController) state.abortController.abort();
      state.key = undefined;
      state.requestKey = null;
      const resets = this.getResetUpdates(params);
      if (resets.size > 0) this.publish(resets, dest);
      return;
    }

    // Phase 10: Request key changed - handle state transition
    if (prevKey !== undefined && prevKey !== key) {
      this.handleRequestKeyChange(dest, prevKey, key);
      // handleRequestKeyChange already updates requestKey, so return early
      return;
    } else {
      state.requestKey = key;
    }

    // Check cache first
    const cached = this.asyncOpts.cacheTtlMs > 0 && !forceRefetch ? this.cache.get(key) : undefined;
    if (cached) {
      // Phase 2: Cache hit - transition to stale-while-revalidate if refresh initiated, otherwise success
      // For now, if we have cached data and are initiating a request, use stale-while-revalidate
      // This will be refined when TTL refresh is implemented in Phase 5
      const hasData = state.currentState.type === "success" ||
        state.currentState.type === "stale-while-revalidate" ||
        state.currentState.type === "stale-with-error";
      
      if (hasData) {
        // We have data, this is a refresh - use stale-while-revalidate
        let retrievedAt = Date.now();
        if (state.currentState.type === "success") {
          retrievedAt = state.currentState.retrievedAt;
        } else if (state.currentState.type === "stale-while-revalidate") {
          retrievedAt = state.currentState.retrievedAt;
        } else if (state.currentState.type === "stale-with-error") {
          retrievedAt = state.currentState.retrievedAt;
        }
        this.addHistoryEntry(
          dest,
          {
            type: "stale-while-revalidate",
            retrievedAt,
            refreshInitiatedAt: Date.now(),
            retryAt: null,
          },
          "cache_hit_refresh_initiated",
        );
      } else {
        // No previous data, cache hit - transition to success
        this.addHistoryEntry(
          dest,
          {
            type: "success",
            retrievedAt: Date.now(),
            retryAt: null,
          },
          "cache_hit",
        );
      }

      // Publish cached value to all destinations sharing this key
      state.key = key;
      const destinations = Array.from(this.producer?.getDestinations().keys() ?? []);
      for (const destNode of destinations) {
        const dctx = destNode.get_context();
        if (!dctx) continue;
        const dparams = this.getDestinationParams(dctx);
        if (!dparams) continue;
        const k2 = this.getRequestKey(dparams);
        if (k2 !== key) continue;
        const updates = this.mapResultToUpdates(dparams, cached.value);
        this.publish(updates, dctx);
        // Mark destination state to prevent repeated resets
        try {
          const dstate = this.getDestState(dctx);
          dstate.key = key;
          dstate.requestKey = key;
        } catch {}
      }
      return;
    }

    // Check for in-flight request with same key
    const existing = this.pending.get(key);
    if (existing) {
      // Arm retry for this destination if pending completes without cache entry
      state.pendingRetryArmed = true;
      existing
        .then(() => {
          const fromCache = this.cache.get(key);
          if (!fromCache) return; // publish handled in finally
        })
        .catch(() => {
          /* ignore; handled in finally */
        })
        .finally(() => {
          const fromCache = this.cache.get(key);
          if (fromCache) {
            // Publish cached value to all destinations
            const destinations = Array.from(this.producer?.getDestinations().keys() ?? []);
            for (const destNode of destinations) {
              const dctx = destNode.get_context();
              if (!dctx) continue;
              const dparams = this.getDestinationParams(dctx);
              if (!dparams) continue;
              const k2 = this.getRequestKey(dparams);
              if (k2 !== key) continue;
              const updates = this.mapResultToUpdates(dparams, fromCache.value);
              this.publish(updates, dctx);
              try {
                this.getDestState(dctx).key = key;
              } catch {}
            }
          } else if (state.pendingRetryArmed && this.pending.get(key) === undefined) {
            // No cache produced; retry once if destination still targets this key
            state.pendingRetryArmed = false;
            const destParams = this.getDestinationParams(dest);
            if (destParams && this.getRequestKey(destParams) === key) {
              this.kickoff(dest, true);
            }
          }
        });
      return;
    }

    // Phase 2: Start new request - transition to loading or stale-while-revalidate
    state.seq += 1;
    const seq = state.seq;
    if (state.controller) state.controller.abort();
    if (state.abortController) {
      state.abortController.abort();
      this.allControllers.delete(state.abortController);
    }
    const controller = new AbortController();
    state.controller = controller; // Keep for backward compatibility
    state.abortController = controller; // Phase 2: Dedicated AbortController
    this.allControllers.add(controller);
    state.key = key;

    // Phase 2: Determine initial state - loading (no data) or stale-while-revalidate (has data)
    const hasData = state.currentState.type === "success" ||
      state.currentState.type === "stale-while-revalidate" ||
      state.currentState.type === "stale-with-error";
    
    if (hasData) {
      // We have data, this is a refresh - use stale-while-revalidate
      let retrievedAt = Date.now();
      if (state.currentState.type === "success") {
        retrievedAt = state.currentState.retrievedAt;
      } else if (state.currentState.type === "stale-while-revalidate") {
        retrievedAt = state.currentState.retrievedAt;
      } else if (state.currentState.type === "stale-with-error") {
        retrievedAt = state.currentState.retrievedAt;
      }
      this.addHistoryEntry(
        dest,
        {
          type: "stale-while-revalidate",
          retrievedAt,
          refreshInitiatedAt: Date.now(),
          retryAt: null,
        },
        "request_initiated",
      );
    } else {
      // No data, initial load - use loading
      this.addHistoryEntry(
        dest,
        {
          type: "loading",
          initiatedAt: Date.now(),
          retryAt: null,
        },
        "request_initiated",
      );
    }

    // Set up deadline timer
    if (state.deadlineTimer) {
      clearTimeout(state.deadlineTimer);
      this.allTimers.delete(state.deadlineTimer);
      state.deadlineTimer = undefined;
    }
    if (this.asyncOpts.deadlineMs > 0) {
      state.deadlineTimer = setTimeout(() => controller.abort(), this.asyncOpts.deadlineMs);
      this.allTimers.add(state.deadlineTimer);
    }

    // Execute request
    const promise = this.buildRequest(params, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        // Latest-only guard
        if (this.asyncOpts.latestOnly && seq !== state.seq) return;

        // Cache result if TTL configured
        if (this.asyncOpts.cacheTtlMs > 0 && key)
          this.cache.set(key, result, this.asyncOpts.cacheTtlMs);

        // Phase 2: Collect destinations to update state for
        const retrievedAt = Date.now();
        const destinationsToUpdate: GripContext[] = [];
        if (this.producer) {
          for (const destNode of Array.from(this.producer.getDestinations().keys())) {
            const dctx = destNode.get_context();
            if (!dctx) continue;
            const dparams = this.getDestinationParams(dctx);
            if (!dparams) continue;
            const k2 = this.getRequestKey(dparams);
            if (k2 !== key) continue;
            destinationsToUpdate.push(dctx);
          }
        }
        
        // Publish to all destinations sharing this key first
        if (!this.producer) {
          if (process.env.NODE_ENV !== "production")
            logger.error(
              `[AsyncTap] ERROR: producer is undefined after successful fetch for key=${key}. Cannot publish results.`,
            );
          return;
        }
        const destinations = Array.from(this.producer.getDestinations().keys());
        if (process.env.NODE_ENV !== "production")
          logger.log(
            `[AsyncTap] Publishing to ${destinations.length} destinations for key=${key}, tap=${
              (this as any).id
            }, homeContext=${this.homeContext?.id || "NOT_ATTACHED"}`,
          );
        for (const destNode of destinations) {
          const dctx = destNode.get_context();
          if (!dctx) {
            if (process.env.NODE_ENV !== "production")
              logger.log(`[AsyncTap]   - Skipping destination: context is gone`);
            continue;
          }
          const dparams = this.getDestinationParams(dctx);
          if (!dparams) continue;
          const k2 = this.getRequestKey(dparams);
          if (process.env.NODE_ENV !== "production")
            logger.log(
              `[AsyncTap]   - Destination ${dctx.id} has key=${k2}, looking for key=${key}`,
            );
          if (k2 !== key) continue;
          const updates = this.mapResultToUpdates(dparams, result);
          this.publish(updates, dctx);
          try {
            const dstate = this.getDestState(dctx);
            dstate.key = key;
            dstate.requestKey = key;
          } catch {}
        }

        // Phase 2: Transition to success state for all destinations with this key (after data is published)
        for (const dctx of destinationsToUpdate) {
          const dstate = this.getDestState(dctx);
          // Phase 4: Reset retry attempt counter on success
          dstate.retryAttempt = 0;
          // Cancel any scheduled retries (success means no retry needed)
          if (dstate.retryTimer) {
            clearTimeout(dstate.retryTimer);
            this.allTimers.delete(dstate.retryTimer);
            dstate.retryTimer = null;
          }
          this.addHistoryEntry(
            dctx,
            {
              type: "success",
              retrievedAt,
              retryAt: null, // Will be set by scheduleRefresh if TTL configured
            },
            "fetch_success",
          );
          // Phase 5: Schedule TTL refresh if configured and listeners exist
          this.publishState(dctx);
          this.scheduleRefresh(dctx);
        }
      })
      .catch((error) => {
        // Phase 2: Handle errors - transition to error or stale-with-error
        if (!this.producer) return;
        
        const failedAt = Date.now();
        for (const destNode of Array.from(this.producer.getDestinations().keys())) {
          const dctx = destNode.get_context();
          if (!dctx) continue;
          const dparams = this.getDestinationParams(dctx);
          if (!dparams) continue;
          const k2 = this.getRequestKey(dparams);
          if (k2 !== key) continue;
          
          const dstate = this.getDestState(dctx);
          const hasData = dstate.currentState.type === "success" ||
            dstate.currentState.type === "stale-while-revalidate" ||
            dstate.currentState.type === "stale-with-error";
          
          if (hasData) {
            // We have cached data, use stale-with-error
            let retrievedAt = Date.now();
            if (dstate.currentState.type === "success") {
              retrievedAt = dstate.currentState.retrievedAt;
            } else if (dstate.currentState.type === "stale-while-revalidate") {
              retrievedAt = dstate.currentState.retrievedAt;
            } else if (dstate.currentState.type === "stale-with-error") {
              retrievedAt = dstate.currentState.retrievedAt;
            }
            this.addHistoryEntry(
              dctx,
              {
                type: "stale-with-error",
                retrievedAt,
                error: error instanceof Error ? error : new Error(String(error)),
                failedAt,
                retryAt: null, // Will be set by scheduleRetry if listeners exist
              },
              "fetch_error",
            );
          } else {
            // No data, use error
            this.addHistoryEntry(
              dctx,
              {
                type: "error",
                error: error instanceof Error ? error : new Error(String(error)),
                failedAt,
                retryAt: null, // Will be set by scheduleRetry if listeners exist
              },
              "fetch_error",
            );
          }

          // Phase 4: Ensure state is published before scheduling retry (so listener count is up to date)
          this.publishState(dctx);
          // Phase 4: Schedule retry if configured and listeners exist
          this.scheduleRetry(dctx);
        }
        // Swallow network errors; optionally map to diagnostics in subclass
      })
      .finally(() => {
        this.pending.delete(key);
        if (state.deadlineTimer) {
          clearTimeout(state.deadlineTimer);
          this.allTimers.delete(state.deadlineTimer);
          state.deadlineTimer = undefined;
        }
      });
    this.pending.set(key, promise);
  }
}

/**
 * Configuration for single-output async Taps with destination parameters.
 *
 * @template T - The type of value provided by the Tap
 */
export interface AsyncValueTapConfig<T> extends BaseAsyncTapOptions {
  provides: Grip<T>;
  destinationParamGrips?: readonly Grip<any>[];
  homeParamGrips?: readonly Grip<any>[];
  requestKeyOf: (params: DestinationParams) => string | undefined;
  fetcher: (params: DestinationParams, signal: AbortSignal) => Promise<T>;
  // Phase 0: Optional state and controller Grips
  stateGrip?: Grip<AsyncRequestState>;
  controllerGrip?: Grip<AsyncTapController>;
}

/**
 * Configuration for single-output async Taps with home parameters only.
 *
 * Same request for all destinations, no destination-specific parameters.
 *
 * @template T - The type of value provided by the Tap
 */
export interface AsyncHomeValueTapConfig<T> extends BaseAsyncTapOptions {
  provides: Grip<T>;
  homeParamGrips?: readonly Grip<any>[];
  requestKeyOf: (homeParams: ReadonlyMap<Grip<any>, any>) => string | undefined;
  fetcher: (homeParams: ReadonlyMap<Grip<any>, any>, signal: AbortSignal) => Promise<T>;
  // Phase 0: Optional state and controller Grips
  stateGrip?: Grip<AsyncRequestState>;
  controllerGrip?: Grip<AsyncTapController>;
}

/**
 * Single-output async Tap implementation.
 *
 * Provides one Grip with destination-aware parameter handling.
 */
class SingleOutputAsyncTap<T> extends BaseAsyncTap {
  private readonly out: Grip<T>;
  private readonly keyOf: (params: DestinationParams) => string | undefined;
  private readonly fetcher: (params: DestinationParams, signal: AbortSignal) => Promise<T>;

  constructor(cfg: AsyncValueTapConfig<T>) {
    super({
      provides: [cfg.provides],
      destinationParamGrips: cfg.destinationParamGrips,
      homeParamGrips: cfg.homeParamGrips,
      async: cfg,
      // Phase 0: Pass state and controller Grips
      stateGrip: cfg.stateGrip,
      controllerGrip: cfg.controllerGrip,
    });
    this.out = cfg.provides;
    this.keyOf = cfg.requestKeyOf;
    this.fetcher = cfg.fetcher;
  }

  protected getRequestKey(params: DestinationParams): string | undefined {
    return this.keyOf(params);
  }

  protected buildRequest(params: DestinationParams, signal: AbortSignal): Promise<unknown> {
    return this.fetcher(params, signal);
  }

  protected mapResultToUpdates(_params: DestinationParams, result: unknown): Map<Grip<any>, any> {
    const updates = new Map<Grip<any>, any>();
    updates.set(this.out as unknown as Grip<any>, result as T);
    return updates;
  }

  protected getResetUpdates(_params: DestinationParams): Map<Grip<any>, any> {
    const updates = new Map<Grip<any>, any>();
    updates.set(this.out as unknown as Grip<any>, undefined as unknown as T);
    return updates;
  }
}

/**
 * Factory for single-output async Taps with destination parameters.
 */
export function createAsyncValueTap<T>(cfg: AsyncValueTapConfig<T>): Tap {
  return new SingleOutputAsyncTap<T>(cfg) as unknown as Tap;
}

/**
 * Single-output async Tap with home parameters only.
 *
 * Same request for all destinations, no destination-specific parameters.
 */
class SingleOutputHomeAsyncTap<T> extends BaseAsyncTap {
  private readonly out: Grip<T>;
  private readonly keyOf: (homeParams: ReadonlyMap<Grip<any>, any>) => string | undefined;
  private readonly fetcher: (
    homeParams: ReadonlyMap<Grip<any>, any>,
    signal: AbortSignal,
  ) => Promise<T>;

  constructor(cfg: AsyncHomeValueTapConfig<T>) {
    super({
      provides: [cfg.provides],
      homeParamGrips: cfg.homeParamGrips,
      async: cfg,
      // Phase 0: Pass state and controller Grips
      stateGrip: cfg.stateGrip,
      controllerGrip: cfg.controllerGrip,
    });
    this.out = cfg.provides;
    this.keyOf = cfg.requestKeyOf;
    this.fetcher = cfg.fetcher;
  }

  protected getRequestKey(params: DestinationParams): string | undefined {
    return this.keyOf(params.getAllHomeParams());
  }

  protected buildRequest(params: DestinationParams, signal: AbortSignal): Promise<unknown> {
    return this.fetcher(params.getAllHomeParams(), signal);
  }

  protected mapResultToUpdates(_params: DestinationParams, result: unknown): Map<Grip<any>, any> {
    const updates = new Map<Grip<any>, any>();
    updates.set(this.out as unknown as Grip<any>, result as T);
    return updates;
  }

  protected getResetUpdates(_params: DestinationParams): Map<Grip<any>, any> {
    const updates = new Map<Grip<any>, any>();
    updates.set(this.out as unknown as Grip<any>, undefined as unknown as T);
    return updates;
  }
}

/**
 * Factory for single-output async Taps with home parameters only.
 */
export function createAsyncHomeValueTap<T>(cfg: AsyncHomeValueTapConfig<T>): Tap {
  return new SingleOutputHomeAsyncTap<T>(cfg) as unknown as Tap;
}

/**
 * Configuration for multi-output async Taps with optional state management.
 *
 * @template Outs - Record type defining the output Grips
 * @template R - The raw result type from the fetcher
 * @template StateRec - Record type defining state Grips
 */
export interface AsyncMultiTapConfig<
  Outs extends GripRecord,
  R = unknown,
  StateRec extends GripRecord = {},
> extends BaseAsyncTapOptions {
  provides: ReadonlyArray<Values<Outs>>;
  destinationParamGrips?: readonly Grip<any>[];
  homeParamGrips?: readonly Grip<any>[];
  handleGrip?: Grip<FunctionTapHandle<StateRec>>;
  initialState?: ReadonlyArray<[Grip<any>, any]> | ReadonlyMap<Grip<any>, any>;
  requestKeyOf: (
    params: DestinationParams,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => string | undefined;
  fetcher: (
    params: DestinationParams,
    signal: AbortSignal,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => Promise<R>;
  mapResult: (
    params: DestinationParams,
    result: R,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => ReadonlyMap<Values<Outs>, GripValue<Values<Outs>>>;
  // Phase 0: Optional state and controller Grips
  stateGrip?: Grip<AsyncRequestState>;
  controllerGrip?: Grip<AsyncTapController>;
}

/**
 * Configuration for multi-output async Taps with home parameters only.
 *
 * @template Outs - Record type defining the output Grips
 * @template R - The raw result type from the fetcher
 * @template StateRec - Record type defining state Grips
 */
export interface AsyncHomeMultiTapConfig<
  Outs extends GripRecord,
  R = unknown,
  StateRec extends GripRecord = {},
> extends BaseAsyncTapOptions {
  provides: ReadonlyArray<Values<Outs>>;
  homeParamGrips?: readonly Grip<any>[];
  handleGrip?: Grip<FunctionTapHandle<StateRec>>;
  initialState?: ReadonlyArray<[Grip<any>, any]> | ReadonlyMap<Grip<any>, any>;
  requestKeyOf: (
    homeParams: ReadonlyMap<Grip<any>, any>,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => string | undefined;
  fetcher: (
    homeParams: ReadonlyMap<Grip<any>, any>,
    signal: AbortSignal,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => Promise<R>;
  mapResult: (
    homeParams: ReadonlyMap<Grip<any>, any>,
    result: R,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => ReadonlyMap<Values<Outs>, GripValue<Values<Outs>>>;
  // Phase 0: Optional state and controller Grips
  stateGrip?: Grip<AsyncRequestState>;
  controllerGrip?: Grip<AsyncTapController>;
}

/**
 * Multi-output async Tap with optional state management.
 *
 * Provides multiple Grips with destination-aware parameter handling.
 * Implements FunctionTapHandle for state management when configured.
 */
class MultiOutputAsyncTap<Outs extends GripRecord, R, StateRec extends GripRecord>
  extends BaseAsyncTap
  implements FunctionTapHandle<StateRec>
{
  private readonly outs: ReadonlyArray<Values<Outs>>;
  private readonly keyOf: (
    params: DestinationParams,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => string | undefined;
  private readonly fetcher: (
    params: DestinationParams,
    signal: AbortSignal,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => Promise<R>;
  private readonly mapper: (
    params: DestinationParams,
    result: R,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => ReadonlyMap<Values<Outs>, GripValue<Values<Outs>>>;
  readonly handleGrip?: Grip<FunctionTapHandle<StateRec>>;
  readonly state = new Map<Grip<any>, any>();

  constructor(cfg: AsyncMultiTapConfig<Outs, R, StateRec>) {
    const providesList = (cfg.handleGrip
      ? [...cfg.provides, cfg.handleGrip]
      : cfg.provides) as unknown as readonly Grip<any>[];
    super({
      provides: providesList,
      destinationParamGrips: cfg.destinationParamGrips,
      homeParamGrips: cfg.homeParamGrips,
      async: cfg,
      // Phase 0: Pass state and controller Grips
      stateGrip: cfg.stateGrip,
      controllerGrip: cfg.controllerGrip,
    });
    this.outs = cfg.provides;
    this.keyOf = cfg.requestKeyOf;
    this.fetcher = cfg.fetcher;
    this.mapper = cfg.mapResult;
    this.handleGrip = cfg.handleGrip as unknown as Grip<FunctionTapHandle<StateRec>> | undefined;
    if (cfg.initialState) {
      const it = Array.isArray(cfg.initialState)
        ? cfg.initialState
        : Array.from((cfg.initialState as ReadonlyMap<Grip<any>, any>).entries());
      for (const [g, v] of it) this.state.set(g, v);
    }
  }

  protected getRequestKey(params: DestinationParams): string | undefined {
    return this.keyOf(params, this.getState.bind(this) as any);
  }

  protected buildRequest(params: DestinationParams, signal: AbortSignal): Promise<unknown> {
    return this.fetcher(params, signal, this.getState.bind(this) as any);
  }

  protected mapResultToUpdates(params: DestinationParams, result: unknown): Map<Grip<any>, any> {
    const typed = this.mapper(params, result as R, this.getState.bind(this) as any);
    const updates = new Map<Grip<any>, any>();
    for (const [g, v] of typed as ReadonlyMap<any, any>) {
      updates.set(g as unknown as Grip<any>, v);
    }
    if (this.handleGrip) {
      updates.set(
        this.handleGrip as unknown as Grip<any>,
        this as unknown as FunctionTapHandle<StateRec>,
      );
    }
    return updates;
  }

  protected getResetUpdates(_params: DestinationParams): Map<Grip<any>, any> {
    const updates = new Map<Grip<any>, any>();
    for (const g of this.outs) {
      updates.set(g as unknown as Grip<any>, undefined);
    }
    // Do not touch handleGrip on reset
    return updates;
  }

  getState<K extends keyof StateRec>(grip: StateRec[K]): GripValue<StateRec[K]> | undefined {
    return this.state.get(grip as unknown as Grip<any>) as GripValue<StateRec[K]> | undefined;
  }

  setState<K extends keyof StateRec>(
    grip: StateRec[K],
    value: GripValue<StateRec[K]> | undefined,
  ): void {
    const prev = this.state.get(grip as unknown as Grip<any>);
    if (prev === value) return;
    this.state.set(grip as unknown as Grip<any>, value);
    // Recompute for all destinations (will abort inflight and reuse cache if present)
    this.produce();
  }
}

/**
 * Factory for multi-output async Taps with destination parameters.
 */
export function createAsyncMultiTap<
  Outs extends GripRecord,
  R = unknown,
  StateRec extends GripRecord = {},
>(cfg: AsyncMultiTapConfig<Outs, R, StateRec>): Tap {
  return new MultiOutputAsyncTap<Outs, R, StateRec>(cfg) as unknown as Tap;
}

/**
 * Multi-output async Tap with home parameters only.
 *
 * Same request for all destinations, no destination-specific parameters.
 * Implements FunctionTapHandle for state management when configured.
 */
class MultiOutputHomeAsyncTap<Outs extends GripRecord, R, StateRec extends GripRecord>
  extends BaseAsyncTap
  implements FunctionTapHandle<StateRec>
{
  private readonly outs: ReadonlyArray<Values<Outs>>;
  private readonly keyOf: (
    homeParams: ReadonlyMap<Grip<any>, any>,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => string | undefined;
  private readonly fetcher: (
    homeParams: ReadonlyMap<Grip<any>, any>,
    signal: AbortSignal,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => Promise<R>;
  private readonly mapper: (
    homeParams: ReadonlyMap<Grip<any>, any>,
    result: R,
    getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined,
  ) => ReadonlyMap<Values<Outs>, GripValue<Values<Outs>>>;
  readonly handleGrip?: Grip<FunctionTapHandle<StateRec>>;
  readonly state = new Map<Grip<any>, any>();

  constructor(cfg: AsyncHomeMultiTapConfig<Outs, R, StateRec>) {
    const providesList = (cfg.handleGrip
      ? [...cfg.provides, cfg.handleGrip]
      : cfg.provides) as unknown as readonly Grip<any>[];
    super({
      provides: providesList,
      homeParamGrips: cfg.homeParamGrips,
      async: cfg,
      // Phase 0: Pass state and controller Grips
      stateGrip: cfg.stateGrip,
      controllerGrip: cfg.controllerGrip,
    });
    this.outs = cfg.provides;
    this.keyOf = cfg.requestKeyOf;
    this.fetcher = cfg.fetcher;
    this.mapper = cfg.mapResult;
    this.handleGrip = cfg.handleGrip as unknown as Grip<FunctionTapHandle<StateRec>> | undefined;
    if (cfg.initialState) {
      const it = Array.isArray(cfg.initialState)
        ? cfg.initialState
        : Array.from((cfg.initialState as ReadonlyMap<Grip<any>, any>).entries());
      for (const [g, v] of it) this.state.set(g, v);
    }
  }

  protected getRequestKey(params: DestinationParams): string | undefined {
    return this.keyOf(params.getAllHomeParams(), this.getState.bind(this) as any);
  }

  protected buildRequest(params: DestinationParams, signal: AbortSignal): Promise<unknown> {
    return this.fetcher(params.getAllHomeParams(), signal, this.getState.bind(this) as any);
  }

  protected mapResultToUpdates(params: DestinationParams, result: unknown): Map<Grip<any>, any> {
    const typed = this.mapper(
      params.getAllHomeParams(),
      result as R,
      this.getState.bind(this) as any,
    );
    const updates = new Map<Grip<any>, any>();
    for (const [g, v] of typed as ReadonlyMap<any, any>) {
      updates.set(g as unknown as Grip<any>, v);
    }
    if (this.handleGrip) {
      updates.set(
        this.handleGrip as unknown as Grip<any>,
        this as unknown as FunctionTapHandle<StateRec>,
      );
    }
    return updates;
  }

  protected getResetUpdates(_params: DestinationParams): Map<Grip<any>, any> {
    const updates = new Map<Grip<any>, any>();
    for (const g of this.outs) {
      updates.set(g as unknown as Grip<any>, undefined);
    }
    // Do not touch handleGrip on reset
    return updates;
  }

  getState<K extends keyof StateRec>(grip: StateRec[K]): GripValue<StateRec[K]> | undefined {
    return this.state.get(grip as unknown as Grip<any>) as GripValue<StateRec[K]> | undefined;
  }

  setState<K extends keyof StateRec>(
    grip: StateRec[K],
    value: GripValue<StateRec[K]> | undefined,
  ): void {
    const prev = this.state.get(grip as unknown as Grip<any>);
    if (prev === value) return;
    this.state.set(grip as unknown as Grip<any>, value);
    // Recompute for all destinations (will abort inflight and reuse cache if present)
    this.produce();
  }
}

/**
 * Factory for multi-output async Taps with home parameters only.
 */
export function createAsyncHomeMultiTap<
  Outs extends GripRecord,
  R = unknown,
  StateRec extends GripRecord = {},
>(cfg: AsyncHomeMultiTapConfig<Outs, R, StateRec>): Tap {
  return new MultiOutputHomeAsyncTap<Outs, R, StateRec>(cfg) as unknown as Tap;
}
