/**
 * GRIP Graph System - Core data flow graph implementation
 *
 * Implements the fundamental graph structures that represent the data flow
 * relationships in the GRIP system. The graph manages connections between
 * producers (Taps), consumers (Drips), and contexts, enabling efficient
 * data propagation and lifecycle management.
 *
 * Key Components:
 * - ProducerRecord: Manages a Tap's connections to multiple destinations
 * - Destination: Represents a Tap's presence at a specific consumer context
 * - DestinationParams: Unified interface for accessing destination and home parameters
 * - GripGraph: The main graph container managing all nodes and relationships
 *
 * Core Concepts:
 * - Producer-Consumer Relationships: Taps provide data to consumer contexts
 * - Destination Management: Each Tap can serve multiple consumer contexts
 * - Parameter Resolution: Unified access to destination and home parameters
 * - Lifecycle Management: Automatic cleanup when contexts are garbage collected
 * - Value Propagation: Efficient publishing of values to subscribed destinations
 *
 * Architecture:
 * - Weak References: Used extensively for GC-aware lifecycle management
 * - Subscription Management: Automatic parameter subscription and cleanup
 * - Value Caching: Efficient value storage and retrieval
 * - Graph Traversal: Support for complex context hierarchies
 */

import { Grip } from "./grip";
import { GripContext } from "./context";
import { Drip, Unsubscribe } from "./drip";
import type { Tap, TapFactory } from "./tap";
import { Grok } from "./grok";
import { GripContextNodeIf } from "./context_node";
import { TaskHandleHolder } from "./task_queue";
import { consola } from "consola";

const logger = consola.withTag("core/graph.ts");

/**
 * Comprehensive interface for accessing destination and home parameters.
 *
 * Provides a unified API for Taps to access both destination-specific parameters
 * (from the consumer context) and home parameters (from the provider context).
 * This abstraction simplifies parameter access and enables efficient caching.
 *
 * Key Features:
 * - Unified parameter access with automatic fallback (dest -> home)
 * - Specific accessors for destination-only or home-only parameters
 * - Efficient caching of parameter values
 * - Type-safe parameter retrieval
 */
export interface DestinationParams {
  // Core context access
  readonly destContext: GripContext;

  // Unified parameter access (checks dest first, then home)
  get<T>(grip: Grip<T>): T | undefined;
  getAll(): ReadonlyMap<Grip<any>, any>;
  has(grip: Grip<any>): boolean;

  // Specific accessors when needed
  getDestParam<T>(grip: Grip<T>): T | undefined;
  getAllDestParams(): ReadonlyMap<Grip<any>, any>;
  getHomeParam<T>(grip: Grip<T>): T | undefined;
  getAllHomeParams(): ReadonlyMap<Grip<any>, any>;
}

/**
 * Manages a Tap's connections to multiple consumer contexts.
 *
 * A ProducerRecord represents a Tap's presence in the graph and manages
 * all its connections to consumer contexts (destinations). It handles:
 * - Multiple destination contexts for the same Tap
 * - Output Grip attribution and visibility
 * - Destination lifecycle management
 * - Value publishing to all relevant destinations
 * - Handle destination cleanup when contexts are GC'd
 */
export class ProducerRecord {
  readonly tap: Tap;
  readonly tapFactory: TapFactory | undefined;
  // Map of destination context id -> Destination (which holds the grips for that dest)
  private destinations = new Map<GripContextNode, Destination>();

  // This is the actual allowed outputs for this tap. There may be more outputs
  // than this set that the tap can produce, however those are hidden in this
  // instance of the producer record.
  // This can happen where a TapMatcher installs multiple taps that have a set
  // of common output grips and has attributed the grips to the tap.
  // This may still have more outputs than the is visible to the destination.
  // One operation is that an output may be transferred from a different producer to
  // this one. In that case, the other producer's destination will need to drop the grip
  // and it will be transferred to this producer's destination for the same context
  // which may mean this producer will need to create a new destination for the same
  // context if it doesn't already exist which includes registering the destination
  // param drips.
  readonly outputs = new Set<Grip<any>>();

  /**
   * Creates a new ProducerRecord for a Tap or TapFactory.
   *
   * @param tap - The Tap or TapFactory to manage
   * @param outputs - Optional set of output Grips this record should manage
   */
  constructor(tap: Tap | TapFactory, outputs?: Iterable<Grip<any>>) {
    if (tap.kind === "TapFactory") {
      this.tap = tap.build();
      this.tapFactory = tap;
    } else {
      this.tap = tap;
      this.tapFactory = undefined;
    }
    if (outputs) for (const g of outputs) this.outputs.add(g as unknown as Grip<any>);
  }

