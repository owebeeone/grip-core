# GRIP Async Request State Management

## Overview

The current `BaseAsyncTap` implementation handles request lifecycle, caching, and cancellation, but does not expose the state of outstanding requests to consumers. This document specifies a design for tracking and exposing async request state, enabling consumers to display loading indicators, error messages, stale-while-revalidate status, and retry scheduling.

## Goals

1. **Expose Request State**: Provide visibility into the current state of async requests (loading, success, error, stale-while-revalidate)
2. **Timing Information**: Track when data was retrieved, when requests were initiated, and when retries are scheduled
3. **Error Details**: Capture and expose error information for failed requests
4. **Retry Management**: Track scheduled retries and prevent unnecessary retries when no consumers are listening
5. **Stale-While-Revalidate**: Distinguish between cached data being shown while a refresh is in progress
6. **Listener-Aware Retries**: Only perform retries when there are active consumers

## State Model

### Request State Enumeration

Each destination context can be in one of the following states:

```typescript
/**
 * Base type for all request states with common retry scheduling.
 */
type RequestStateBase = {
  retryAt: number | null; // Scheduled retry time or null if no retry scheduled
};

type RequestState =
  | ({ type: "idle" } & RequestStateBase)
  | ({ type: "loading"; initiatedAt: number } & RequestStateBase)
  | ({ type: "success"; retrievedAt: number } & RequestStateBase)
  | ({ type: "error"; error: Error; failedAt: number } & RequestStateBase)
  | ({ type: "stale-while-revalidate"; retrievedAt: number; refreshInitiatedAt: number } & RequestStateBase)
  | ({ type: "stale-with-error"; retrievedAt: number; error: Error; failedAt: number } & RequestStateBase);
```

### State Transitions

**Allowed Transitions** (explicit list):

1. `idle` → `loading` (first request, no cache)
2. `idle` → `stale-while-revalidate` (cache hit with immediate refresh)
3. `loading` → `success` (request succeeds)
4. `loading` → `error` (request fails, no cache)
5. `success` → `stale-while-revalidate` (refresh initiated)
6. `stale-while-revalidate` → `success` (refresh succeeds)
7. `stale-while-revalidate` → `stale-with-error` (refresh fails)
8. `error` → `loading` (retry initiated)
9. `stale-with-error` → `stale-while-revalidate` (refresh retry initiated)
10. Any state → `idle` (manual reset)

**Visual Flow**:
- Initial load path: `idle` → `loading` → (`success` | `error`)
- Refresh path: `success` → `stale-while-revalidate` → (`success` | `stale-with-error`)
- Retry path: `error` → `loading` → (`success` | `error`)
- Cache hit path: `idle` → `stale-while-revalidate` (if cache exists and refresh initiated)

### Transition Rules

1. **First Fetch vs Refresh**:
   - **First fetch**: If no cached data exists, enter `loading` state
   - **Refresh**: If cached data exists and a new request is initiated, enter `stale-while-revalidate` state (never re-enter `loading` when data is present)
   - **Guarantee**: If cached data exists, state will NEVER be `loading` - it will be `stale-while-revalidate` during refresh

2. **Cache Hit Behavior**:
   - If cached data is available and a request is initiated (TTL refresh or manual), always use `stale-while-revalidate` state
   - `isLoading()` should never return `true` when data is available - if data exists, state must be `success`, `stale-while-revalidate`, or `stale-with-error`
   - UI can safely render cached data when `state.type === "loading"` (guaranteed no data exists)

3. **State Immutability**:
   - Async state is immutable - each state transition creates a new state instance
   - Errors are captured in history entries, not persisted in the current state (unless in error states)
   - After a successful refresh, error information moves to history; current state has no error field

4. **Error Lifecycle**:
   - When `stale-with-error` transitions to `stale-while-revalidate` (refresh retry), error info remains in history
   - When `stale-with-error` transitions to `success` (refresh succeeds), error info moves to history, current state has no error
   - When `error` transitions to `loading` (retry), error info remains in history
   - When `error` transitions to `success` (retry succeeds), error info moves to history, current state has no error
   - **History preserves all errors** - errors are never removed from history, only from current state

4. **Explicit Allowed Transitions**:
   - `idle` → `loading` (first request, no cache)
   - `idle` → `stale-while-revalidate` (cache hit with immediate refresh)
   - `loading` → `success` (request succeeds)
   - `loading` → `error` (request fails, no cache)
   - `success` → `stale-while-revalidate` (refresh initiated)
   - `stale-while-revalidate` → `success` (refresh succeeds)
   - `stale-while-revalidate` → `stale-with-error` (refresh fails)
   - `error` → `loading` (retry initiated)
   - `stale-with-error` → `stale-while-revalidate` (refresh retry initiated)
   - Any state → `idle` (manual reset)

### State Details

#### Common Fields

All states share:
- **`retryAt`**: `number | null` - Scheduled retry time or `null` if no retry is scheduled

#### 1. `idle`
- **When**: No request has been made or all data has been cleared
- **Fields**: `retryAt: null` (no retry scheduled in idle state)
- **Use Case**: Initial state, or after explicit reset
- **Note**: Data is accessed via the output Grip(s), not the state

#### 2. `loading`
- **When**: A request has been initiated and is in-flight, and **no cached data exists**
- **Fields**: `initiatedAt: number`, `retryAt: null` (no retry scheduled while loading)
- **Use Case**: Show loading spinner, disable actions
- **Note**: This state should **never** occur when cached data exists. If cached data exists and a request is in progress, state must be `stale-while-revalidate`. Data is not available via output Grip(s) in this state.

