## Grip Async Taps: Design Spec

Goal: First‑class support for async, cancelable, cacheable taps driven by destination/home parameters. Keep code modular and small, avoid enums/switches; rely on classes and helpers. Provide tests before any demo integration (e.g., OpenMeteo).

Principles
- No mutation of engine internals; use existing tap lifecycle (attach/connect/disconnect/detach) and destination param semantics.
- Per‑destination isolation: concurrency and cancellation tracked per destination.
- Predictable, minimal APIs; small helpers over deep inheritance trees.

---

### Core Additions (proposed)

1) BaseAsyncTap (core)
- Purpose: Common utilities for async taps (per‑destination state, cancellation, debouncing, caching, latest‑only).
- Extends: `BaseTap` (or `BaseTapNoParams` depending on use).
- Responsibilities (per destination):
  - Track param snapshot → derive a stable request key (string)
  - Debounce param changes (optional) before triggering a request
  - Cancel in‑flight request via `AbortController`
  - Latest‑only: ignore out‑of‑date completions
  - Publish mapped outputs on success; publish `undefined`/no‑op on failure (configurable)
  - Cleanup on `onDisconnect`/`onDetach`
- Minimal API (abstracts):
  - `protected getRequestKey(dest: GripContext): string | undefined`
  - `protected buildRequest(dest: GripContext, signal: AbortSignal): Promise<unknown>`
  - `protected mapResultToUpdates(dest: GripContext, result: unknown): Map<Grip<any>, any>`
- Options:
  - `debounceMs?: number` (default 0)
  - `cache?: AsyncCache<string, unknown>`
  - `cacheTtlMs?: number`
  - `latestOnly?: boolean` (default true)

2) AsyncCache (core)
- Interface: `get(k): {value:any, expiresAt:number}|undefined`, `set(k, v, ttlMs)`, `delete(k)`.
- Default impl: `LruTtlCache` with size/TTL limits; soft cleanup on writes.

3) Per‑Destination State (core)
- Hidden inside BaseAsyncTap; store in `WeakMap<GripContextNode, DestState>`.
- `DestState`: { abort: AbortController, timer?: any, key?: string, seq: number }

4) Promise Adapter (core)
- Utility: `createAsyncValueTap({ provides, destinationParamGrips, requestKeyOf, fetcher, mapResult, opts })`.
- Returns a concrete `Tap` (subclassing BaseAsyncTap) for simple value flows.

5) Debounce Helper (core)
- Small utility: `createDebouncer(ms, schedule)` returning a function that coalesces calls per destination state.

---

### React Additions (optional, separate module)
- No Grip state usage. Provide only ergonomic wrappers if needed:
  - `useAbortOnUnmount(controller)` (tiny) – generally BaseAsyncTap should manage controllers.
  - Prefer keeping async logic in taps, not hooks.

---

### Lifecycle & Semantics
- Attach: prepare caches/state; no network yet.
- Connect(dest, grip): publish initial (cached) values if ready; schedule request if params are present.
- Param change (destination/home):
  - Debounce if configured; then compute key → check cache → else fetch.
  - Cancel prior fetch for that destination; start new one with fresh `AbortController`.
  - If `latestOnly`, stamp request with `seq` and discard outdated completions.
- Disconnect(dest): cancel and dispose per‑dest state.
- Detach: clear caches, cancel all inflight.

---

### Error Handling
- For network errors/abort: do not publish stale values; optional hooks for diagnostics.
- Consider optional grips for `LOADING`/`ERROR` in specific taps (not needed in base).

---

### Test Plan (core)
- BaseAsyncTap unit tests with a fake async fetcher:
  - Debounce coalesces rapid param changes (single request)
  - Cancellation: previous request aborted when params change
  - Latest‑only: out‑of‑order completions don't publish
  - Cache hit publishes synchronously; TTL expiry re‑fetches
  - Proper cleanup on `onDisconnect`/`onDetach` (no memory leaks)
- LruTtlCache tests: TTL, eviction, capacity, soft cleanup.

---

### Reference Usage (OpenMeteo scenario)
- Geocoding tap:
  - destination params: `[WEATHER_LOCATION]`
  - `getRequestKey`: `location.toLowerCase()`
  - `buildRequest`: fetch Open‑Meteo geocoding; return `{lat, lon, label}`
  - `mapResultToUpdates`: set `GEO_LAT`, `GEO_LON` (+ optional `GEO_LABEL`)
  - debounce: 250ms; cache TTL: 30m
- Weather tap:
  - destination params: `[GEO_LAT, GEO_LON]`
  - `getRequestKey`: `"lat:lon"` rounded
  - `buildRequest`: fetch current+hourly; choose nearest hour
  - `mapResultToUpdates`: publish the existing weather grips
  - cache TTL: 5–10m

---

### Migration/Adoption
- Implement BaseAsyncTap + helpers in core with tests.
- Add minimal docs; do not change existing taps.
- Build the demo OpenMeteo taps using the new primitives.