  /**
   * Adds a Grip to a destination context for this producer.
   *
   * Creates or updates a Destination for the specified context and adds
   * the Grip to its set of provided outputs. Handles Tap lifecycle events
   * and initial value production.
   *
   * @param destNode - The destination context node
   * @param grip - The Grip to add to this destination
   */
  addDestinationGrip(destNode: GripContextNode, grip: Grip<any>): void {
    var existing = this.destinations.get(destNode);
    var added = false;
    if (!existing) {
      existing = new Destination(destNode, this.tap, this);
      this.destinations.set(destNode, existing);
      added = true;
      // Register any per-destination parameter subscriptions
      existing.registerDestinationParamDrips();
    }
    existing.addGrip(grip);
    if (process.env.NODE_ENV !== "production")
      logger.log(
        `[ProducerRecord] addDestinationGrip: Added ${grip.key} to ${destNode.id} for tap ${this.tap.constructor.name} (id=${(this.tap as any).id || "no-id"}), now has ${this.destinations.size} destinations`,
      );
    const destCtx = destNode.get_context();
    if (added) {
      this.tap.onConnect?.(destCtx as GripContext, grip);
    } else {
      // Always produce initial values when a grip is added to a destination.
      if (destCtx) {
        this.tap.produce({ destContext: destCtx }); // TODO This should be delayed/placed in a task queue.
      }
    }
  }

  /**
   * Removes all connections to a destination context.
   *
   * Cleans up the Destination for the specified context and triggers
   * Tap detachment if this was the last destination.
   *
   * @param destCtx - The destination context to remove
   */
  removeDestinationForContext(destCtx: GripContextNode): void {
    const destination = this.destinations.get(destCtx);
    if (destination) {
      destination.unsubscribeAllDestinationParams();
      this.destinations.delete(destCtx);
    }

    if (this.destinations.size === 0) {
      // Only detach if the tap's home context still exists and there are truly no destinations
      const homeCtx = this.tap.getHomeContext?.();
      if (!homeCtx) {
        // Tap thinks it's detached; nothing to do
        return;
      }
      this.tap.onDetach?.();
    }
  }

  /**
   * Returns all destinations for this producer.
   *
   * @returns Map of destination context nodes to their Destination objects
   */
  getDestinations(): Map<GripContextNode, Destination> {
    return this.destinations;
  }

  /**
   * Adds a destination for a specific Grip.
   *
   * Creates a new Destination if one doesn't exist for the context,
   * then adds the Grip to that destination.
   *
   * @param destNode - The destination context node
   * @param grip - The Grip to add
   */
  addDestination(destNode: GripContextNode, grip: Grip<any>): void {
    if (process.env.NODE_ENV !== "production")
      logger.log(`[ProducerRecord] addDestination: Adding ${grip.key} to ${destNode.id}`);
    var existing = this.destinations.get(destNode);
    if (!existing) {
      existing = new Destination(destNode, this.tap, this);
      this.destinations.set(destNode, existing);
      // Register any per-destination parameter subscriptions
      existing.registerDestinationParamDrips();
    }
    existing.addGrip(grip);
  }

  /**
   * Removes a specific Grip from a destination context.
   *
   * Removes the Grip from the destination and cleans up the destination
   * if it no longer provides any Grips.
   *
   * @param destNode - The destination context node
   * @param grip - The Grip to remove
   */
  removeDestinationGripForContext(destNode: GripContextNode, grip: Grip<any>): void {
    if (process.env.NODE_ENV !== "production")
      logger.log(
        `[ProducerRecord] removeDestinationGripForContext: Removing ${grip.key} from ${destNode.id}`,
      );
    const destination = this.destinations.get(destNode);
    if (destination) {
      destination.removeGrip(grip);
      if (destination.getGrips().size === 0) {
        this.removeDestinationForContext(destNode);
      }
    }
  }

  /**
   * Gets destination parameters for a specific destination context.
   *
   * @param destContext - The destination context to get parameters for
   * @returns DestinationParams interface for the context, or undefined if not found
   */
  getDestinationParams(destContext: GripContext): DestinationParams | undefined {
    // Find the destination for this context
    for (const [destNode, destination] of this.destinations) {
      if (destNode.get_context() === destContext) {
        return destination;
      }
    }
    return undefined;
  }

