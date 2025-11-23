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
export type { Grip } from "./core/grip";

// Contexts
export type { GripContext, GripContextLike } from "./core/context";

// Runtime
export { Grok } from "./core/grok";

// Graph types
export type { GripContextNode } from "./core/graph";

// Drips
export { Drip } from "./core/drip";

// Taps
export type { Tap } from "./core/tap";
export {
  AtomTap,
  AtomTapHandle,
  createAtomValueTap,
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
export type { Query } from "./core/query";
export { withOneOf, withAnyOf, QueryBuilderFactory } from "./core/query";

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

// Logging helper
export { getLoggingTagsGrip } from "./logging";
