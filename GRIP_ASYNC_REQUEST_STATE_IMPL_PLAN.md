# GRIP Async Request State Implementation Plan

## Overview

This document outlines a phased, test-driven approach to implementing the async request state management system specified in `GRIP_ASYNC_REQUEST_STATE.md`.

## Implementation Strategy

**Test-Driven Design Process:**
1. **Phase 0**: Define all types, interfaces, and method signatures (no implementation)
2. **Phase 1+**: For each phase:
   - Write comprehensive tests first
   - Implement functionality to pass tests
   - Review and refactor
   - Add integration tests

## Phase 0: Type Definitions and Interfaces (No Implementation)

**Goal**: Establish all type definitions, interfaces, and method signatures without any implementation.

**Deliverables**:
1. Create `src/core/async_request_state.ts` with:
   - `RequestStateBase` type
   - `RequestState` discriminated union type
   - `StateHistoryEntry` interface
   - `AsyncRequestState` interface
   - `AsyncTapController` interface
   - `RetryConfig` interface
   - `BaseAsyncTapOptions` extension (add `historySize`, `retry`, `refreshBeforeExpiryMs`)

2. Update `src/core/async_tap.ts`:
   - Extend `DestState` interface with new fields (commented as "TODO: Phase X")
   - Add optional `stateGrip` and `controllerGrip` to `BaseAsyncTap` constructor options
   - Update all factory config interfaces to accept optional `stateGrip` and `controllerGrip`:
     - `AsyncValueTapConfig`
     - `AsyncHomeValueTapConfig`
     - `AsyncMultiTapConfig`
     - `AsyncHomeMultiTapConfig`
   - Update factory constructors to pass `stateGrip`/`controllerGrip` to `BaseAsyncTap`
   - Add method signatures (no implementation):
     - `getRequestState(dest: GripContext): AsyncRequestState`
     - `protected retry(dest: GripContext, forceRefetch?: boolean): void`
     - `protected refresh(dest: GripContext, forceRefetch?: boolean): void`
     - `protected reset(dest: GripContext): void`
     - `protected cancelRetry(dest: GripContext): void`
     - `private publishState(dest: GripContext): void`
     - `private publishController(dest: GripContext): void`
     - `private createController(dest: GripContext): AsyncTapController`
     - `private addHistoryEntry(dest: GripContext, newState: RequestState, reason?: string): void`
     - `private scheduleRetry(dest: GripContext): void`
     - `private executeRetry(dest: GripContext, requestKey: string): void`
     - `private handleRequestKeyChange(dest: GripContext, oldKey: string, newKey: string | null): void`
     - `private isOutputGrip(grip: Grip<any>): boolean`

3. Create `src/core/async_state_helpers.ts`:
   - Export all helper function signatures (no implementation)

4. Update `src/index.ts`:
   - Export types and helper functions

**Testing**: Type checking only - ensure all types compile correctly.

**Estimated Time**: 1 day

---

## Phase 1: Helper Functions and State Building

**Goal**: Implement helper functions and ability to manually construct/validate state objects.

**Deliverables**:
1. Implement all helper functions in `src/core/async_state_helpers.ts`:
   - `hasData(state: RequestState): boolean`
   - `isStale(state: RequestState): boolean`
   - `isRefreshing(state: RequestState): boolean`
   - `isRefreshingWithData(state: RequestState): boolean`
   - `hasError(state: RequestState): boolean`
   - `getError(state: RequestState): Error | null`
   - `isLoading(state: RequestState): boolean`
   - `isIdle(state: RequestState): boolean`
   - `getDataRetrievedAt(state: RequestState): number | null`
   - `getRequestInitiatedAt(state: RequestState): number | null`
   - `getErrorFailedAt(state: RequestState): number | null`
   - `hasScheduledRetry(state: RequestState): boolean`
   - `getRetryTimeRemaining(state: RequestState): number | null`
   - `getStatusMessage(state: RequestState): string`

2. Create `tests/async_state_helpers.spec.ts`:
   - Test each helper function with all state types
   - Test edge cases (null retryAt, past retryAt, etc.)
   - Test guarantees (e.g., `isLoading()` never returns true when data exists)

**Testing Requirements**:
- All helper functions work correctly for all state types
- Guarantees are verified (e.g., loading never has data)
- Edge cases handled (null values, past timestamps, etc.)

**Estimated Time**: 2-3 days

---

## Phase 2: State Tracking and Publishing to State Grip

**Goal**: Implement state tracking infrastructure and publish state to state Grip per destination.

