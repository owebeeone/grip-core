/**
 * GRIP Context System - Hierarchical parameter containers for data flow
 *
 * GripContext represents a node in a directed acyclic graph (DAG) that provides
 * parameters and scope for data resolution. Contexts can inherit from multiple
 * parents with priorities, enabling complex parameter hierarchies and overrides.
 *
 * Key concepts:
 * - Contexts form a DAG with prioritized parent relationships
 * - Parameters are resolved by searching up the parent hierarchy
 * - Contexts can hold both static values and dynamic Drips
 * - Taps are registered at contexts and provide data to descendant contexts
 */

import { Grip } from "./grip";
import { Drip } from "./drip";
import type { Tap, TapFactory } from "./tap";
import { GripContextNode } from "./graph";
import { Grok } from "./grok";

/**
 * Represents a parameter override that can be either a static value or a dynamic Drip.
 * Used internally for parameter resolution across the context hierarchy.
 */
type Override = { type: "value"; value: unknown } | { type: "drip"; drip: Drip<any> };

/**
 * Common interface for context containers that can be used with useGrip and tap attachment.
 *
 * This interface allows for different context container types (single, dual, etc.)
 * while providing a consistent API for consumers and producers.
 */
export interface GripContextLike {
  /** Returns the context where useGrip should read from (destination context) */
  getGripConsumerContext(): GripContext;
  /** Returns the context where taps should be attached by default (home context) */
  getGripHomeContext(): GripContext;
  /** Returns the GROK engine instance managing this context */
  getGrok(): Grok;
}

/**
 * GripContext represents a node in the hierarchical parameter graph.
 *
 * Each context can have multiple parents with priorities, enabling complex
 * inheritance patterns. Contexts provide the scope for parameter resolution
 * and serve as attachment points for Taps (data producers).
 *
 * The context hierarchy determines which Tap provides data for a given Grip
 * through the "closest provider" resolution algorithm.
 */
export class GripContext implements GripContextLike {
  readonly kind: "GripContext" = "GripContext";
  private grok: Grok;
  private contextNode: GripContextNode;
  readonly id: string;

  /**
   * Creates a new GripContext instance.
   *
   * @param engine - The GROK engine that manages this context
   * @param id - Optional unique identifier (auto-generated if not provided)
   */
  constructor(engine: Grok, id?: string) {
    this.grok = engine;
    this.id = id ?? `ctx_${Math.random().toString(36).slice(2)}`;
    this.contextNode = engine.ensureNode(this);
  }

  /**
   * Returns this context as the consumer context (where useGrip reads from).
   * For single contexts, this is the same as the home context.
   */
  getGripConsumerContext(): GripContext {
    return this;
  }

  /**
   * Returns this context as the home context (where taps are attached).
   * For single contexts, this is the same as the consumer context.
   */
  getGripHomeContext(): GripContext {
    return this;
  }

  /**
   * Returns the internal graph node representation of this context.
   * Used by the engine for graph operations and lifecycle management.
   */
  getNode(): GripContextNode {
    return this.contextNode;
  }

  /**
   * Returns the GROK engine instance managing this context.
   */
  getGrok(): Grok {
    return this.grok;
  }

  /**
   * Returns true if this context has no parents (is a root context).
   * Root contexts serve as the top-level scope for parameter resolution.
   */
  isRoot(): boolean {
    return this.contextNode.get_parent_nodes().length === 0;
  }

  /**
   * Submits a task to be executed by this context's task queue.
   * Tasks are executed with priority ordering and can be used for
   * deferred operations like cleanup or state updates.
   */
  submitTask(callback: () => void, priority = 0): void {
    this.contextNode.submitTask(callback, priority);
  }

  /**
   * Submits a weak task that doesn't prevent garbage collection.
   * Used for cleanup operations that should not keep the context alive.
   */
  submitWeakTask(taskQueueCallback: () => void) {
    this.contextNode.submitWeakTask(taskQueueCallback);
  }

  /**
   * Returns a shallow copy of all parent contexts with their priorities.
   * Used for graph building and debugging purposes.
   */
  getParents(): ReadonlyArray<{ ctx: GripContext; priority: number }> {
    if (!this.contextNode) {
      return [];
    }
    return this.contextNode
      .get_parents_with_priority()
      .map((p) => ({
        ctx: p.node.get_context()!,
        priority: p.priority,
      }))
      .filter((p) => p.ctx != null);
  }

