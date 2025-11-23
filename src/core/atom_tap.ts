/**
 * GRIP Atom Tap System - Simple value containers for reactive state management
 *
 * Atom Taps provide a simple, atom-style approach to managing values in the GRIP system.
 * They act as both Taps (data producers) and controllers (for updating values), making
 * them ideal for local state management, form inputs, and simple data sources.
 *
 * Key features:
 * - Single-value and multi-value atom containers
 * - Built-in get/set/update APIs for value manipulation
 * - Automatic value change notifications to subscribers
 * - Optional handle Grips for exposing controller interfaces
 * - Type-safe value management with TypeScript generics
 */

import { Grip } from "./grip";
import { GripContext } from "./context";
import type { Tap } from "./tap";
import { BaseTapNoParams } from "./base_tap";

/**
 * Controller interface for atom-style value management.
 *
 * Provides a simple get/set/update API for manipulating atom values.
 * This interface is exposed through optional handle Grips, allowing
 * components to both read values (via Drips) and write values (via controllers).
 *
 * @template T - The type of value managed by this atom
 */
export interface AtomTapHandle<T> {
  /** Returns the current value of the atom */
  get: () => T;

  /** Sets the atom to a new value, triggering notifications if changed */
  set(value: T): void;

  /** Updates the atom value using a function that receives the previous value */
  update(updater: (prev: T) => T): void;
}

// Public alias for ergonomics in app code
export type AtomTap<T> = AtomTapHandle<T>;

/**
 * A simple atom-style Tap that contains its own value and publishes updates.
 *
 * AtomValueTap combines the functionality of a Tap (data producer) with
 * atom-style value management. It maintains an internal value and automatically
 * publishes updates when the value changes, making it ideal for local state
 * management scenarios.
 *
 * The Tap can optionally expose a handle Grip that provides access to the
 * controller interface, allowing components to both read and write values.
 *
 * @template T - The type of value managed by this atom
 */
export class AtomValueTap<T> extends BaseTapNoParams implements AtomTap<T>, Tap {
  /** Current value stored in the atom */
  private currentValue: T;

  /** The Grip that provides the value */
  private valueGrip: Grip<T>;

  /** Optional Grip that provides the controller handle */
  private handleGrip: Grip<AtomTapHandle<T>> | undefined;

  /** Set of listeners to notify when the value changes */
  private listeners = new Set<() => void>();

  /**
   * Creates a new AtomValueTap instance.
   *
   * @param grip - The Grip that this atom provides
   * @param initial - Initial value for the atom
   * @param opts - Optional configuration
   * @param opts.handleGrip - Optional Grip for exposing the controller interface
   */
  constructor(grip: Grip<T>, initial?: T | undefined, opts?: { handleGrip?: Grip<any> }) {
    super({ provides: opts?.handleGrip ? [grip, opts.handleGrip] : [grip] });
    this.valueGrip = grip;
    this.handleGrip = opts?.handleGrip;
    this.currentValue = initial ?? grip.defaultValue!;
  }

  /**
   * Produces current values for all provided Grips.
   *
   * Publishes the current atom value and, if configured, the controller handle.
   *
   * @param opts - Production options
   * @param opts.destContext - Optional specific destination context to produce for
   */
  produce(opts?: { destContext?: GripContext }) {
    const updates = new Map<Grip<any>, any>([[this.valueGrip, this.currentValue]]);
    if (this.handleGrip) {
      updates.set(this.handleGrip, this);
    }
    this.publish(updates, opts?.destContext);
  }

  /**
   * Returns the current value of the atom.
   *
   * @returns The current value
   */
  get(): T {
    return this.currentValue as T;
  }

  /**
   * Sets the atom to a new value.
   *
   * If the new value is different from the current value, it triggers
   * value production and notifies all listeners.
   *
   * @param next - The new value to set
   */
  set(next: T): void {
    const nextValue = next;
    if (this.currentValue !== nextValue) {
      this.currentValue = nextValue;
      this.produce();
      this.listeners.forEach((l) => l());
    }
  }

  /**
   * Updates the atom value using a function.
   *
   * The updater function receives the current value and should return
   * the new value. This is useful for derived updates or conditional changes.
   *
   * @param updater - Function that receives the current value and returns the new value
   */
  update(updater: (prev: T) => T): void {
    this.set(updater(this.currentValue));
  }

