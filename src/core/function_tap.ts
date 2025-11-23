/**
 * GRIP Function Tap System - Data transformation through compute functions
 *
 * FunctionTap provides a flexible way to transform data by applying compute functions
 * that can read from multiple parameter sources and maintain optional state. Unlike
 * AtomValueTap which stores simple values, FunctionTap transforms inputs into outputs
 * through user-defined computation logic.
 *
 * Key features:
 * - Compute functions that transform inputs to outputs
 * - Support for home parameters (from tap's home context)
 * - Support for destination parameters (from consumer contexts)
 * - Optional state management for stateful transformations
 * - Type-safe parameter and output handling
 * - Handle Grips for exposing state management APIs
 *
 * Use cases:
 * - Unit conversions (metric to imperial)
 * - Data formatting and transformation
 * - Mapping between different Grip sets
 * - Stateful computations that depend on multiple inputs
 */

import { Grip } from "./grip";
import { GripContext } from "./context";
import type { Tap } from "./tap";
import { BaseTap } from "./base_tap";

// Type helpers for type-safe grips
/**
 * Type helper for creating a record of Grips with string keys.
 * Used to define collections of related Grips in a type-safe manner.
 */
export type GripRecord = Record<string, Grip<any>>;

/**
 * Type helper that extracts the value type from a Grip.
 *
 * @template G - The Grip type to extract the value type from
 * @returns The value type that the Grip provides
 */
export type GripValue<G extends Grip<any>> = G extends Grip<infer T> ? T : never;

/**
 * Type helper that extracts all value types from a GripRecord.
 *
 * @template R - The GripRecord to extract value types from
 * @returns Union of all value types in the record
 */
export type Values<R extends GripRecord> = R[keyof R];
// Narrowed result typing for compute() return
export type OutputKey<Outs extends GripRecord> = Values<Outs>;
export type StateKey<StateRec extends GripRecord> = Values<StateRec>;
export type OutputVal<Outs extends GripRecord> = GripValue<Values<Outs>>;
export type StateVal<StateRec extends GripRecord> = GripValue<Values<StateRec>>;
export type ComputeResultMap<Outs extends GripRecord, StateRec extends GripRecord> = Map<
  OutputKey<Outs> | StateKey<StateRec>,
  OutputVal<Outs> | StateVal<StateRec>
>;

/**
 * Controller interface for managing FunctionTap state.
 *
 * Provides get/set APIs for accessing and modifying the internal state
 * of a FunctionTap. This interface is exposed through optional handle Grips,
 * allowing clients to manage state directly.
 *
 * @template StateRec - Record type defining the state Grips managed by this tap
 */
export interface FunctionTapHandle<StateRec extends GripRecord> {
  /**
   * Gets the current state value for a specific Grip.
   *
   * @param grip - The state Grip to get the value for
   * @returns The current state value or undefined if not set
   */
  getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined;

  /**
   * Sets the state value for a specific Grip.
   *
   * @param grip - The state Grip to set the value for
   * @param value - The new state value
   */
  setState: <K extends keyof StateRec>(
    grip: StateRec[K],
    value: GripValue<StateRec[K]> | undefined,
  ) => void;
}

/**
 * Compute function that transforms inputs into outputs.
 *
 * This function is called whenever any input parameters change and is responsible
 * for computing the output values based on the current state of all inputs.
 *
 * The function receives:
 * - dest: The destination context (consumer context)
 * - getHomeParam: Function to read home parameters (from tap's home context)
 * - getDestParam: Function to read destination parameters (from consumer context)
 * - getState: Function to read internal state values
 *
 * @template Outs - Record type defining the output Grips this tap provides
 * @template Home - Record type defining the home parameter Grips
 * @template Dest - Record type defining the destination parameter Grips
 * @template StateRec - Record type defining the state Grips
 */
export type ComputeFn<
  Outs extends GripRecord,
  Home extends GripRecord,
  Dest extends GripRecord,
  StateRec extends GripRecord,
> = (args: {
  /** The destination context (consumer context) making the request */
  dest?: GripContext;

  /** Function to read home parameters from the tap's home context */
  getHomeParam: <K extends keyof Home>(grip: Home[K]) => GripValue<Home[K]> | undefined;

  /** Function to read destination parameters from the consumer context */
  getDestParam: <K extends keyof Dest>(
    grip: Dest[K],
    dest?: GripContext,
  ) => GripValue<Dest[K]> | undefined;

  /** Function to read internal state values */
  getState: <K extends keyof StateRec>(grip: StateRec[K]) => GripValue<StateRec[K]> | undefined;
}) => ComputeResultMap<Outs, StateRec>;

