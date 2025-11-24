# GRIP Async Request State – Codex Implementation Plan

Test-driven, phased delivery. Each phase lands with green tests before proceeding.

## Phase 0: Baseline & Fixtures
- Add any needed test scaffolding/mocks for async taps (dest context builders, fake fetchers, timers, cache helpers).
- Decide test runner patterns (fake timers for retry/TTL, helper assertions for state shapes).

## Phase 1: Public Surface (types only)
- Introduce request state/types, history entry, AsyncRequestState, AsyncTapController interface, retry config.
- Add optional `stateGrip`/`controllerGrip`/`historySize`/retry options to configs and BaseAsyncTap options.
- Export helper function signatures (no logic yet), new types, and grips.
- No runtime implementation; compilation-only tests to lock API surface.

## Phase 2: Helper Functions (logic, no wiring)
- Implement `hasData`, `isStale`, `isRefreshing`, `hasError`, `getError`, `isLoading`, `isIdle`, `getDataRetrievedAt`, `getRequestInitiatedAt`, `getErrorFailedAt`, `hasScheduledRetry`, `getRetryTimeRemaining`, `getStatusMessage`.
- Add unit tests covering all state variants, boundary cases (`retryAt` past/future/null).

## Phase 3: State Container & History Plumbing (no integration)
- Extend `DestState` to hold currentState, retry/refresh timers, retryAttempt, history buffer, abortController, listenerCount.
- Implement history circular buffer helper and transition reason tagging.
- Tests: history sizing, immutability/read-only guarantees, transition reason recording.

## Phase 4: State Publication (integration into taps)
- Wire state lifecycle into BaseAsyncTap: request initiation, cache hit, success, error, refresh, retries, resets.
- Guarantee: cached data -> `stale-while-revalidate`, no `loading` when data exists.
- Publish to state grip when provided; default no-op otherwise.
- Tests: per-destination isolation, state transitions, cache-hit path, idle/reset behavior.

## Phase 5: Listener Tracking & Gating
- Track output Grip subscriptions only (exclude state/controller grips) to set `hasListeners`/listenerCount.
- Cancel retries/TTL refreshes when listeners drop to zero; freeze state.
- Respect listener gating before executing scheduled retry/refresh.
- Tests: listener connect/disconnect paths, zero-listener cleanup, shared request key across destinations.

## Phase 6: Retry & TTL Scheduling Semantics
- Implement retry scheduling with backoff, max retries, retryOnError predicate.
- Implement TTL-based refresh scheduling with `refreshBeforeExpiryMs`.
- Ensure timers cleared on key change, manual retry/refresh, reset, zero listeners.
- Tests: backoff math, max retry cutoff, retryAt semantics, TTL scheduling and cancellation, overdue retryAt -> immediate execution.

## Phase 7: Request Key Change Handling
- Abort in-flight request on key change, clear timers, reset retryAttempt, preserve history with transition reason.
- Decide state/histories behavior per spec (preserve history, mark key change, transition to loading/idle as appropriate).
- Tests: rapid param changes, new key initiates new cycle, old timers do not fire.

## Phase 8: Controller Grip Exposure
- Publish per-destination controller grip when configured; no-op when absent/no listeners.
- Ensure controller tracks latest dest/key and survives reconnections.
- Tests: controller grip publication/removal, default no-op safety.

## Phase 9: Controller Behavior
- Implement `retry` vs `refresh` semantics (abort, cancel timers, retryAttempt increment rules, forceRefetch handling).
- Implement `reset` and `cancelRetry`; ensure they update state/history.
- Tests: manual retry/refresh/reset flows, retryAttempt increments, interaction with scheduled retries/refreshes.

## Phase 10: Concurrency & Latest-Only Guarantees
- Ensure new kickoff aborts in-flight request, handles `latestOnly` sequencing, ignores stale completions.
- Tests: overlapping requests, out-of-order completions, concurrent manual actions.

## Phase 11: Documentation & Migration Notes
- Update README/async tap docs to include new grips, helpers, behaviors, guarantees.
- Add examples mirroring the spec.

## Phase 12: Final QA
- Audit for dangling timers/controllers on teardown.
- Cross-browser/node fake timers sanity checks.
- Coverage review and any additional edge-case tests (error recovery after success, stale-with-error to success, etc.).
