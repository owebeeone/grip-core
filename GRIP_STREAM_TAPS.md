# GRIP Stream Taps

Implemented API for long-lived async subscriptions in `@owebeeone/grip-core`.

Design background for one-shot async taps remains in `GRIP_ASYNC_TAPS.md`. This
document covers **`createAsyncStreamMultiTap`** only.

## When to use which tap

| Use case | Tap |
|----------|-----|
| One HTTP fetch, cache, retry, stale-while-revalidate | `createAsyncValueTap` / `createAsyncMultiTap` |
| Websocket, tick feed, service `subscribe` stream | `createAsyncStreamMultiTap` |
| Derived value from other grips | `createFunctionTap` |
| Simple local UI state | `createAtomValueTap` |

Stream taps open when the first destination listens for a request key, share one
upstream subscription for identical keys, replay the latest event to late
listeners when `cacheLatest` is true (default), and close after the last
destination detaches (plus `cleanupDelayMs`).

## TypeScript API

```ts
import { createAsyncStreamMultiTap } from "@owebeeone/grip-core";

createAsyncStreamMultiTap({
  provides: [OUT_A, OUT_B],
  destinationParamGrips?: [...],
  homeParamGrips?: [...],
  requestKeyOf: (params, getState) => string | undefined,
  subscribe: (params, signal, getState) => AsyncIterable<Event> | Promise<AsyncIterable<Event>>,
  mapEvent: (params, event, getState) => ReadonlyMap<Grip, value>,
  getResetUpdates?: (params) => ReadonlyMap<Grip, undefined>,
  cacheLatest?: true,
  cleanupDelayMs?: 1000,
  retry?: AsyncStreamRetryConfig | false,
  onError?: (error, requestKey) => void,
});
```

### Request keys

- Return `undefined` when required params are missing → outputs reset, no stream.
- Share streams by key: `coinbase:BTC-USD`.
- Force isolation per column: include `params.destContext.id` in the key when
  needed.

### Retry

Set `retry: false` to disable. Default retry policy reconnects after subscribe
errors and after a stream ends while listeners remain.

```ts
retry: {
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitterRatio: 0.5,
  maxRetries: Number.POSITIVE_INFINITY,
  stableResetMs: 10_000,
  retryOnError: (error) => true,
}
```

After `stableResetMs` of successful events, the retry attempt counter resets.

### Python API

```py
from grip_py.core import create_async_stream_multi_tap, AsyncStreamRetryConfig

create_async_stream_multi_tap(
    provides=[...],
    destination_param_grips=[...],
    home_param_grips=[...],
    request_key_of=lambda params: ...,
    subscribe=lambda params, cancel_event: async_iterable,
    map_event=lambda params, event: {grip: value, ...},
    get_reset_updates=None,
    cache_latest=True,
    cleanup_delay_ms=1000,
    retry=AsyncStreamRetryConfig(...),
    on_error=None,
)
```

Field names mirror the TypeScript config (`cacheLatest` ↔ `cache_latest`, etc.).

## Example

See `grip-react-demo`:

- `src/CoinColumn.tsx` — two independent columns via `useKeyedMatchingContext`
- `src/cointaps.ts` — mock, Coinbase, and Binance stream taps

Each column selects a provider through matcher bindings; stream taps normalize
exchange payloads to the same output grips.