/**
 * Configuration for creating a FunctionTap.
 *
 * Defines all the parameters, outputs, and behavior of a FunctionTap instance.
 *
 * @template Outs - Record type defining the output Grips this tap provides
 * @template Home - Record type defining the home parameter Grips
 * @template Dest - Record type defining the destination parameter Grips
 * @template StateRec - Record type defining the state Grips
 */
export interface FunctionTapConfig<
  Outs extends GripRecord,
  Home extends GripRecord = {},
  Dest extends GripRecord = {},
  StateRec extends GripRecord = {},
> {
  /** The Grips this tap will provide as outputs */
  provides: ReadonlyArray<Values<Outs>>;

  /** Grips to read from destination contexts (consumer contexts) */
  destinationParamGrips?: ReadonlyArray<Values<Dest>>;

  /** Grips to read from the tap's home context */
  homeParamGrips?: ReadonlyArray<Values<Home>>;

  /** Optional Grip for exposing the state management handle */
  handleGrip?: Grip<FunctionTapHandle<StateRec>>;

  /**
   * Grips that represent state keys. When present in the compute() result map,
   * their values are applied to internal state instead of being published.
   * If omitted, keys present in initialState are treated as state by default.
   */
  stateGrips?: ReadonlyArray<Values<StateRec>>;

  /** Initial state values if the tap needs to be stateful */
  initialState?: ReadonlyArray<[Grip<any>, any]> | ReadonlyMap<Grip<any>, any>;

  /** The compute function that transforms inputs to outputs */
  compute: ComputeFn<Outs, Home, Dest, StateRec>;
}

/**
 * A flexible tap that computes outputs based on destination and home parameters,
 * plus optional local state. The compute() function is invoked whenever any
 * subscribed parameter or local state changes.
 */
