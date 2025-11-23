/**
 * GRIP Tap Resolver - Core producer-consumer resolution system
 *
 * Implements the core algorithms for resolving which Tap (producer) provides data
 * for a given Grip (consumer) based on context hierarchy and priority rules.
 *
 * Key Responsibilities:
 * - Producer-consumer relationship management
 * - Context hierarchy traversal and priority resolution
 * - Graph state updates during Tap/consumer lifecycle changes
 * - Delta-based producer updates with batched re-resolution
 * - Breadth-first, root-last search algorithm implementation
 *
 * Core Algorithms:
 * - Closest Provider Resolution: Finds the nearest Tap in the context hierarchy
 * - Delta Application: Efficiently updates graph state from query evaluation results
 * - Descendant Re-evaluation: Propagates changes through the context DAG
 * - Producer-Consumer Linking: Establishes and maintains data flow connections
 */

import { Grip } from "./grip";
import { GripContext } from "./context";
import { Tap, TapFactory } from "./tap";
import { Grok } from "./grok";
import { GripContextNode, ProducerRecord } from "./graph";
import { EvaluationDelta, TapAttribution } from "./query_evaluator";
import { consola } from "consola";

const logger = consola.withTag("core/tap_resolver.ts");

/**
 * Utility function to compute intersection of a Set and an Iterable.
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
 * Utility function to compute difference between two Sets.
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
 * Interface for pluggable resolver implementations.
 *
 * Defines the contract for managing producer-consumer relationships
 * within the GRIP graph. The resolver is responsible for:
 * - Linking consumers to appropriate producers
 * - Handling Tap lifecycle events
 * - Managing context hierarchy changes
 * - Applying producer deltas from query evaluation
 */
export interface IGripResolver {
  /**
   * Called when a new consumer is added to a context.
   * Finds and links the appropriate producer based on context hierarchy.
   */
  addConsumer(context: GripContext, grip: Grip<any>): void;

  /**
   * Called when a consumer is removed from a context.
   * Unlinks it from its current producer.
   */
  removeConsumer(context: GripContext, grip: Grip<any>): void;

  /**
   * Called when a new producer (Tap) is added to a context.
   * Re-links any descendant consumers that might be affected.
   */
  addProducer(context: GripContext, tap: Tap | TapFactory): void;

  /**
   * Called when a producer (Tap) is removed from a context.
   * Re-links any consumers that were linked to it.
   */
  removeProducer(context: GripContext, tap: Tap | TapFactory): void;

  /**
   * Called when a parent is added to a context.
   * Re-evaluates all consumers in the context and its descendants.
   */
  addParent(context: GripContext, parent: GripContext): void;

  /**
   * Called when a parent is removed from a context.
   * Re-evaluates all consumers in the context and its descendants.
   */
  unlinkParent(context: GripContext, parent: GripContext): void;

  /**
   * Called when a producer delta is applied to a context.
   * Updates the graph to reflect new producer state from query evaluation.
   */
  applyProducerDelta(context: GripContext | GripContextNode, delta: EvaluationDelta): void;
}

/**
 * Simple, correct implementation of the IGripResolver interface.
 *
 * Implements the core resolution algorithms defined in GRIP_GRAPH_OPS.md:
 * - Breadth-first, root-last search for closest provider
 * - Delta-based graph updates with batched re-resolution
 * - Producer-consumer lifecycle management
 * - Context hierarchy change propagation
 */
export class SimpleResolver implements IGripResolver {
  private grok: Grok;

  constructor(grok: Grok) {
    this.grok = grok;
  }

  /**
   * Adds a consumer and resolves it to the best available producer.
   *
   * Ensures the consumer is recorded on the node for future re-evaluations
   * and immediately resolves it to find the closest provider.
   */
  addConsumer(context: GripContext, grip: Grip<any>): void {
    const node = this.grok.ensureNode(context);
    // Ensure the consumer is recorded on the node so future re-evaluations can find it
    node.getOrCreateConsumer(grip);
    this.resolveConsumer(node, grip);
  }

  /**
   * Removes a consumer and unlinks it from its producer.
   *
   * Cleans up the producer-consumer relationship and removes the consumer
   * from the node's registry.
   */
  removeConsumer(context: GripContext, grip: Grip<any>): void {
    const node = this.grok.ensureNode(context);
    this.unresolveConsumer(node, grip);
    // Remove the consumer from the node's registry
    node.removeConsumerForGrip(grip);
  }

