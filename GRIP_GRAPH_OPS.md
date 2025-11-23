# Graph Operations

The graph consists solely of a Directed Acyclic Graph (DAG) of `Context` objects. Each context may have multiple parents, ordered by priority. A "root" context is a context with no parents. The graph may also have producers and consumers, which are exclusively associated with the single context that contains them.

Consumers designate what they consume by a single key. Producers, however, can provide for multiple keys. Consumers are associated with the "closest" producer by recursively examining parents for an associated producer, searching each node's parents in priority order.

Consumers and producers can only be associated with a single context. This document primarily describes graph mutations and how to efficiently discover which consumers and producers are related.

## Notation and Conventions

### Core Components
- **Contexts**: `C<x>` (e.g., `CA`, `CB`). These represent unique contexts like `Context('A')` and `Context('B')`.
- **Producers**: `P<a,b,c...>` (e.g., `Pij`). This would be a `Producer` with `keys=('i', 'j')`.
- **Consumers**: `D<a>` (e.g., `Di`, `Dj`). These would be `Consumer('i')` and `Consumer('j')`.
- **Root Context**: `$C<x>` (e.g., `$CA`). A context with no parents.

### Operator Definitions
- **Parent Relationship**: `->`
  - `CA->CB` means `CA` is a parent of `CB`.
  - The operator `-n>` indicates priority, where `n` is an integer (lower values have higher priority). `->` is equivalent to `-0>`.
- **Consumer Source**: `c.k.p`
  - `CA.a.CD` means the consumer for key `a` in `CA` is satisfied by a producer in `CD`.
- **Containment**: `(...)`
  - `CA(Pij, Dk)` indicates that `CA` contains a producer for keys `i` and `j`, and a consumer for key `k`.
- **Shortcuts**:
  - `CL->CM->CN` is a shortcut for `CL->CM` and `CM->CN`.
  - `CL-1>CM->CN` is a shortcut for `CL-1>CM` and `CM->CN`.


## Graph Mutations

The graph can be modified through the following mutations:

1.  **Remove Context**: A childless context is removed from the graph.
    - `CX.remove()`
2.  **Add Parent**: A context is associated with a new parent.
    - `CA.addParent(CB)` (makes `CA` a parent of `CB`)
3.  **Unlink Parent**: A parent is unlinked from a child.
    - `CP.unlinkParent(CC)` (where `CP` is a parent of `CC`)
4.  **Add Consumer**: A new consumer is added to a context.
    - `CA.addConsumer(Di)`
5.  **Remove Consumer**: A consumer is removed from a context.
    - `CA.removeConsumer(Di)`
6.  **Add Producer**: A new producer is added to a context. It is an error to add a producer for a key that already has a producer in the same context.
    - `CA.addProducer(Pabc)`
7.  **Remove Producer**: A producer is removed from a context.
    - `CA.removeProducer(Pabc)`


## Producer <-> Consumer Relationships

The context graph represents consumer-producer relationships. The goal is to maintain a data structure for these relationships incrementally and efficiently as the graph mutates.

The search for a producer proceeds as follows:
1.  Check for a producer in the consumer's own context.
2.  If not found, perform a breadth-first search (level-by-level) of the context's ancestors.
3.  At each level, non-root parents are searched first (ordered by priority), followed by any root parents (also ordered by priority). This ensures the "closest" producer is always found and that non-root contexts are prioritized over global/root contexts.

A context may have both consumers and producers, and their keys may overlap.

## Data Structures

The following TypeScript definitions outline the core data structures used to manage producer-consumer relationships within the graph.

```typescript
// Forward declarations for core types
type Grip<T> = any; // Represents a unique key for a value
type Tap = any;     // Represents a Producer
class GripContextNode { /* ... */ }

export class Destination {
  private readonly destContextNode: GripContextNode;
  private readonly grips: Set<Grip<any>>;
  private readonly tap: Tap;
  private readonly producer: ProducerRecord;
}

export class ProducerRecord {
  readonly tap: Tap;
  // Map of destination context -> Destination
  private destinations: Map<GripContextNode, Destination>;

  readonly outputs: Set<Grip<any>>;
};
```