  /**
   * Subscribes to value changes.
   *
   * @param listener - Function to call when the value changes
   * @returns Function to unsubscribe from notifications
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Creates a single-value atom Tap.
 *
 * This factory function creates an AtomValueTap with proper TypeScript
 * type inference. It provides overloads to handle nullable vs non-nullable
 * types appropriately.
 *
 * @param grip - The Grip that the atom will provide
 * @param opts - Configuration options
 * @param opts.initial - Initial value (uses Grip's default if not provided)
 * @param opts.handleGrip - Optional Grip for exposing the controller interface
 * @returns An AtomValueTap instance
 */

// Overload 1: When initial value is provided and is non-nullable, return AtomValueTap with non-nullable type
export function createAtomValueTap<T>(
  grip: Grip<T | undefined>,
  opts: { initial: NonNullable<T>; handleGrip?: Grip<any> },
): AtomValueTap<NonNullable<T>>;

// Overload 2: Standard case - return AtomValueTap with original grip type
export function createAtomValueTap<T>(
  grip: Grip<T>,
  opts?: { initial?: T; handleGrip?: Grip<any> },
): AtomValueTap<T>;

// Implementation
export function createAtomValueTap<T>(
  grip: Grip<T>,
  opts?: { initial?: T | undefined; handleGrip?: Grip<any> },
): AtomValueTap<T> {
  const tap = new AtomValueTap<T>(grip, opts?.initial ?? grip.defaultValue!, opts);
  return tap;
}

// Type helpers for type-safe grips (mirrors function_tap.ts)
export type GripRecord = Record<string, Grip<any>>;
export type GripValue<G extends Grip<any>> = G extends Grip<infer T> ? T : never;
export type Values<R extends GripRecord> = R[keyof R];

/**
 * Controller interface for multi-value atom management.
 *
 * Provides a comprehensive API for managing multiple Grips in a single atom.
 * Supports individual get/set operations as well as bulk operations for
 * efficient multi-value updates.
 *
 * @template Outs - Record type defining the Grips managed by this atom
 */
export interface MultiAtomTapHandle<Outs extends GripRecord = any> {
  /**
   * Gets the current value for a specific Grip.
   *
   * @param grip - The Grip to get the value for
   * @returns The current value or undefined if not set
   */
  get: <K extends keyof Outs>(grip: Outs[K]) => GripValue<Outs[K]> | undefined;

  /**
   * Returns a read-only map of all current values.
   *
   * @returns Map of all Grip values currently managed by this atom
   */
  getAll: () => ReadonlyMap<Values<Outs>, GripValue<Values<Outs>> | undefined>;

  /**
   * Sets the value for a specific Grip.
   *
   * @param grip - The Grip to set the value for
   * @param next - The new value to set
   */
  set<K extends keyof Outs>(grip: Outs[K], next: GripValue<Outs[K]> | undefined): void;

  /**
   * Updates the value for a specific Grip using a function.
   *
   * @param grip - The Grip to update
   * @param updater - Function that receives the current value and returns the new value
   */
  update<K extends keyof Outs>(
    grip: Outs[K],
    updater: (prev: GripValue<Outs[K]> | undefined) => GripValue<Outs[K]> | undefined,
  ): void;

  /**
   * Sets multiple values at once.
   *
   * @param values - Map of Grip values to set
   */
  setAll(values: Map<Values<Outs>, GripValue<Values<Outs>> | undefined>): void;

