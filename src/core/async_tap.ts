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
import { consola } from "consola";

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
*/
interface DestState {
controller?: AbortController;
seq: number;
key?: string;
deadlineTimer?: any;
pendingRetryArmed?: boolean;
}

/**
* Configuration options for async Taps.
* 
* @param debounceMs - Debounce parameter changes (apply at caller site)
* @param cache - Custom cache implementation (default: LruTtlCache)
* @param cacheTtlMs - Cache TTL in milliseconds (0 = no caching)
* @param latestOnly - Only process latest request per destination (default: true)
* @param deadlineMs - Request timeout in milliseconds (0 = no timeout)
*/
export interface BaseAsyncTapOptions {
debounceMs?: number;
cache?: AsyncCache<string, unknown>;
cacheTtlMs?: number;
latestOnly?: boolean;
deadlineMs?: number;
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
protected readonly asyncOpts: Required<BaseAsyncTapOptions>;
private readonly destState = new WeakMap<GripContext, DestState>();
private readonly cache: AsyncCache<string, unknown>;
private readonly pending = new Map<string, Promise<unknown>>();
private readonly allControllers = new Set<AbortController>();
private readonly allTimers = new Set<any>();

constructor(opts: {
provides: readonly Grip<any>[];
destinationParamGrips?: readonly Grip<any>[];
homeParamGrips?: readonly Grip<any>[];
async?: BaseAsyncTapOptions;
}) {
super({
provides: opts.provides,
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
};
this.cache = this.asyncOpts.cache;
}

/**
* Get or create destination state for async operations.
*/
protected getDestState(dest: GripContext): DestState {
let s = this.destState.get(dest);
if (!s) {
s = { seq: 0 };
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
this.kickoff(dest);
}

/**
* Clean up destination state on disconnect.
* 
* Aborts in-flight requests and clears timers.
*/
onDisconnect(dest: GripContext, grip: Grip<any>): void {
try {
const s = this.destState.get(dest);
if (s) {
s.controller?.abort();
if (s.deadlineTimer) {
clearTimeout(s.deadlineTimer);
this.allTimers.delete(s.deadlineTimer);
s.deadlineTimer = undefined;
}
this.destState.delete(dest);
}
} finally {
super.onDisconnect(dest, grip);
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
const prevKey = state.key;

const params = this.getDestinationParams(dest);
if (!params) {
// Can't get params, abort and clear outputs
if (state.controller) state.controller.abort();
state.key = undefined;
return;
}

const key = this.getRequestKey(params);

// Parameters insufficient - abort and reset outputs
if (!key) {
if (state.controller) state.controller.abort();
state.key = undefined;
const resets = this.getResetUpdates(params);
if (resets.size > 0) this.publish(resets, dest);
return;
}

// Request key changed - abort previous request (stale-while-revalidate)
if (prevKey !== undefined && prevKey !== key) {
if (state.controller) state.controller.abort();
}

// Check cache first
const cached = this.asyncOpts.cacheTtlMs > 0 && !forceRefetch ? this.cache.get(key) : undefined;
if (cached) {
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
this.getDestState(dctx).key = key;
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

// Start new request
state.seq += 1;
const seq = state.seq;
if (state.controller) state.controller.abort();
const controller = new AbortController();
state.controller = controller;
this.allControllers.add(controller);
state.key = key;

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

// Publish to all destinations sharing this key
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
this.getDestState(dctx).key = key;
} catch {}
}
})
.catch(() => {
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
super({ provides: [cfg.provides], homeParamGrips: cfg.homeParamGrips, async: cfg });
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
super({ provides: providesList, homeParamGrips: cfg.homeParamGrips, async: cfg });
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
