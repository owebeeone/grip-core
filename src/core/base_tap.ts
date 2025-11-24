/**
 * Base Tap Implementation - Core lifecycle and parameter management
 *
 * Abstract base class providing common Tap functionality:
 * - Lifecycle management (attach/detach/connect/disconnect)
 * - Parameter subscription and change handling
 * - Destination management and value publishing
 * - Home vs destination parameter distinction
 *
 * Subclasses implement produce() and optionally produceOnParams()/produceOnDestParams().
 */

import { Drip, Unsubscribe } from "./drip";
import { Grip } from "./grip";
import type { GripContext, GripContextLike } from "./context";
import type { Grok } from "./grok";
import type { Tap } from "./tap";
import type { GripContextNode, Destination, ProducerRecord, DestinationParams } from "./graph";
import { consola } from "./logger";

const logger = consola.withTag("core/base_tap.ts");

/**
 * Base Tap implementation managing lifecycle and parameter bookkeeping.
 *
 * Handles:
 * - Tap registration with GROK engine
 * - Parameter subscription and change notifications
 * - Destination management and value publishing
 * - Context resolution (home vs consumer contexts)
 */
export abstract class BaseTap implements Tap {
  readonly kind: "Tap" = "Tap";
  readonly id: string = `tap_${Math.random().toString(36).substr(2, 9)}`;

  protected engine?: Grok;
  readonly provides: readonly Grip<any>[]; // Grips this tap publishes
  readonly destinationParamGrips?: readonly Grip<any>[]; // Grips read from destination context
  readonly homeParamGrips?: readonly Grip<any>[]; // Grips read from paramsContext
  protected homeContext?: GripContext; // Context this tap publishes to
  protected paramsContext?: GripContext; // Context providing incoming parameters
  protected paramDrips: Map<Grip<any>, Drip<any>> = new Map();
  protected paramDripsSubs: Map<Grip<any>, Unsubscribe> = new Map();
  protected producer?: ProducerRecord;
  protected delayedUpdates: boolean = true;
  protected paramUpdates: Set<Grip<any>> = new Set();

  constructor(opts: {
    provides: readonly Grip<any>[];
    destinationParamGrips?: readonly Grip<any>[];
    homeParamGrips?: readonly Grip<any>[];
  }) {
    this.provides = opts.provides;
    this.destinationParamGrips = opts.destinationParamGrips;
    this.homeParamGrips = opts.homeParamGrips;

    // Validate: can't produce what we consume
    if (opts.destinationParamGrips) {
      for (const grip of opts.destinationParamGrips) {
        if (this.provides.includes(grip)) {
          throw new Error("Destination parameter grip is also provided by this tap");
        }
      }
    }
  }

  getHomeContext(): GripContext | undefined {
    return this.homeContext;
  }

  getParamsContext(): GripContext | undefined {
    return this.paramsContext;
  }

  /**
   * Called when tap is attached to a home context.
   *
   * Sets up:
   * - Context references (home/params)
   * - Producer record registration
   * - GROK engine discovery
   * - Parameter subscriptions
   */
  onAttach(home: GripContext | GripContextLike): void {
    var realHome: GripContext;
    var paramContext: GripContext;
    if ((home as any).getGripHomeContext) {
      const contextLike = home as GripContextLike;
      realHome = contextLike.getGripHomeContext();
      paramContext = contextLike.getGripConsumerContext();
    } else {
      realHome = home as GripContext;
      paramContext = realHome;
    }
    this.homeContext = realHome;
    this.paramsContext = paramContext;

    // Get or create ProducerRecord for this tap at home node
    const homeNode = this.homeContext._getContextNode();
    this.producer = homeNode.getOrCreateProducerRecord(this as unknown as Tap, this.provides);
    if (process.env.NODE_ENV !== "production")
      logger.log(
        `[BaseTap] onAttach: ${this.constructor.name} (id=${this.id}) attached to ${realHome.id}, producer has ${this.producer.getDestinations().size} destinations`,
      );

    // Record producer under each provided grip for resolution
    for (const g of this.provides) {
      homeNode.recordProducer(g as unknown as Grip<any>, this.producer);
    }

    // Discover engine from context
    const grok: Grok = realHome.getGrok();
    this.engine = grok;

    this.subscribeToIncomingParams();
  }

  /**
   * Subscribe to home parameter drips.
   *
   * Only subscribes to homeParamGrips at params/home context.
   * Destination param subscriptions handled per-destination in Destination.registerDestinationParamDrips().
   */
  private subscribeToIncomingParams(): void {
    if (!this.paramsContext || !this.homeParamGrips || this.homeParamGrips.length === 0) return;

    this.delayedUpdates = true; // Delay updates during subscription
    const self = this;

    for (const paramGrip of this.homeParamGrips) {
      const paramDrip = this.paramsContext.getOrCreateConsumer(paramGrip);
      const sub = paramDrip.subscribe(() => {
        self.inputParmsChanged(paramGrip);
      });
      this.paramDrips.set(paramGrip, paramDrip);
      this.paramDripsSubs.set(paramGrip, sub);
    }
  }