  /**
   * Publishes values to all destinations of this producer.
   *
   * Iterates through all destinations and updates them with the provided values.
   * Only updates destinations for Grips they are subscribed to and that are
   * in the producer's output set. Automatically cleans up destinations whose
   * contexts have been garbage collected.
   *
   * @param values - Map of Grip values to publish
   * @param updater - Function to call for each value update
   * @returns Number of values successfully published
   */
  publish(
    values: Map<Grip<any>, any>,
    updater: (destCtx: GripContext, grip: Grip<any>, value: any) => void,
  ): number {
    let count = 0;
    const destCtxsToRemove = new Set<GripContextNode>();
    try {
      for (const [destNode, destination] of this.getDestinations()) {
        const destCtx = destNode.get_context();
        if (!destCtx) {
          // Context is gone, remove the destination, stash these in a set
          // so we can remove them after the loop so we don't mess up the iterator.
          destCtxsToRemove.add(destNode);
          continue;
        }
        // We only update the destination for the grips the destination is subscribed to.
        for (const g of destination.getGrips()) {
          if (values.has(g) && this.outputs.has(g)) {
            updater(destCtx, g, values.get(g));
            count += 1;
          }
        }
      }
    } finally {
      for (const destNode of destCtxsToRemove) {
        this.removeDestinationForContext(destNode);
      }
    }
    return count;
  }
}

/**
 * Represents a Tap's presence at a specific consumer context.
 *
 * A Destination manages the relationship between a Tap and a specific
 * consumer context. It handles:
 * - The set of Grips provided to this context
 * - Destination parameter subscriptions and caching
 * - Value propagation to the consumer context
 * - Lifecycle management and cleanup
 *
 * Key Features:
 * - Parameter caching for efficient access
 * - Automatic subscription management
 * - Grip set management
 * - Unified parameter access interface
 */
export class Destination implements DestinationParams {
  private readonly destContextNode: GripContextNode;
  private readonly grips: Set<Grip<any>>;
  private readonly tap: Tap;
  private readonly producer: ProducerRecord;

  // This stores the destination param drips for this destination.
  private readonly destinationParamDrips: Map<Grip<any>, Drip<any>> = new Map();
  private readonly destinationDripsSubs: Map<Grip<any>, Unsubscribe> = new Map();

  /**
   * Creates a new Destination for a Tap at a specific consumer context.
   *
   * @param destContextNode - The destination context node
   * @param tap - The Tap providing data to this destination
   * @param producer - The ProducerRecord managing this destination
   * @param grips - Optional initial set of Grips provided to this destination
   */
  constructor(
    destContextNode: GripContextNode,
    tap: Tap,
    producer: ProducerRecord,
    grips?: Iterable<Grip<any>>,
  ) {
    this.destContextNode = destContextNode;
    this.tap = tap;
    this.grips = new Set(grips ?? []);
    this.producer = producer;
  }

  /**
   * Registers subscriptions for destination parameters.
   *
   * Sets up subscriptions to destination parameter Grips and triggers
   * Tap production when parameter values change.
   */
  registerDestinationParamDrips() {
    if (!this.tap.destinationParamGrips) return;
    const self = this;
    for (const grip of this.tap.destinationParamGrips) {
      const drip = this.destContextNode.getOrCreateConsumer(grip);
      // Do not force-resolve the param consumer to a provider here.
      // Recording the consumer is enough for provider publishes to reach it.
      this.destinationParamDrips.set(grip, drip);
      this.destinationDripsSubs.set(
        grip,
        drip.subscribePriority((_v) => {
          // The produceOnDestParams should exist, let's throw if it doesn't.
          // Only trigger if there is an actual value change to a defined value
          if (drip.get() !== undefined) {
            self.tap.produceOnDestParams!(this.destContextNode.get_context(), grip);
          }
        }),
      );
      // Do not kick initial evaluation on undefined to avoid creating producer links preemptively
    }
  }

  /**
   * Unregisters this destination from its producer.
   */
  unregisterDestination() {
    this.producer.removeDestinationForContext(this.destContextNode);
  }

  /**
   * Unsubscribes from all destination parameter Drips.
   *
   * Cleans up all subscriptions and clears the parameter maps.
   */
  unsubscribeAllDestinationParams(): void {
    for (const [grip, sub] of this.destinationDripsSubs) {
      sub();
    }
    this.destinationDripsSubs.clear();
    this.destinationParamDrips.clear();
  }

  /**
   * Returns the current value for a specific destination parameter Grip.
   *
   * @param grip - The destination parameter Grip to get the value for
   * @returns The current value or undefined if not set
   */
  getDestinationParamValue<T>(grip: Grip<T>): T | undefined {
    const d = this.destinationParamDrips.get(grip as unknown as Grip<any>);
    return d?.get() as T | undefined;
  }

  /**
   * Returns a snapshot map of all destination parameter values.
   *
   * @returns Map of all destination parameter Grips to their current values
   */
  getAllDestinationParamValues(): Map<Grip<any>, any> {
    const map = new Map<Grip<any>, any>();
    for (const [g, d] of this.destinationParamDrips) {
      map.set(g as unknown as Grip<any>, d.get());
    }
    return map;
  }