  /**
   * Updates all values using a function that receives the current state.
   *
   * @param updater - Function that receives current values and returns new values
   */
  updateAll(
    updater: (
      current: ReadonlyMap<Values<Outs>, GripValue<Values<Outs>> | undefined>,
    ) => Map<Values<Outs>, GripValue<Values<Outs>> | undefined>,
  ): void;
}

export type MultiAtomTap<Outs extends GripRecord = any> = MultiAtomTapHandle<Outs>;

/**
 * Multi-value atom Tap that manages multiple Grips in a single container.
 *
 * MultiAtomValueTap extends the single-value concept to handle multiple
 * related Grips efficiently. It provides both individual and bulk operations
 * for managing the values, with automatic change detection and notifications.
 *
 * The Tap supports flexible initialization where values can be provided
 * through a Grips array, a value map, or a combination of both.
 *
 * @template Outs - Record type defining the Grips managed by this atom
 */
export class MultiAtomValueTap<Outs extends GripRecord = any>
  extends BaseTapNoParams
  implements MultiAtomTap<Outs>, Tap
{
  /** Internal map storing all current values */
  private readonly values = new Map<Values<Outs>, GripValue<Values<Outs>> | undefined>();

  /** Array of Grips that this atom provides */
  private readonly valueGrips: ReadonlyArray<Values<Outs>>;

  /** Optional Grip for exposing the controller handle */
  private readonly handleGrip?: Grip<MultiAtomTapHandle<Outs>>;

  /**
   * Creates a new MultiAtomValueTap instance.
   *
   * Merge semantics for initialization:
   * - Tracked set S = union(grips, gripsMap?.keys())
   * - For g in S:
   *   - if gripsMap has g: use that value (even if undefined)
   *   - else if g is in grips: use g.defaultValue
   *   - else: leave undefined
   *
   * @param grips - Array of Grips that this atom provides
   * @param gripsMap - Optional map of initial values
   * @param opts - Optional configuration
   * @param opts.handleGrip - Optional Grip for exposing the controller interface
   */
  constructor(
    grips: ReadonlyArray<Values<Outs>>,
    gripsMap: Map<Values<Outs>, GripValue<Values<Outs>> | undefined> | undefined,
    opts?: { handleGrip?: Grip<MultiAtomTapHandle<Outs>> },
  ) {
    const providesList = (opts?.handleGrip
      ? [...grips, opts.handleGrip]
      : grips) as unknown as readonly Grip<any>[];
    super({ provides: providesList });
    this.valueGrips = grips;
    this.handleGrip = opts?.handleGrip as unknown as Grip<MultiAtomTapHandle<Outs>> | undefined;

    const tracked = new Set<Values<Outs>>();
    for (const g of grips) tracked.add(g);
    if (gripsMap) for (const g of gripsMap.keys()) tracked.add(g);

    for (const g of tracked) {
      if (gripsMap?.has(g)) {
        this.values.set(g, gripsMap.get(g));
      } else if (grips.includes(g)) {
        this.values.set(g, (g as unknown as Grip<any>).defaultValue);
      } else {
        this.values.set(g, undefined);
      }
    }
  }

  /**
   * Updates a specific Grip value using a function.
   *
   * @param grip - The Grip to update
   * @param updater - Function that receives the current value and returns the new value
   */
  update<K extends keyof Outs>(
    grip: Outs[K],
    updater: (prev: GripValue<Outs[K]> | undefined) => GripValue<Outs[K]> | undefined,
  ): void {
    this.set(grip, updater(this.values.get(grip)));
  }

  /**
   * Updates all values using a function that receives the current state.
   *
   * @param updater - Function that receives current values and returns new values
   */
  updateAll(
    updater: (
      current: ReadonlyMap<Values<Outs>, GripValue<Values<Outs>> | undefined>,
    ) => Map<Values<Outs>, GripValue<Values<Outs>> | undefined>,
  ): void {
    this.setAll(updater(this.values));
  }

  /**
   * Sets multiple values at once.
   *
   * Validates that all Grips in the map are tracked by this atom and
   * that the handle Grip is not being modified directly.
   *
   * @param values - Map of Grip values to set
   * @throws Error if attempting to set untracked Grips or the handle Grip
   */
  setAll(values: Map<Values<Outs>, GripValue<Values<Outs>> | undefined>): void {
    const nextMap = values;

    for (const [g] of nextMap) {
      if (
        this.handleGrip &&
        (g as unknown as Grip<any>) === (this.handleGrip as unknown as Grip<any>)
      ) {
        throw new Error("Cannot set the self/handle grip value via setAll");
      }
      if (!this.values.has(g)) {
        throw new Error("Cannot set value for non-tracked grip on MultiAtomValueTap");
      }
    }

    const changed: Grip<any>[] = [];
    for (const [g, v] of nextMap) {
      const prev = this.values.get(g);
      if (prev !== v) {
        this.values.set(g, v);
        changed.push(g as unknown as Grip<any>);
      }
    }
    if (changed.length) {
      this.produce({ changed });
    }
  }

  /**
   * Produces current values for all provided Grips.
   *
   * Can produce all values or only changed values for efficiency.
   *
   * @param opts - Production options
   * @param opts.destContext - Optional specific destination context to produce for
   * @param opts.changed - Optional specific Grips that changed (for efficient updates)
   */
  produce(opts?: { destContext?: GripContext; changed?: Grip<any> | Grip<any>[] }) {
    const updates = new Map<Grip<any>, any>();
    const changedArray = Array.isArray(opts?.changed)
      ? (opts?.changed as Grip<any>[])
      : opts?.changed
        ? [opts.changed]
        : undefined;
    if (changedArray?.length) {
      for (const g of changedArray) {
        updates.set(g as unknown as Grip<any>, this.values.get(g as unknown as Values<Outs>));
      }
    } else {
      for (const g of this.valueGrips) {
        updates.set(g as unknown as Grip<any>, this.values.get(g));
      }
      if (this.handleGrip)
        updates.set(this.handleGrip as unknown as Grip<any>, this as MultiAtomTap<Outs>);
    }
    this.publish(updates, opts?.destContext);
  }

  /**
   * Gets the current value for a specific Grip.
   *
   * @param grip - The Grip to get the value for
   * @returns The current value or undefined if not set
   */
  get<K extends keyof Outs>(grip: Outs[K]): GripValue<Outs[K]> | undefined {
    return this.values.get(grip as unknown as Values<Outs>) as GripValue<Outs[K]> | undefined;
  }

  /**
   * Returns a read-only map of all current values.
   *
   * @returns Map of all Grip values currently managed by this atom
   */
  getAll(): ReadonlyMap<Values<Outs>, GripValue<Values<Outs>> | undefined> {
    return this.values;
  }

  /**
   * Sets the value for a specific Grip.
   *
   * Validates that the Grip is tracked by this atom and that it's not
   * the handle Grip being modified directly.
   *
   * @param grip - The Grip to set the value for
   * @param nextValue - The new value to set
   * @throws Error if attempting to set untracked Grips or the handle Grip
   */
  set<K extends keyof Outs>(grip: Outs[K], nextValue: GripValue<Outs[K]> | undefined): void {
    if (
      this.handleGrip &&
      (grip as unknown as Grip<any>) === (this.handleGrip as unknown as Grip<any>)
    ) {
      throw new Error("Cannot set the self/handle grip value");
    }
    if (!this.values.has(grip as unknown as Values<Outs>)) {
      throw new Error("Cannot set value for non-provided grip on MultiAtomValueTap");
    }
    const key = grip as unknown as Values<Outs>;
    const prev = this.values.get(key) as GripValue<Outs[K]> | undefined;
    if (prev !== nextValue) {
      this.values.set(key, nextValue);
      this.produce({ changed: grip as unknown as Grip<any> });
    }
  }
}

/**
 * Creates a multi-value atom Tap.
 *
 * This factory function creates a MultiAtomValueTap with flexible configuration.
 * It supports providing Grips through an array, a value map, or both, with
 * clear initialization semantics.
 *
 * Config semantics (equal priority):
 * - Tracked grips = union(config.grips, config.gripMap?.keys())
 * - Initialization per grip g:
 *   - if config.gripMap has g: use that value (even if undefined)
 *   - else if g is in config.grips: use g.defaultValue
 *   - else: leave undefined
 *
 * @param config - Configuration for the multi-value atom
 * @param config.grips - Optional array of Grips to provide
 * @param config.gripMap - Optional map of initial values
 * @param config.handleGrip - Optional Grip for exposing the controller interface
 * @returns A MultiAtomValueTap instance
 */
export function createMultiAtomValueTap<Outs extends GripRecord>(config: {
  grips?: ReadonlyArray<Values<Outs>>;
  gripMap?: Map<Values<Outs>, GripValue<Values<Outs>> | undefined>;
  handleGrip?: Grip<MultiAtomTapHandle<Outs>>;
}): MultiAtomValueTap<Outs> {
  const resolvedGrips: ReadonlyArray<Values<Outs>> =
    config.grips ?? Array.from(config.gripMap?.keys() ?? []);
  const tap = new MultiAtomValueTap<Outs>(resolvedGrips, config.gripMap, {
    handleGrip: config.handleGrip,
  });
  return tap;
}