  /**
   * Called when a home parameter changes.
   *
   * Queues parameter update and calls produceOnParams if not in delayed mode.
   */
  inputParmsChanged(paramGrip: Grip<any>): void {
    this.paramUpdates.add(paramGrip);
    if (!this.delayedUpdates) {
      this.produceOnParams!(paramGrip);
    }
  }

  /**
   * Called when tap is detached.
   *
   * Cleans up:
   * - Context references
   * - Parameter subscriptions
   * - Producer record
   */
  onDetach(): void {
    this.engine = undefined;
    this.homeContext = undefined;
    this.producer = undefined;
    // Clean up parameter subscriptions
    for (const unsub of this.paramDripsSubs.values()) {
      try {
        unsub();
      } catch {}
    }
    this.paramDripsSubs.clear();
    this.paramDrips.clear();
  }

  /**
   * Get destinations for a specific grip at a context node.
   */
  getDestinationsForNode(node: GripContextNode, grip: Grip<any>): Destination | undefined {
    const producer = node.get_producers().get(grip);
    if (!producer) throw new Error("Grip not produced by this tap");

    const destination = producer.getDestinations().get(node);
    return destination;
  }

  /**
   * Called when tap connects to a destination.
   *
   * Always publishes initial values for the destination.
   */
  onConnect(dest: GripContext, grip: Grip<any>): void {
    this.produce({ destContext: dest });
  }

  /**
   * Called when tap disconnects from a destination.
   *
   * Removes the grip from the destination's grip list.
   */
  onDisconnect(dest: GripContext, grip: Grip<any>): void {
    const destination = this.getDestination(dest);
    if (!destination) throw new Error("Destination not found for this tap");
    destination.removeGrip(grip);
  }

  /**
   * Get destination record for a specific context.
   */
  getDestination(dest: GripContext): Destination | undefined {
    return this.producer?.getDestinations().get(dest._getContextNode());
  }

  /**
   * Read destination parameter value for a specific grip.
   */
  protected getDestParamValue<T>(dest: GripContext, grip: Grip<T>): T | undefined {
    const d = this.getDestination(dest);
    return d?.getDestinationParamValue(grip);
  }

  /**
   * Get snapshot of all destination parameter values.
   */
  protected getAllDestParamValues(dest: GripContext): Map<Grip<any>, any> | undefined {
    const d = this.getDestination(dest);
    return d?.getAllDestinationParamValues();
  }

  /**
   * Publish updates to destinations.
   *
   * If target specified, publishes only to that destination.
   * Otherwise publishes to all destinations.
   *
   * @param updates - Map of grip values to publish
   * @param target - Optional specific destination context
   * @returns Number of consumers notified
   */
  protected publish(updates: Map<Grip<any>, any>, target?: GripContext): number {
    if (!this.engine || !this.homeContext || !this.producer) {
      return 0; // Not fully attached yet
    }

    var destinations: Destination[] = [];
    if (target) {
      const destNode = target._getContextNode();
      const destination = this.producer.getDestinations().get(destNode);
      if (!destination) {
        return 0; // Destination removed before async produce call
      }
      destinations.push(destination);
    } else {
      destinations = Array.from(this.producer.getDestinations().values());
    }

    var count = 0;
    for (const destination of destinations) {
      const destCtx = destination.getContext();
      if (!destCtx) continue;
      for (const grip of destination.getGrips()) {
        if (updates.has(grip)) {
          count += destCtx._getContextNode().notifyConsumers(grip, updates.get(grip));
        }
      }
    }
    return count;
  }

  /**
   * Produce current state values.
   *
   * If destContext provided, produces only for that destination.
   * Subclasses must implement this method.
   */
  abstract produce(opts?: { destContext?: GripContext }): void;

  /**
   * Called when a home parameter changes.
   *
   * Optional override for taps that need to react to home parameter changes.
   */
  abstract produceOnParams?(paramGrip: Grip<any>): void;

  /**
   * Called when a destination parameter changes.
   *
   * Optional override for taps that need to react to destination parameter changes.
   */
  abstract produceOnDestParams?(destContext: GripContext | undefined, paramGrip: Grip<any>): void;

  /**
   * Get destination parameters for a specific context.
   */
  protected getDestinationParams(destContext: GripContext): DestinationParams | undefined {
    return this.producer?.getDestinationParams(destContext);
  }
}

/**
 * Base tap without parameters.
 *
 * Simplified base class for taps that don't read any parameters.
 * Throws on parameter change callbacks since they shouldn't be called.
 */
export abstract class BaseTapNoParams extends BaseTap {
  constructor(opts: { provides: readonly Grip<any>[] }) {
    super({ provides: opts.provides });
  }

  /**
   * Produce current state values.
   *
   * Subclasses must implement this method.
   */
  abstract produce(opts?: { destContext?: GripContext }): void;

  produceOnParams?(paramGrip: Grip<any>): void {
    throw new Error("Method not implemented.");
  }
  produceOnDestParams?(destContext: GripContext | undefined, paramGrip: Grip<any>): void {
    throw new Error("Method not implemented.");
  }
}