#### 3. `success`
- **When**: Request completed successfully and data is available
- **Fields**: `retrievedAt: number`, `retryAt: number | null` (scheduled refresh if TTL-based)
- **Use Case**: Display data, show last updated time
- **Note**: Data is available via the output Grip(s)

#### 4. `error`
- **When**: Request failed and no cached data is available
- **Fields**: `error: Error`, `failedAt: number`, `retryAt: number | null` (scheduled retry or null if disabled/max retries reached)
- **Use Case**: Show error message, enable manual retry button
- **Note**: Output Grip(s) may contain `undefined` or default values

#### 5. `stale-while-revalidate`
- **When**: Cached data is being shown while a refresh request is in progress
- **Fields**: `retrievedAt: number`, `refreshInitiatedAt: number`, `retryAt: number | null`
- **Use Case**: Show cached data with "refreshing..." indicator, show last updated time
- **Note**: Cached data is available via the output Grip(s); it may be stale

#### 6. `stale-with-error`
- **When**: Cached data is available but the refresh request failed
- **Fields**: `retrievedAt: number`, `error: Error`, `failedAt: number`, `retryAt: number | null`
- **Use Case**: Show cached data with error warning, enable retry button
- **Note**: Stale cached data is available via the output Grip(s)

## State Helper Functions

### Design

To simplify UI code, helper functions should be provided to answer common questions about the async state. These functions work with the `RequestState` type and provide ergonomic checks for common UI patterns.

### Helper Functions

```typescript
/**
 * Checks if data is currently available (either fresh or stale).
 * Returns true if state is success, stale-while-revalidate, or stale-with-error.
 */
function hasData(state: RequestState): boolean {
  return state.type === "success" || 
         state.type === "stale-while-revalidate" || 
         state.type === "stale-with-error";
}

/**
 * Checks if data is available but potentially stale.
 * Returns true if state is stale-while-revalidate or stale-with-error.
 */
function isStale(state: RequestState): boolean {
  return state.type === "stale-while-revalidate" || 
         state.type === "stale-with-error";
}

/**
 * Checks if a request is currently in progress (either initial load or refresh).
 * Returns true if state is loading or stale-while-revalidate.
 * 
 * **Semantics**: This returns true for any in-flight request, regardless of whether data exists.
 * - `loading`: Initial request in progress, no data available
 * - `stale-while-revalidate`: Refresh in progress, cached data available
 * 
 * **Note**: Given the guarantee that `loading` never occurs when data exists, this function
 * effectively indicates "a request is in progress" but doesn't distinguish initial load vs refresh.
 * 
 * **For UI**: 
 * - Use `isLoading(state)` to check for initial load (no data)
 * - Use `isRefreshingWithData(state)` to check for refresh (data exists)
 * - Use `isRefreshing(state)` to check for any in-flight request
 */
function isRefreshing(state: RequestState): boolean {
  return state.type === "loading" || 
         state.type === "stale-while-revalidate";
}

/**
 * Checks if a refresh is in progress with existing data available.
 * Returns true only if state is stale-while-revalidate (data exists, refresh in progress).
 * 
 * **Use Case**: Distinguish between initial load (no data) and refresh (data exists).
 * This is the "refresh" that UIs typically want to show as "refreshing..." while displaying cached data.
 * 
 * **Guarantee**: If this returns true, cached data is available and safe to render.
 */
function isRefreshingWithData(state: RequestState): boolean {
  return state.type === "stale-while-revalidate";
}

/**
 * Checks if there is an error condition.
 * Returns true if state is error or stale-with-error.
 */
function hasError(state: RequestState): boolean {
  return state.type === "error" || 
         state.type === "stale-with-error";
}

/**
 * Gets the error object if present, null otherwise.
 */
function getError(state: RequestState): Error | null {
  return state.type === "error" || state.type === "stale-with-error"
    ? state.error
    : null;
}

/**
 * Checks if the current state indicates loading (no data available yet).
 * Returns true if state is loading and no cached data exists.
 */
function isLoading(state: RequestState): boolean {
  return state.type === "loading";
}

/**
 * Checks if the state is idle (no request has been made).
 */
function isIdle(state: RequestState): boolean {
  return state.type === "idle";
}

/**
 * Gets the timestamp when data was last successfully retrieved.
 * Returns null if no data has been retrieved yet.
 */
function getDataRetrievedAt(state: RequestState): number | null {
  switch (state.type) {
    case "success":
    case "stale-while-revalidate":
    case "stale-with-error":
      return state.retrievedAt;
    default:
      return null;
  }
}

/**
 * Gets the timestamp when a request was initiated.
 * Returns null if no request is currently in progress.
 */
function getRequestInitiatedAt(state: RequestState): number | null {
  switch (state.type) {
    case "loading":
      return state.initiatedAt;
    case "stale-while-revalidate":
      return state.refreshInitiatedAt;
    default:
      return null;
  }
}

/**
 * Gets the timestamp when an error occurred.
 * Returns null if no error has occurred.
 */
function getErrorFailedAt(state: RequestState): number | null {
  switch (state.type) {
    case "error":
    case "stale-with-error":
      return state.failedAt;
    default:
      return null;
  }
}

/**
 * Checks if a retry is scheduled (future time).
 * 
 * **retryAt Semantics**:
 * - When published, retryAt should always represent a future timestamp (or null)
 * - If retryAt is in the past, it means the retry should have fired but hasn't yet (timer delay)
 * - Once a retry fires, retryAt is either updated (next retry) or set to null (no more retries)
 * - retryAt is set to null when: listeners drop to zero, manual reset, or max retries reached
 */
function hasScheduledRetry(state: RequestState): boolean {
  return state.retryAt !== null && state.retryAt > Date.now();
}

/**
 * Gets the time remaining until the next retry in milliseconds.
 * Returns 0 if retry is due now (or overdue), null if no retry is scheduled.
 * 
 * **Behavior**:
 * - If retryAt is in the past, returns 0 (retry should execute immediately)
 * - If retryAt is null, returns null (no retry scheduled)
 * - Otherwise returns milliseconds until retry time
 */
function getRetryTimeRemaining(state: RequestState): number | null {
  if (state.retryAt === null) return null;
  const remaining = state.retryAt - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * Gets a human-readable status string for UI display.
 */
function getStatusMessage(state: RequestState): string {
  switch (state.type) {
    case "idle":
      return "Ready";
    case "loading":
      return "Loading...";
    case "success":
      return "Loaded";
    case "error":
      return `Error: ${state.error.message}`;
    case "stale-while-revalidate":
      return "Refreshing...";
    case "stale-with-error":
      return `Stale (Error: ${state.error.message})`;
  }
}
```