  /**
   * Adds a Grip to this destination.
   *
   * Registers destination parameter subscriptions on the first Grip added.
   *
   * @param g - The Grip to add to this destination
   */
  addGrip(g: Grip<any>) {
    if (this.grips.has(g)) return;
    if (this.grips.size === 0) {
      // Register for destination params on the first OUTPUT grip added (not for param grips)
      this.registerDestinationParamDrips();
    }
    this.grips.add(g);
    this.sanityCheck();
  }

  /**
   * Removes a Grip from this destination.
   *
   * @param g - The Grip to remove from this destination
   */
  removeGrip(g: Grip<any>) {
    try {
      if (!this.grips.has(g)) return;
      this.grips.delete(g);
      if (this.grips.size === 0) {
        // Unregister for destination params if this is the last destination grip removed.
        this.unregisterDestination();
      }
    } finally {
      this.sanityCheck();
    }
  }

  /**
   * Performs sanity checks on the destination state.
   *
   * Validates that the destination has a consistent state, particularly
   * that it doesn't have destination parameter Drips without output Grips.
   */
  sanityCheck(): void {
    if (this.grips.size === 0) {
      if (this.destinationParamDrips.size > 0) {
        throw new Error("Destination has destination param drips but no output grips");
      }
    }
  }

  /**
   * Gets the Grips being delivered for this destination.
   *
   * @returns Read-only set of Grips provided to this destination
   */
  getGrips(): ReadonlySet<Grip<any>> {
    return this.grips;
  }

  /**
   * Gets read-only access to destination parameter Drips map for analysis.
   *
   * @returns Read-only map of destination parameter Grips to their Drips
   */
  getDestinationParamDrips(): ReadonlyMap<Grip<any>, Drip<any>> {
    return this.destinationParamDrips;
  }

  /**
   * Gets the destination context, if it still exists.
   *
   * @returns The destination context or undefined if it has been garbage collected
   */
  getContext(): GripContext | undefined {
    return this.destContextNode.contextRef.deref();
  }

  /**
   * Gets the destination context node.
   *
   * @returns The GripContextNode for this destination
   */
  getContextNode() {
    return this.destContextNode;
  }

  // DestinationParams implementation
  get destContext(): GripContext {
    const ctx = this.destContextNode.get_context();
    if (!ctx) throw new Error("Destination context is gone");
    return ctx;
  }

  // Combined getter - checks destination params first, then home params
  get<T>(grip: Grip<T>): T | undefined {
    // First check destination params (higher priority)
    const destValue = this.getDestParam(grip);
    if (destValue !== undefined) return destValue;

    // Fall back to home params
    return this.getHomeParam(grip);
  }

  // Combined getAll - merges both maps (dest params override home params)
  getAll(): ReadonlyMap<Grip<any>, any> {
    const map = new Map();

    // Start with home params
    const homeContext = this.tap.getHomeContext?.();
    if (homeContext && this.tap.homeParamGrips) {
      const paramContext = this.tap.getParamsContext?.() || homeContext;
      for (const grip of this.tap.homeParamGrips) {
        const drip = paramContext.getOrCreateConsumer(grip);
        const value = drip.get();
        if (value !== undefined) {
          map.set(grip, value);
        }
      }
    }

    // Override with dest params (higher priority)
    for (const [g, d] of this.destinationParamDrips) {
      const value = d.get();
      if (value !== undefined) {
        map.set(g, value);
      }
    }

    return map;
  }

  // Combined has - checks both
  has(grip: Grip<any>): boolean {
    return this.hasDestParam(grip) || this.hasHomeParam(grip);
  }

  getDestParam<T>(grip: Grip<T>): T | undefined {
    const d = this.destinationParamDrips.get(grip as unknown as Grip<any>);
    return d?.get() as T | undefined;
  }

  getAllDestParams(): ReadonlyMap<Grip<any>, any> {
    const map = new Map();
    for (const [g, d] of this.destinationParamDrips) {
      const value = d.get();
      if (value !== undefined) {
        map.set(g, value);
      }
    }
    return map;
  }

  getHomeParam<T>(grip: Grip<T>): T | undefined {
    const homeContext = this.tap.getHomeContext?.();
    if (!homeContext) return undefined;
    // Get the drip from the tap's param context
    const paramContext = this.tap.getParamsContext?.() || homeContext;
    const drip = paramContext.getOrCreateConsumer(grip);
    return drip.get();
  }

  getAllHomeParams(): ReadonlyMap<Grip<any>, any> {
    const map = new Map();
    const homeContext = this.tap.getHomeContext?.();
    if (homeContext && this.tap.homeParamGrips) {
      const paramContext = this.tap.getParamsContext?.() || homeContext;
      for (const grip of this.tap.homeParamGrips) {
        const drip = paramContext.getOrCreateConsumer(grip);
        const value = drip.get();
        if (value !== undefined) {
          map.set(grip, value);
        }
      }
    }
    return map;
  }

