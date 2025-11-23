/**
 * Core GRIP (Generalized Retrieval Intent Provisioning) types for reactive dataflow.
 *
 * GRIP provides a declarative, reactive architecture where components request data
 * by Grip keys rather than directly managing data sources. The system automatically
 * resolves the best provider (Tap) for each request based on context hierarchy.
 */

/**
 * Grip represents an immutable identifier for a specific piece of data.
 *
 * A Grip acts as a universal key for requesting and providing specific data attributes
 * within the GRIP system. The name is treated as a flat identifier; variations or
 * specific instances are differentiated using GripContext parameters during query
 * resolution, not through hierarchical naming within the Grip itself.
 *
 * Grips are typically defined centrally within the GripRegistry and used by
 * application components to declare their data needs via queries.
 */
export class Grip<T> {
  /** The scope/namespace for organizing related grips (e.g., "app", "weather", "user") */
  readonly scope: string;

  /** The unique name within the scope for this data attribute */
  readonly name: string;

  /** The full key combining scope and name (e.g., "weather:temperature") */
  readonly key: string;

  /** Optional default value returned when no provider is available */
  readonly defaultValue?: T;

  /** @internal */
  constructor(opts: { scope?: string; name: string; defaultValue?: T }) {
    this.scope = opts.scope ?? "app";
    this.name = opts.name;
    this.key = `${this.scope}:${this.name}`;
    this.defaultValue = opts.defaultValue;
  }
}

/**
 * Central registry for managing all Grip definitions globally.
 *
 * The GripRegistry maintains a global catalog of all available Grips,
 * ensuring uniqueness and providing a central point for Grip discovery.
 * This registry is used by the GROK engine to validate Grip references
 * and by application code to define and retrieve Grip instances.
 */
export class GripRegistry {
  /** Internal map of all registered grips by their full key */
  private grips = new Map<string, Grip<any>>();

  private makeKey(scope: string | undefined, name: string): string {
    return `${scope ?? "app"}:${name}`;
  }

  /**
   * Defines and registers a new Grip with the registry.
   *
   * @param name - The unique name for this data attribute
   * @param defaultValue - Optional default value when no provider is available
   * @param scope - Optional scope/namespace (defaults to "app")
   * @returns The newly created and registered Grip instance
   * @throws Error if a Grip with the same key already exists
   */
  defineGrip<T>(name: string, defaultValue?: T, scope?: string): Grip<T> {
    const g = new Grip<T>({ scope, name, defaultValue });
    if (this.grips.has(g.key)) throw new Error(`Grip already registered: ${g.key}`);
    this.grips.set(g.key, g);
    return g;
  }

  /**
   * Finds an existing Grip or defines it if missing.
   * This is explicit and side-effect free for callers that want idempotent setup.
   */
  findOrDefineGrip<T>(name: string, defaultValue?: T, scope?: string): Grip<T> {
    const k = this.makeKey(scope, name);
    const existing = this.grips.get(k) as Grip<T> | undefined;
    if (existing) return existing;
    return this.defineGrip<T>(name, defaultValue, scope);
  }

  /**
   * Retrieves a previously registered Grip by scope and name.
   *
   * @param scope - The scope/namespace of the Grip
   * @param name - The name of the Grip within that scope
   * @returns The registered Grip instance or undefined if not found
   *
   */
  get<T>(scope: string, name: string): Grip<T> | undefined {
    // TODO: add a check to see if the requested type is the same as the defined type.
    return this.grips.get(`${scope}:${name}`) as Grip<T> | undefined;
  }
}

/**
 * Convenience factory function for creating Grips with a specific registry.
 *
 * This provides a more ergonomic API for defining Grips, allowing for
 * a functional programming style while maintaining the registry's
 * central management capabilities.
 *
 * @param registry - The GripRegistry instance to use for registration
 * @returns A function that creates and registers Grips with the given registry
 */
export const GripOf =
  (registry: GripRegistry) =>
  <T>(name: string, defaultValue?: T, scope?: string) =>
    registry.defineGrip<T>(name, defaultValue, scope);
