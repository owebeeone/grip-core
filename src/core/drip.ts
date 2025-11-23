/**
 * GRIP Drip System - Live value streams for reactive data consumption
 *
 * A Drip represents a live value stream for a specific Grip within a GripContext.
 * It provides the consumer end of the data pipeline, allowing components to
 * subscribe to value updates and receive notifications when data changes.
 *
 * Key features:
 * - Subscribable value streams with immediate and queued notifications
 * - Lifecycle callbacks for first subscriber and zero subscribers
 * - Deferred cleanup to handle transient resubscribe patterns
 * - Weak references to prevent memory leaks
 */

import type { GripContext } from "./context";

/**
 * Function type for unsubscribing from a Drip.
 * Called to remove a subscription and stop receiving updates.
 */
export type Unsubscribe = () => void;

/**
 * Drip represents a live value stream for a specific Grip within a GripContext.
 *
 * Drips are the consumer end of the GRIP data pipeline. They receive values
 * from connected Taps (producers) and notify subscribers when values change.
 * Drips are shared across multiple consumers in the same context to ensure
 * consistency and efficiency.
 *
 * The class provides both immediate and queued notification mechanisms,
 * allowing for different performance characteristics based on subscriber needs.
 */
export class Drip<T> {
  /** The context this Drip belongs to (keeps context alive while Drip exists) */
  private context: GripContext | null = null;

  /** Current value of the Drip */
  private value: T | undefined;

  /** Regular subscribers that receive queued notifications */
  private subs = new Set<(v: T | undefined) => void>();

  /** Immediate subscribers that receive synchronous notifications */
  private immediateSubs = new Set<(v: T | undefined) => void>();

  /** Callbacks triggered when the first subscriber is added */
  private firstSubCallbacks = new Set<() => void>();

  /** Callbacks triggered when the last subscriber is removed */
  private zeroSubCallbacks = new Set<() => void>();

  /** Flag indicating if a notification task is already enqueued */
  private enqueued = false;

  /** Flag indicating if a zero-subscriber check is scheduled */
  private zeroCheckScheduled = false;

  /**
   * Creates a new Drip instance.
   *
   * @param context - The GripContext this Drip belongs to
   * @param initial - Initial value for the Drip
   */
  /** @internal */
  constructor(context: GripContext, initial: T | undefined) {
    this.context = context;
    this.value = initial;
  }

  /**
   * Returns the current value of the Drip.
   *
   * @returns The current value or undefined if no value has been set
   */
  get(): T | undefined {
    return this.value;
  }

  /**
   * Updates the value of the Drip and notifies subscribers.
   *
   * If the new value is the same as the current value, subscribers are not notified.
   * Immediate subscribers are notified synchronously, while regular subscribers
   * receive notifications via the task queue.
   *
   * @param v - The new value to set
   */
  next(v: T | undefined): void {
    if (this.value !== v) {
      this.value = v;
      this.enqueueNotifySubscribers();
    }
  }

  /**
   * Enqueues a task to notify subscribers of value changes.
   *
   * Immediate subscribers are notified synchronously, while regular subscribers
   * receive notifications via the task queue to avoid blocking the current
   * execution context.
   */
  private enqueueNotifySubscribers(): void {
    this.notifyImmediateSubscribers();
    if (!this.enqueued) {
      this.enqueued = true;
      const self = this;
      this.context?.submitWeakTask(() => self.taskQueueCallback());
    }
  }

  /**
   * Task queue callback that notifies regular subscribers.
   * Called by the context's task queue to deliver queued notifications.
   */
  private taskQueueCallback(): void {
    this.enqueued = false;
    this.notifySubscribers();
  }

  /**
   * Notifies all regular subscribers with the current value.
   */
  private notifySubscribers(): void {
    this.subs.forEach((fn) => fn(this.value));
  }

  /**
   * Notifies all immediate subscribers with the current value.
   */
  private notifyImmediateSubscribers(): void {
    this.immediateSubs.forEach((fn) => fn(this.value));
  }