  private hasDestParam(grip: Grip<any>): boolean {
    return this.destinationParamDrips.has(grip);
  }

  private hasHomeParam(grip: Grip<any>): boolean {
    return this.tap.homeParamGrips?.includes(grip) ?? false;
  }
}

/**
 * Represents a node in the GRIP context graph.
 *
 * A GripContextNode is the internal representation of a GripContext in the graph.
 * It manages the relationships between contexts, producers, and consumers,
 * and provides the core data structures for the GRIP system.
 *
 * Key Responsibilities:
 * - Manages parent-child relationships in the context hierarchy
 * - Tracks producers and consumers for each Grip
 * - Maintains resolved provider mappings
 * - Handles lifecycle management with weak references
 * - Provides task scheduling capabilities
 *
 * Architecture:
 * - Weak References: Uses WeakRef for contexts to enable GC
 * - Bidirectional Relationships: Maintains both parent and child references
 * - Producer-Consumer Mapping: Maps Grips to their producers and consumers
 * - Resolution Tracking: Caches which provider supplies each Grip
 */
export class GripContextNode implements GripContextNodeIf {
  readonly kind: "GripContextNode" = "GripContextNode";
  readonly grok: Grok;
  readonly id: string;
  readonly contextRef: WeakRef<GripContext>;
  readonly parents: Array<{ node: GripContextNode; priority: number }> = [];
  readonly children: GripContextNode[] = [];
  readonly handleHolder = new TaskHandleHolder();

  // One producer per Grip key - ProducerRecords cache the state of the
  // producer graph.
  readonly producers: Map<Grip<any>, ProducerRecord> = new Map();
  // One weakly-referenced drip per Grip at this destination context
  readonly consumers: Map<Grip<any>, WeakRef<Drip<any>>> = new Map();
  // A map of deleted consumers by grip key. These will be reused if the grip is requested again.
  readonly deletedConsumers: Map<Grip<any>, WeakRef<Drip<any>>> = new Map();
  // Destination-side resolved map: which provider context id supplies each Grip
  readonly resolvedProviders: Map<Grip<any>, GripContextNode> = new Map();
  // Source-side: producer records per tap instance
  readonly producerByTap: Map<Tap | TapFactory, ProducerRecord> = new Map();
  private lastSeen = Date.now();

  /**
   * Creates a new GripContextNode for a GripContext.
   *
   * @param grok - The GROK engine this node belongs to
   * @param ctx - The GripContext this node represents
   */
  constructor(grok: Grok, ctx: GripContext) {
    this.grok = grok;
    this.id = ctx.id;
    this.contextRef = new WeakRef(ctx);
  }

  /**
   * Gets the GROK engine this node belongs to.
   *
   * @returns The GROK engine instance
   */
  get_grok(): Grok {
    return this.grok;
  }

  /**
   * Submits a task to the GROK engine with priority.
   *
   * @param callback - The task to execute
   * @param priority - Priority level (lower = higher priority)
   */
  submitTask(callback: () => void, priority: number) {
    this.grok.submitTask(callback, priority, this.handleHolder);
  }

  /**
   * Submits a weak task to the GROK engine.
   *
   * @param taskQueueCallback - The task to execute
   */
  submitWeakTask(taskQueueCallback: () => void) {
    this.grok.submitWeakTask(taskQueueCallback, this.handleHolder);
  }

  /**
   * Gets the GripContext this node represents, if it still exists.
   *
   * @returns The GripContext or undefined if it has been garbage collected
   */
  get_context(): GripContext | undefined {
    return this.contextRef.deref();
  }

  get_parent_nodes(): GripContextNode[] {
    return this.parents.map((p) => p.node);
  }

  isRoot(): boolean {
    // Root is the context that has no parents.
    return this.parents.length === 0;
  }

  // Expose a shallow copy of parents (for graph building / debug)
  getParents(): ReadonlyArray<GripContextNode> {
    return this.get_parents_with_priority().map((p) => p.node);
  }

  get_parents_with_priority(): ReadonlyArray<{ node: GripContextNode; priority: number }> {
    return this.parents.slice();
  }

  get_producers(): Map<Grip<any>, ProducerRecord> {
    return this.producers;
  }

  get_consumers(): Map<Grip<any>, WeakRef<Drip<any>>> {
    return this.consumers;
  }

  get_children_nodes(): GripContextNode[] {
    return this.children;
  }

