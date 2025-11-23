/**
* GRIP Context Node Interface - Internal graph node management
* 
* Defines the interface for internal context nodes that represent GripContexts
* in the GRIP graph. These nodes manage the relationships and state of contexts
* without exposing the context itself as a public API.
* 
* Key Concepts:
* - Context nodes are internal implementation details
* - They manage graph relationships and state
* - They use weak references for GC-aware lifecycle management
* - They coordinate with the GROK engine for graph operations
* 
* Lifetime Management:
* - References to Drips are weak (allows GC of unused Drips)
* - Drip references to ContextNodes are hard (keeps nodes alive while Drips exist)
* - References to child ContextNodes are weak (allows GC of unused children)
* - References to ProducerRecords are hard (keeps nodes alive while producers exist)
* - References to Taps are hard (keeps nodes alive while Taps exist)
* - Tap references to context nodes are hard (bidirectional strong references)
* 
* The ContextNode is kept alive as long as there are active Drips, active Taps,
* or active children ContextNodes. This ensures proper cleanup when contexts
* are no longer needed.
* 
* Note: This interface is not part of the public API. It is used internally
* by the engine to manage the graph structure and relationships.
*/

import { Grip } from "./grip";
import type { Grok } from "./grok";
import type { GripContext } from "./context";
import type { GripContextNode, ProducerRecord } from "./graph";
import { Drip } from "./drip";
import { Tap } from "./tap";

/**
* Interface for internal context nodes in the GRIP graph.
* 
* GripContextNodeIf provides the contract for managing context nodes
* within the graph. These nodes handle the internal representation
* of GripContexts and manage their relationships, producers, and consumers.
* 
* Key Responsibilities:
* - Manage parent-child relationships in the context hierarchy
* - Track producers and consumers for each Grip
* - Maintain resolved provider mappings
* - Handle lifecycle management with weak references
* - Coordinate with the GROK engine for graph operations
*/
export interface GripContextNodeIf {
/**
* Gets the GROK engine this node belongs to.
* 
* @returns The GROK engine instance
*/
get_grok(): Grok;

/**
* Gets the GripContext this node represents.
* 
* @returns The GripContext or undefined if it has been garbage collected
*/
get_context(): GripContext | undefined; // undefined may mean the context has been GC'd

/**
* Gets all parent nodes of this context.
* 
* @returns Array of parent context nodes
*/
get_parent_nodes(): GripContextNode[];

/**
* Gets all parent nodes with their priority levels.
* 
* @returns Array of parent nodes with priority information
*/
get_parents_with_priority(): ReadonlyArray<{ node: GripContextNode; priority: number }>;

/**
* Gets all child nodes of this context.
* 
* @returns Array of child context nodes
*/
get_children_nodes(): GripContextNode[];

/**
* Gets all producers registered at this context.
* 
* @returns Map of Grip to ProducerRecord
*/
get_producers(): Map<Grip<any>, ProducerRecord>;

/**
* Gets all consumers registered at this context.
* 
* @returns Map of Grip to WeakRef of Drip
*/
get_consumers(): Map<Grip<any>, WeakRef<Drip<any>>>;

/**
* Gets the resolved provider mappings for this context.
* 
* Maps each Grip to the context node that provides it.
* 
* @returns Map of Grip to provider context node
*/
getResolvedProviders(): Map<Grip<any>, GripContextNode>;

/**
* Adds a parent to this context with optional priority.
* 
* @param parent - The parent context node to add
* @param priority - Optional priority level (default: 0)
*/
addParent(parent: GripContextNode, priority?: number): void;

/**
* Records a producer for a specific Grip at this context.
* 
* @param grip - The Grip the producer provides
* @param rec - The ProducerRecord for the producer
*/
recordProducer<T>(grip: Grip<T>, rec: ProducerRecord): void;

/**
* Sets the resolved provider for a specific Grip.
* 
* @param grip - The Grip to set the provider for
* @param node - The context node that provides this Grip
*/
setResolvedProvider<T>(grip: Grip<T>, node: GripContextNode): void;

/**
* Gets or creates a producer record for a Tap.
* 
* Returns the producer record for a given Tap, creating it if it doesn't exist.
* 
* @param tap - The Tap to get or create a record for
* @param outputs - Optional set of output Grips
* @returns The ProducerRecord for the Tap
*/
getOrCreateProducerRecord(tap: Tap, outputs?: Iterable<Grip<any>>): ProducerRecord;

/**
* Records a consumer for a specific Grip at this context.
* 
* @param grip - The Grip the consumer needs
* @param drip - The Drip instance for the consumer
*/
recordConsumer<T>(grip: Grip<T>, drip: Drip<T>): void;

/**
* Gets the live Drip instance for a specific Grip at this context.
* 
* @param grip - The Grip to get the Drip for
* @returns The Drip instance or undefined if not found
*/
getLiveDripForGrip<T>(grip: Grip<T>): Drip<T> | undefined;

/**
* Notifies all consumers of a specific Grip with a new value.
* 
* @param grip - The Grip to notify consumers for
* @param value - The new value to notify with
* @returns The number of consumers notified
*/
notifyConsumers<T>(grip: Grip<T>, value: T): number;

/**
* Marks this node as recently accessed.
* 
* Used for lifecycle management and cleanup decisions.
*/
touch(): void;

/**
* Gets the timestamp when this node was last accessed.
* 
* @returns The timestamp of the last access
*/
getLastSeen(): number;
}
