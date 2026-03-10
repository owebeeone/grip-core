import { describe, expect, it } from "vitest";

import { Grok, GripRegistry } from "../src";

describe("context identity", () => {
  it("reuses deterministic named children via getOrCreateChild", () => {
    const grok = new Grok(new GripRegistry());

    const first = grok.mainPresentationContext.getOrCreateChild("stable-child");
    const second = grok.mainPresentationContext.getOrCreateChild("stable-child");

    expect(first).toBe(second);
    expect(first.id).toBe("main-presentation/stable-child");
  });

  it("rejects duplicate named children created explicitly", () => {
    const grok = new Grok(new GripRegistry());

    grok.mainPresentationContext.createChild("dup-child");

    expect(() => grok.mainPresentationContext.createChild("dup-child")).toThrow(
      /already has a child named 'dup-child'/,
    );
  });
});
