/**
 * GRIP Core Library - Generalized Retrieval Intent Provisioning
 *
 * Framework-agnostic runtime and query system. This library exposes:
 *  - Grips: typed keys for data attributes
 *  - Contexts: hierarchical containers for parameters and scope
 *  - Taps: producers
 *  - Drips: live streams
 *  - GROK: the central orchestrator
 */

// Grips
export { Grip, GripRegistry, GripOf } from "./core/grip";

// Contexts
export type { GripContext, GripContextLike } from "./core/context";

// Runtime
export { Grok } from "./core/grok";

// Graph types
export type { GripContextNode } from "./core/graph";

// Drips
export { Drip } from "./core/drip";

// Taps
export type { Tap, TapFactory } from "./core/tap";
export { BaseTap, BaseTapNoParams } from "./core/base_tap";
export {
  AtomTap,
  AtomTapHandle,
  AtomValueTap,
  createAtomValueTap,
  MultiAtomTapHandle,
  MultiAtomTap,
  MultiAtomValueTap,
  createMultiAtomValueTap,
} from "./core/atom_tap";

export { FunctionTap, createFunctionTap } from "./core/function_tap";

export {
  BaseAsyncTap,
  createAsyncValueTap,
  createAsyncMultiTap,
  createAsyncHomeValueTap,
  createAsyncHomeMultiTap,
} from "./core/async_tap";

// Query system
export { Query, withOneOf, withAnyOf, QueryBuilderFactory } from "./core/query";

// Graph dump / debugging
export type {
  GraphDump,
  GraphDumpOptions,
  GraphDumpNodeContext,
  GraphDumpNodeTap,
  GraphDumpNodeDrip,
} from "./core/graph_dump";
export { GraphDumpKeyRegistry, GripGraphDumper } from "./core/graph_dump";

// Caching / utils
export { LruTtlCache } from "./core/async_cache";
export { createDebouncer } from "./core/debounce";

// Async request state types and helpers (Phase 0)
export type {
  RequestState,
  AsyncRequestState,
  AsyncTapController,
  RetryConfig,
  StateHistoryEntry,
} from "./core/async_request_state";
export {
  hasData,
  isStale,
  isRefreshing,
  isRefreshingWithData,
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

// Logging helper
export { getLoggingTagsGrip } from "./logging";