### Usage in UI

These helpers make UI code more readable and maintainable:

```typescript
// In a React component (grip-react)
const userData = useGrip(USER_DATA, ctx);
const state = useGrip(USER_DATA_STATE, ctx);
const controller = useGrip(USER_DATA_CONTROLLER, ctx);

// Simple checks
if (isLoading(state.state)) {
  return <Spinner />;
}

if (hasError(state.state)) {
  const error = getError(state.state);
  return (
    <div>
      <p>Error: {error?.message}</p>
      {hasScheduledRetry(state.state) && (
        <p>Retrying in {Math.ceil(getRetryTimeRemaining(state.state)! / 1000)}s</p>
      )}
      <button onClick={() => controller.retry()}>Retry</button>
      <button onClick={() => controller.retry(true)}>Force Refresh</button>
    </div>
  );
}

// Check data availability
if (!hasData(state.state)) {
  return <div>No data available</div>;
}

// Show data with freshness indicator
const retrievedAt = getDataRetrievedAt(state.state);
const isStaleData = isStale(state.state);
const isRefreshingData = isRefreshing(state.state);

return (
  <div>
    <UserDisplay data={userData} />
    {isStaleData && (
      <small className="warning">
        Showing cached data (may be outdated)
      </small>
    )}
    {isRefreshingData && (
      <small className="info">Refreshing...</small>
    )}
    {retrievedAt && (
      <small>Updated {formatTime(retrievedAt)}</small>
    )}
  </div>
);
```

## State Grip

### Design

Each async tap should optionally provide a state Grip that exposes the current request state for a destination context.

## Retry/Refresh Controller Grip

### Design

Each async tap should optionally provide a controller Grip that exposes retry and refresh operations. This allows UI components to trigger retries and refreshes without needing direct access to the tap instance.

### Controller Interface

```typescript
/**
 * Controller interface for async tap operations.
 * Provides methods to manually trigger retries and refreshes.
 */
interface AsyncTapController {
  /**
   * Manually trigger a retry for the current destination context.
   * Cancels any in-flight request and initiates a new request.
   * 
   * @param forceRefetch - If true, bypasses cache and forces a fresh fetch
   */
  retry(forceRefetch?: boolean): void;
  
  /**
   * Manually trigger a refresh for the current destination context.
   * If data exists, this initiates a stale-while-revalidate refresh.
   * If no data exists, this initiates a new request.
   * 
   * @param forceRefetch - If true, bypasses cache and forces a fresh fetch
   */
  refresh(forceRefetch?: boolean): void;
  
  /**
   * Reset the state for the current destination context.
   * Clears state, cancels retries, and aborts in-flight requests.
   */
  reset(): void;
  
  /**
   * Cancel any scheduled retries for the current destination context.
   */
  cancelRetry(): void;
}
```

### Controller Grip Type

```typescript
const ASYNC_CONTROLLER_GRIP = defineGrip<AsyncTapController>("AsyncTapController", {
  retry: () => {},
  refresh: () => {},
  reset: () => {},
  cancelRetry: () => {},
});
```

### Per-Destination Controllers

The controller Grip value should be specific to each destination context, as different destinations may have different request keys and states. Each destination gets its own controller instance that operates on that specific destination.

### Controller Implementation

The controller should be implemented as a closure that captures the destination context:

```typescript
private createController(dest: GripContext): AsyncTapController {
  return {
    retry: (forceRefetch?: boolean) => {
      // Retry aborts any in-flight request and initiates a new one
      // Increments retryAttempt counter for exponential backoff
      const state = this.getDestState(dest);
      
      // Abort any in-flight request (via AbortController)
      if (state.abortController) {
        state.abortController.abort();
        state.abortController = undefined;
      }
      
      // Cancel any scheduled retries
      this.cancelRetry(dest);
      
      // Increment retry attempt (for exponential backoff)
      state.retryAttempt += 1;
      
      // Initiate new request
      this.kickoff(dest, forceRefetch === true);
    },
    refresh: (forceRefetch?: boolean) => {
      // If we have data, do stale-while-revalidate refresh
      // Otherwise, just kickoff normally
      const state = this.getDestState(dest);
      if (state.currentState.type === "success" || 
          state.currentState.type === "stale-while-revalidate" ||
          state.currentState.type === "stale-with-error") {
        // We have data, refresh it
        this.kickoff(dest, forceRefetch === true);
      } else {
        // No data, just do normal request
        this.kickoff(dest, forceRefetch === true);
      }
    },
    reset: () => {
      this.reset(dest);
    },
    cancelRetry: () => {
      this.cancelRetry(dest);
    },
  };
}

/**
 * Publish controller to controller Grip for a destination.
 */
private publishController(dest: GripContext): void {
  if (!this.controllerGrip || !this.engine || !this.homeContext || !this.producer) {
    return;
  }
  
  const state = this.getDestState(dest);
  const controller = state.controller || this.createNoOpController();
  
  const updates = new Map<Grip<any>, any>([[this.controllerGrip, controller]]);
  this.publish(updates, dest);
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
  };
}
```