  addParent(parent: GripContextNode, priority: number = 0): void {
    const existing = this.parents.find((p) => p.node === parent);
    if (!existing) {
      this.parents.push({ node: parent, priority });
      // Sort by priority (lower priority values come first)
      this.parents.sort((a, b) => a.priority - b.priority);
      parent.children.push(this);
    }
  }

  removeParent(parent: GripContextNode): void {
    const idx = this.parents.findIndex((p) => p.node === parent);
    if (idx === -1) {
      throw new Error(`Parent ${parent.id} is not a parent of ${this.id}`);
    }
    this.parents.splice(idx, 1);

    const cidx = parent.children.indexOf(this);
    if (cidx !== -1) {
      parent.children.splice(cidx, 1);
    }
  }

  // Internal method to remove a tap from a node.
  _removeTap(tap: Tap | TapFactory): void {
    const producerRecord = this.producerByTap.get(tap);
    if (producerRecord) {
      for (const grip of producerRecord.outputs) {
        this.producers.delete(grip);
      }

      // Delete both the factory and tap instance keys if they exist
      this.producerByTap.delete(tap);
      if (producerRecord.tapFactory) {
        this.producerByTap.delete(producerRecord.tapFactory);
      }

      producerRecord.tap.onDetach?.();
    }
  }

  recordProducer<T>(grip: Grip<T>, rec: ProducerRecord): void {
    this.producers.set(grip as unknown as Grip<any>, rec);
    this.lastSeen = Date.now();
  }

  getResolvedProviders(): Map<Grip<any>, GripContextNode> {
    return this.resolvedProviders;
  }

  setResolvedProvider<T>(grip: Grip<T>, node: GripContextNode): void {
    this.resolvedProviders.set(grip as unknown as Grip<any>, node);
  }

  getOrCreateProducerRecord(
    tapOrFactory: Tap | TapFactory,
    outputs?: Iterable<Grip<any>>,
  ): ProducerRecord {
    // First check if we already have a record for this tap/factory
    let rec = this.producerByTap.get(tapOrFactory);
    if (!rec) {
      // Create a new ProducerRecord (which will build the tap if it's a factory)
      rec = new ProducerRecord(tapOrFactory, outputs);

      // Store the record using BOTH the original key AND the tap instance as keys
      // This ensures we can find it whether we look up by factory or by tap instance
      this.producerByTap.set(tapOrFactory, rec);
      if (tapOrFactory !== rec.tap) {
        // If we built from a factory, also store by the tap instance
        this.producerByTap.set(rec.tap, rec);
      }

      const tapInstance = rec.tap;
      if (process.env.NODE_ENV !== "production")
        logger.log(
          `[GripContextNode] Created new ProducerRecord for tap ${tapInstance.constructor.name} (id=${(tapInstance as any).id}) in context ${this.id}`,
        );
    } else {
      const tapInstance = rec.tap;
      if (process.env.NODE_ENV !== "production")
        logger.log(
          `[GripContextNode] Found existing ProducerRecord for tap ${tapInstance.constructor.name} (id=${(tapInstance as any).id}) in context ${this.id}`,
        );
    }
    return rec;
  }

  getProducerRecord(tap: Tap | TapFactory): ProducerRecord | undefined {
    return this.producerByTap.get(tap);
  }

  recordConsumer<T>(grip: Grip<T>, drip: Drip<T>): void {
    this.consumers.set(grip as unknown as Grip<any>, new WeakRef(drip as unknown as Drip<any>));
    this.lastSeen = Date.now();
    drip.addOnFirstSubscriber(() => {
      const ctx = this.get_context();
      if (ctx) {
        this.grok.resolver.addConsumer(ctx, grip as unknown as Grip<any>);
      }
    });
  }

  getOrCreateConsumer<T>(grip: Grip<T>): Drip<T> {
    let drip = this.consumers.get(grip as unknown as Grip<any>)?.deref();
    if (!drip) {
      const ctx = this.get_context() as GripContext;
      if (!ctx) throw new Error("Context is gone"); // This should never happen.
      const deletedDripRef = this.deletedConsumers.get(grip as unknown as Grip<any>);
      const oldDrip = deletedDripRef?.deref();
      if (deletedDripRef && !oldDrip) {
        // We're goind to re-use the old drip, so delete the deleted container.
        this.deletedConsumers.delete(grip as unknown as Grip<any>);
      }
      // There is a window where a drip is still being referenced by a React component.
      // Here we re-use the old drip (for this grip in this context) if it's still being referenced.
      if (oldDrip) {
        drip = oldDrip;
      } else {
        drip = new Drip<T>(ctx, grip.defaultValue as unknown as T | undefined);
      }
      this.recordConsumer(grip, drip);
      drip.addOnZeroSubscribers(() => {
        this.removeConsumerForGrip(grip);
      });
    }
    return drip;
  }

