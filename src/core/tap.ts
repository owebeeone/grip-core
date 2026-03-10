/**
 * GRIP Tap System - Data producers for reactive dataflow
 *
 * Taps are data producers that provide one or more Grips to the GRIP system.
 * They represent the source end of the data pipeline, generating values that
 * flow to consumer Drips through the GROK orchestration engine.
 *
 * Key concepts:
 * - Taps advertise which Grips they can provide
 * - Taps can declare parameter dependencies for dynamic behavior
 * - Taps have lifecycle hooks for connection management
 * - Taps can be factories for lazy instantiation
 * - Taps support both single and multi-output scenarios
 */

import { Grip } from "./grip";
import { GripContext } from "./context";
import { Drip } from "./drip";
import type { Grok } from "./grok";
import type { GripContextLike } from "./context";

export type TapExecutionMode = "replicated" | "origin-primary" | "negotiated-primary";
export type TapExecutionRole = "primary" | "follower";

export interface SharedProjectionTapSpec {
  tap_id: string;
  tap_type: string;
  home_path: string;
  mode: TapExecutionMode | string;
  role?: TapExecutionRole | string;
  provides: string[];
  home_param_grips?: string[];
  destination_param_grips?: string[];
  purpose?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Tap represents a data producer that can provide one or more Grips.
 *
 * Taps are the source end of the GRIP data pipeline. They generate values
 * for specific Grips and are automatically connected to consumer Drips by
 * the GROK engine based on context hierarchy and resolution rules.
 *
 * Taps can declare parameter dependencies that influence their behavior:
 * - Destination parameters: Read from the destination context lineage
 * - Home parameters: Read from the provider's home context lineage
 *
 * The engine manages the lifecycle of Taps, calling appropriate hooks
 * when they are attached, connected, or disconnected.
 */
export interface Tap {
  readonly kind: "Tap";
  readonly id?: string;

  /** The Grips this Tap can provide */
  provides: readonly Grip<any>[];

  /** Parameters read from the destination context lineage (affect a single destination) */
  destinationParamGrips?: readonly Grip<any>[];

  /** Parameters read from the home (provider) context lineage (affect all destinations under the provider) */
  homeParamGrips?: readonly Grip<any>[];

  /** Returns how this tap should execute across replicas. */
  getExecutionMode(): TapExecutionMode;

  /** Returns the local runtime role for this tap. */
  getExecutionRole(): TapExecutionRole;

  /** Updates the local runtime role for this tap. */
  setExecutionRole(role: TapExecutionRole): void;

  /**
   * Called when the Tap is attached to a home context.
   *
   * This is the primary lifecycle hook for Tap initialization. The Tap
   * can perform setup operations, register with external systems, or
   * initialize internal state.
   *
   * @param home - The home context where this Tap is being attached
   */
  onAttach?(home: GripContext | GripContextLike): void;

  /**
   * Called when the Tap is detached from its home context.
   *
   * This hook allows the Tap to perform cleanup operations, unregister
   * from external systems, or release resources.
   */
  onDetach?(): void;

  /**
   * Returns the home context where this Tap is attached.
   *
   * @returns The home context or undefined if not attached
   */
  getHomeContext(): GripContext | undefined;

  /**
   * Returns the context used for parameter resolution.
   *
   * @returns The parameter context or undefined if not available
   */
  getParamsContext(): GripContext | undefined;

  /**
   * Called when a destination context connects to a Grip provided by this Tap.
   *
   * This hook allows the Tap to track destination connections and potentially
   * optimize its behavior based on the specific destination context.
   *
   * @param dest - The destination context that is connecting
   * @param grip - The specific Grip being consumed
   */
  onConnect?(dest: GripContext, grip: Grip<any>): void;

  /**
   * Called when a destination context disconnects from a Grip provided by this Tap.
   *
   * This hook allows the Tap to clean up destination-specific state or
   * optimize its behavior when destinations are removed.
   *
   * @param dest - The destination context that is disconnecting
   * @param grip - The specific Grip being unsubscribed from
   */
  onDisconnect?(dest: GripContext, grip: Grip<any>): void;

  /**
   * Produces values for the current state.
   *
   * This is the main method for generating and publishing values. If a
   * destination context is provided, the Tap may optimize to produce
   * updates only for that specific destination.
   *
   * @param opts - Options for production
   * @param opts.destContext - Optional specific destination context to produce for
   */
  produce(opts?: { destContext?: GripContext }): void;

