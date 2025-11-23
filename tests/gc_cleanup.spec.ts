import { describe, it, expect } from "vitest";
import { Grok } from "../src/core/grok";
import { GripContext } from "../src/core/context";
import { GripRegistry } from "../src/core/grip";

describe("GC cleanup of parent-child relationships", () => {
  it("should properly clean up stale child references when nodes are removed", async () => {
    const grok = new Grok(new GripRegistry());
    const mainCtx = grok.mainPresentationContext;

    // Create child contexts
    const child1 = mainCtx.createChild();
    const child2 = mainCtx.createChild();
    const child1Id = child1.id;
    const child2Id = child2.id;

    // Verify children are tracked
    const mainNode = mainCtx.getContextNode();
    expect(mainNode.get_children_nodes().length).toBe(2);
    expect(mainNode.get_children_nodes().some((n) => n.id === child1Id)).toBe(true);
    expect(mainNode.get_children_nodes().some((n) => n.id === child2Id)).toBe(true);

    // Manually simulate what happens when contexts are GC'd
    // by clearing them from the nodes map and running clearContextNode
    const graph = (grok as any).graph as any;
    const child1Node = graph.nodes.get(child1Id);
    const child2Node = graph.nodes.get(child2Id);

    // Clear the nodes (simulating GC)
    graph.clearContextNode(child1Node);
    graph.clearContextNode(child2Node);
    graph.nodes.delete(child1Id);
    graph.nodes.delete(child2Id);

    // Now trigger the GC sweep to clean up stale references
    graph.gcSweep();

    // The main context should have cleaned up its children array
    expect(mainNode.get_children_nodes().length).toBe(0);

    // Check sanity - there should be no missing nodes
    const { nodes, missingNodes } = grok.getGraphSanityCheck();
    expect(missingNodes.size).toBe(0);
  });

  it("should handle complex parent-child relationships during node removal", async () => {
    const grok = new Grok(new GripRegistry());
    const rootCtx = grok.rootContext;
    const mainCtx = grok.mainPresentationContext;

    // Create a more complex hierarchy
    const parent1 = mainCtx.createChild();
    const parent2 = mainCtx.createChild();
    const child1 = parent1.createChild();
    const child2 = parent1.createChild();
    const child3 = parent2.createChild();

    // Add cross-links
    child3.addParent(parent1, 1); // child3 has two parents

    const parent1Id = parent1.id;
    const child1Id = child1.id;
    const child2Id = child2.id;
    const child3Id = child3.id;
    const parent2Id = parent2.id;

    // Verify initial state
    const parent1Node = parent1.getContextNode();
    const parent2Node = parent2.getContextNode();
    const child3Node = child3.getContextNode();

    expect(parent1Node.get_children_nodes().length).toBe(3); // child1, child2, child3
    expect(child3Node.get_parent_nodes().length).toBe(2); // parent2, parent1

    // Simulate removal of parent1 and its exclusive children
    const graph = (grok as any).graph as any;
    const child1Node = graph.nodes.get(child1Id);
    const child2Node = graph.nodes.get(child2Id);

    // Clear the nodes (simulating GC)
    graph.clearContextNode(parent1Node);
    graph.clearContextNode(child1Node);
    graph.clearContextNode(child2Node);
    graph.nodes.delete(parent1Id);
    graph.nodes.delete(child1Id);
    graph.nodes.delete(child2Id);

    // Run GC sweep to clean up stale references
    graph.gcSweep();

    // child3 should still exist (has another parent)
    expect(graph.nodes.has(child3Id)).toBe(true);

    // child3 should no longer have parent1 as a parent
    const updatedChild3Node = graph.nodes.get(child3Id);
    if (updatedChild3Node) {
      const parentIds = updatedChild3Node.get_parent_nodes().map((n) => n.id);
      expect(parentIds).not.toContain(parent1Id);
      expect(parentIds).toContain(parent2Id);
      expect(parentIds.length).toBe(1);
    }

    // parent2 should not have parent1's children
    expect(parent2Node.get_children_nodes().length).toBe(1); // only child3
    expect(parent2Node.get_children_nodes()[0].id).toBe(child3Id);

    // mainCtx should have cleaned up references to removed children
    const mainNode = mainCtx.getContextNode();
    expect(mainNode.get_children_nodes().some((n) => n.id === parent1Id)).toBe(false);
    expect(mainNode.get_children_nodes().some((n) => n.id === parent2Id)).toBe(true);
  });

  it("should clean up orphaned nodes in snapshotSanityCheck", () => {
    const grok = new Grok(new GripRegistry());
    const mainCtx = grok.mainPresentationContext;

    // Create child contexts
    const child1 = mainCtx.createChild();
    const child2 = mainCtx.createChild();

    // Manually corrupt the state by removing from nodes but keeping in children
    const graph = (grok as any).graph as any;
    const mainNode = mainCtx.getContextNode();

    // Remove child1 from nodes map but keep in children array
    graph.nodes.delete(child1.id);

    // Run sanity check - it should detect and report the orphaned node
    const { nodes, missingNodes } = grok.getGraphSanityCheck();

    // child1's node should be in missingNodes
    expect(Array.from(missingNodes).some((n) => n.id === child1.id)).toBe(true);

    // After sanity check, main's children should be cleaned up
    expect(mainNode.get_children_nodes().some((n) => n.id === child1.id)).toBe(false);
    expect(mainNode.get_children_nodes().some((n) => n.id === child2.id)).toBe(true);
  });
});
