## GRIP Resolver and DAG Caching Spec (v0.1)

### 1. Scope and goals

- Resolve the correct Tap for a requested `(Grip, GripContext)` efficiently.
- Keep per-context, per-grip mappings up to date when taps/contexts/parameters change.
- Propagate registrations/removals through the context DAG with correct overshadowing rules.
- Be compatible with multi-output taps and parameter-driven variants.

Out of scope for this iteration: full "Query matcher" (Android resources analogue), tapscope filtering, prospective graph, and scored selection policies. These can layer on top later.

### 2. Definitions

- **Grip**: Typed key with default value.
- **Tap**: Producer that can provide data for one or more Grips. May declare `parameterGrips` it depends on.
- **GripContext**: Node in a directed acyclic graph (DAG) with prioritized parents. GripContexts anchor consumers (Drip) and producers (Tap). Each Drip is associated with single Grip while a Tap can provide for multiple Taps. A GripContext provides the "scope" in a hierarchical. Taps local or "visible" via the parents will determin which Tap/producer will provide for the local Drips.
- **LocalProviders (registration map)**: Per-context `Map<Grip, Tap>` of taps registered at exactly that context. Constraint: at most one tap per grip per context.
- **ResolvedMap (selection cache)**: Per-context `Map<Grip, GripContext>` capturing the currently selected source context. Only populated for active or recently used mappings; entries are removed on last consumer (see lifecycle).
- **ConsumerDrips**: Per-context `Map<Grip, Drip>` of the active drip per grip (shared by multiple consumers in the same destination context).
- **Parameter grips**: Grips declared by a tap that influence selection/production (e.g., `WEATHER_LOCATION`).

### 3. Invariants and constraints

- Registering a tap in a context exposes that tap to all its descendant contexts, unless an intervening context registers its own tap for the same grip (overshadowing).
- Only one tap per grip can be registered at a single context. Registering a second tap for the same grip in the same context is an error.
- Multiple taps may exist in different contexts for the same grip; the closest (by destination) wins.
- Multi-output taps: a single tap may provide multiple grips. Selection and caching must be per grip.

### 4. Data model (runtime)

- On each `GripContextNode` (engine graph node):
  - `localProviders: Map<Grip, Tap>` (registration map)
  - `resolvedMap: Map<Grip, GripContext>` (selection cache for this destination context)
  - `dripByGrip: Map<Grip, Drip>` (one shared drip per `(context, grip)`)
  - `children: WeakSet<GripContextNode>` (downward edges; maintained by engine)
  - `parents: ReadonlyArray<{ node: GripContextNode; priority: number }>` (upward edges)
  - `lastSeen: number` (for GC)
- Engine-level (optional for sharing multi-output producers): `producerRegistry` keyed by `(tapId, parameterSignature)`

- Notes:
- `resolvedMap` stores only the chosen provider GripContext for the associated Grip (not the produced drip). A tap's production uses parameters resolved from the destination (consumer) context. Therefore, within a given destination context, all consumers of that Grip share the same provider context and the same single, engine-owned drip. Different destination contexts may bind to the same tap but with different parameters (because their context parameters differ).
- A future evolution can keep a light "selection-only cache" distinct from "active binding cache". For now, we remove the `resolvedMap` entry on last consumer.

### 5. Resolution algorithm (Consumer Grip + Context)

Input: `(ctx, grip)`

1) If `resolvedMap(ctx)` has an entry for `grip`, return that tap.
2) If `localProviders(ctx)` has a tap for `grip`, select it, set `resolvedMap(ctx, grip)`, return it.
3) Otherwise, traverse parents in priority order, depth-first. For each parent `p`, recursively resolve `(p, grip)`; the first successful result is selected; set `resolvedMap(ctx, grip)` and return it.
4) If no tap is found up to the root (default), return the grip's default value (no `resolvedMap` entry or mark as `isDefault` if you choose to cache defaults).

Selection policy: proximity-only for now (closest provider wins). A future query matcher can refine this policy.

