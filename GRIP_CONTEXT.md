### GRIP Contexts, Parameter Topologies, and Transform Taps

This document specifies context container types and parameter semantics for taps. It introduces two parameter categories on taps, home-vs-destination context semantics, and a dual-context container to enable transform taps (e.g., unit conversion) that listen in one subtree and emit in another.

## Goals
- Separate where a tap LISTENS for its input parameters from where it PRESENTS its outputs.
- Support transform taps that read one or more grips and re-emit (possibly the same) grips after transformation.
- Provide a dual-context container to cleanly model "read inputs from parent, emit outputs to a child".
- Ensure lifecycle correctness: taps must de-register when their home context is reaped; no strong refs that block GC.

## Terminology
- Home Context: The context where a tap is registered (its attachment point). Taps must only strongly reference their home context node identity (e.g., id) and use WeakRef when needed for GC safety.
- Destination Context: The context that consumes the tap's outputs (the context used in a query).
- Destination Parameter Grips: Grips whose values are read from the destination context lineage; changes should invalidate/reproduce outputs for only that destination.
- Home Parameter Grips: Grips whose values are read from the home context lineage; changes should invalidate/reproduce outputs for ALL destination contexts attached to the same home provider.

## Context Container Types
1) SingleContextContainer (status quo)
   - A single `GripContext` acts as both home and destination.
   - Default case for most taps where parameters and outputs live in the same subtree.

2) DualContextContainer (Parent→Child)
   - A container with two contexts: `home` (parent) and `dest` (child). The tap reads "homeParamGrips" from `home`, and presents outputs (for the grips it provides) into `dest`.
   - Intended for transform taps (e.g., unit conversion) where inputs (including a mode like metric/imperial) live one level up, and outputs are materialized in a controlled child context.
   - API sketch (engine):
     - `grok.createDualContext(opts?): { home: GripContext, dest: GripContext }`
       - Creates `dest` as `home.createChild(...)` with optional initial overrides.
     - React convenience: `useDualContext(parent?: GripContext, init?: Init[])`.

## Tap API Changes
- Rename `parameterGrips` → `destinationParamGrips`.
- Add `homeParamGrips?: readonly Grip<any>[]`.

```ts
interface Tap {
  id: string;
  provides: readonly Grip<any>[];
  destinationParamGrips?: readonly Grip<any>[]; // read from destination context lineage
  homeParamGrips?: readonly Grip<any>[];        // read from home context lineage
  produce<T>(grip: Grip<T>, ctx: GripContext, grok: Grok): Drip<T>;
}
```

Semantics
- Registration (`registerTapAt(homeCtx, tap)`) defines the tap's home context.
- On query for a grip at a destination context, the resolver chooses the closest provider (as today). That provider's "home context" determines which `homeParamGrips` to read.
- Engine subscribes to `destinationParamGrips` in the destination context and invalidates only that (tap, destCtx, grip) mapping on change.
- Engine subscribes to `homeParamGrips` in the home context and invalidates all (tap, anyDestCtxUnderHome, grips provided by tap) mappings on change.

## Transform Taps
Example: A metric/imperial converter that reads an input grip and re-emits the same grip with converted units, controlled by a `UNIT_SYSTEM` parameter.

- Register converter at some `home` context.
- `homeParamGrips: [UNIT_SYSTEM]` so a change at `home` flips all children using converter.
- `destinationParamGrips`: typically the input data grip(s) when supplied as drips in the destination lineage; changing those only affects the local destination.
- Use a DualContextContainer where consumption happens at `dest` (child), but converter listens to `UNIT_SYSTEM` at `home`.

Sketch
```ts
const UNIT_SYSTEM = defineGrip<'metric'|'imperial'>("UnitSystem", 'metric');
const SPEED = defineGrip<number>("SpeedKph", 0);

const ConverterTap: Tap = {
  id: 'unit-converter',
  provides: [SPEED],
  homeParamGrips: [UNIT_SYSTEM],
  destinationParamGrips: [],
  produce: (grip, destCtx, grok) => {
    // read home param from provider home context lineage (engine supplies)
    // read source drip at destination if present; emit converted drip
    // engine wires invalidation across home/destination parameter sources
    return new Drip<number>(0) as any;
  },
};
```

## Engine/Resolver Integration
- Registration:
  - `registerTapAt(homeCtx, tap)` indexes tap under `homeCtx` and registers its `provides` with resolver at `homeCtx` (closest provider semantics unchanged).
- Query:
  - Resolver picks provider context id `providerCtxId` for the requested `(destCtx, grip)`.
  - Engine picks the tap registered at `providerCtxId` that provides `grip`.
  - For cache keying and invalidation, engine tracks `(tapId, grip.key, destCtx.id)` → drip.
  - Destination params: subscribe in `destCtx` to declared drips/values; evict only this `(tap, grip, destCtx)` mapping on change.
  - Home params: subscribe in `providerCtx` (home). On change, evict all `(tap, anyGripProvided, anyDestUnderHome)` cache entries. Efficiently tracked via per-tap destination index:
    - `Map<providerCtxId, { grips: Set<GripKey>, destsByGrip: Map<GripKey, Set<destCtxId>> }>`.

## Drip Lifecycle and GC
- Per tap, outputs are tracked per destination context. Use weak references for destination drips; cleanup on `onZeroSubscribers` and/or when resolver mapping changes.
- Taps must keep only the provider context id (string) and use WeakRef for any stored home `GripContext`. The engine (or graph) owns the hard references.
- When a home context is reaped (graph's WeakRef to `GripContext` is dead), engine clears all indices for that provider id and unsubscribes from homeParamGrips.

## DualContextContainer API
Engine API proposal
```ts
type DualContext = { home: GripContext; dest: GripContext };
grok.createDualContext(opts?: {
  idPrefix?: string;
  homeParent?: GripContext;   // default: grok.mainContext
  destPriority?: number;       // parent→child priority for dest
  initDest?: Array<{ grip: Grip<any>, value?: any, drip?: Drip<any> }>
}): DualContext;
```

React hooks
```ts
function useDualContext(parent?: GripContext, initDest?: Init[]): DualContext
```

Query semantics
- `useGrip(grip, dual.dest)` reads outputs from `dest`.
- Taps registered at `dual.home` read `homeParamGrips` from `dual.home` lineage; `destinationParamGrips` are read from `dual.dest` lineage.

## Migration Plan
1) Introduce `destinationParamGrips` and `homeParamGrips` on `Tap`. Keep `parameterGrips` as deprecated alias for a short period (tests updated first).
2) Add per-tap destination index and home/destination param subscriptions to engine; implement precise invalidation.
3) Add `createDualContext` + `useDualContext`; wire resolver parent links upon creation (avoid doing it inside query).
4) Refactor `GripContext` to `BaseGripContext` internally; public API type remains `GripContext`. Introduce a thin `ContextContainer` type for dual contexts (does not change existing `GripContext` usage).
5) Add tests: transform tap (converter), dual-context overshadowing, home vs destination param invalidations, GC of home context triggers cleanup.

## Notes
- Overshadowing remains proximity-based via resolver; destinations always resolve to the nearest provider.
- Transform taps that re-emit the same grip must be careful to avoid feedback loops; engines can enforce a simple guard (e.g., produced drip identity differs from any source drip discovered via parameters).



