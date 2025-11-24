/**
 * GRIP Logging System - Integrated logging with tag-based filtering
 *
 * Provides a logging system that integrates with the GRIP context system
 * to enable dynamic, tag-based log filtering. Uses Consola for logging
 * and provides fine-grained control over which log messages are displayed.
 *
 * Key Features:
 * - Tag-based log filtering
 * - Dynamic log level control via GRIP contexts
 * - Production vs development logging modes
 * - Wildcard tag support for global logging
 * - Integration with Consola logging library
 *
 * Use Cases:
 * - Development debugging
 * - Runtime log filtering
 * - Performance monitoring
 * - Error tracking and reporting
 */

import { consola } from "./core/logger";
import { Grip, GripRegistry } from "./core/grip";
import { GripContext } from "./core/context";

/**
 * A Grip that holds a map of enabled log tags.
 *
 * The key is the tag (typically a file path or module name) and the value
 * is a boolean indicating if logging for that tag is enabled. A special
 * tag '*' can be used to enable all logs globally.
 *
 * This Grip allows dynamic control of logging levels through the GRIP
 * context system, enabling runtime configuration of which log messages
 * should be displayed.
 */
// No module-level grip instance; acquire from registry at runtime in setupConsola

/** Returns the shared logging tags Grip from the provided registry. */
export function getLoggingTagsGrip(registry: GripRegistry): Grip<Map<string, boolean>> {
  return registry.findOrDefineGrip<Map<string, boolean>>(
    "tags",
    new Map<string, boolean>(),
    "logging",
  );
}

/**
 * Sets up the Consola logging system with GRIP integration.
 *
 * Configures Consola to use a custom reporter that filters log messages
 * based on the enabled tags in the provided GRIP context. In production,
 * logging is completely disabled for performance.
 *
 * Key Features:
 * - Production mode: Disables all logging
 * - Development mode: Enables tag-based filtering
 * - Dynamic tag updates: Responds to changes in the LOGGING_TAGS_GRIP
 * - Wildcard support: '*' tag enables all logs
 * - Recursion prevention: Uses separate Consola instance for output
 *
 * @param context - The GRIP context that contains the logging configuration
 */
export function setupConsola(context: GripContext) {
  // Disable all logging in production for performance
  if (process.env.NODE_ENV === "production") {
    consola.setReporters([]); // Disable logs in production
    return;
  }

  let enabledTags = new Map<string, boolean>();

  // Get the logging tags grip from the per-engine registry and subscribe via grok.query
  const registry = context.getGrok().getRegistry();
  const loggingTagsGrip = getLoggingTagsGrip(registry);
  const drip = context.getGrok().query(loggingTagsGrip, context);
  // Custom reporter that filters logs based on enabled tags
  const customReporter: any = {
    log: (logObj: any) => {
      const tag = logObj.tag;

      // Log if:
      // 1. The log has no tag (always log untagged messages)
      // 2. The specific tag is enabled in the map
      // 3. The wildcard '*' tag is enabled (global logging)
      if (!tag || enabledTags.get(tag) || enabledTags.get("*")) {
        // Create a new consola instance to avoid recursive calls to this reporter.
        // This new instance will have the default reporters.
        new (consola as any).constructor().log(logObj);
      }
    },
  };
  // Pin the drip to avoid GC by storing on the reporter
  customReporter._drip = drip;
  customReporter._unsub = drip.subscribe((tagsMap: Map<string, boolean> | undefined) => {
    enabledTags = tagsMap || new Map();
  });

  // Replace the default reporters with our custom one
  consola.setReporters([customReporter]);
}
