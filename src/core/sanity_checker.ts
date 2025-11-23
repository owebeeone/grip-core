/**
 * GRIP Graph Sanity Checker - Graph validation and consistency checking
 *
 * Provides validation and sanity checking for the GRIP graph to detect
 * inconsistencies, memory leaks, and structural issues. This is essential
 * for debugging and maintaining the integrity of the data flow graph.
 *
 * Key Features:
 * - Bidirectional relationship validation
 * - Memory leak detection
 * - Parameter subscription validation
 * - Graph structure consistency checking
 * - Issue reporting and categorization
 *
 * Validation Rules:
 * - Parent-child relationship consistency
 * - Parameter-only destination detection
 * - Subscription cleanup verification
 * - Graph connectivity validation
 *
 * Use Cases:
 * - Development and debugging
 * - Memory leak detection
 * - Graph integrity verification
 * - Performance optimization analysis
 */

import { Grok } from "./grok";
import { Grip } from "./grip";
import { Drip } from "./drip";
import { GripContextNode, ProducerRecord } from "./graph";
import type { Tap } from "./tap";

/**
 * Represents a sanity check issue found in the graph.
 *
 * @property contextId - The ID of the context where the issue was found
 * @property message - Description of the issue
 */
export type SanityIssue = { contextId: string; message: string };

/**
 * Validates the GRIP graph for consistency and potential issues.
 *
 * The GripGraphSanityChecker performs comprehensive validation of the graph
 * structure, relationships, and memory management. It detects issues that
 * could indicate bugs, memory leaks, or performance problems.
 *
 * Key Validation Areas:
 * - Parent-child relationship consistency
 * - Parameter subscription cleanup
 * - Destination management
 * - Memory leak detection
 * - Graph connectivity
 */
export class GripGraphSanityChecker {
  private readonly issuesByContextId = new Map<string, string>();

  /**
   * Creates a new sanity checker for the specified GROK instance.
   *
   * @param grok - The GROK engine to validate
   */
  constructor(private readonly grok: Grok) {
    this.buildIndex();
  }

  /**
   * Builds the issue index by scanning the entire graph.
   *
   * Performs comprehensive validation of the graph structure and
   * relationships, identifying potential issues and memory leaks.
   */
  private buildIndex(): void {
    // Rule: param-only destinations without outputs

    const { nodes, missingNodes } = this.grok.getGraphSanityCheck();
    for (const node of nodes.values()) {
      // Validate parent-child relationship consistency
      for (const child of node.get_children_nodes()) {
        if (!child.get_parent_nodes().includes(node)) {
          this.addIssue(
            child,
            `Parent ${node.id} has child ${child.id} but child does not have parent ${node.id}`,
          );
        }
      }

      // Validate producer destinations and parameter subscriptions
      for (const [, rec] of node.get_producers()) {
        for (const [destNode, destination] of rec.getDestinations()) {
          const outputs = Array.from(destination.getGrips());
          const tap: any = rec.tap as any;
          const hasDestParams =
            Array.isArray(tap.destinationParamGrips) && tap.destinationParamGrips.length > 0;

          // Determine whether all destination-parameter drips have zero subscribers
          const paramDrips = Array.from(destination.getDestinationParamDrips().values());
          const allParamSubsZero = paramDrips.every((d) => {
            const anyDrip = d as any;
            const a = anyDrip?.subs instanceof Set ? anyDrip.subs.size : 0;
            const b = anyDrip?.immediateSubs instanceof Set ? anyDrip.immediateSubs.size : 0;
            return a + b === 0;
          });

          // Detect param-only destinations without outputs (potential memory leak)
          if (hasDestParams && outputs.length === 0) {
            // Flag: tap maintains a param-only destination; include hint if params also unsubscribed
            const msg = allParamSubsZero
              ? `Drip unsubscribe failed: param-only destination and no param subscribers`
              : `Drip unsubscribe failed: param-only destination without outputs`;
            this.addIssue(destNode, msg);
          }
        }
      }
    }
  }

  /**
   * Adds an issue for a specific context node.
   *
   * If the node already has issues, the new issue is appended to the
   * existing message to provide comprehensive reporting.
   *
   * @param node - The context node where the issue was found
   * @param msg - Description of the issue
   */
  addIssue(node: GripContextNode, msg: string): void {
    if (!this.issuesByContextId.has(node.id)) {
      this.issuesByContextId.set(node.id, msg);
    } else {
      const current = this.issuesByContextId.get(node.id);
      if (current) {
        this.issuesByContextId.set(node.id, `${current}\n${msg}`);
      }
    }
  }

  /**
   * Gets the sanity check report for a specific context.
   *
   * @param node - The context node to check
   * @returns The issue message for the context, or null if no issues found
   */
  reportContext(node: GripContextNode): string | null {
    return this.issuesByContextId.get(node.id) ?? null;
  }

  /**
   * Runs all sanity checks and returns all found issues.
   *
   * @returns Array of all sanity issues found in the graph
   */
  runAll(): SanityIssue[] {
    const out: SanityIssue[] = [];
    for (const [contextId, message] of this.issuesByContextId) out.push({ contextId, message });
    return out;
  }
}