export class FunctionTap<
    Outs extends GripRecord,
    Home extends GripRecord = {},
    Dest extends GripRecord = {},
    StateRec extends GripRecord = {},
  >
  extends BaseTap
  implements FunctionTapHandle<StateRec>
{
  protected readonly computeFn: ComputeFn<Outs, Home, Dest, StateRec>;
  readonly handleGrip?: Grip<FunctionTapHandle<StateRec>>;
  readonly state = new Map<Grip<any>, any>();
  private readonly stateGripSet: Set<Grip<any>>;
  // Subscriptions for home param drips
  private homeParamUnsubs: Array<() => void> = [];

  constructor(config: FunctionTapConfig<Outs, Home, Dest, StateRec>) {
    super({
      provides: (config.handleGrip
        ? [...config.provides, config.handleGrip]
        : config.provides) as unknown as readonly Grip<any>[],
      destinationParamGrips: config.destinationParamGrips as unknown as readonly Grip<any>[],
      homeParamGrips: config.homeParamGrips as unknown as readonly Grip<any>[],
    });
    this.computeFn = config.compute;
    this.handleGrip = config.handleGrip as unknown as Grip<FunctionTapHandle<StateRec>> | undefined;
    // Build state grip set from explicit stateGrips and/or keys from initialState.
    const stateSet = new Set<Grip<any>>(
      (config.stateGrips as unknown as ReadonlyArray<Grip<any>> | undefined) ?? [],
    );
    if (config.initialState) {
      const it = Array.isArray(config.initialState)
        ? config.initialState
        : Array.from((config.initialState as ReadonlyMap<Grip<any>, any>).keys()).map(
            (g) => [g, undefined] as [Grip<any>, any],
          );
      for (const [g] of it) stateSet.add(g);
    }
    this.stateGripSet = stateSet;
    if (config.initialState) {
      const it = Array.isArray(config.initialState)
        ? config.initialState
        : Array.from((config.initialState as ReadonlyMap<Grip<any>, any>).entries());
      for (const [g, v] of it) this.state.set(g, v);
    }
  }

  // Handle API
  getState<K extends keyof StateRec>(grip: StateRec[K]): GripValue<StateRec[K]> | undefined {
    return this.state.get(grip as unknown as Grip<any>) as GripValue<StateRec[K]> | undefined;
  }
  setState<K extends keyof StateRec>(
    grip: StateRec[K],
    value: GripValue<StateRec[K]> | undefined,
  ): void {
    const prev = this.state.get(grip as unknown as Grip<any>);
    if (prev === value) return;
    this.state.set(grip as unknown as Grip<any>, value);
    this.produce();
  }

  // Wire up home param subscriptions in addition to BaseTap destination param handling
  onAttach(home: GripContext): void {
    super.onAttach(home);
    // Subscribe to homeParamGrips (if any) at the home context lineage
    if (this.homeParamGrips && this.homeParamGrips.length > 0) {
      for (const g of this.homeParamGrips) {
        const d = home.getOrCreateConsumer(g);
        // Ensure resolution to a provider for the home parameter
        home.getGrok().resolver.addConsumer(home, g as unknown as Grip<any>);
        const unsub = d.subscribe(() => {
          this.produce();
        });
        this.homeParamUnsubs.push(unsub);
      }
    }
  }

  onDetach(): void {
    try {
      for (const u of this.homeParamUnsubs) u();
    } finally {
      this.homeParamUnsubs = [];
      super.onDetach();
    }
  }

  private computeFor(dest?: GripContext): Map<Grip<any>, any> {
    const getHomeParam = <K extends keyof Home>(g: Home[K]) =>
      this.homeContext?.getOrCreateConsumer(g as unknown as Grip<any>).get() as
        | GripValue<Home[K]>
        | undefined;
    const getDestParam = <K extends keyof Dest>(g: Dest[K], d?: GripContext) =>
      (d ?? dest ?? this.homeContext)?.getOrCreateConsumer(g as unknown as Grip<any>).get() as
        | GripValue<Dest[K]>
        | undefined;
    const getState = <K extends keyof StateRec>(g: StateRec[K]) =>
      this.state.get(g as unknown as Grip<any>) as GripValue<StateRec[K]> | undefined;
    const typedResult = this.computeFn({ dest, getHomeParam, getDestParam, getState });
    // Split outputs vs state and apply state updates post-compute (no re-entrancy)
    const result = new Map<Grip<any>, any>();
    const pendingState: Array<[Grip<any>, any]> = [];
    for (const [grip, value] of typedResult) {
      const g = grip as unknown as Grip<any>;
      if (this.stateGripSet.has(g)) pendingState.push([g, value]);
      else result.set(g, value);
    }
    if (pendingState.length) {
      for (const [g, v] of pendingState) {
        const prev = this.state.get(g);
        if (prev !== v) this.state.set(g, v);
      }
    }
    if (this.handleGrip) {
      result.set(this.handleGrip as unknown as Grip<any>, this as FunctionTapHandle<StateRec>);
    }
    return result;
  }

  // Publish current state for all known destinations or a specific one
  produce(opts?: { destContext?: GripContext }): void {
    if (opts?.destContext) {
      const updates = this.computeFor(opts.destContext);
      this.publish(updates, opts.destContext);
      return;
    }
    // Publish to all destinations for this producer
    const destinations = Array.from(this.producer?.getDestinations().keys() ?? []);
    if (destinations.length === 0) return;
    for (const destNode of destinations) {
      const destCtx = destNode.get_context();
      if (!destCtx) continue;
      const updates = this.computeFor(destCtx);
      this.publish(updates, destCtx);
    }
  }

  // Home param changed
  produceOnParams(): void {
    this.produce();
  }

  // Destination parameter changed for a specific destination
  produceOnDestParams(destContext: GripContext | undefined): void {
    this.produce({ destContext });
  }
}

/**
 * Factory function to create a new FunctionTap instance.
 *
 * @template Outs - Record type defining the output Grips this tap provides
 * @template Home - Record type defining the home parameter Grips
 * @template Dest - Record type defining the destination parameter Grips
 * @template StateRec - Record type defining the state Grips
 * @param config - Configuration object for the FunctionTap
 * @returns A new FunctionTap instance
 */
export function createFunctionTap<
  Outs extends GripRecord,
  Home extends GripRecord = {},
  Dest extends GripRecord = {},
  StateRec extends GripRecord = {},
>(config: FunctionTapConfig<Outs, Home, Dest, StateRec>): FunctionTap<Outs, Home, Dest, StateRec> {
  return new FunctionTap<Outs, Home, Dest, StateRec>(config);
}
