/**
 * GRIP Tap Matcher - Dynamic Tap selection based on context queries
 *
 * Implements reactive Tap selection by observing Grip values in a home context,
 * evaluating queries against those values, and dynamically activating/deactivating
 * Taps in a presentation context based on query results.
 *
 * Key Features:
 * - Reactive query evaluation on Grip value changes
 * - Dynamic Tap activation/deactivation
 * - Dual context management (home for inputs, presentation for outputs)
 * - Batched evaluation with task scheduling
 * - Automatic subscription management
 *
 * Architecture:
 * - TapMatcher: Core matching logic with reactive evaluation
 * - MatchingContext: Simplified API combining dual contexts and matcher
 * - QueryBinding: Association between queries and Taps
 * - EvaluationDelta: Changes in Tap attributions
 *
 * Use Cases:
 * - Dynamic UI based on user preferences
 * - Feature flags and A/B testing
 * - Context-aware data sources
 * - Conditional Tap activation
 */

// ---[ Core GRIP Imports ]-------------------------------------------------------
import { Grip } from "./grip";
import { Drip, Unsubscribe } from "./drip";
import { Tap, TapFactory } from "./tap";
import { DualContextContainer } from "./containers";
import { GripContext } from "./context";
import {
  QueryEvaluator,
  QueryBinding,
  EvaluationDelta,
  AddBindingResult,
  RemoveBindingResult,
  evaluationToString,
} from "./query_evaluator";
import { consola } from "./logger";

const logger = consola.withTag("core/matcher.ts");

/**
 * Reactive Tap selector that observes Grip values and dynamically activates Taps.
 *
 * The TapMatcher observes a 'home' context for input Grip changes, evaluates
 * queries against those inputs, and determines which Taps should be active
 * in a 'presentation' context. It provides a declarative way to select Taps
 * based on context conditions rather than imperative logic.
 *
 * Key Responsibilities:
 * - Subscribe to input Grip changes in home context
 * - Evaluate queries when input values change
 * - Apply Tap attribution changes to presentation context
 * - Manage subscription lifecycle for input Grips
 * - Schedule evaluations as low-priority tasks
 */
export class TapMatcher {
  private evaluator: QueryEvaluator;
  private container: DualContextContainer;
  private valuesMap = new Map<Grip<any>, any>();
  private changedGrips = new Set<Grip<any>>();
  private dripSubscriptions = new Map<Grip<any>, Unsubscribe>();
  private isFirstEvaluation = true;

  /**
   * Constructs a TapMatcher instance.
   *
   * @param container - A DualContextContainer providing the 'home' context for inputs
   *                    and the 'presentation' context for outputs
   */
  constructor(container: DualContextContainer) {
    this.container = container;
    this.evaluator = new QueryEvaluator();
  }

  /**
   * Adds a query binding to the matcher and subscribes to necessary input Grips.
   *
   * When a binding is added:
   * 1. The evaluator determines which input Grips are needed
   * 2. Subscriptions are established for new input Grips
   * 3. Subscriptions are cleaned up for unused input Grips
   * 4. An initial evaluation is scheduled to establish the baseline state
   *
   * @param binding - The QueryBinding to add, containing query, tap, and base score
   */
  public addBinding(binding: QueryBinding): void {
    if (process.env.NODE_ENV !== "production") logger.log(`[TapMatcher] addBinding: ${binding.id}`);
    const result: AddBindingResult = this.evaluator.addBinding(binding);
    result.newInputs.forEach((grip) => this._subscribeToGrip(grip));
    result.removedInputs.forEach((grip) => this._unsubscribeFromGrip(grip));

    // Force re-evaluation of all grips related to the new binding
    for (const grip of binding.query.conditions.keys()) {
      this.changedGrips.add(grip);
    }

    // Schedule an immediate evaluation to establish the initial state
    this.container.getGripHomeContext().submitTask(() => this._evaluate(), 100);
  }

  /**
   * Removes a query binding from the matcher and cleans up subscriptions.
   *
   * When a binding is removed:
   * 1. The evaluator determines which input Grips are no longer needed
   * 2. A final evaluation is scheduled to update the state
   * 3. Subscriptions are cleaned up for unused input Grips
   *
   * @param bindingId - The unique ID of the binding to remove
   */
  public removeBinding(bindingId: string): void {
    if (process.env.NODE_ENV !== "production")
      logger.log(`[TapMatcher] removeBinding: ${bindingId}`);
    const binding = this.evaluator.getBinding(bindingId); // Assuming getBinding exists
    if (binding) {
      for (const grip of binding.query.conditions.keys()) {
        this.changedGrips.add(grip);
      }
    }

    const result: RemoveBindingResult = this.evaluator.removeBinding(bindingId);

    // Schedule an immediate evaluation to update the state after removal
    // Do this BEFORE unsubscribing so the evaluation can still access the grip values
    this.container.getGripHomeContext().submitTask(() => this._evaluate(), 100);

    result.removedInputs.forEach((grip) => this._unsubscribeFromGrip(grip));
  }