  /**
   * Called when a home parameter Grip has changed.
   *
   * This allows the Tap to react to changes in parameters that affect
   * all destinations under this provider.
   *
   * @param paramGrip - The parameter Grip that changed
   */
  produceOnParams?(paramGrip: Grip<any>): void;

  /**
   * Called when a destination parameter Grip has changed.
   *
   * This allows the Tap to react to changes in parameters that affect
   * only a specific destination context.
   *
   * @param destContext - The destination context (or undefined for all destinations)
   * @param paramGrip - The parameter Grip that changed
   */
  produceOnDestParams?(destContext: GripContext | undefined, paramGrip: Grip<any>): void;

  /**
   * Optional factory function to create a destination-specific context.
   * Called once when a Destination is first created for this tap.
   *
   * This allows Taps to manage per-destination state and resources without
   * relying on WeakMaps keyed by GripContext. The returned context receives
   * lifecycle callbacks when Grips are added/removed and when the destination
   * is detached.
   *
   * @param destination - The Destination instance being created
   * @returns A TapDestinationContext instance, or undefined if not needed
   */
  createDestinationContext?(destination: import("./graph").Destination): import("./graph").TapDestinationContext | undefined;

  /**
   * Returns persisted grip values owned by this tap.
   *
   * Local persistence uses this to capture stateful tap values without
   * requiring active consumer drips.
   */
  getPersistedGripValues?(): ReadonlyMap<Grip<any>, unknown>;

  /**
   * Restores a previously persisted grip value owned by this tap.
   *
   * Returns `true` when the tap consumed the value and no fallback drip
   * restore is required.
   */
  restorePersistedGripValue?(grip: Grip<any>, value: unknown): boolean | void;
}

export interface SharedValueTap extends Tap {
  setSharedGripValue?(grip: Grip<any>, value: unknown): boolean | void;
}

export interface TapMaterializationRegistry {
  materializeTap(grok: Grok, spec: SharedProjectionTapSpec): Tap;
}

/**
 * A factory for creating Taps on demand.
 *
 * TapFactories enable lazy instantiation of Taps. They are only instantiated
 * if the query resolution process determines they are the best match for
 * a requested Grip. This is useful for expensive Taps or Taps that require
 * dynamic configuration.
 *
 * The factory must advertise which Grips it can provide so that the
 * resolution system can determine if it's a candidate for selection.
 */
export interface TapFactory {
  readonly kind: "TapFactory";

  /** Optional human-readable label for debugging and identification */
  label?: string;

  /** The Grips that the Tap created by this factory can provide */
  provides: readonly Grip<any>[];

  /**
   * Creates and returns a new Tap instance.
   *
   * This method is called by the engine when the factory is selected
   * as the best provider for a requested Grip.
   *
   * @returns A new Tap instance
   */
  build(): Tap;
}

/**
 * Optional interface for producers that can be activated and deactivated.
 *
 * This interface provides lifecycle hooks for Taps that need to manage
 * resources or external connections. The engine calls these methods
 * when the first consumer connects or the last consumer disconnects.
 */
export interface ActivatableProducer {
  /**
   * Called when the producer should become active.
   *
   * @param requestedGrips - Optional set of Grips that triggered activation
   */
  activate?(requestedGrips?: ReadonlySet<Grip<any>>): void;

  /**
   * Called when the producer should become inactive.
   *
   * This allows the producer to release resources, close connections,
   * or perform other cleanup operations.
   */
  deactivate?(): void;
}

/**
 * Optional interface for Taps that can provide controller objects.
 *
 * This interface extends Tap to support scenarios where the Tap needs
 * to provide both a Drip (for reading values) and a controller (for
 * writing values or controlling behavior).
 *
 * @template TDrip - The type of the Drip
 * @template TController - The type of the controller
 */
export interface TapWithController<TDrip = any, TController = any> extends Tap {
  /**
   * Produces both a Drip and a controller for the specified Grip.
   *
   * @param grip - The Grip to produce for
   * @param ctx - The context where the production is happening
   * @param grok - The GROK engine instance
   * @returns An object containing both the Drip and controller
   */
  produceWithController?<T>(
    grip: Grip<T>,
    ctx: GripContext,
    grok: Grok,
  ): { drip: Drip<T>; controller: TController };
}
