/**
 * GRIP GROK Engine - Central orchestrator for reactive dataflow
 *
 * GROK (Generalized Retrieval Orchestration Kernel) is the central coordinator
 * of the entire GRIP system. It manages the data flow graph, resolves queries,
 * connects producers (Taps) to consumers (Drips), and handles the lifecycle
 * of all system components.
 *
 * Key responsibilities:
 * - Manages the context DAG and graph operations
 * - Resolves queries to find the best Tap for each Grip request
 * - Orchestrates connections between Taps and Drips
 * - Handles Tap registration and lifecycle management
 * - Provides task scheduling and execution
 * - Manages the query evaluation system for declarative Tap selection
 */

import { Grip, GripRegistry } from "./grip";
import { GripContext, GripContextLike } from "./context";
import { Drip } from "./drip";
import { Tap, TapFactory } from "./tap";
import { GrokGraph, GripContextNode, ProducerRecord } from "./graph";
import { DualContextContainer } from "./containers";
import { TaskHandleHolder, TaskQueue } from "./task_queue";
import { SimpleResolver, IGripResolver } from "./tap_resolver";
import { EvaluationDelta, QueryBinding } from "./query_evaluator";
import { MatchingContext } from "./matcher";

/**
 * Utility function to find the intersection of a Set and an Iterable.
 */
function intersection<T>(setA: Set<T>, iterable: Iterable<T>): Set<T> {
  const result = new Set<T>();
  for (const item of iterable) {
    if (setA.has(item)) {
      result.add(item);
    }
  }
  return result;
}

/**
 * Utility function to find the difference between two Sets.
 */
function difference<T>(setA: Set<T>, setB: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of setA) {
    if (!setB.has(item)) {
      result.add(item);
    }
  }
  return result;
}

/**
 * GROK (Generalized Retrieval Orchestration Kernel) is the central engine
 * that orchestrates the entire GRIP reactive dataflow system.
 *
 * GROK manages:
 * - The context DAG (Directed Acyclic Graph) representing the hierarchy
 * - Tap registration and lifecycle management
 * - Query resolution to find the best data providers
 * - Connection management between producers (Taps) and consumers (Drips)
 * - Task scheduling and execution for asynchronous operations
 * - The query evaluation system for declarative Tap selection
 *
 * All related objects (Drips, Contexts, Taps, etc.) have access to one
 * GROK instance, which serves as the single source of truth for the
 * data flow graph and orchestration logic.
 */
export class Grok {
  /** The internal graph representation managing contexts and their relationships */
  private graph = new GrokGraph(this);

  /** Task queue for scheduling and executing asynchronous operations */
  private taskQueue = new TaskQueue();

  /** Root context with no parents, serves as the top-level scope */
  readonly rootContext: GripContext;

  /** Main home context for Tap registration, inherits from root */
  readonly mainHomeContext: GripContext;

  /** Main presentation context for data consumption, inherits from main home */
  readonly mainPresentationContext: GripContext;

  /** Main matching context combining home and presentation contexts */
  readonly mainContext: MatchingContext;

  /** Resolver for finding the best Tap for each Grip request */
  readonly resolver: IGripResolver = new SimpleResolver(this);

  /**
   * Creates a new GROK engine instance.
   *
   * Initializes the core context hierarchy:
   * - rootContext: Top-level context with no parents
   * - mainHomeContext: Default context for Tap registration
   * - mainPresentationContext: Default context for data consumption
   * - mainContext: Combined context for matching operations
   */
  private registry: GripRegistry;

  constructor(registry: GripRegistry) {
    this.registry = registry;
    this.rootContext = new GripContext(this, "root");
    this.mainHomeContext = new GripContext(this, "main-home").addParent(this.rootContext, 0);
    this.mainPresentationContext = new GripContext(this, "main-presentation").addParent(
      this.mainHomeContext,
      0,
    );
    this.mainContext = new MatchingContext(this.mainHomeContext, this.mainPresentationContext);
  }

  getRegistry(): GripRegistry {
    return this.registry;
  }

  /**
   * Checks if adding a new node would create a cycle in the context DAG.
   *
   * @param newNode - The node to check for cycle creation
   * @returns True if adding the node would create a cycle
   */
  hasCycle(newNode: GripContextNode): boolean {
    return this.graph.hasCycle(newNode);
  }

  /**
   * Submits a task to the internal task queue for execution.
   *
   * @param callback - The function to execute
   * @param priority - Priority level (lower numbers = higher priority)
   * @param handleHolder - Container for the task handle
   */
  submitTask(callback: () => void, priority: number, handleHolder: TaskHandleHolder) {
    this.taskQueue.submit(callback, priority, handleHolder);
  }

  /**
   * Submits a weak task that doesn't prevent garbage collection.
   *
   * @param taskQueueCallback - The function to execute
   * @param handleHolder - Container for the task handle
   */
  submitWeakTask(taskQueueCallback: () => void, handleHolder: TaskHandleHolder) {
    this.taskQueue.submitWeak(taskQueueCallback, 0, handleHolder);
  }

  /**
   * Returns the internal task queue for direct access.
   *
   * @returns The task queue instance
   */
  getTaskQueue(): TaskQueue {
    return this.taskQueue;
  }

  /**
   * Drains the internal task queue, executing all pending tasks.
   * Useful for tests to assert post-update state.
   */
  flush(): void {
    this.taskQueue.flush();
  }

  /**
   * Ensures a context node exists in the graph, creating it if necessary.
   *
   * @param ctx - The context to ensure a node for
   * @returns The graph node for the context
   */
  ensureNode(ctx: GripContext): GripContextNode {
    return this.graph.ensureNode(ctx);
  }

