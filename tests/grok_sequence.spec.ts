import { describe, expect, it } from "vitest";
import { Grok } from "../src/core/grok";
import { GripRegistry } from "../src/core/grip";

describe("Grok local mutation sequence", () => {
  it("allocates a monotonic local origin mutation sequence", () => {
    const grok = new Grok(new GripRegistry());

    expect(grok.getLastOriginMutationSeq()).toBe(0);
    expect(grok.allocateOriginMutationSeq()).toBe(1);
    expect(grok.allocateOriginMutationSeq()).toBe(2);
    expect(grok.allocateOriginMutationSeq()).toBe(3);
    expect(grok.getLastOriginMutationSeq()).toBe(3);
  });
});