### 6. Tap registration algorithm (add Tap at node A)

Given tap `T` provides set `G` at node `A`, update descendants efficiently.

- Maintain traversal state:
  - `availableGrips`: start as `G`.
  - `visited: Map<NodeId, GripSubsetKey>` to avoid revisiting a node with the same (or a superset) of grips.
- Traverse children (priority-respecting order if needed). At each node `N`:
  1) Compute `closer = localProviders(N) ∩ availableGrips`. If non-empty, `availableGrips -= closer` (grips overshadowed at/under `N`). If `availableGrips` becomes empty, prune this branch.
  2) For each `g ∈ availableGrips`, run the Consumer Resolution at `N`. If selected tap is `T` (originating at `A`), set `resolvedMap(N, g) = T`.
  3) Descend into children with the (possibly reduced) `availableGrips`.
- Always consult `visited` keyed by `(node, frozenset(availableGrips))` to prevent exponential revisits.

### 7. Tap removal algorithm (remove Tap from node A)

Mirror of add:

- Traverse children with `gripsToRemove = G`.
- At each node `N`:
  - If `resolvedMap(N, g) == T` for any `g`, clear that mapping and re-run Consumer Resolution at `N` to find the next best (a different ancestor or default). Update `resolvedMap` accordingly.
  - If `localProviders(N)` provides any of `g`, then those grips are overshadowed here and below; exclude them from `gripsToRemove` before descending.
  - Continue into children with the remaining grips to remove.

### 8. Parameter grips and invalidation

- A tap may declare `parameterGrips`. When a tap is selected for `(ctx, grip)`, subscribe to override changes for those parameter grips at `ctx` (and for a direct override of `grip` itself). On change, evict `resolvedMap(ctx, grip)` and allow the next query to re-resolve.
- Parameter drip semantics: a tap may bind to a parameter drip and internally switch produced values without a mapping change. Mapping changes occur only when parameters cause a different tap to be selected.
- Parent-provided parameters: for now, observe only local override changes at `ctx` (simple and avoids excessive subscriptions). A later enhancement can subscribe along the actual resolution lineage returned by parameter resolution.

### 9. Consumer lifecycle and mapping retention

- On first consumer for `(ctx, grip)`, ensure `resolvedMap(ctx, grip)` exists (resolving if needed) and create or reuse the single shared drip in `dripByGrip`.
- On last consumer removal, release the shared drip and remove `resolvedMap(ctx, grip)` if desired. Multiple `useGrip` calls in the same context share the same drip.
- On context disposal, delete all `resolvedMap` entries for that context.

### 9.1 Tap destination index (per-tap)

Each tap maintains a destination index to enable fast delivery without re-resolution. We use `GripContextNode` as the key (not raw `GripContext`) so liveness/GC is centralized in the engine's proxy node.

- `destinationIndex: Map<GripContextNode, { grips: Set<Grip>; sinksByGrip: Map<Grip, (value: any) => void> }>`
  - `grips`: which grips from this tap are currently connected for that destination node
  - `sinksByGrip`: the engine-owned sink functions per grip, used to push values into the shared drips
- Optional reverse index: `byGrip: Map<Grip, Set<GripContextNode>>` for fast fan-out per grip

Why track a Set<Grip> per node?
- A single tap can provide multiple grips, and a single destination context may be consuming any subset of them. The `Set<Grip>` is the minimal bookkeeping to know which outputs are active for that node (e.g., push only those, and disconnect them precisely).
- In practice, taps will almost always also keep `sinksByGrip` so they can call `sink(value)` without recomputing or looking up engine state.

Delivery and deferred cleanup:
- During producer updates, a tap iterates `destinationIndex`. If a node's `contextRef.deref()` is missing or the node is marked disposed, the tap should skip it and enqueue the node for cleanup (do not mutate the map while iterating). After the pass (e.g., `queueMicrotask`), remove those nodes and invoke `onDisconnect` for the recorded grips.
- The engine's periodic GC and/or explicit `disposeContext` will also prune nodes; taps may receive disconnect callbacks accordingly and should prune `destinationIndex`.