  /**
   * Applies producer delta from query evaluation with batched re-resolution.
   *
   * This is the core method for updating the graph state when query evaluation
   * determines that different Taps should provide specific Grips. The method:
   *
   * 1. Collects all affected consumers before making changes
   * 2. Applies structural changes to the graph
   * 3. Triggers batched re-resolution for affected consumers
   * 4. Cleans up empty producer records
   *
   * The delta contains TapAttribution objects that specify which Taps should
   * provide which Grips based on query evaluation results.
   */
  applyProducerDelta(context: GripContext | GripContextNode, delta: EvaluationDelta): void {
    const node = context.kind === "GripContext" ? context.getNode() : context;
    if (process.env.NODE_ENV !== "production")
      logger.log(`[SimpleResolver] applyProducerDelta: Queuing delta application for ${node.id}`);

    node.submitTask(() => {
      if (process.env.NODE_ENV !== "production")
        logger.log(
          `[SimpleResolver] applyProducerDelta: Executing queued delta application for ${node.id}`,
        );

      // --- Step 1: Collect all affected consumers before making any changes ---
      const consumersToReResolve = new Set<{ destNode: GripContextNode; grip: Grip<any> }>();
      for (const [tap, attribution] of delta.removed.entries()) {
        const producerRecord = node.getProducerRecord(tap);
        if (producerRecord) {
          for (const grip of attribution.attributedGrips) {
            this.collectConsumers(producerRecord, grip, consumersToReResolve);
          }
        }
      }

      // --- Step 2: Apply all structural changes to the graph ---

      // Process removals
      for (const [tap, attribution] of delta.removed.entries()) {
        const producerRecord = node.getProducerRecord(tap);
        if (producerRecord) {
          for (const grip of attribution.attributedGrips) {
            // Only remove the producer for this grip if it's the one currently assigned
            if (node.get_producers().get(grip) === producerRecord) {
              node.get_producers().delete(grip);
            }
            producerRecord.outputs.delete(grip);
          }
        }
      }

      // Process additions
      for (const [tapOrFactory, attribution] of delta.added.entries()) {
        // Pass the tap or factory directly to getOrCreateProducerRecord
        // ProducerRecord will handle building the tap if it's a factory
        const producerRecord = node.getOrCreateProducerRecord(tapOrFactory, tapOrFactory.provides);

        // Ensure the tap is properly attached if it isn't already
        const nodeContext = node.get_context();
        const tapInstance = producerRecord.tap;
        if (nodeContext && !tapInstance.getHomeContext?.()) {
          tapInstance.onAttach?.(nodeContext);
        }

        for (const grip of attribution.attributedGrips) {
          // This will overwrite any existing producer for the grip, which is intended.
          node.recordProducer(grip, producerRecord);
          producerRecord.outputs.add(grip);
        }
      }

      // --- Step 3: Trigger Batched Re-resolution for removals and any new consumers ---
      const descendants = [node, ...this.getDescendants(node)];
      for (const [tap, attribution] of delta.added.entries()) {
        for (const grip of attribution.attributedGrips) {
          for (const descendant of descendants) {
            if (descendant.get_consumers().has(grip)) {
              consumersToReResolve.add({ destNode: descendant, grip });
            }
          }
        }
      }

      for (const { destNode, grip } of consumersToReResolve) {
        this.unresolveConsumer(destNode, grip);
        this.resolveConsumer(destNode, grip);
      }

      // --- Step 4: Cleanup ---
      const tapsInDelta = new Set([...delta.added.keys(), ...delta.removed.keys()]);
      for (const tap of tapsInDelta) {
        const producerRecord = node.getProducerRecord(tap);
        if (producerRecord && producerRecord.outputs.size === 0) {
          node._removeTap(tap);
        }
      }
    }, 100); // Schedule as a low-priority task
  }

