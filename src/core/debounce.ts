/**
 * GRIP Debounce Utility - Rate limiting for function calls
 *
 * Provides a simple debouncing utility that limits the rate at which
 * functions can be called. Useful for preventing excessive function
 * calls during rapid state changes or user interactions.
 *
 * Key Features:
 * - Configurable delay period
 * - Customizable scheduler (default: setTimeout)
 * - Immediate execution for zero delay
 * - Automatic timer cleanup
 *
 * Use Cases:
 * - Rate limiting async operations
 * - Preventing excessive Tap updates
 * - User input throttling
 * - Performance optimization
 */

/**
 * Function signature for scheduling delayed execution.
 *
 * @param fn - The function to execute
 * @param ms - The delay in milliseconds
 * @returns A timer handle that can be used for cancellation
 */
export type Scheduler = (fn: () => void, ms: number) => any;

/**
 * Creates a debounced function that limits execution frequency.
 *
 * The debouncer ensures that the provided function is called at most once
 * within the specified delay period. If the debounced function is called
 * multiple times within the delay, only the last call will be executed.
 *
 * @param ms - The delay in milliseconds (0 = immediate execution)
 * @param schedule - Optional scheduler function (default: setTimeout)
 * @returns A debounced function that can be called multiple times
 */
export function createDebouncer(ms: number, schedule: Scheduler = (fn, t) => setTimeout(fn, t)) {
  let timer: any | null = null;

  return (fn: () => void) => {
    // If delay is 0 or negative, execute immediately
    if (ms <= 0) {
      fn();
      return;
    }

    // Clear existing timer if one exists
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    // Schedule new execution
    timer = schedule(fn, ms);
  };
}