The engine calls connection callbacks to keep this index in sync (see API below).

#### Engine → Tap connection API (sketch)

- `onConnect(ctxNode: GripContextNode, grip: Grip<any>, sink: (value: any) => void, helpers: { queryParam: <T>(g: Grip<T>) => T | Drip<T>; requestedGrips?: ReadonlySet<Grip<any>> })`
  - Called when `(destination ctx, grip)` first maps to this tap and the first consumer appears
  - Tap updates `destinationIndex` (add `grip` to the node's set and record `sink`)
  - Tap reads parameters from the destination context (via `helpers`) and may start per-destination work
- `onDisconnect(ctxNode: GripContextNode, grip: Grip<any>)`
  - Called when the last consumer for `(destination ctx, grip)` unsubscribes or mapping changes away
  - Tap removes `grip` for that node; if the node has no more grips, remove the node entry
- Optional `onActivate()`/`onDeactivate()` for global lifecycle (first/last connection across all destinations)

### 10. Errors and edge cases

- Duplicate registration in the same context for the same grip is an error.
- Multi-output taps overlapping with other taps: handled per grip; overshadowing and resolution apply grip-by-grip.
- Multiple parents: respect parent priority during upward resolution. During downward propagation (add/remove), maintain a `visited` keyed by `(node, grip subset)` to avoid revisiting with the same set.
- Parameter changes that switch the selected tap: ensure the engine detaches the old binding and attaches the new one cleanly.

### 11. Generic DAG traverser (utility)

Provide a reusable traverser for add/remove operations:

```ts
interface DagNode { id: string }
interface DagAdapter<N extends DagNode> {
  getChildren(node: N): readonly N[];
  // Optional: getParents(node: N): readonly N[]; // for upward resolution
}

type GripSet = ReadonlySet<Grip<any>>;

interface TraversalState {
  availableGrips: GripSet;
}

class DagTraverser<N extends DagNode, S extends TraversalState> {
  constructor(private adapter: DagAdapter<N>) {}
  walk(start: N, init: S, visit: (node: N, state: S) => S | null): void {
    // Depth-first with (node, gripSubsetKey) visited guard and state push/pop semantics
  }
}
```

The `visit` callback can implement the overshadowing subtraction and the re-resolution checks required by add/remove.

### 11.1. DagNode ↔ GripContext relationship

- `GripContextNode` is the engine's proxy for a `GripContext` and stores:
  - A `WeakRef<GripContext>` so nodes do not keep contexts alive
  - Back-references to parents and children nodes to support traversals
  - Per-node runtime data (`localProviders`, `resolvedMap`, `dripByGrip`)
- Parents hold only weak references to children through `children: WeakSet<GripContextNode>` so GC can reap nodes when the corresponding `GripContext` is unreachable. The engine's periodic GC pass (or explicit `disposeContext`) prunes nodes with a dead context and no shared drips.

This design lets us traverse and manage connections robustly while respecting the requirement that application-held contexts are not strongly referenced by the engine.

### 12. Complexity & performance

- Upward resolution is O(P) in number of parents along the resolved lineage (usually small).
- Downward propagation during add/remove is pruned aggressively by overshadowing and visited-by-grip-subset.
- Mapping cache is per-context/per-grip and removed on last consumer, bounding steady-state size to active consumers.

### 13. Test plan

- Upward resolution: simple chain; diamond with priorities; missing providers → default.
- Add tap: mid-tree registration with overshadowing at some descendants; ensure only correct contexts map to new tap.
- Remove tap: re-maps to next provider or default; overshadowed descendants unaffected.
- Multi-output tap: add/remove with subset overshadowed by locals; verify per-grip mapping.
- Parameter drips: changing parameter triggers mapping eviction/re-resolution; provider switch is applied.
- No revisits: ensure visited guard by `(node, grip subset)` prevents redundant work.



