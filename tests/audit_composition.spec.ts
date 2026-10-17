import { describe, expect, it, vi } from "vitest";
import { Grok } from "../src/core/grok";
import { GripContext } from "../src/core/context";
import { GripRegistry } from "../src/core/grip";
import { AtomValueTap } from "../src/core/atom_tap";
import { createFunctionTap } from "../src/core/function_tap";
import { withOneOf } from "../src/core/query";
import { QueryEvaluator } from "../src/core/query_evaluator";

function setup() {
  const registry = new GripRegistry();
  return { registry, grok: new Grok(registry) };
}

describe("audit composition regressions", () => {
  it("C1 re-resolves a child and descendants after adding a preferred parent", () => {
    const { registry, grok } = setup();
    const value = registry.defineGrip("value", "default");
    const first = new GripContext(grok);
    const second = new GripContext(grok);
    second.registerTap(new AtomValueTap(value, "second"));
    const child = first.createChild(),
      descendant = child.createChild();
    const drips = [child, descendant].map((ctx) => grok.query(value, ctx));
    drips.forEach((d) => d.subscribe(() => {}));
    grok.flush();
    child.addParent(second, -1);
    grok.flush();
    expect(drips.map((d) => d.get())).toEqual(["second", "second"]);
    expect(() => second.addParent(descendant)).toThrow(/Cycle/);
    grok.flush();
    expect(drips.map((d) => d.get())).toEqual(["second", "second"]);
  });

  it("C2 preserves retained inputs when replacing a binding", () => {
    const { registry, grok } = setup();
    const input = registry.defineGrip("input", "off"),
      out = registry.defineGrip("out", "default");
    const atom = new AtomValueTap(input, "on"),
      tap = new AtomValueTap(out, "winner");
    grok.registerTap(atom);
    const binding = { id: "rule", query: withOneOf(input, "on").build(), tap, baseScore: 0 };
    grok.addBinding(binding);
    const drip = grok.query(out, grok.mainContext);
    drip.subscribe(() => {});
    grok.flush();
    grok.addBinding({ ...binding, query: withOneOf(input, "on", 2).build() });
    grok.flush();
    expect(drip.get()).toBe("winner");
    atom.set("off");
    grok.flush();
    expect(drip.get()).toBe("default");
    atom.set("on");
    grok.flush();
    expect(drip.get()).toBe("winner");
  });

  it.each([true, false])(
    "C3 keeps shared Query indexing after removing one binding (cache %s)",
    (cache) => {
      const { registry } = setup();
      const input = registry.defineGrip("input", "on"),
        a = registry.defineGrip("a"),
        b = registry.defineGrip("b");
      const query = withOneOf(input, "on").build();
      const tapA = new AtomValueTap(a),
        tapB = new AtomValueTap(b);
      const evaluator = new QueryEvaluator(
        [
          { id: "a", query, tap: tapA, baseScore: 0 },
          { id: "b", query, tap: tapB, baseScore: 0 },
        ],
        1000,
        true,
        cache,
      );
      const changed = new Set([input]);
      evaluator.onGripsChanged(changed, { getValue: () => "on" });
      evaluator.removeBinding("a");
      evaluator.onGripsChanged(changed, { getValue: () => "on" });
      expect(evaluator.onGripsChanged(changed, { getValue: () => "off" }).removed.has(tapB)).toBe(
        true,
      );
      expect(evaluator.onGripsChanged(changed, { getValue: () => "on" }).added.has(tapB)).toBe(
        true,
      );
    },
  );

  it.each([false, true])(
    "C4 seeds late matcher inputs (existing subscribed input %s)",
    (existing) => {
      const { registry, grok } = setup();
      const initial = registry.defineGrip("initial", "on"),
        input = registry.defineGrip("input", "on");
      const a = registry.defineGrip("a"),
        out = registry.defineGrip("out", "default");
      grok.addBinding({
        id: "first",
        query: withOneOf(initial, "on").build(),
        tap: new AtomValueTap(a),
        baseScore: 0,
      });
      if (existing) {
        grok.registerTap(new AtomValueTap(input, "on"));
        grok.query(input, grok.mainHomeContext).subscribe(() => {});
      }
      grok.flush();
      grok.addBinding({
        id: "late",
        query: withOneOf(input, "on").build(),
        tap: new AtomValueTap(out, "winner"),
        baseScore: 0,
      });
      const drip = grok.query(out, grok.mainContext);
      drip.subscribe(() => {});
      grok.flush();
      expect(drip.get()).toBe("winner");
    },
  );

  it("C5 subscribes to destination parameters once and releases them", () => {
    const { registry, grok } = setup();
    const input = registry.defineGrip("input", 0),
      out = registry.defineGrip<number>("out");
    const ctx = grok.mainPresentationContext.createChild(),
      atom = new AtomValueTap(input, 1);
    ctx.registerTap(atom);
    const compute = vi.fn(({ getDestParam }) => new Map([[out, getDestParam(input)]]));
    grok.registerTap(
      createFunctionTap({ provides: [out], destinationParamGrips: [input], compute }),
    );
    const drip = grok.query(out, ctx),
      off = drip.subscribe(() => {});
    grok.flush();
    compute.mockClear();
    atom.set(2);
    grok.flush();
    expect(compute).toHaveBeenCalledTimes(1);
    off();
    grok.flush();
    compute.mockClear();
    expect(ctx.getOrCreateConsumer(input).hasSubscribers()).toBe(false);
    atom.set(3);
    grok.flush();
    expect(compute).not.toHaveBeenCalled();
  });

  it.each(["set", "remove"])(
    "C6 propagates defined-to-undefined destination parameters via %s",
    (action) => {
      const { registry, grok } = setup();
      const input = registry.defineGrip<number | undefined>("input"),
        out = registry.defineGrip<string>("out");
      const ctx = grok.mainPresentationContext.createChild(),
        atom = new AtomValueTap(input, 1);
      ctx.registerTap(atom);
      grok.registerTap(
        createFunctionTap({
          provides: [out],
          destinationParamGrips: [input],
          compute: ({ getDestParam }) => new Map([[out, String(getDestParam(input))]]),
        }),
      );
      const drip = grok.query(out, ctx);
      drip.subscribe(() => {});
      grok.flush();
      if (action === "set") atom.set(undefined);
      else ctx.unregisterTap(atom);
      grok.flush();
      expect(drip.get()).toBe("undefined");
    },
  );

  it("C7 repeated same-home registration is idempotent and cleans up home inputs", () => {
    const { registry, grok } = setup();
    const input = registry.defineGrip("input", 0),
      out = registry.defineGrip<number>("out");
    const atom = new AtomValueTap(input, 1);
    grok.registerTap(atom);
    const compute = vi.fn(({ getHomeParam }) => new Map([[out, getHomeParam(input)]]));
    const tap = createFunctionTap({ provides: [out], homeParamGrips: [input], compute });
    grok.registerTap(tap);
    grok.query(out, grok.mainContext).subscribe(() => {});
    grok.flush();
    grok.registerTap(tap);
    grok.flush();
    compute.mockClear();
    atom.set(2);
    grok.flush();
    expect(compute).toHaveBeenCalledTimes(1);
    grok.unregisterTap(tap);
    grok.flush();
    expect(grok.mainHomeContext.getOrCreateConsumer(input).hasSubscribers()).toBe(false);
  });
});