**Deliverables**:
1. Extend `DestState` interface with state tracking fields:
   - `currentState: RequestState`
   - `listenerCount: number`
   - `retryAttempt: number`
   - `retryTimer: any | null`
   - `refreshTimer: any | null`
   - `history: StateHistoryEntry[]`
   - `historySize: number`
   - `abortController?: AbortController` (rename from `controller`)

2. Implement state management methods:
   - `addHistoryEntry()` - Add entry to history circular buffer
   - `publishState()` - Publish state to state Grip for destination
   - Initialize state in `getDestState()` - default to idle state

3. Integrate state transitions in `kickoff()`:
   - Transition to `loading` when request starts (no cache)
   - Transition to `stale-while-revalidate` when request starts (with cache)
   - Transition to `success` on successful fetch
   - Transition to `error` on failed fetch (no cache)
   - Transition to `stale-with-error` on failed refresh (with cache)

4. Create test files:
   - `tests/async_state_transitions.spec.ts`: Test state transitions in various scenarios, state immutability (new instances on transitions)
   - `tests/async_state_publishing.spec.ts`: Test state Grip publishing (verify state is published per destination), state persistence across request key changes
   - `tests/async_state_history.spec.ts`: Test history tracking (entries added, circular buffer works) - can be created here or in Phase 6

**Testing Requirements**:
- State transitions follow the specified rules
- State is published correctly to state Grip
- History entries are captured correctly
- State is per-destination (multiple destinations have independent state)
- State persists across request key changes

**Estimated Time**: 3-4 days

---

## Phase 3: Listener Tracking

**Goal**: Track listeners per destination (only output Grips count) and update `hasListeners` in state.

**Deliverables**:
1. Implement listener tracking:
   - `isOutputGrip()` - Check if grip is in `provides` array
   - Update `onConnect()` - Only increment `listenerCount` for output Grips
   - Update `onDisconnect()` - Only decrement `listenerCount` for output Grips
   - Track per-request-key listener counts (for retry/refresh scheduling)
   - Update `hasListeners` in published state