## Core Algorithms

To ensure correctness, the fundamental operation is always resolving a consumer from its own perspective by searching upwards through its ancestors. This avoids the pitfalls of trying to "push" producer information down the graph, where visibility rules can be complex.

The following pseudo-code outlines the simple, correct algorithms for handling graph mutations.

### `findProducerFor(context, key)`: The Central Lookup

This is the core function for resolving a single consumer.

1.  If `context` has a producer for `key`, return `context`.
2.  Initialize a queue for a Breadth-First Search (BFS) with the parents of `context`. To handle the "root-last" rule, add non-root parents to the queue first, then root parents.
3.  Initialize a `visited` set to track visited contexts and avoid redundant searches.
4.  While the queue is not empty:
    a. Dequeue a `parentContext`.
    b. If `parentContext` has been visited, continue. Otherwise, mark it as visited.
    c. If `parentContext` has a producer for `key`, a source has been found. Return `parentContext`.
    d. Add `parentContext`'s non-root parents, then root parents, to the end of the queue.
5.  If the search completes without finding a producer, return `null`.

### Mutation: `context.addConsumer(key)`

1.  Call `findProducerFor(context, key)`.
2.  If a `producerContext` is returned, establish the link:
    a. Update the `ProducerRecord` in `producerContext` to add a `Destination` pointing to `context` for the given `key`.
    b. In `context`, store a local reference mapping the `key` to the `producerContext`.
3.  If `null` is returned, the consumer is unresolved.

### Mutation: `context.removeConsumer(key)`

1.  Look up the consumer's current `producerContext` from local storage.
2.  If one exists, go to that `producerContext`'s `ProducerRecord` and remove the `Destination` that points to `context` for the given `key`.
3.  Remove the local mapping in `context`.

### Mutation: `context.addProducer(keys)`

This action must notify potential consumers in its descendants.

1.  Perform a traversal (BFS or DFS) of all descendants of `context`.
2.  For each `descendantContext` found:
    a. For each `consumerKey` that the descendant is consuming:
        i. If `keys` contains `consumerKey`, it's possible this new producer could be a better source.
        ii. Trigger a full re-resolution for that consumer by calling `findProducerFor(descendantContext, consumerKey)` and updating the links accordingly.

### Mutation: `context.removeProducer(keys)`

This action must invalidate consumers that were linked to it.

1.  For each `key` being removed, get the list of `Destination`s from the producer's `ProducerRecord`.
2.  For each `destinationContext` that was a consumer:
    a. Unlink it from this producer.
    b. Trigger a full re-resolution for it by calling `findProducerFor(destinationContext, key)` to find a new source (e.g., from a more distant ancestor).

### Mutation: `context.addParent()` or `context.unlinkParent()`

A change in parentage is the most impactful mutation. It potentially changes the resolution for *every* consumer in the context and all its descendants.

1.  Perform a traversal (BFS or DFS) of `context` and all of its descendants.
2.  For each `descendantContext` found:
    a. For each `consumerKey` that the descendant is consuming:
        i. Trigger a full re-resolution by calling `findProducerFor(descendantContext, consumerKey)` and updating links.

## Optimization Strategies and Gotchas

The algorithms above are correct but can be inefficient, especially `addProducer` and parentage changes, which traverse large parts of the graph. The following strategies can be used to improve performance.

### 1. Cached Resolution (Memoization)

The result of `findProducerFor(context, key)` can be cached directly in `context`.

-   **Fast Path (`addConsumer`)**: When a consumer is added, it can first check this cache. If a resolution for its key already exists in the cache, it can be reused instantly. If not, it performs the full `findProducerFor` and caches the result. This optimizes for the case you described, where multiple consumers for the same key exist in the same context.