  // Returns the live drip instance for this grip at this destination context, if any
  getLiveDripForGrip<T>(grip: Grip<T>): Drip<T> | undefined {
    const wr = this.consumers.get(grip as unknown as Grip<any>);
    const d = wr?.deref();
    if (!d && wr) this.consumers.delete(grip as unknown as Grip<any>);
    return d as unknown as Drip<T> | undefined;
  }

  // Notify the live consumer drip for a grip at this destination context
  notifyConsumers<T>(grip: Grip<T>, value: T): number {
    const d = this.getLiveDripForGrip(grip);
    if (!d) {
      return 0;
    }
    d.next(value);
    return 1;
  }

  // Remove the drip for this grip.
  removeConsumerForGrip<T>(grip: Grip<T>): void {
    const wr = this.consumers.get(grip as unknown as Grip<any>);
    if (wr && wr.deref()) {
      this.deletedConsumers.set(grip as unknown as Grip<any>, wr);
    }
    this.consumers.delete(grip as unknown as Grip<any>);
    this.unregisterSource(grip);
    // Clear resolved provider so future subscriptions re-resolve and re-link
    this.resolvedProviders.delete(grip as unknown as Grip<any>);
  }

  // If we have a producer configured for this grip, unregister ourselves from it.
  unregisterSource(grip: Grip<any>) {
    const node = this.resolvedProviders.get(grip);
    if (node) {
      node.removeDestinationForContext(grip, this);
    }
  }

  // If this context has a destination for this grip, remove that grip as a destination.
  removeDestinationForContext(grip: Grip<any>, dest: GripContextNode): void {
    const producer = this.producers.get(grip);
    if (producer) {
      producer.removeDestinationGripForContext(dest, grip);
    }
  }

  /**
   * Remove any dangling drips from this context node.
   * @returns The number of drips remaining.
   */
  purgeDanglingDrips(): number {
    const toRemove = new Set<Grip<any>>();
    var count = 0;
    for (const [grip, wr] of this.consumers) {
      const d = wr.deref();
      if (!d) {
        toRemove.add(grip);
      } else {
        count += 1;
      }
    }
    for (const grip of toRemove) {
      this.removeConsumerForGrip(grip);
    }
    return count;
  }

  touch(): void {
    this.lastSeen = Date.now();
  }
  getLastSeen(): number {
    return this.lastSeen;
  }
}

export class GrokGraph {
  private grok: Grok;
  private nodes = new Map<string, GripContextNode>();
  private weakNodes = new Map<string, WeakRef<GripContextNode>>();
  private gcIntervalMs = 30000;
  private maxIdleMs = 120000;
  private gcTimer: any | null = null;

  constructor(grok: Grok) {
    this.grok = grok;
  }

  // Check for cycles in the graph from the new node.
  hasCycle(newNode: GripContextNode): boolean {
    const todo = new Set<GripContextNode>(newNode.get_children_nodes());
    const seen = new Set<GripContextNode>();
    const stack = new Array<GripContextNode>();
    const visit = (node: GripContextNode) => {
      todo.delete(node);
      if (seen.has(node)) return false;
      seen.add(node);
      stack.push(node);
      for (const parent of node.get_parent_nodes()) {
        if (stack.includes(parent)) return true;
        if (visit(parent)) return true;
      }
      stack.pop();
      return false;
    };
    while (todo.size > 0) {
      const node = todo.values().next().value;
      if (!node) continue; // Should never happen.
      if (visit(node)) return true;
    }
    return false;
  }

  ensureNode(ctx: GripContext): GripContextNode {
    let node = this.nodes.get(ctx.id);
    if (!node) {
      node = new GripContextNode(this.grok, ctx);
      this.nodes.set(ctx.id, node);
      this.weakNodes.set(ctx.id, new WeakRef(node));
      // Connect parents hard
      for (const { ctx: parentCtx, priority } of ctx.getParents()) {
        const parentNode = this.ensureNode(parentCtx);
        node.addParent(parentNode, priority);
      }
      this.startGcIfNeeded();
    } else {
    }
    node.touch();
    return node;
  }

  getNode(ctx: GripContext): GripContextNode | undefined {
    return this.nodes.get(ctx.id);
  }

  getNodeById(id: string): GripContextNode | undefined {
    return this.nodes.get(id);
  }

  snapshot(): ReadonlyMap<string, GripContextNode> {
    return this.nodes;
  }