### Controller Grip Updates

The controller Grip should be updated whenever:
1. **On Destination Connect**: Create controller for that destination
2. **On Destination Disconnect**: Controller becomes no-op (when `listenerCount === 0`)
3. **On Request Key Change**: Controller continues to work but operates on new key (old request aborted)

### Controller vs Retry Semantics

**`retry()` - Error Recovery**:
- Aborts in-flight request
- Cancels scheduled retries/refreshes
- **Increments `retryAttempt` counter** (for exponential backoff calculation)
- Initiates new request with `forceRefetch` option
- Always executes regardless of listener count
- Used when user wants to retry after an error

**`refresh()` - Data Freshness**:
- Aborts in-flight request
- Cancels scheduled retries/refreshes
- **Does NOT increment `retryAttempt`** (refresh is not error recovery)
- Initiates new request with `forceRefetch` option
- If cached data exists, results in `stale-while-revalidate` state
- If no cached data, results in `loading` state
- Always executes regardless of listener count
- Used when user wants fresh data (not necessarily after error)

**Key Differences**:
1. **retryAttempt**: `retry()` increments it, `refresh()` does not
2. **Purpose**: `retry()` is for error recovery, `refresh()` is for data freshness
3. **Backoff**: `retry()` uses exponential backoff based on retryAttempt, `refresh()` does not
4. **State**: Both can result in same states, but retryAttempt affects backoff timing

### Usage in UI

```typescript
const USER_DATA = defineGrip<User>("UserData", null);
const USER_DATA_STATE = defineGrip<AsyncRequestState>("UserDataState", {
  state: { type: "idle", retryAt: null },
  requestKey: null,
  hasListeners: false,
  history: [],
});
const USER_DATA_CONTROLLER = defineGrip<AsyncTapController>("UserDataController", {
  retry: () => {},
  refresh: () => {},
  reset: () => {},
  cancelRetry: () => {},
});

const userDataTap = createAsyncValueTap({
  provides: [USER_DATA],
  stateGrip: USER_DATA_STATE,
  controllerGrip: USER_DATA_CONTROLLER, // Expose controller
  destinationParamGrips: [USER_ID],
  // ... rest of config
});

// In UI component
const userData = useGrip(USER_DATA, ctx);
const state = useGrip(USER_DATA_STATE, ctx);
const controller = useGrip(USER_DATA_CONTROLLER, ctx);

if (hasError(state.state)) {
  return (
    <div>
      <p>Error: {getError(state.state)?.message}</p>
      <button onClick={() => controller.retry()}>Retry</button>
      <button onClick={() => controller.retry(true)}>Force Refresh</button>
    </div>
  );
}

// Refresh button for stale data
if (isStale(state.state)) {
  return (
    <div>
      <UserDisplay data={userData} />
      <button onClick={() => controller.refresh()}>Refresh</button>
    </div>
  );
}
```

```typescript
/**
 * Historical state entry for debugging purposes.
 * Captures a snapshot of state at a specific point in time.
 */
interface StateHistoryEntry {
  state: RequestState;
  timestamp: number; // When this state was entered
  requestKey: string | null;
  transitionReason?: string; // Optional reason for state transition (e.g., "request_initiated", "cache_hit", "fetch_success", "fetch_error")
}

interface AsyncRequestState {
  state: RequestState;
  requestKey: string | null; // The cache key for this request
  /**
   * Whether any consumers are subscribed to the output Grip(s) for this destination context.
   * 
   * **Source of Truth**: Derived from `DestState.listenerCount > 0` for this destination.
   * 
   * **Semantics**:
   * - Per-destination: Each destination context has its own `hasListeners` value
   * - Not per-request-key: Multiple destinations may share the same request key but have different listener counts
   * - Not state Grip subscribers: Subscribers to the state Grip itself do NOT count as listeners
   * - Not controller Grip subscribers: Subscribers to the controller Grip do NOT count as listeners
   * - Only output Grip subscribers: Only consumers subscribed to the actual data Grip(s) count
   * 
   * **Implementation**: In `onConnect()`, only increment `listenerCount` if the grip is an output Grip (not state or controller Grip).
   * 
   * **Purpose**: Determines whether automatic retries and TTL refreshes should be scheduled/executed.
   */
  hasListeners: boolean;
  /**
   * Read-only array of state transition history entries.
   * 
   * **Immutability**: This array is read-only (frozen) to prevent external mutation.
   * History entries themselves are immutable snapshots.
   * 
   * **Persistence**: History persists across request key changes but entries are marked with the request key at time of transition.
   * History is cleared only on explicit `reset()` call.
   */
  history: ReadonlyArray<StateHistoryEntry>; // Last N state transitions for debugging
  // Note: Data is NOT included here - it's delivered via the output Grip(s)
}
```