-   **Invalidation (The Hard Part)**: The cache is the "fast path," but it must be aggressively invalidated to prevent stale results. A `(context, key)` cache entry must be cleared if:
    1.  The parents of `context` change.
    2.  A producer for `key` is added or removed anywhere in the **ancestry** of `context`.

Tracking ancestral changes is complex and is the primary drawback of this approach.

### 2. Lazy Resolution with Dirty Flags

This avoids the expensive traversal of `addProducer` and parentage changes.

-   **The Strategy**: Instead of re-resolving immediately, the mutation simply "dirties" the consumers that *might* be affected.
    -   When `addParent` or `unlinkParent` is called on a context, mark all consumers in that context and its descendants as "dirty."
    -   When a producer is added, mark descendant consumers for the same keys as "dirty."
    -   When a producer is removed, mark its now-unlinked consumers as "dirty."

-   **Resolution**: Consumers are only re-resolved (by calling `findProducerFor`) when their value is next accessed. After resolution, the "dirty" flag is cleared.

-   **Gotcha**: This adds complexity to the data access layer, which must now check for dirty flags before returning a value. It distributes the cost of mutations over time rather than paying it all at once.

### 3. Optimizing Producer Mutations with a Scoping Traversal

The simple algorithms for `addProducer` and `removeProducer` are inefficient because they naively re-evaluate every descendant consumer. A much more performant approach uses a top-down traversal to identify the precise subset of consumers that could be affected by the mutation.

-   **The Strategy (Two-Phase Resolution)**:
    1.  **Phase 1: Identify Candidates (Top-Down)**: When a producer is added or removed, perform a `resolveProducer`-style traversal *down* the graph from the mutated context.
        -   This traversal carries the set of keys affected by the mutation.
        -   As it enters a descendant context, it checks if that context has its own producer for any of the affected keys. If so, those keys are considered "shadowed," and the traversal does not proceed further down that branch *for those keys*.
        -   Any consumer encountered for a non-shadowed, affected key is added to a "candidate set."
    2.  **Phase 2: Verify Correctness (Bottom-Up)**: Once the traversal is complete, iterate through the small "candidate set." For each candidate consumer, run the correct `findProducerFor(consumerContext, key)` to determine its new, correct producer.

-   **The Benefit**: This approach combines the speed of a top-down traversal (which can efficiently handle multiple keys at once and prune entire branches via shadowing) with the correctness of the consumer-led `findProducerFor` lookup. It ensures that the expensive `findProducerFor` is only run on the minimal set of consumers that are actually impacted by the mutation.

## Graph Scenarios

### 1. Simple Case
- **Graph**: `CA(Pa) -> CB(Da)`
- **Action**: `CB.addConsumer(Da)` is called after the graph is established.
- **Expected**: `CB.a.CA`

### 2. Transitive Case
- **Graph**: `CA(Pa) -> CB -> CC(Da)`
- **Expected**: `CC.a.CA`

### 3. Producer Shadowing by Ancestor
- **Graph**: `CA(Pa) -> CB(Pa) -> CC(Da)`
- **Note**: The `Pa` in `CA` and `CB` are distinct producers.
- **Expected**: `CC.a.CB`
- **Analysis**: The consumer `Da` in `CC` finds the producer in the nearest parent, `CB`.

### 4. Priority-Based Resolution
- **Graph**: `CA->CC->CD`, `CB-1>CD`, with `CB(Pa)`, `CC(Pa)`, `CD(Da)`
- **Expected**: `CD.a.CC`
- **Analysis**: The child `CD` sees `CC` with a higher priority (0) than `CB` (1), so it connects to the producer in `CC`.

### 5. Producer Shadowing by Key
- **Graph**: `CA(Pmno) -> CB(Pn) -> CC(Dno)`
- **Expected**: `CC.n.CB` and `CC.o.CA`
- **Analysis**: Consumer `Dn` in `CC` is satisfied by the producer in `CB`. Consumer `Do` is satisfied by `CA`, as `CB` does not have a producer for `o`.