  /**
   * Creates a new context optionally parented to a given context.
   *
   * @param parent - Optional parent context (defaults to main context)
   * @param priority - Priority for inheritance (default: 0)
   * @param id - Optional unique identifier
   * @returns The newly created context
   */
  createContext(parent?: GripContext, priority = 0, id?: string): GripContext {
    const ctx = new GripContext(this, id);
    if (parent ?? this.mainContext) ctx.addParent(parent ?? this.mainContext, priority);
    this.ensureNode(ctx);
    return ctx;
  }

  /**
   * Disposes a context, clearing caches and allowing garbage collection.
   *
   * @param ctx - The context to dispose
   */
  disposeContext(ctx: GripContext): void {
    // Optionally: detach from parents to break strong references in contexts
    // There is no public API on GripContext to remove parents; we rely on graph WeakRef GC.
  }

  /**
   * Creates a dual context container with separate home and presentation contexts.
   *
   * This is useful for transform Taps that read from one context hierarchy
   * and write to another, enabling clean separation of concerns.
   *
   * @param homeParent - The parent context for the home context
   * @param opts - Options for the dual context
   * @param opts.destPriority - Priority for the destination context inheritance
   * @returns A dual context container
   */
  createDualContext(
    homeParent: GripContext,
    opts?: { destPriority?: number },
  ): DualContextContainer {
    const home = this.createContext(homeParent, 0);
    // Create presentation child off home
    const dest = home.createChild();
    // Ensure graph and resolver know about dest
    this.ensureNode(dest);
    return new DualContextContainer(home, dest);
  }

  /**
   * Registers a Tap at a specific context.
   *
   * The Tap will be available to the specified context and all its descendants,
   * unless overshadowed by a closer Tap in a descendant context.
   *
   * @param ctx - The context to register the Tap at
   * @param tap - The Tap or TapFactory to register
   */
  registerTapAt(ctx: GripContextLike, tap: Tap | TapFactory): void {
    const homeCtx = ctx.getGripHomeContext();
    // Delegate to resolver for attach and re-resolution
    this.resolver.addProducer(homeCtx, tap);
  }

  /**
   * Applies a producer delta from query evaluation results.
   *
   * This method is used by the query evaluation system to apply changes
   * to the producer graph based on declarative query results.
   *
   * @param context - The context to apply the delta to
   * @param delta - The evaluation delta containing added/removed producers
   */
  applyProducerDelta(context: GripContext | GripContextNode, delta: EvaluationDelta): void {
    this.resolver.applyProducerDelta(context, delta);
  }

  /**
   * Convenience method to register a Tap at the main context.
   *
   * @param tap - The Tap or TapFactory to register
   */
  registerTap(tap: Tap | TapFactory): void {
    this.registerTapAt(this.mainContext, tap);
  }

  /**
   * Unregisters a Tap from the system.
   *
   * This will trigger re-resolution of any consumers that were using
   * this Tap, potentially finding alternative providers.
   *
   * @param tap - The Tap to unregister
   */
  unregisterTap(tap: Tap): void {
    const homeCtx = tap.getHomeContext();
    if (homeCtx) {
      // Delegate to resolver so it can re-link affected consumers
      this.resolver.removeProducer(homeCtx, tap);
    }
  }

  /**
   * Central query API: resolves a Grip request to a Drip.
   *
   * This is the primary method used by components to request data.
   * The engine will find the best Tap to provide the requested Grip
   * based on context hierarchy and resolution rules.
   *
   * @param grip - The Grip being requested
   * @param consumerCtx - The context making the request
   * @returns A Drip that provides the requested data
   */
  query<T>(grip: Grip<T>, consumerCtx: GripContextLike): Drip<T> {
    const ctx = consumerCtx.getGripConsumerContext();
    const ctxNode = ctx.getGripConsumerContext()._getContextNode();

    var drip = ctxNode.getLiveDripForGrip(grip);

    if (drip) {
      // Best case we have a live drip; ensure it's resolved to a producer
      const hasProvider = ctxNode.getResolvedProviders().has(grip as unknown as Grip<any>);
      if (!hasProvider) {
        this.resolver.addConsumer(ctx, grip as unknown as Grip<any>);
      }
      return drip;
    }

    // Creates a new drip, now we need to resolve it to a tap or fallback.
    drip = ctxNode.getOrCreateConsumer(grip);

    this.resolver.addConsumer(ctx, grip);

    return drip;
  }

  /**
   * Adds a query binding to the main matching context.
   *
   * Query bindings define declarative rules for Tap selection based on
   * context parameters and conditions.
   *
   * @param binding - The query binding to add
   */
  addBinding(binding: QueryBinding): void {
    this.mainContext.addBinding(binding);
  }

  /**
   * Removes a query binding from the main matching context.
   *
   * @param bindingId - The ID of the binding to remove
   */
  removeBinding(bindingId: string): void {
    this.mainContext.removeBinding(bindingId);
  }

  /**
   * Returns a read-only snapshot of the current graph state.
   *
   * This is useful for debugging, inspection, and visualization
   * of the current data flow graph.
   *
   * @returns A map of context IDs to their graph nodes
   */
  getGraph(): ReadonlyMap<string, GripContextNode> {
    return this.graph.snapshot();
  }

  /**
   * Returns a sanity check of the graph state for debugging.
   *
   * This method helps identify potential issues with the graph,
   * such as missing nodes or nodes that should have been garbage collected.
   *
   * @returns An object containing graph state and potential issues
   */
  getGraphSanityCheck(): {
    nodes: ReadonlyMap<string, GripContextNode>;
    missingNodes: ReadonlySet<GripContextNode>;
    nodesNotReaped: ReadonlySet<GripContextNode>;
  } {
    return this.graph.snapshotSanityCheck();
  }
}