  snapshotSanityCheck(): {
    nodes: ReadonlyMap<string, GripContextNode>;
    missingNodes: ReadonlySet<GripContextNode>;
    nodesNotReaped: ReadonlySet<GripContextNode>;
  } {
    const allNodes = new Map<string, GripContextNode>();
    const nodesToCheck = [...this.nodes.values()];
    const missingNodes = new Set<GripContextNode>();

    while (nodesToCheck.length > 0) {
      const node = nodesToCheck.pop();
      if (allNodes.has(node!.id)) continue;
      allNodes.set(node!.id, node!);

      // Check children and clean up stale references
      const validChildren: GripContextNode[] = [];
      node!.children.forEach((child) => {
        if (!allNodes.has(child.id) && !this.nodes.has(child.id)) {
          // This child is not in the main nodes map - it's orphaned
          missingNodes.add(child);
          // Don't add to nodesToCheck since it's not in the main graph
        } else {
          validChildren.push(child);
          if (!allNodes.has(child.id)) {
            nodesToCheck.push(child);
          }
        }
      });

      // Clean up stale children references
      if (validChildren.length !== node!.children.length) {
        node!.children.length = 0;
        node!.children.push(...validChildren);
      }
    }

    if (missingNodes.size > 0) {
      if (process.env.NODE_ENV !== "production")
        logger.log(
          `GrokGraph: snapshotSanityCheck: found ${missingNodes.size} orphaned nodes: ${Array.from(
            missingNodes,
          )
            .map((n) => n.id)
            .join(", ")}`,
        );
    }

    const weakNodesToDelete = new Set<string>();
    const nodesNotReaped = new Set<GripContextNode>();
    // Check if all nodes still in the graph are also in the weakNodes map (they should be)
    for (const [id, nodeWr] of this.weakNodes) {
      const node = nodeWr.deref();
      if (node) {
        if (!allNodes.has(node.id)) {
          nodesNotReaped.add(node);
          if (process.env.NODE_ENV !== "production")
            logger.warn(
              `GrokGraph: Sanity Check Warning: Node ${id} is in the active graph but not in the weakNodes map. This indicates an inconsistency.`,
            );
        }
      } else {
        weakNodesToDelete.add(id);
      }
    }

    for (const id of weakNodesToDelete) {
      this.weakNodes.delete(id);
    }

    return { nodes: allNodes, missingNodes: missingNodes, nodesNotReaped: nodesNotReaped };
  }

  // Notify all live consumers for a grip in a destination context
  notifyConsumers<T>(destCtx: GripContext, grip: Grip<T>, value: T): number {
    const node = this.getNode(destCtx);
    if (!node) return 0;
    return node.notifyConsumers(grip, value);
  }

  private startGcIfNeeded() {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.gcSweep(), this.gcIntervalMs);
    // Avoid keeping the process alive due to GC timer
    try {
      (this.gcTimer as any).unref?.();
    } catch {}
  }

  private gcSweep() {
    const now = Date.now();
    const nodesToDelete = new Set<string>();

    // First pass: identify nodes to delete
    for (const [id, node] of this.nodes) {
      const ctx = node.contextRef.deref();
      const contextGone = !ctx;
      const count = node.purgeDanglingDrips(); // Returns the number of drips remaining.
      const noConsumers = count === 0;

      // If the context is gone, there are no consumers, and the node has no children,
      // then we can delete the node.
      if (contextGone && noConsumers && node.children.length === 0) {
        nodesToDelete.add(id);
      }
    }

    // Second pass: clean up nodes and their relationships
    for (const id of nodesToDelete) {
      const node = this.nodes.get(id);
      if (node) {
        this.clearContextNode(node);
        this.nodes.delete(id);
      }
    }

    // Third pass: clean up any stale child references in remaining nodes
    for (const [id, node] of this.nodes) {
      const validChildren = node.children.filter((child) => this.nodes.has(child.id));
      if (validChildren.length !== node.children.length) {
        node.children.length = 0;
        node.children.push(...validChildren);
      }
    }
  }

  private clearContextNode(node: GripContextNode): void {
    for (const wr of node.consumers.values()) {
      const d = wr.deref();
      if (d) d.unsubscribeAll();
    }
    node.consumers.clear();

    // Remove this node from its parents' children arrays
    for (const parentRef of node.parents.slice()) {
      node.removeParent(parentRef.node);
    }

    // Remove this node from its children's parent arrays
    for (const child of node.children.slice()) {
      try {
        child.removeParent(node);
      } catch (e) {
        // Child might not have this as parent if relationship was already broken
        // Just remove from children array
        const idx = node.children.indexOf(child);
        if (idx !== -1) {
          node.children.splice(idx, 1);
        }
      }
    }

    // Clear the arrays to avoid holding references
    node.parents.length = 0;
    node.children.length = 0;
  }

  private countLiveConsumers(node: GripContextNode): number {
    let count = 0;
    for (const wr of node.consumers.values()) {
      if (wr.deref()) count += 1;
    }
    return count;
  }
}