  /**
   * Returns true if the Drip has any active subscribers.
   *
   * @returns True if there are regular or immediate subscribers
   */
  hasSubscribers(): boolean {
    return this.subs.size > 0 || this.immediateSubs.size > 0;
  }

  /**
   * Internal method to subscribe to a specific subscriber queue.
   *
   * @param queue - The subscriber queue to add to (regular or immediate)
   * @param fn - The callback function to call when values change
   * @returns An unsubscribe function to remove the subscription
   */
  /** @internal */
  subscribeWith(
    queue: Set<(v: T | undefined) => void>,
    fn: (v: T | undefined) => void,
  ): Unsubscribe {
    const wasEmpty = !this.hasSubscribers();
    queue.add(fn);
    if (wasEmpty) {
      this.firstSubCallbacks.forEach((cb) => cb());
    }
    return () => {
      if (queue.has(fn)) {
        queue.delete(fn);
        // Defer zero-subscriber cleanup to allow transient resubscribe patterns
        if (!this.hasSubscribers() && !this.zeroCheckScheduled) {
          this.zeroCheckScheduled = true;
          const self = this;
          this.context?.submitWeakTask(() => {
            self.zeroCheckScheduled = false;
            if (!self.hasSubscribers()) {
              self.zeroSubCallbacks.forEach((cb) => cb());
            }
          });
        }
      }
    };
  }

  /**
   * Subscribes to regular (queued) notifications.
   *
   * Regular subscribers receive notifications via the task queue, which
   * prevents blocking the current execution context but may have slight
   * latency compared to immediate subscribers.
   *
   * @param fn - Callback function called when the value changes
   * @returns Function to unsubscribe from notifications
   */
  subscribe(fn: (v: T | undefined) => void): Unsubscribe {
    return this.subscribeWith(this.subs, fn);
  }

  /**
   * Subscribes to immediate (synchronous) notifications.
   *
   * Immediate subscribers receive notifications synchronously when the
   * value changes. This provides the lowest latency but may block the
   * current execution context.
   *
   * @param fn - Callback function called immediately when the value changes
   * @returns Function to unsubscribe from notifications
   */
  subscribePriority(fn: (v: T | undefined) => void): Unsubscribe {
    return this.subscribeWith(this.immediateSubs, fn);
  }

  /**
   * Adds a callback to be triggered when the first subscriber is added.
   *
   * This is useful for lazy initialization of data sources or other
   * setup that should only occur when there are active consumers.
   *
   * @param fn - Callback function to execute on first subscriber
   */
  addOnFirstSubscriber(fn: () => void): void {
    this.firstSubCallbacks.add(fn);
  }

  /**
   * Adds a callback to be triggered when the last subscriber is removed.
   *
   * This is useful for cleanup operations, resource management, or
   * stopping data sources when there are no active consumers.
   *
   * @param fn - Callback function to execute on zero subscribers
   */
  addOnZeroSubscribers(fn: () => void): void {
    this.zeroSubCallbacks.add(fn);
  }

  /**
   * Removes all subscribers and triggers zero-subscriber callbacks.
   *
   * This method is typically used for cleanup when the Drip is being
   * disposed or when the context is being destroyed.
   */
  unsubscribeAll(): void {
    if (this.hasSubscribers()) {
      this.subs.clear();
      this.immediateSubs.clear();
      this.zeroSubCallbacks.forEach((cb) => cb());
    }
    this.context = null;
  }

  /**
   * Internal method for managed unsubscribe wrappers.
   *
   * Triggers zero-subscriber callbacks if appropriate, with deferred
   * execution to handle transient resubscribe patterns.
   */
  /** @internal */
  _notifyUnsubscribed(): void {
    if (this.subs.size === 0 && !this.zeroCheckScheduled) {
      this.zeroCheckScheduled = true;
      const self = this;
      this.context?.submitWeakTask(() => {
        self.zeroCheckScheduled = false;
        if (!self.hasSubscribers()) {
          self.zeroSubCallbacks.forEach((cb) => cb());
        }
      });
    }
  }
}