### 6. Dynamic Re-Parenting
- **Initial State**: `CA(Pa) -1> CC(Da)` and a separate `CB(Pa)`. Relationship is `CC.a.CA`.
- **Mutation**: `CC.addParent(CB)` (making `CB` the new, highest-priority parent).
- **Expected**: The relationship for `Da` becomes `CC.a.CB`.

### 7. Parent Link Removal & Re-linking
- **Initial State**: `CA(Pa)`, `CB(Pa)`, `CA->CC`, `CB-1>CC`, `CC(Da)`. Relationship is `CC.a.CA`.
- **Mutation**: `CC.unlinkParent(CA)`.
- **Expected**: `Da` re-links to the next available producer in `CB`. New relationship: `CC.a.CB`.

### 8. Producer Removal
- **Initial State**: `CA(Pa)`, `CB(Pa)`, `CA->CC`, `CB-1>CC`, `CC(Da)`. Relationship is `CC.a.CA`.
- **Mutation**: `CA.removeProducer(Pa)`.
- **Expected**: `Da` re-links to the producer in `CB`. New relationship: `CC.a.CB`.

### 9. Adding a Shadowing Producer
- **Initial State**: `CA(Pa) -> CB(Da)`. Relationship is `CB.a.CA`.
- **Mutation**: `CB.addProducer(Pa)`.
- **Expected**: The relationship updates to `CB.a.CB` as `CB` now has a closer producer.

### 10. No Producer Available
- **Graph**: `CA -> CB(Da)`.
- **Expected**: The consumer `Da` remains unresolved, as no producer for key `a` exists in the ancestry.

### 11. Consumer in Same Context as Producer
- **Graph**: `CA(Pa, Da)`.
- **Expected**: The relationship is internal: `CA.a.CA`.

### 12. Removing a Consumer
- **Initial State**: `CA(Pa) -> CB(Da)`. The relationship `CB.a.CA` exists.
- **Mutation**: `CB.removeConsumer(Da)`.
- **Expected**: The relationship is removed. The `ProducerRecord` in `CA` should no longer point to `CB` for key `a`.

### 13. Fallback to Ancestor After Self-Producer Removal
- **Initial State**: `CB(Pa) -> CA(Pa, Da)`. The relationship is internal (`CA.a.CA`).
- **Mutation**: `CA.removeProducer(Pa)`.
- **Expected**: `Da` re-evaluates and links to the producer in its parent, `CB`. The new relationship becomes `CA.a.CB`.

### 14. Root Parent De-prioritization
- **Graph**: `$CA(Pa)`, `CB(Pa)`, `$CA->CD`, `CB-1>CD`, `CD(Da)`
- **Analysis**: `CD` has two parents: `$CA` (root, priority 0) and `CB` (non-root, priority 1). The "root-last" rule overrides the explicit priority, so `CB` is searched first.
- **Expected**: `CD.a.CB`.

### 15. Diamond Dependency Resolution
- **Graph**: `$CA(Pa)->CB->CD` and `$CA->CC(Pa)->CD`, with `CD(Da)`.
- **Analysis**: The consumer `Da` in `CD` initiates a breadth-first search. It inspects immediate parents `CB` and `CC` first. A producer is found in `CC`, so the search terminates immediately without needing to check the grandparent `$CA`.
- **Expected**: `CD.a.CC`.

### 16. Cascading Re-linking after Producer Removal
- **Initial State**: `CA(Pa)->CB(Pa)->CC(Da)->CD(Da)`.
- **Initial Relationships**: `CC.a.CB` and `CD.a.CB`.
- **Mutation**: `CB.removeProducer(Pa)`.
- **Expected**: Both consumers in `CC` and `CD` are invalidated and re-link to the producer in `CA`. The new relationships become `CC.a.CA` and `CD.a.CA`.

