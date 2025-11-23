import { describe, it, expect, beforeEach } from "vitest";
import { Grok } from "../src/core/grok";
import { Grip, GripRegistry } from "../src/core/grip";
import { GripContext } from "../src/core/context";
import { Tap } from "../src/core/tap";
import { SimpleResolver } from "../src/core/tap_resolver";
import { MultiAtomValueTap } from "../src/core/atom_tap";
import { QueryBuilderFactory } from "../src/core/query";
import { TapMatcher, MatchingContext } from "../src/core/matcher";
import { DualContextContainer } from "../src/core/containers";

describe("TapMatcher Integration with SimpleResolver", () => {
  let grok: Grok;
  let resolver: SimpleResolver;
  const gripRegistry = new GripRegistry();
  const gripA = gripRegistry.defineGrip<string>("a", "a");
  const gripM = gripRegistry.defineGrip<string>("m", "m");
  const gripN = gripRegistry.defineGrip<string>("n", "n");

  const getResolvedTap = (consumer: GripContext, grip: Grip<any>): Tap | undefined => {
    const consumerNode = grok.ensureNode(consumer);
    const producerNode = consumerNode.getResolvedProviders().get(grip);
    const producerRecord = producerNode?.get_producers().get(grip);
    return producerRecord?.tap;
  };

  beforeEach(() => {
    grok = new Grok(gripRegistry);
    resolver = new SimpleResolver(grok);
    (grok as any).resolver = resolver;
  });

  it("should drive tap transfers via query evaluation", async () => {
    const qb = () => new QueryBuilderFactory().newQuery();

    // --- Setup ---
    // Contexts
    const home = grok.createContext(grok.rootContext, 0, "home");
    const presentation = grok.createContext(grok.rootContext, 0, "presentation");
    const consumer = grok.createContext(presentation, 0, "consumer");
    const container = new DualContextContainer(home, presentation);

    // Grips
    const controlGrip = gripRegistry.defineGrip<string>("control");
    const controlAtom = new MultiAtomValueTap([controlGrip], new Map([[controlGrip, "base"]]));
    home.registerTap(controlAtom); // Tap that controls which other taps are active

    // Taps to be matched
    const tapA = new MultiAtomValueTap(
      [gripA, gripM],
      new Map([
        [gripA, "valA"],
        [gripM, "valA"],
      ]),
    );
    const tapB = new MultiAtomValueTap(
      [gripM, gripN],
      new Map([
        [gripM, "valB"],
        [gripN, "valB"],
      ]),
    );

    // Queries
    const qA = qb().oneOf(controlGrip, "base", 10).build();
    const qB = qb().oneOf(controlGrip, "transfer", 20).build();

    // Matcher
    const matcher = new TapMatcher(container);
    matcher.addBinding({ id: "A", query: qA, tap: tapA, baseScore: 0 });
    matcher.addBinding({ id: "B", query: qB, tap: tapB, baseScore: 0 });

    // Add consumers to the final destination
    consumer.getOrCreateConsumer(gripA);
    consumer.getOrCreateConsumer(gripM);
    consumer.getOrCreateConsumer(gripN);

    // --- Initial State ---
    grok.flush(); // Run matcher's initial evaluation

    expect(getResolvedTap(consumer, gripA)).toBe(tapA);
    expect(getResolvedTap(consumer, gripM)).toBe(tapA);
    expect(getResolvedTap(consumer, gripN)).toBeUndefined();

    // --- Trigger Transfer ---
    controlAtom.set(controlGrip, "transfer"); // Change the control value
    grok.flush(); // Run matcher reaction and delta application

    // --- Final State ---
    expect(getResolvedTap(consumer, gripA)).toBeUndefined(); // tapA lost all grips
    expect(getResolvedTap(consumer, gripM)).toBe(tapB); // Transferred
    expect(getResolvedTap(consumer, gripN)).toBe(tapB); // Newly provided
  });
});

describe("MatchingContext Integration", () => {
  let grok: Grok;
  let resolver: SimpleResolver;
  const gripRegistry = new GripRegistry();
  const gripA = gripRegistry.defineGrip<string>("a", "a");
  const gripM = gripRegistry.defineGrip<string>("m", "m");
  const gripN = gripRegistry.defineGrip<string>("n", "n");

  const getResolvedTap = (consumer: GripContext, grip: Grip<any>): Tap | undefined => {
    const consumerNode = grok.ensureNode(consumer);
    const producerNode = consumerNode.getResolvedProviders().get(grip);
    const producerRecord = producerNode?.get_producers().get(grip);
    return producerRecord?.tap;
  };

  beforeEach(() => {
    grok = new Grok(gripRegistry);
    resolver = new SimpleResolver(grok);
    (grok as any).resolver = resolver;
  });

  it("should drive tap transfers using its internal TapMatcher", () => {
    const qb = () => new QueryBuilderFactory().newQuery();

    // --- Setup ---
    const home = grok.createContext(grok.rootContext, 0, "home");
    const presentation = grok.createContext(grok.rootContext, 0, "presentation");
    const consumer = grok.createContext(presentation, 0, "consumer");

    // Use the new MatchingContext
    const matchingContext = new MatchingContext(home, presentation);

    const controlGrip = gripRegistry.defineGrip<string>("control");
    const controlAtom = new MultiAtomValueTap([controlGrip], new Map([[controlGrip, "base"]]));
    home.registerTap(controlAtom);

    const tapA = new MultiAtomValueTap(
      [gripA, gripM],
      new Map([
        [gripA, "valA"],
        [gripM, "valA"],
      ]),
    );
    const tapB = new MultiAtomValueTap(
      [gripM, gripN],
      new Map([
        [gripM, "valB"],
        [gripN, "valB"],
      ]),
    );

    const qA = qb().oneOf(controlGrip, "base", 10).build();
    const qB = qb().oneOf(controlGrip, "transfer", 20).build();

    // Use the context's binding methods
    matchingContext.addBinding({ id: "A", query: qA, tap: tapA, baseScore: 0 });
    matchingContext.addBinding({ id: "B", query: qB, tap: tapB, baseScore: 0 });

    consumer.getOrCreateConsumer(gripA);
    consumer.getOrCreateConsumer(gripM);
    consumer.getOrCreateConsumer(gripN);

    // --- Initial State ---
    grok.flush();

    expect(getResolvedTap(consumer, gripA)).toBe(tapA);
    expect(getResolvedTap(consumer, gripM)).toBe(tapA);
    expect(getResolvedTap(consumer, gripN)).toBeUndefined();

    // --- Trigger Transfer ---
    controlAtom.set(controlGrip, "transfer");
    grok.flush();

    // --- Final State ---
    expect(getResolvedTap(consumer, gripA)).toBeUndefined();
    expect(getResolvedTap(consumer, gripM)).toBe(tapB);
    expect(getResolvedTap(consumer, gripN)).toBe(tapB);
  });
});