### State Grip Type

```typescript
const ASYNC_STATE_GRIP = defineGrip<AsyncRequestState>("AsyncRequestState", {
  state: { type: "idle", retryAt: null },
  requestKey: null,
  hasListeners: false,
  history: [],
});
// Note: All states include retryAt via RequestStateBase
```

### History Configuration

The history size is configurable per tap via the async options:

```typescript
interface BaseAsyncTapOptions {
  // ... existing options ...
  historySize?: number; // Number of state transitions to keep in history (default: 10, 0 = disabled)
}
```

### History Management

- **History is maintained per destination context** - each destination has its own history, even if multiple destinations share the same request key and current state
- **History entries capture the state being exited** - when transitioning from state A to state B, the entry stores state A (the previous state) with the timestamp of the transition
- **History entries are added on every state transition** - captures the state being left behind
- **History is a circular buffer** - when history size is reached, oldest entries are removed
- **History includes transition reasons** - helps understand why state changed (e.g., "request_initiated", "cache_hit", "fetch_success", "fetch_error", "retry_scheduled")
- **History is read-only in the state Grip** - prevents external mutation
- **History can be disabled** - set `historySize: 0` to disable history tracking for performance
- **History persists across request key changes** - when request key changes, history is preserved but new entries are marked with the new request key

### Per-Destination State

The state Grip value should be specific to each destination context, as different destinations may have different request keys and states.

**Important**: Multiple destination contexts may share the same request key (e.g., same parameters) and may have the same current state, but each maintains:
- Its own independent history
- Its own listener count
- Its own controller instance
- Its own retry/refresh timers

This allows fine-grained tracking and control per destination while sharing cached data and request deduplication at the request key level.

## Listener Tracking

### Requirement

Retries and TTL-based refreshes should only be scheduled and executed when there are active listeners (consumers) for the request key. This prevents unnecessary network requests when no components are consuming the data.

### Implementation

1. **Track Subscriptions**: When a consumer subscribes to an output Grip, increment a listener count for that destination's request key
2. **Track Unsubscriptions**: When a consumer unsubscribes, decrement the listener count
3. **Check Before Retry/Refresh**: Before executing a scheduled retry or TTL refresh, verify that `hasListeners === true`
4. **Cancel Retries/Refreshes**: If all listeners unsubscribe, cancel any scheduled retries and TTL refreshes for that request key
5. **State on Zero Listeners**: When listeners drop to zero:
   - Cancel all scheduled retries and TTL refreshes (`retryAt` set to `null`)
   - Keep the current state (do not reset to idle) - this preserves the last known state for debugging
   - Clear the controller (make it no-op) if controller Grip is provided
   - State remains frozen until listeners return or manual reset is called

### hasListeners Implementation

**Single Source of Truth**: `hasListeners` in `AsyncRequestState` is derived from `DestState.listenerCount > 0` for that specific destination context.

**Tracking Implementation**:
```typescript
interface DestState {
  listenerCount: number; // Per-destination listener count (incremented on connect, decremented on disconnect)
  // ... other fields
}

// Per request key: aggregate listener count across all destinations with that key
private readonly listenerCounts = new Map<string, number>();

// Per destination: the request key it's listening to
private readonly destinationRequestKeys = new WeakMap<GripContext, string>();

// When publishing state:
function publishState(dest: GripContext): void {
  const state = this.getDestState(dest);
  const asyncState: AsyncRequestState = {
    state: state.currentState,
    requestKey: state.requestKey,
    hasListeners: state.listenerCount > 0, // Single source of truth
    history: Object.freeze([...state.history]) as ReadonlyArray<StateHistoryEntry>, // Shallow frozen (array is readonly, entries treated as immutable by convention)
  };
  // ... publish to state Grip
}
```

**Key Points**:
- `hasListeners` is **per-destination**, not per-request-key
- Multiple destinations can share the same request key but have different `hasListeners` values
- State Grip subscribers do NOT count toward `hasListeners`
- Only output Grip subscribers count toward `hasListeners`

### Listener Count Map

```typescript
// Per request key: number of active listeners
private readonly listenerCounts = new Map<string, number>();

// Per destination: the request key it's listening to
private readonly destinationRequestKeys = new WeakMap<GripContext, string>();
```

## Retry Logic

### Retry Scheduling

Retries should be scheduled based on:

1. **Error-based Retries**: When a request fails, schedule a retry with exponential backoff
2. **TTL-based Refreshes**: When data has a TTL, schedule a refresh before expiration
3. **Manual Retries**: User-initiated retries (via controller)

### Retry Configuration

```typescript
interface RetryConfig {
  maxRetries?: number; // Maximum number of retries (default: 3)
  initialDelayMs?: number; // Initial retry delay (default: 1000ms)
  maxDelayMs?: number; // Maximum retry delay (default: 30000ms)
  backoffMultiplier?: number; // Exponential backoff multiplier (default: 2)
  retryOnError?: (error: Error) => boolean; // Predicate to determine if error is retryable
}
```

### Retry Scheduling Algorithm

```typescript
function calculateRetryTime(
  attempt: number,
  config: RetryConfig,
  baseTime: number = Date.now()
): number | null {
  if (attempt >= (config.maxRetries ?? 3)) {
    return null; // Max retries reached
  }
  
  const delay = Math.min(
    (config.initialDelayMs ?? 1000) * Math.pow(config.backoffMultiplier ?? 2, attempt),
    config.maxDelayMs ?? 30000
  );
  
  return baseTime + delay;
}
```

