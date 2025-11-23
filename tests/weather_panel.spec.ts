import { describe, it, expect } from "vitest";
import { Grok } from "../src/core/grok";
import { GripRegistry, GripOf } from "../src/core/grip";
import { Drip } from "../src/core/drip";
import { createAtomValueTap } from "../src/core/atom_tap";
import type { AtomTap } from "../src/core/atom_tap";

describe("WeatherPanel-style multi-context, multi-parent with independent simple taps", () => {
  it("each context uses its local provider and updates independently", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const VALUE = defineGrip<string>("WP.Value", "init");
    const VALUE_TAP = defineGrip<AtomTap<string>>("WP.ValueTap", undefined as any);

    const grok = new Grok(registry);

    // Build DAG: A (root child), B (parent A), C (parent A)
    const A = grok.mainPresentationContext.createChild();
    const B = A.createChild();
    const C = A.createChild();

    // Register one simple tap per context with distinct initials
    const tapA = createAtomValueTap(VALUE, { initial: "A", handleGrip: VALUE_TAP });
    grok.registerTapAt(A, tapA as unknown as any);

    const tapB = createAtomValueTap(VALUE, { initial: "B", handleGrip: VALUE_TAP });
    grok.registerTapAt(B, tapB as unknown as any);

    const tapC = createAtomValueTap(VALUE, { initial: "C", handleGrip: VALUE_TAP });
    grok.registerTapAt(C, tapC as unknown as any);

    // Connect: query both value and controller drips at each destination
    const vA1 = grok.query(VALUE, A);
    const hA = grok.query(VALUE_TAP, A);
    const vB1 = grok.query(VALUE, B);
    const hB = grok.query(VALUE_TAP, B);
    const vC1 = grok.query(VALUE, C);
    const hC = grok.query(VALUE_TAP, C);

    expect(vA1.get()).toBe("A");
    expect(vB1.get()).toBe("B");
    expect(vC1.get()).toBe("C");

    // Update B via its controller; A and C should remain unchanged
    hB.get()!.set("BB");
    expect(grok.query(VALUE, B).get()).toBe("BB");
    expect(grok.query(VALUE, A).get()).toBe("A");
    expect(grok.query(VALUE, C).get()).toBe("C");

    // Update A via its controller; B and C should remain unchanged (C has its own local provider)
    hA.get()!.set("AA");
    expect(grok.query(VALUE, A).get()).toBe("AA");
    expect(grok.query(VALUE, B).get()).toBe("BB");
    expect(grok.query(VALUE, C).get()).toBe("C");

    // Update C; only C should change
    hC.get()!.set("CC");
    expect(grok.query(VALUE, C).get()).toBe("CC");
    expect(grok.query(VALUE, A).get()).toBe("AA");
    expect(grok.query(VALUE, B).get()).toBe("BB");
  });
});