  /**
   * Adds a parent context with the specified priority.
   *
   * Lower priority values have higher precedence during parameter resolution.
   * The system detects cycles and prevents them to maintain the DAG structure.
   *
   * @param parentCtxt - The parent context to add
   * @param priority - Priority for inheritance (default: 0, higher priority = lower number)
   * @returns This context for method chaining
   * @throws Error if contexts are from different engines or if a cycle would be created
   */
  addParent(parentCtxt: GripContextLike, priority = 0): this {
    const parent = parentCtxt.getGripHomeContext();
    if (parent.contextNode.grok !== this.grok)
      throw new Error("Contexts must be attached to the same engine");
    if (parent === this) throw new Error("Context cannot be its own parent");

    this.contextNode.addParent(parent.contextNode, priority);

    if (this.grok.hasCycle(this.contextNode)) {
      this.contextNode.removeParent(parent.contextNode);
      throw new Error("Cycle detected in context DAG");
    }

    return this;
  }

  /**
   * Removes a parent context from this context's inheritance chain.
   *
   * @param parent - The parent context to remove
   * @returns This context for method chaining
   */
  unlinkParent(parent: GripContext): this {
    try {
      this.contextNode.removeParent(parent.contextNode);
    } catch (e) {
      // Parent not found - ignore
    }
    return this;
  }

  /**
   * Checks if the given context is an ancestor of this context.
   * Used internally for cycle detection and relationship validation.
   */
  private hasAncestor(target: GripContext): boolean {
    return this.contextNode
      .get_parent_nodes()
      .some((p) => p.get_context() === target || p.get_context()?.hasAncestor(target) || false);
  }

  // Direct overrides are deprecated in taps-only design
  setValue<T>(_grip: Grip<T>, _value: T): this {
    return this;
  }
  setDrip<T>(_grip: Grip<T>, _drip: Drip<T>): this {
    return this;
  }

  // Resolve a parameter (value or drip) following priority across parents
  resolveOverride<T>(_grip: Grip<T>): Override | undefined {
    return undefined;
  }
  resolveOverrideWithSource<T>(
    _grip: Grip<T>,
  ): { override: Override; source: GripContext } | undefined {
    return undefined;
  }

  /**
   * Creates a child context that inherits from this context.
   *
   * @param opts - Options for the child context
   * @param opts.priority - Priority for inheritance (default: 0)
   * @returns A new child context
   */
  createChild(opts?: { priority?: number }): GripContext {
    const child = new GripContext(this.grok).addParent(this, opts?.priority ?? 0);
    return child;
  }

  /**
   * Returns the live Drip for a specific Grip in this context, if it exists.
   * Used internally by the engine for value resolution.
   */
  getLiveDripForGrip<T>(grip: Grip<T>): Drip<T> | undefined {
    return this.contextNode.getLiveDripForGrip(grip);
  }

  /**
   * Gets or creates a consumer Drip for the specified Grip.
   * This is the primary method used by useGrip to obtain data streams.
   */
  getOrCreateConsumer<T>(grip: Grip<T>): Drip<T> {
    return this.contextNode.getOrCreateConsumer(grip);
  }

  // --- App-facing helpers to manage taps without referencing the engine ---

  /**
   * Registers a Tap at this context.
   *
   * The Tap will be available to this context and all its descendants,
   * unless overshadowed by a closer Tap in a descendant context.
   *
   * @param tap - The Tap or TapFactory to register
   */
  registerTap(tap: Tap | TapFactory): void {
    if (!this.grok) throw new Error("Context is not attached to an engine");
    this.grok.registerTapAt(this, tap);
  }

  /**
   * Unregisters a Tap from the engine.
   *
   * @param tap - The Tap to unregister
   */
  unregisterTap(tap: Tap): void {
    this.grok.unregisterTap(tap);
  }

  /**
   * Unregisters all Taps that provide the specified Grip from this context.
   *
   * @param grip - The Grip to unregister sources for
   */
  unregisterSource(grip: Grip<any>): void {
    const node = this.contextNode;
    node.unregisterSource(grip);
  }

  /**
   * Returns the internal context node (for internal use only).
   */
  _getContextNode() {
    return this.contextNode;
  }

  /**
   * Returns the internal context node (for debugging and advanced use).
   */
  getContextNode() {
    return this.contextNode;
  }
}