### TTL-based Refresh Scheduling

For cached data with TTL:

```typescript
function calculateRefreshTime(
  retrievedAt: number,
  ttlMs: number,
  refreshBeforeExpiryMs: number = 0
): number | null {
  if (ttlMs <= 0) return null; // No TTL, no scheduled refresh
  
  const expiryTime = retrievedAt + ttlMs;
  const refreshTime = expiryTime - refreshBeforeExpiryMs;
  
  return refreshTime > Date.now() ? refreshTime : null;
}
```

## API Design

### BaseAsyncTap Extensions

```typescript
export abstract class BaseAsyncTap extends BaseTap {
  // Optional state Grip to expose request state
  readonly stateGrip?: Grip<AsyncRequestState>;
  
  // Optional controller Grip to expose retry/refresh operations
  readonly controllerGrip?: Grip<AsyncTapController>;
  
  // Get current state for a destination
  getRequestState(dest: GripContext): AsyncRequestState;
  
  // Internal methods (controller Grip provides public API)
  protected retry(dest: GripContext, forceRefetch?: boolean): void;
  protected refresh(dest: GripContext, forceRefetch?: boolean): void;
  protected reset(dest: GripContext): void;
  protected cancelRetry(dest: GripContext): void;
}
```

### State Helper Functions Export

The helper functions should be exported from the core library for use in UI code:

```typescript
// Export from @owebeeone/grip-core
export type { AsyncTapController } from "./core/async_tap";
export {
  hasData,
  isStale,
  isRefreshing,
  hasError,
  getError,
  isLoading,
  isIdle,
  getDataRetrievedAt,
  getRequestInitiatedAt,
  getErrorFailedAt,
  hasScheduledRetry,
  getRetryTimeRemaining,
  getStatusMessage,
} from "./core/async_state_helpers";
```

### Factory Function Extensions

```typescript
export interface AsyncValueTapConfig<T> extends BaseAsyncTapOptions {
  // ... existing options ...
  
  // Optional: provide a state Grip to expose request state
  stateGrip?: Grip<AsyncRequestState>;
  
  // Optional: provide a controller Grip to expose retry/refresh operations
  controllerGrip?: Grip<AsyncTapController>;
  
  // Optional: retry configuration
  retry?: RetryConfig;
  
  // Optional: refresh data before TTL expires (milliseconds before expiry)
  refreshBeforeExpiryMs?: number;
}
```

### State Grip Updates

The state Grip should be updated:

1. **On Request Initiation**: Transition to `loading`
2. **On Request Success**: Transition to `success` or `stale-while-revalidate`
3. **On Request Failure**: Transition to `error` or `stale-with-error`
4. **On Retry Scheduling**: Update `retryAt` timestamp
5. **On Listener Changes**: Update `hasListeners` flag
6. **On Cache Hit**: Transition to `stale-while-revalidate` if refresh initiated

## Concurrency and Race Conditions

### Concurrent Request Handling

When multiple requests are initiated rapidly (e.g., rapid parameter changes or manual retry/refresh):

1. **Abort Previous Request**: Any new `kickoff()` call should abort the in-flight request for that destination
2. **Cancel Scheduled Retries**: Manual retry/refresh cancels any scheduled retries/refreshes
3. **Request Key Changes**: If request key changes while a request is in-flight, abort the old request and handle key change
4. **Latest-Only Semantics**: If `latestOnly: true`, out-of-order completions are ignored (sequence number check)

### Implementation

```typescript
private kickoff(dest: GripContext, forceRefetch?: boolean): void {
  const state = this.getDestState(dest);
  
  // Abort any in-flight request for this destination (via AbortController)
  if (state.abortController) {
    state.abortController.abort();
    this.addHistoryEntry(dest, state.currentState, "concurrent_request_aborted");
    state.abortController = undefined;
  }
  
  // Create new AbortController for this request
  state.abortController = new AbortController();
  
  // Cancel any scheduled retries/refreshes
  this.cancelRetry(dest);
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
  
  // ... rest of kickoff logic (use state.abortController.signal for fetch) ...
}
```

### Data Availability Guarantees

**Guarantee**: If cached data exists and a request is initiated, the state will **always** be `stale-while-revalidate`, never `loading`. This ensures:
- UI can safely render cached data when `state.type === "loading"` (no data exists)
- UI can safely render cached data when `state.type === "stale-while-revalidate"` (data exists, refresh in progress)
- `isLoading()` will never return `true` when data is available

## Implementation Details

### State Storage

```typescript
interface DestState {
  // ... existing fields ...
  
  // Request state tracking
  currentState: RequestState;
  requestKey: string | null;
  listenerCount: number; // Count of output Grip subscribers only (not state/controller Grip subscribers)
  retryAttempt: number;
  retryTimer: any | null;
  refreshTimer: any | null;
  history: StateHistoryEntry[]; // Circular buffer of state transitions
  historySize: number; // Maximum history entries to keep
  controller?: AsyncTapController; // Controller instance for this destination
  abortController?: AbortController; // AbortController for in-flight requests (separate from AsyncTapController)
}
```

### State Updates

State updates should be published to the state Grip (if provided) whenever:

1. State transitions occur
2. Retry times are calculated or updated
3. Listener counts change
4. Timers are scheduled or cancelled

### History Updates

History entries should be added whenever a state transition occurs:

```typescript
private addHistoryEntry(
  dest: GripContext,
  newState: RequestState,
  reason?: string
): void {
  const state = this.getDestState(dest);
  
  if (state.historySize === 0) return; // History disabled
  
  const entry: StateHistoryEntry = {
    state: state.currentState, // Previous state
    timestamp: Date.now(),
    requestKey: state.requestKey,
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
```

### Transition Reasons

Common transition reasons for debugging:

- `"initial"` - Initial state when tap is first connected
- `"request_initiated"` - New request started
- `"cache_hit"` - Data retrieved from cache
- `"fetch_success"` - Request completed successfully
- `"fetch_error"` - Request failed with error
- `"retry_scheduled"` - Retry scheduled after error
- `"retry_executed"` - Retry attempt initiated
- `"refresh_initiated"` - Stale-while-revalidate refresh started
- `"refresh_success"` - Refresh completed successfully
- `"refresh_error"` - Refresh failed
- `"listener_unsubscribed"` - All listeners unsubscribed (retryAt cleared, state frozen)
- `"manual_reset"` - State manually reset via controller
- `"manual_retry"` - Manual retry triggered via controller
- `"manual_refresh"` - Manual refresh triggered via controller
- `"ttl_refresh_scheduled"` - TTL-based refresh scheduled
- `"ttl_refresh_executed"` - TTL-based refresh executed
- `"request_key_changed"` - Request key changed (parameters changed)
- `"concurrent_request_aborted"` - In-flight request aborted due to concurrent request

### Retry Execution

```typescript
private executeRetry(dest: GripContext, requestKey: string): void {
  const state = this.getDestState(dest);
  
  // Check if listeners still exist
  if (state.listenerCount === 0) {
    // No listeners, cancel retry
    state.retryTimer = null;
    state.currentState = { ...state.currentState, retryAt: null };
    this.publishState(dest);
    return;
  }
  
  // Check if request key still matches
  const currentParams = this.getDestinationParams(dest);
  const currentKey = currentParams ? this.getRequestKey(currentParams) : null;
  if (currentKey !== requestKey) {
    // Request key changed, cancel retry and reset state
    this.handleRequestKeyChange(dest, requestKey, currentKey);
    return;
  }
  
  // Execute retry
  // Note: retryAttempt is incremented when retry is scheduled (for scheduled retries)
  // or when manual retry() is called (for manual retries)
  // This ensures retryAttempt is correct before kickoff is called
  this.kickoff(dest, true); // forceRefetch = true
}

/**
 * Handle request key change - cancel old timers, preserve history, reset state.
 * 
 * **Behavior**:
 * - History is preserved (not cleared) but new entries will have new request key
 * - All timers for old key are cancelled
 * - In-flight requests for old key are aborted
 * - Retry attempt counter is reset (new key = fresh start)
 * - State transitions based on whether new key is available
 */
private handleRequestKeyChange(
  dest: GripContext,
  oldKey: string,
  newKey: string | null
): void {
  const state = this.getDestState(dest);
  
  // Cancel old retry/refresh timers (these were for the old key)
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
  
  // Abort any in-flight request for old key
  if (state.abortController) {
    state.abortController.abort();
    this.addHistoryEntry(dest, state.currentState, "request_key_changed_aborted");
    state.abortController = undefined;
  }
  
  // Reset retry attempt counter for new key (fresh start)
  state.retryAttempt = 0;
  
  // Update request key
  const previousKey = state.requestKey;
  state.requestKey = newKey;
  
  // Add history entry for key change (preserve history, mark with new key)
  this.addHistoryEntry(dest, { ...state.currentState, retryAt: null }, "request_key_changed");
  
  // If new key is available, initiate new request
  if (newKey) {
    // Transition to loading (no cached data for new key yet)
    this.addHistoryEntry(dest, { type: "loading", initiatedAt: Date.now(), retryAt: null }, "request_initiated");
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
```

### Listener Tracking in Lifecycle

```typescript
onConnect(dest: GripContext, grip: Grip<any>): void {
  const state = this.getDestState(dest);
  
  // Only increment listenerCount for output Grips (not state or controller Grips)
  // This ensures hasListeners accurately reflects whether data consumers exist
  const isOutputGrip = this.isOutputGrip(grip);
  if (isOutputGrip) {
    state.listenerCount += 1;
    
    // Update request key if needed
    const params = this.getDestinationParams(dest);
    if (params) {
      const key = this.getRequestKey(params);
      if (key) {
        this.destinationRequestKeys.set(dest, key);
        this.incrementListenerCount(key);
      }
    }
  }
  
  // Create controller if controller Grip is provided (regardless of which grip connected)
  // Controller creation is independent of listener counting
  if (this.controllerGrip && !state.controller) {
    state.controller = this.createController(dest);
    this.publishController(dest);
  }
  
  // ... existing connection logic ...
  this.publishState(dest);
}

/**
 * Check if a grip is an output Grip (data Grip, not state or controller Grip).
 * 
 * **Output Grips**: Grips in the `provides` array - these deliver actual data to consumers.
 * **Non-Output Grips**: State Grip and Controller Grip - these are metadata/control, not data.
 * 
 * Only output Grip subscribers count toward hasListeners for retry/refresh scheduling.
 */
private isOutputGrip(grip: Grip<any>): boolean {
  // State and controller Grips are provided by the tap, output Grips are in provides array
  return this.provides.includes(grip);
}

onDisconnect(dest: GripContext, grip: Grip<any>): void {
  const state = this.getDestState(dest);
  
  // Only decrement listenerCount for output Grips (not state or controller Grips)
  const isOutputGrip = this.isOutputGrip(grip);
  if (isOutputGrip) {
    state.listenerCount = Math.max(0, state.listenerCount - 1);
    
    // Decrement listener count for request key
    const key = this.destinationRequestKeys.get(dest);
    if (key) {
      this.decrementListenerCount(key);
      
      // Cancel retries and TTL refreshes if no listeners
      if (state.listenerCount === 0) {
        this.cancelRetry(dest);
        // Also cancel TTL refresh timer
        if (state.refreshTimer) {
          clearTimeout(state.refreshTimer);
          state.refreshTimer = null;
        }
        // Clear retryAt in state
        state.currentState = { ...state.currentState, retryAt: null };
      }
    }
    
    // Clear controller if no listeners remain
    if (state.listenerCount === 0 && this.controllerGrip) {
      state.controller = undefined;
      this.publishController(dest);
    }
  }
  
  // ... existing disconnection logic ...
  this.publishState(dest);
}
```