  /**
   * Analyzes delta to determine added, removed, and transferred Grips.
   *
   * Compares current producer state with desired final state to identify:
   * - Grips that need new producers (added)
   * - Grips that lost their producers (removed)
   * - Grips that moved between producers (transferred)
   */
  private analyzeDelta(node: GripContextNode, delta: EvaluationDelta) {
    // 1. Determine the current state of producers
    const currentProducers = new Map<Tap | TapFactory, Set<Grip<any>>>();
    for (const [grip, producerRecord] of node.get_producers().entries()) {
      const tap = producerRecord.tapFactory ?? producerRecord.tap;
      if (!currentProducers.has(tap)) {
        currentProducers.set(tap, new Set());
      }
      currentProducers.get(tap)!.add(grip);
    }

    // 2. Calculate the final (desired) state based on the delta
    const finalProducers = new Map<Tap | TapFactory, TapAttribution>();
    const tempFinalGrips = new Map<Tap | TapFactory, Set<Grip<any>>>();

    // Start with current state
    for (const [tap, grips] of currentProducers.entries()) {
      const rec = node.getProducerRecord(tap)!; // Should exist
      tempFinalGrips.set(tap, new Set(grips));
      finalProducers.set(tap, {
        producerTap: tap,
        score: 0,
        bindingId: "",
        attributedGrips: tempFinalGrips.get(tap)!,
      });
    }

    // Apply removals from delta
    for (const [tap, attribution] of delta.removed.entries()) {
      const finalGrips = tempFinalGrips.get(tap);
      if (finalGrips) {
        for (const grip of attribution.attributedGrips) {
          finalGrips.delete(grip);
        }
        if (finalGrips.size === 0) {
          tempFinalGrips.delete(tap);
          finalProducers.delete(tap);
        }
      }
    }

    // Apply additions from delta
    for (const [tap, attribution] of delta.added.entries()) {
      if (!tempFinalGrips.has(tap)) {
        tempFinalGrips.set(tap, new Set());
      }
      const finalGrips = tempFinalGrips.get(tap)!;
      for (const grip of attribution.attributedGrips) {
        finalGrips.add(grip);
      }
      finalProducers.set(tap, { ...attribution, attributedGrips: finalGrips });
    }

    // 3. Compare current and final states to determine added, removed, and transferred
    const added = new Map<Tap | TapFactory, Set<Grip<any>>>();
    const removed = new Map<Tap | TapFactory, Set<Grip<any>>>();
    const transferred = new Map<Grip<any>, { from: Tap | TapFactory; to: Tap | TapFactory }>();

    const allGrips = new Set<Grip<any>>();
    currentProducers.forEach((grips) => grips.forEach((g) => allGrips.add(g)));
    tempFinalGrips.forEach((grips) => grips.forEach((g) => allGrips.add(g)));

    for (const grip of allGrips) {
      const oldTap = this.findTapForGrip(grip, currentProducers);
      const newTap = this.findTapForGrip(grip, tempFinalGrips);

      if (oldTap && !newTap) {
        if (!removed.has(oldTap)) removed.set(oldTap, new Set());
        removed.get(oldTap)!.add(grip);
      } else if (!oldTap && newTap) {
        if (!added.has(newTap)) added.set(newTap, new Set());
        added.get(newTap)!.add(grip);
      } else if (oldTap && newTap && oldTap !== newTap) {
        transferred.set(grip, { from: oldTap, to: newTap });
      }
    }
    return { added, removed, transferred, finalProducers };
  }

  /**
   * Finds which Tap provides a specific Grip in a producer map.
   */
  private findTapForGrip(
    grip: Grip<any>,
    map: Map<Tap | TapFactory, Set<Grip<any>>>,
  ): Tap | TapFactory | undefined {
    for (const [tap, grips] of map.entries()) {
      if (grips.has(grip)) {
        return tap;
      }
    }
    return undefined;
  }

  /**
   * Collects all consumers of a specific Grip from a producer record.
   *
   * Used to identify which consumers need re-resolution when a producer changes.
   */
  private collectConsumers(
    producerRecord: ProducerRecord,
    grip: Grip<any>,
    consumersToReResolve: Set<{ destNode: GripContextNode; grip: Grip<any> }>,
  ) {
    for (const destination of producerRecord.getDestinations().values()) {
      if (destination.getGrips().has(grip)) {
        consumersToReResolve.add({ destNode: destination.getContextNode(), grip });
      }
    }
  }

