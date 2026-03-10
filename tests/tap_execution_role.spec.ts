import { describe, expect, it } from "vitest";
import { Grok } from "../src/core/grok";
import { GripGraphDumper } from "../src/core/graph_dump";
import { GripOf, GripRegistry } from "../src/core/grip";
import { createAsyncValueTap } from "../src/core/async_tap";
import { createAtomValueTap } from "../src/core/atom_tap";
import { createFunctionTap } from "../src/core/function_tap";

describe("Tap execution ownership", () => {
  it("exposes default execution mode and role by tap type", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const INPUT = defineGrip<number>("Mode.Input", 0);
    const OUTPUT = defineGrip<number>("Mode.Output", 0);

    const atom = createAtomValueTap(INPUT, { initial: 1 });
    const fn = createFunctionTap({
      provides: [OUTPUT],
      homeParamGrips: [INPUT],
      compute: ({ getHomeParam }) =>
        new Map([[OUTPUT, getHomeParam(INPUT) ?? 0]]),
    });
    const asyncTap = createAsyncValueTap({
      provides: OUTPUT,
      destinationParamGrips: [INPUT],
      fetcher: async (dest) => (dest.get(INPUT) ?? 0) * 10,
    });

    expect(atom.getExecutionMode()).toBe("replicated");
    expect(atom.getExecutionRole()).toBe("primary");
    expect(fn.getExecutionMode()).toBe("origin-primary");
    expect(fn.getExecutionRole()).toBe("primary");
    expect(asyncTap.getExecutionMode()).toBe("origin-primary");
    expect(asyncTap.getExecutionRole()).toBe("primary");
  });

  it("suppresses function tap publication while in follower role and resumes with same identity", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const INPUT = defineGrip<number>("Role.Input", 0);
    const OUTPUT = defineGrip<number>("Role.Output", 0);
    const grok = new Grok(registry);
    const ctx = grok.mainPresentationContext.createChild("ctx_1");

    const source = createAtomValueTap(INPUT, { initial: 3 });
    grok.registerTap(source);

    const fn = createFunctionTap({
      provides: [OUTPUT],
      homeParamGrips: [INPUT],
      compute: ({ getHomeParam }) =>
        new Map([[OUTPUT, getHomeParam(INPUT) ?? 0]]),
    });
    const stableId = fn.id;
    fn.setExecutionRole("follower");
    grok.registerTap(fn);

    const drip = grok.query(OUTPUT, ctx);
    grok.flush();
    expect(drip.get()).toBe(0);

    fn.setExecutionRole("primary");
    fn.produce();
    grok.flush();
    expect(fn.id).toBe(stableId);
    expect(drip.get()).toBe(3);

    source.set(5);
    grok.flush();
    expect(drip.get()).toBe(5);

    fn.setExecutionRole("follower");
    source.set(7);
    grok.flush();
    expect(drip.get()).toBe(5);
  });

  it("includes execution ownership metadata in graph dumps", () => {
    const registry = new GripRegistry();
    const defineGrip = GripOf(registry);
    const INPUT = defineGrip<number>("Dump.Input", 0);
    const grok = new Grok(registry);

    const atom = createAtomValueTap(INPUT, { initial: 1 });
    grok.registerTap(atom);

    const dump = new GripGraphDumper({ grok }).dump();
    const tapNode = dump.nodes.taps.find((node) => node.class === "AtomValueTap");
    expect(tapNode?.executionMode).toBe("replicated");
    expect(tapNode?.executionRole).toBe("primary");
  });
});