## Usage Examples

### Basic Usage with State Grip

```typescript
const USER_DATA = defineGrip<User>("UserData", null);
const USER_DATA_STATE = defineGrip<AsyncRequestState>("UserDataState", {
  state: { type: "idle", retryAt: null },
  requestKey: null,
  hasListeners: false,
  history: [],
});
// Note: retryAt is common to all states via RequestStateBase

const userDataTap = createAsyncValueTap({
  provides: [USER_DATA],
  stateGrip: USER_DATA_STATE, // Expose state
  destinationParamGrips: [USER_ID],
  requestKeyOf: (params) => params.destination[USER_ID],
  fetcher: async (params, signal) => {
    const response = await fetch(`/api/users/${params.destination[USER_ID]}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
  mapResult: (result) => ({ [USER_DATA]: result }),
  opts: {
    cacheTtlMs: 5 * 60 * 1000, // 5 minutes
    retry: {
      maxRetries: 3,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
    },
  },
});
```

### Consuming State in UI (Using Helper Functions)

```typescript
// In a React component (grip-react)
import {
  hasData,
  isStale,
  isRefreshing,
  hasError,
  getError,
  isLoading,
  getDataRetrievedAt,
  hasScheduledRetry,
  getRetryTimeRemaining,
} from "@owebeeone/grip-core";

const userData = useGrip(USER_DATA, ctx);
const state = useGrip(USER_DATA_STATE, ctx);
const controller = useGrip(USER_DATA_CONTROLLER, ctx);

// Simple checks using helpers
if (isLoading(state.state)) {
  return <Spinner />;
}

if (hasError(state.state)) {
  const error = getError(state.state);
  return (
    <div>
      <p>Error: {error?.message}</p>
      {hasScheduledRetry(state.state) && (
        <p>Retrying in {Math.ceil(getRetryTimeRemaining(state.state)! / 1000)}s</p>
      )}
      <button onClick={() => controller.retry()}>Retry</button>
      <button onClick={() => controller.retry(true)}>Force Refresh</button>
    </div>
  );
}

// Check data availability
if (!hasData(state.state)) {
  return <div>No data available</div>;
}

// Show data with freshness indicators
const retrievedAt = getDataRetrievedAt(state.state);
const isStaleData = isStale(state.state);
const isRefreshingData = isRefreshing(state.state);

return (
  <div>
    <UserDisplay data={userData} />
    {isStaleData && (
      <small className="warning">Showing cached data (may be outdated)</small>
    )}
    {isRefreshingData && <small className="info">Refreshing...</small>}
    {retrievedAt && <small>Updated {formatTime(retrievedAt)}</small>}
    {process.env.NODE_ENV === "development" && state.history.length > 0 && (
      <details>
        <summary>State History ({state.history.length} entries)</summary>
        <ul>
          {state.history.map((entry, i) => (
            <li key={i}>
              {new Date(entry.timestamp).toLocaleTimeString()} - {entry.state.type}
              {entry.transitionReason && ` (${entry.transitionReason})`}
            </li>
          ))}
        </ul>
      </details>
    )}
  </div>
);
```

## Migration Considerations

### Backward Compatibility

- State Grip is optional - existing code continues to work without it
- State tracking is internal - no breaking changes to existing APIs
- Retry behavior is opt-in via configuration

### Performance

- State updates should be batched to avoid excessive re-renders
- Listener counting is lightweight (increment/decrement operations)
- Retry timers are only created when needed

## Testing Requirements

1. **State Transitions**: Verify all state transitions occur correctly
2. **Retry Scheduling**: Verify retries are scheduled with correct timing
3. **Listener Tracking**: Verify retries are cancelled when listeners unsubscribe
4. **Error Handling**: Verify error states are captured correctly
5. **Stale-While-Revalidate**: Verify cached data is shown during refresh
6. **TTL Refresh**: Verify refreshes are scheduled before TTL expiry
7. **Multiple Destinations**: Verify state is tracked independently per destination
8. **History Tracking**: Verify history entries are added on state transitions
9. **History Size Limit**: Verify history circular buffer maintains correct size
10. **History Disabled**: Verify history is not tracked when `historySize: 0`
11. **History Read-Only**: Verify history array is read-only in published state

## Future Enhancements

1. **Request Progress**: Track upload/download progress for long-running requests
2. **Request Cancellation**: Expose ability to cancel in-flight requests
3. **Request Queuing**: Queue requests when offline, execute when online
4. **Optimistic Updates**: Support optimistic updates with rollback on error
5. **Request Deduplication**: Expose information about request deduplication