  /**
   * Adds a producer (Tap) to a context and re-evaluates affected consumers.
   *
   * Attaches the Tap to the context, creates producer records, and re-resolves
   * all consumers in the producer's context and descendants that could be affected.
   */
  addProducer(context: GripContext, tap: Tap): void {
    // Attach tap to context so it tracks its home and sets up producer record
    tap.onAttach?.(context);
    const producerNode = this.grok.ensureNode(context);
    const producerRecord = producerNode.getOrCreateProducerRecord(tap, tap.provides);

    // Defensive: ensure tap instance reflects attachment even if onAttach was a no-op
    try {
      (tap as any).producer = (tap as any).producer ?? producerRecord;
      (tap as any).homeContext = (tap as any).homeContext ?? context;
      (tap as any).engine = (tap as any).engine ?? this.grok;
    } catch {}

    // Ensure all provided grips are mapped to this producer record on the producer node
    for (const grip of tap.provides) {
      producerNode.recordProducer(grip, producerRecord);
    }

    // Ensure the tap is now considered attached (home/prod already recorded by onAttach)
    // Per the spec, we must re-evaluate all consumers in the producer's
    // own context and all descendant consumers that could be affected.
    const descendants = [producerNode, ...this.getDescendants(producerNode)];
    const providedGrips = new Set(tap.provides);

    for (const descendant of descendants) {
      for (const [grip, _] of descendant.get_consumers()) {
        if (providedGrips.has(grip)) {
          // This consumer might have a new, better producer. Re-resolve it.
          this.resolveConsumer(descendant, grip);
        }
      }
    }
  }

  /**
   * Removes a producer (Tap) from a context and re-links affected consumers.
   *
   * Snapshot all affected consumer-producer relationships, remove the producer,
   * and re-resolve each affected consumer to find the next-best provider.
   */
  removeProducer(context: GripContext, tap: Tap | TapFactory): void {
    const producerNode = this.grok.ensureNode(context);
    const producerRecord = producerNode.getProducerRecord(tap);
    if (!producerRecord) return;

    // Snapshot all (destination, grip) pairs to re-evaluate after removal
    const pairs: Array<{ destNode: GripContextNode; grip: Grip<any> }> = [];
    for (const destination of Array.from(producerRecord.getDestinations().values())) {
      const destNode = destination.getContextNode();
      for (const grip of destination.getGrips()) {
        pairs.push({ destNode, grip });
      }
    }

    // Remove the grip -> producer mapping for this tap's grips if pointing to this record
    for (const grip of tap.provides) {
      const current = producerNode.get_producers().get(grip);
      if (current === producerRecord) {
        producerNode.get_producers().delete(grip);
      }
    }

    // Remove the producer record from the node and notify tap.
    // The tap can be a tap factory, so we need to let the node handle it
    // as it will have the real tap instance.
    producerNode._removeTap(tap);

    // Now unresolve and re-resolve each affected destination/grip
    for (const { destNode, grip } of pairs) {
      // Remove resolved link if currently pointing to this producer
      const resolvedProviders = destNode.getResolvedProviders();
      const linkedNode = resolvedProviders.get(grip);
      if (linkedNode === producerNode) {
        resolvedProviders.delete(grip);
      }
      // Remove destination from the old record to keep it tidy
      producerRecord.removeDestinationGripForContext(destNode, grip);
      // Re-resolve to find next-best provider
      this.resolveConsumer(destNode, grip);
    }
  }

  /**
   * Called when a parent is added to a context.
   *
   * Re-evaluates all consumers in the context and its descendants since
   * the context hierarchy has changed.
   */
  addParent(context: GripContext, parent: GripContext): void {
    this.reevaluateDescendants(context);
  }

  /**
   * Called when a parent is removed from a context.
   *
   * Updates the graph to reflect the removed parent and re-evaluates
   * all consumers in the context and its descendants.
   */
  unlinkParent(context: GripContext, parent: GripContext): void {
    // Update the graph to reflect the removed parent, then re-evaluate.
    // If the context implementation does not support unlinking, this is a no-op.
    (context as any).unlinkParent?.(parent);
    this.reevaluateDescendants(context);
  }

