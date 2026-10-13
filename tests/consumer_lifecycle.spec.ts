import { describe, expect, it, vi } from "vitest";
import { AtomValueTap } from "../src/core/atom_tap";
import { Grok } from "../src/core/grok";
import { GripRegistry } from "../src/core/grip";

function setup() {
  const registry = new GripRegistry();
  const projectId = registry.defineGrip<string>("ProjectId", "");
  const grok = new Grok(registry);
  const layout = grok.mainPresentationContext.createChild();
  const tab = layout.createChild();
  const atom = new AtomValueTap(projectId, "p3");
  grok.resolver.addProducer(layout, atom);
  const drip = grok.query(projectId, tab);
  grok.flush();
  const node = tab._getContextNode();
  const producer = layout._getContextNode().get_producers().get(projectId)!;
  return { grok, projectId, tab, atom, drip, node, producer };
}

describe("consumer re-registration", () => {
  it("keeps a subscriber that resumes on a memoized drip after cleanup", () => {
    const { grok, projectId, atom, drip, node } = setup();
    const unsubscribe = drip.subscribe(() => {});
    unsubscribe();
    grok.flush();
    expect(node.getLiveDripForGrip(projectId)).toBeUndefined();

    // React can retain its memoized drip while a background tab is unsubscribed.
    const listener = vi.fn();
    const unsubscribeAgain = drip.subscribe(listener);
    grok.flush();
    expect(drip.hasSubscribers()).toBe(true);
    expect(node.getLiveDripForGrip(projectId)).toBe(drip);
    atom.set("p4");
    grok.flush();
    expect(listener).toHaveBeenLastCalledWith("p4");
    unsubscribeAgain();
    grok.flush();
    expect(node.getLiveDripForGrip(projectId)).toBeUndefined();
  });

  it("fully unlinks a collected drip and initializes its replacement without an atom update", () => {
    const { grok, projectId, tab, drip, node, producer } = setup();
    expect(drip.get()).toBe("p3");
    const reference = node.consumers.get(projectId)!;
    // Simulate only this WeakRef being collected; do not depend on GC timing.
    vi.spyOn(reference, "deref").mockReturnValue(undefined);

    expect(node.getLiveDripForGrip(projectId)).toBeUndefined();
    expect(node.getResolvedProviders().has(projectId)).toBe(false);
    expect(producer.getDestinations().has(node)).toBe(false);
    const replacement = grok.query(projectId, tab);
    grok.flush();
    expect(replacement).not.toBe(drip);
    expect(replacement.get()).toBe("p3");
    expect(producer.getDestinations().has(node)).toBe(true);
  });

  it("initializes a replacement requested directly after collection", () => {
    const { grok, projectId, drip, node } = setup();
    vi.spyOn(node.consumers.get(projectId)!, "deref").mockReturnValue(undefined);
    const replacement = node.getOrCreateConsumer(projectId);
    const unsubscribe = replacement.subscribe(() => {});
    grok.flush();
    expect(replacement).not.toBe(drip);
    expect(replacement.get()).toBe("p3");
    unsubscribe();
    grok.flush();
  });

  it("does not let delayed cleanup from an old drip remove a replacement", () => {
    const { grok, projectId, atom, drip, node } = setup();
    const unsubscribeOld = drip.subscribe(() => {});
    unsubscribeOld();
    vi.spyOn(node.consumers.get(projectId)!, "deref").mockReturnValue(undefined);
    const replacement = node.getOrCreateConsumer(projectId);
    const listener = vi.fn();
    const unsubscribeNew = replacement.subscribe(listener);
    grok.flush();
    expect(node.getLiveDripForGrip(projectId)).toBe(replacement);
    atom.set("p4");
    grok.flush();
    expect(listener).toHaveBeenLastCalledWith("p4");
    unsubscribeNew();
    grok.flush();
  });

  it("reuses a queried drip across repeated cleanup and subscription cycles", () => {
    const { grok, projectId, tab, atom, drip, node } = setup();
    for (let i = 0; i < 3; i++) {
      const queried = grok.query(projectId, tab);
      expect(queried).toBe(drip);
      const listener = vi.fn();
      const unsubscribe = queried.subscribe(listener);
      atom.set(`p${i + 4}`);
      grok.flush();
      expect(listener).toHaveBeenLastCalledWith(`p${i + 4}`);
      unsubscribe();
      grok.flush();
      expect(node.getLiveDripForGrip(projectId)).toBeUndefined();
    }
  });
});