2. Implement zero-listener behavior:
   - Cancel retries and TTL refreshes when listeners drop to zero
   - Freeze state (don't reset to idle)
   - Clear controller (make no-op)

3. Create `tests/async_listener_tracking.spec.ts`:
   - Test listener counting (only output Grips count)
   - Test state/controller Grip subscribers don't count
   - Test zero-listener behavior (retries cancelled, state frozen)
   - Test listener count per destination vs per request key
   - Test `hasListeners` in published state

**Testing Requirements**:
- Only output Grip subscribers count toward `hasListeners`
- State/controller Grip subscribers don't count
- Zero listeners cancels retries/refreshes
- State is frozen (not reset) when listeners drop to zero
- `hasListeners` accurately reflects listener count

**Estimated Time**: 2-3 days

---

## Phase 4: Retry System

**Goal**: Implement exponential backoff retry system with listener-aware execution.

**Deliverables**:
1. Implement retry configuration and calculation:
   - `calculateRetryDelay()` - Exponential backoff calculation
   - `scheduleRetry()` - Schedule retry with backoff
   - `executeRetry()` - Execute scheduled retry (check listeners, request key)

2. Integrate retry scheduling:
   - Schedule retry on error (if listeners exist)
   - Cancel retry when listeners drop to zero
   - Cancel retry on request key change
   - Increment `retryAttempt` when scheduling (not executing)
   - **CRITICAL**: Add `retryTimer` to `allTimers` set for automatic cleanup in `onDetach()`

3. Update error handling in `kickoff()`:
   - Capture errors from `buildRequest()` failures
   - Transition to `error` or `stale-with-error` state
   - Schedule retry if configured and listeners exist

4. Create `tests/async_retry.spec.ts`:
   - Test exponential backoff calculation
   - Test retry scheduling (only when listeners exist)
   - Test retry cancellation (zero listeners, key change)
   - Test retry execution (listener check, key check)
   - Test retry attempt counter (increments on schedule, not execution)
   - Test max retries limit
   - Test retry timer cleanup

**Testing Requirements**:
- Exponential backoff works correctly
- Retries only scheduled/executed when listeners exist
- Retries cancelled appropriately
- Retry attempt counter managed correctly
- Max retries respected

**Estimated Time**: 3-4 days

---

## Phase 5: TTL Refresh Scheduling

**Goal**: Implement automatic TTL-based refresh scheduling before cache expiry.

**Deliverables**:
1. Implement TTL refresh calculation:
   - `calculateRefreshTime()` - Calculate refresh time before TTL expiry
   - Schedule refresh timer when data is cached
   - Only schedule if `hasListeners === true`

2. Integrate TTL refresh:
   - Schedule refresh on successful fetch (if TTL configured)
   - Cancel refresh when listeners drop to zero
   - Cancel refresh on request key change
   - Execute refresh (check listeners, use stale-while-revalidate)
   - **CRITICAL**: Add `refreshTimer` to `allTimers` set for automatic cleanup in `onDetach()`

3. Update `kickoff()` to handle TTL refreshes:
   - Check if refresh is due when destination connects
   - Schedule refresh after successful fetch

4. Create `tests/async_ttl_refresh.spec.ts`:
   - Test refresh time calculation
   - Test refresh scheduling (only when listeners exist)
   - Test refresh cancellation (zero listeners, key change)
   - Test refresh execution (listener check, stale-while-revalidate state)
   - Test refresh timer cleanup

**Testing Requirements**:
- Refresh scheduled before TTL expiry
- Refresh only scheduled/executed when listeners exist
- Refresh cancelled appropriately
- Refresh uses stale-while-revalidate state

**Estimated Time**: 2-3 days

---

## Phase 6: History Tracking

**Goal**: Implement circular buffer history tracking with transition reasons.

**Deliverables**:
1. Complete history implementation:
   - Ensure `addHistoryEntry()` captures previous state correctly
   - Maintain circular buffer (remove oldest when size exceeded)
   - Add transition reasons to all state transitions
   - Preserve history across request key changes

2. History management:
   - Clear history on `reset()`
   - Preserve history on request key change (mark with new key)
   - Shallow freeze history when publishing

3. Create `tests/async_state_history.spec.ts` (if not created in Phase 2):
   - Test history entries capture previous state
   - Test circular buffer behavior
   - Test history persistence across key changes
   - Test history clearing on reset
   - Test transition reasons are recorded
   - Test history is per-destination

**Testing Requirements**:
- History entries store previous state (not new state)
- Circular buffer maintains correct size
- History persists across key changes
- History cleared on reset
- History is per-destination

**Estimated Time**: 2 days

---

## Phase 7: Error Capture and Tracking

**Goal**: Capture errors from failed requests and expose them in state.

**Deliverables**:
1. Update error handling:
   - Capture errors from `buildRequest()` catch block
   - Store errors in state (error/stale-with-error states)
   - Preserve errors in history
   - Clear errors from current state on successful refresh

2. Error lifecycle:
   - Errors move to history on successful refresh
   - Errors remain in history (never removed)
   - Current state only has errors in error states

3. Create `tests/async_error_tracking.spec.ts`:
   - Test error capture from failed requests
   - Test error in state (error/stale-with-error)
   - Test error lifecycle (moves to history on success)
   - Test error persistence in history
   - Test error clearing from current state

**Testing Requirements**:
- Errors captured correctly
- Errors exposed in state
- Errors preserved in history
- Errors cleared from current state on success

**Estimated Time**: 1-2 days

---

## Phase 8: Controller Grip Implementation

**Goal**: Implement controller Grip creation and publishing per destination.

**Deliverables**:
1. Implement controller creation:
   - `createController()` - Create controller closure for destination
   - `createNoOpController()` - Create no-op controller for zero listeners
   - `publishController()` - Publish controller to controller Grip

2. Controller lifecycle:
   - Create controller on destination connect (if controller Grip provided)
   - Clear controller (make no-op) when listeners drop to zero
   - Controller persists across request key changes

3. Create `tests/async_controller_grip.spec.ts`:
   - Test controller creation per destination
   - Test controller is no-op when zero listeners
   - Test controller persists across key changes
   - Test controller Grip publishing

**Testing Requirements**:
- Controller created per destination
- Controller is no-op when zero listeners
- Controller persists across key changes
- Controller Grip publishes correctly

**Estimated Time**: 1-2 days

---

## Phase 9: Controller Functionality Implementation

**Goal**: Implement retry, refresh, reset, and cancelRetry methods in controller.

**Deliverables**:
1. Implement controller methods:
   - `retry()` - Abort in-flight, cancel timers, increment retryAttempt, kickoff
   - `refresh()` - Abort in-flight, cancel timers, don't increment retryAttempt, kickoff
   - `reset()` - Abort in-flight, cancel timers, clear history, reset state to idle
   - `cancelRetry()` - Cancel retry timer, clear retryAt

2. Integrate controller methods:
   - Ensure methods work correctly with state tracking
   - Ensure methods respect listener counts
   - Ensure methods handle request key changes

3. Create `tests/async_controller_functionality.spec.ts`:
   - Test `retry()` - increments retryAttempt, aborts in-flight, cancels timers
   - Test `refresh()` - doesn't increment retryAttempt, aborts in-flight, cancels timers
   - Test `reset()` - clears history, resets state, cancels timers
   - Test `cancelRetry()` - cancels retry timer, clears retryAt
   - Test controller methods work with zero listeners
   - Test controller methods handle concurrent requests

**Testing Requirements**:
- Controller methods work correctly
- Retry vs refresh semantics are correct
- Reset clears everything appropriately
- Controller methods handle edge cases

**Estimated Time**: 2-3 days

---

## Phase 10: Request Key Change Handling

**Goal**: Implement proper handling of request key changes (abort old, preserve history, reset counters).

**Deliverables**:
1. Implement `handleRequestKeyChange()`:
   - Cancel old retry/refresh timers
   - Abort in-flight request for old key
   - Preserve history (mark with new key)
   - Reset retry attempt counter
   - Transition state appropriately

2. Integrate key change handling:
   - Call `handleRequestKeyChange()` when key changes in `kickoff()`
   - Call `handleRequestKeyChange()` when key changes in retry execution

3. Create `tests/async_request_key_change.spec.ts`:
   - Test key change cancels old timers
   - Test key change aborts old request
   - Test key change preserves history
   - Test key change resets retry attempt
   - Test key change transitions state correctly

**Testing Requirements**:
- Key changes handled correctly
- Old timers/requests cancelled
- History preserved
- Retry attempt reset
- State transitions correctly

**Estimated Time**: 2 days

---

## Phase 11: Integration and Edge Cases

**Goal**: Integrate all features, handle edge cases, and comprehensive testing.

**Deliverables**:
1. Integration testing:
   - Test all features working together
   - Test complex scenarios (rapid key changes, concurrent requests, etc.)
   - Test performance (history size limits, timer cleanup, etc.)
   - **Verify cleanup**: Test that `onDetach()` properly cleans up all timers (retry, refresh, deadline) and abort controllers
   - **Verify backward compatibility**: Test that existing async taps without state/controller Grips continue to work

2. Edge case handling:
   - Rapid successive kickoff calls
   - Overlapping retries
   - Request key changes during in-flight requests
   - Listener changes during retry execution
   - TTL refresh during manual refresh
   - Multiple destinations with same key

3. Create integration test files:
   - `tests/async_integration_state.spec.ts`: State management integration (state + listeners + history working together)
   - `tests/async_integration_retry.spec.ts`: Retry integration (retry + TTL + listeners + key changes)
   - `tests/async_integration_controller.spec.ts`: Controller integration (controller + state + retry/refresh)
   - `tests/async_integration_edge_cases.spec.ts`: Edge cases (rapid changes, concurrent requests, overlapping operations)
   - `tests/async_integration_performance.spec.ts`: Performance and memory (timer cleanup, history limits, memory leaks)

4. Code review and refactoring:
   - Review implementation against spec
   - Refactor for clarity and maintainability
   - Ensure all guarantees are met

**Testing Requirements**:
- All features work together correctly
- Edge cases handled appropriately
- Performance is acceptable
- No memory leaks
- All spec guarantees met

**Estimated Time**: 3-4 days

---

## Phase 12: Documentation and Export

**Goal**: Ensure all types and helpers are exported, documentation is complete.

**Deliverables**:
1. Export all types and helpers:
   - Export `RequestState`, `AsyncRequestState`, `AsyncTapController` types
   - Export all helper functions from `src/index.ts`
   - Ensure proper TypeScript declarations

2. Update documentation:
   - Update `README.md` if needed
   - Ensure examples in spec are accurate
   - Add JSDoc comments to public APIs

3. Final verification:
   - All types compile correctly
   - All exports work correctly
   - Documentation is complete

**Testing Requirements**:
- All types exported correctly
- All helpers exported correctly
- Documentation is accurate

**Estimated Time**: 1 day

---

## Summary

**Total Estimated Time**: 25-35 days (5-7 weeks)

**Phases**:
- Phase 0: Type Definitions (1 day)
- Phase 1: Helper Functions (2-3 days)
- Phase 2: State Tracking (3-4 days)
- Phase 3: Listener Tracking (2-3 days)
- Phase 4: Retry System (3-4 days)
- Phase 5: TTL Refresh (2-3 days)
- Phase 6: History Tracking (2 days)
- Phase 7: Error Tracking (1-2 days)
- Phase 8: Controller Grip (1-2 days)
- Phase 9: Controller Functionality (2-3 days)
- Phase 10: Request Key Changes (2 days)
- Phase 11: Integration (3-4 days)
- Phase 12: Documentation (1 day)

**Key Principles**:
- Test-driven: Write tests before implementation
- Incremental: Each phase builds on previous phases
- Review: Review each phase before moving to next
- Integration: Test features together in later phases