  /**
   * Re-evaluates all consumers in a context and all of its descendants.
   *
   * This is a costly operation, triggered by a change in parentage.
   * Used when the context hierarchy changes and all consumers need
   * to be re-resolved to find new best providers.
   */
  private reevaluateDescendants(context: GripContext): void {
    const startNode = this.grok.ensureNode(context);
    const descendants = [startNode, ...this.getDescendants(startNode)];
    for (const descendant of descendants) {
      // Collect all grips for which this descendant has consumers
      const consumerGrips = Array.from(descendant.get_consumers().keys());
      for (const grip of consumerGrips) {
        this.resolveConsumer(descendant, grip);
      }
    }
  }

  /**
   * Resolves a single consumer and updates the graph state.
   *
   * Finds the best producer for the consumer and establishes the
   * producer-consumer relationship. If the producer changes, it
   * unlinks from the old producer and links to the new one.
   */
  resolveConsumer(node: GripContextNode, grip: Grip<any>): void {
    const currentProducerNode = node.getResolvedProviders().get(grip);
    const newProducerNode = this.findProducerFor(node, grip);

    // If the new producer is different, or if we previously had a producer and now don't (or vice versa)
    if (currentProducerNode !== newProducerNode) {
      // Unlink from the old producer if it existed
      if (currentProducerNode) {
        this.unresolveConsumer(node, grip);
      }

      // Link to the new producer if one was found
      if (newProducerNode) {
        const producerRecord = newProducerNode.get_producers().get(grip);
        if (producerRecord) {
          // If the tap was previously detached (no destinations), re-attach it to its home before connecting
          const homeCtx = newProducerNode.get_context();
          if (homeCtx && !producerRecord.tap.getHomeContext()) {
            producerRecord.tap.onAttach?.(homeCtx);
          }
          producerRecord.addDestinationGrip(node, grip);
          node.setResolvedProvider(grip, newProducerNode);
        }
      } else {
        // If no new producer, ensure it's removed from resolvedProviders
        node.getResolvedProviders().delete(grip);
        // Revert destination drip to default value to maintain deterministic state
        const ctx = node.get_context();
        if (ctx) {
          // Notify the consumer at this destination of the default value
          node.notifyConsumers(grip as any, (grip as any).defaultValue);
        }
      }
    }
  }

  /**
   * Unlinks a consumer from its current producer, if any.
   *
   * Removes the producer-consumer relationship and cleans up
   * the resolved provider mapping.
   */
  unresolveConsumer(destNode: GripContextNode, grip: Grip<any>): void {
    const resolvedProviders = destNode.getResolvedProviders();
    const producerNode = resolvedProviders.get(grip);
    if (producerNode) {
      producerNode.removeDestinationForContext(grip, destNode);
      // Only delete from resolvedProviders if the producer was successfully removed
      // This ensures that if the removal fails for some reason, the state is still consistent.
      resolvedProviders.delete(grip);
    }
  }

  /**
   * Finds the highest-priority producer for a given grip starting from a context node.
   *
   * Implements the breadth-first, root-last search algorithm:
   * 1. Check the starting node first (closest provider)
   * 2. Use BFS to traverse the context hierarchy
   * 3. Process non-root parents before root parents (root-last)
   * 4. Respect explicit priority ordering from the context layer
   *
   * Returns the closest provider node or null if no provider found.
   */
  private findProducerFor(startNode: GripContextNode, grip: Grip<any>): GripContextNode | null {
    // 1. Check self
    if (startNode.get_producers().has(grip)) {
      return startNode;
    }

    const queue: GripContextNode[] = [];
    const visited = new Set<GripContextNode>();

    // Add startNode to queue and visited set
    queue.push(startNode);
    visited.add(startNode);

    // 3. BFS search
    while (queue.length > 0) {
      const currentNode = queue.shift()!;
      // Check if current node has the producer
      if (currentNode.get_producers().has(grip)) {
        return currentNode; // Found the closest producer.
      }

      // Enqueue parents for the next level, maintaining root-last order
      // and explicit priority ordering from the context layer.
      const orderedParents = currentNode.get_parents_with_priority();
      const nonRoots: GripContextNode[] = [];
      const roots: GripContextNode[] = [];

      for (const { node: parentNode } of orderedParents) {
        if (!visited.has(parentNode)) {
          if (parentNode.isRoot()) {
            roots.push(parentNode);
          } else {
            nonRoots.push(parentNode);
          }
          visited.add(parentNode); // Mark as visited when enqueued
        }
      }
      queue.push(...nonRoots, ...roots);
    }

    // 4. No producer found.
    return null;
  }