  /**
   * Subscribes to a Grip in the home context.
   *
   * Establishes a subscription to monitor Grip value changes and triggers
   * re-evaluation when values change. For the first evaluation, captures
   * the initial value immediately.
   *
   * @param grip - The Grip to subscribe to for value changes
   */
  private _subscribeToGrip(grip: Grip<any>): void {
    if (this.dripSubscriptions.has(grip)) {
      return;
    }

    const homeCtx = this.container.getGripHomeContext();
    const drip = homeCtx.getOrCreateConsumer(grip);

    // For the very first evaluation, we need to get the initial value.
    if (this.isFirstEvaluation) {
      this.valuesMap.set(grip, drip.get());
      this.changedGrips.add(grip);
    }

    const unsubscribe = drip.subscribePriority(() => {
      this._onGripChanged(grip, drip);
    });

    this.dripSubscriptions.set(grip, unsubscribe);
  }

  /**
   * Unsubscribes from a Grip and cleans up associated state.
   *
   * Removes the subscription, cleans up the unsubscribe function,
   * and removes the Grip's value from the values map.
   *
   * @param grip - The Grip to unsubscribe from
   */
  private _unsubscribeFromGrip(grip: Grip<any>): void {
    const unsubscribe = this.dripSubscriptions.get(grip);
    if (unsubscribe) {
      unsubscribe();
      this.dripSubscriptions.delete(grip);
      this.valuesMap.delete(grip);
    }
  }

  /**
   * Handles a change notification from a subscribed Drip.
   *
   * Updates the cached value for the changed Grip and schedules
   * a re-evaluation to determine if Tap attributions should change.
   *
   * @param grip - The Grip that changed
   * @param drip - The Drip instance for the changed Grip
   */
  private _onGripChanged(grip: Grip<any>, drip: Drip<any>): void {
    this.valuesMap.set(grip, drip.get());
    this.changedGrips.add(grip);
    // Schedule the evaluation to run in a low-priority task
    this.container.getGripHomeContext().submitTask(() => this._evaluate(), 100);
  }

  /**
   * Executes the query evaluator with the collected changes.
   *
   * This is the core evaluation method that:
   * 1. Collects all changed Grips since the last evaluation
   * 2. Creates a context snapshot with current Grip values
   * 3. Evaluates all queries against the current state
   * 4. Applies the resulting delta to the presentation context
   *
   * Evaluations are batched and scheduled as low-priority tasks
   * to avoid blocking the main thread.
   */
  private _evaluate(): void {
    if (process.env.NODE_ENV !== "production")
      logger.log(`[TapMatcher] _evaluate: Evaluating ${this.changedGrips.size} grips.`);
    if (this.changedGrips.size === 0 && !this.isFirstEvaluation) {
      return;
    }

    const gripsToEvaluate = this.changedGrips;
    this.changedGrips = new Set<Grip<any>>();
    this.isFirstEvaluation = false;

    const contextSnapshot = {
      getValue: (grip: Grip<any>) => this.valuesMap.get(grip),
    };

    const delta = this.evaluator.onGripsChanged(gripsToEvaluate, contextSnapshot);

    this.applyAttributionDelta(delta);
  }

  /**
   * Applies the calculated delta of Tap attributions to the presentation context.
   *
   * This is where the rubber meets the road - the delta contains information
   * about which Taps should be added or removed from the presentation context
   * based on the query evaluation results.
   *
   * @param delta - The evaluation delta containing added and removed Tap attributions
   */
  public applyAttributionDelta(delta: EvaluationDelta): void {
    // Delta is applied to the consumer/presentation context.
    if (process.env.NODE_ENV !== "production")
      logger.log(
        `[TapMatcher] applyAttributionDelta: Applying delta to consumer context. ${evaluationToString(delta)}`,
      );
    this.container.getGrok().applyProducerDelta(this.container.getGripConsumerContext(), delta);
  }
}

/**
 * A specialized context container that automatically creates and manages a TapMatcher.
 *
 * Provides a simplified API for dynamic Tap management by combining the dual context
 * functionality with the TapMatcher. This makes it easy to create contexts that
 * automatically select Taps based on query conditions.
 *
 * Key Features:
 * - Automatic TapMatcher creation and management
 * - Simplified binding API
 * - Dual context separation (home/presentation)
 * - Reactive Tap selection
 */
export class MatchingContext extends DualContextContainer {
  private readonly matcher: TapMatcher;

  /**
   * Constructs a MatchingContext with home and presentation contexts.
   *
   * @param home - The home context where input Grips are observed
   * @param presentation - The presentation context where selected Taps are activated
   */
  constructor(home: GripContext, presentation: GripContext) {
    super(home, presentation);
    this.matcher = new TapMatcher(this);
  }

  /**
   * Adds a query binding to the internal matcher.
   *
   * Delegates to the internal TapMatcher to add the binding and establish
   * the necessary subscriptions and evaluations.
   *
   * @param binding - The QueryBinding to add
   */
  public addBinding(binding: QueryBinding): void {
    this.matcher.addBinding(binding);
  }

  /**
   * Removes a query binding from the internal matcher.
   *
   * Delegates to the internal TapMatcher to remove the binding and clean up
   * subscriptions and evaluations.
   *
   * @param bindingId - The ID of the binding to remove
   */
  public removeBinding(bindingId: string): void {
    this.matcher.removeBinding(bindingId);
  }
}