  /**
   * Performs a traversal to get all unique descendants of a starting node.
   *
   * Uses BFS to collect all descendant nodes in the context DAG.
   * Used for propagating changes through the context hierarchy.
   */
  private getDescendants(startNode: GripContextNode): GripContextNode[] {
    const descendants = new Set<GripContextNode>();
    const queue = [...startNode.get_children_nodes()];
    const visited = new Set<GripContextNode>([startNode]);

    while (queue.length > 0) {
      const currentNode = queue.shift()!;
      if (visited.has(currentNode)) {
        continue;
      }
      visited.add(currentNode);
      descendants.add(currentNode);

      for (const child of currentNode.get_children_nodes()) {
        if (!visited.has(child)) {
          queue.push(child);
        }
      }
    }
    return Array.from(descendants);
  }

  // Internal helpers used by Grok's original resolve flow retained for completeness
  /**
   * Stage 1 resolution for Grok's original resolve flow.
   *
   * This method is tightly coupled with Grok's internal graph traversal.
   * Implements the core logic for finding and linking producers to consumers
   * in the original resolution algorithm.
   */
  resolveConsumerStage1(
    dest: GripContext,
    source: GripContext,
    grip: Grip<any>,
    visited: Set<GripContext>,
    roots: GripContext[],
  ): boolean {
    // This method is tightly coupled with Grok's internal graph traversal.
    // SimpleResolver (this class) is responsible for this logic.
    // Re-implementing the core logic here from Grok's original resolveConsumerStage1
    // Check to see if the current context has a tap that provides this grip.
    var sourceNode = this.grok.ensureNode(source);
    var producer = sourceNode.get_producers().get(grip);

    if (producer) {
      // We have a tap that provides this grip.
      // Link the producer to the original destination context for this grip
      const destNode = this.grok.ensureNode(dest);
      producer.addDestinationGrip(destNode, grip);
      // Record the resolved provider for cleanup from the destination side
      destNode.setResolvedProvider(grip, sourceNode);
      return true;
    }

    // Check all parents all the way up to the root.
    for (const parent of source.getParents()) {
      const parentCtx = parent.ctx;
      if (parentCtx.isRoot()) {
        roots.push(parentCtx);
        continue;
      }
      if (visited.has(parentCtx)) continue;
      visited.add(parentCtx);
      if (this.resolveConsumerStage1(dest, parentCtx, grip, visited, roots)) return true;
    }

    return false;
  }

  /**
   * Resolves producers for a set of Grips in a context.
   *
   * Checks for local consumers that can be provided by the available Grips,
   * handling shadowing and overrides appropriately.
   */
  resolveProducer(ctx: GripContext, current: GripContext | undefined, grips: Set<Grip<any>>) {
    var available_grips = grips;

    // Check to see local consumers first.
    if (current) {
      const node = this.grok.ensureNode(current);
      const producers = node.get_producers();

      // If there are producers that can provide the grips, then these shadow our
      // grips so we remove them from the available grips. If we're completely
      // overridden, then we return. There may have been other contexts that where
      // we successfully resolved or there may be more grips being registered later
      // where the source context can provide data for.
      if (producers.size > 0) {
        const common = intersection(available_grips, producers.keys());
        if (common.size > 0) {
          available_grips = difference(available_grips, common);
          if (available_grips.size === 0) {
            // The available grips are completely overridden by other producers.
            return;
          }
        }
      }
    } else {
      // On the first call in the recursion we set the current context to be undefined.
      // as we don't want to shadow ourselves. In this case we do want to prodice for
      // local consumers.
      current = ctx;
    }

    // This is where we check for consumers in the "current" destination context.
    const node = this.grok.ensureNode(current);
    // Now scan the children to find any consumers that can be provided by the producers context.
    const consumers = node.get_consumers();
    for (const [grip, drip] of consumers) {
      if (available_grips.has(grip)) {
        // OK - we have a consumer that we want to provide.
        // Now we need to check to see if this context/grip pair is already
        // has a different visible producer by doing a resolveConsumer.
        this.resolveConsumer(node, grip);
      }
    }
  }
}
