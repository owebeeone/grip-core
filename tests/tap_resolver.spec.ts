import { describe, it, expect, beforeEach } from "vitest";
import { Grok } from "../src/core/grok";
import { Grip, GripRegistry } from "../src/core/grip";
import { GripContext } from "../src/core/context";
import { Tap, TapFactory } from "../src/core/tap";
import { SimpleResolver } from "../src/core/tap_resolver";
import {
  EvaluationDelta,
  TapAttribution,
  QueryEvaluator,
  QueryBinding,
} from "../src/core/query_evaluator";
import { MultiAtomValueTap } from "../src/core/atom_tap";
import { QueryBuilderFactory } from "../src/core/query";

describe("SimpleResolver", () => {
  let grok: Grok;
  let resolver: SimpleResolver;

  // Grips
  const gripRegistry = new GripRegistry();
  const gripA = gripRegistry.defineGrip<string>("a", "a");
  const gripB = gripRegistry.defineGrip<string>("b", "b");
  const gripM = gripRegistry.defineGrip<string>("m", "m");
  const gripN = gripRegistry.defineGrip<string>("n", "n");
  const gripO = gripRegistry.defineGrip<string>("o", "o");

  beforeEach(() => {
    grok = new Grok(gripRegistry); // Instantiate Grok first (resolver is optional in constructor)
    resolver = new SimpleResolver(grok); // Instantiate SimpleResolver with grok
    (grok as any).resolver = resolver; // Assign the resolver back to grok
  });

  const getResolvedContextId = (consumer: GripContext, grip: Grip<any>): string | undefined => {
    const consumerNode = consumer._getContextNode();
    const producerNode = consumerNode.getResolvedProviders().get(grip);
    return producerNode?.get_context()?.id;
  };

  const getResolvedTap = (consumer: GripContext, grip: Grip<any>): Tap | undefined => {
    const consumerNode = consumer._getContextNode();
    const producerNode = consumerNode.getResolvedProviders().get(grip);
    const producerRecord = producerNode?.get_producers().get(grip);
    return producerRecord?.tap;
  };

  const registerProducer = (context: GripContext, tap: Tap) => {
    resolver.addProducer(context, tap);
  };

  const addConsumer = (context: GripContext, grip: Grip<any>) => {
    resolver.addConsumer(context, grip);
  };

  it("Scenario 1: Simple Case", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(ca, 0, "cb");
    registerProducer(ca, new MultiAtomValueTap([gripA], undefined));
    addConsumer(cb, gripA);
    expect(getResolvedContextId(cb, gripA)).toBe(ca.id);
  });

  it("Scenario 2: Transitive Case", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(ca, 0, "cb");
    const cc = grok.createContext(cb, 0, "cc");
    registerProducer(ca, new MultiAtomValueTap([gripA], undefined));
    addConsumer(cc, gripA);
    expect(getResolvedContextId(cc, gripA)).toBe(ca.id);
  });

  it("Scenario 3: Producer Shadowing by Ancestor", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(ca, 0, "cb");
    const cc = grok.createContext(cb, 0, "cc");
    registerProducer(ca, new MultiAtomValueTap([gripA], undefined));
    registerProducer(cb, new MultiAtomValueTap([gripA], undefined));
    addConsumer(cc, gripA);
    expect(getResolvedContextId(cc, gripA)).toBe(cb.id);
  });

  it("Scenario 4: Priority-Based Resolution", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(grok.rootContext, 0, "cb");
    const cc = grok.createContext(ca, 0, "cc");
    const cd = grok.createContext(cc, 0, "cd");
    cd.addParent(cb, 1); // Lower priority
    registerProducer(cb, new MultiAtomValueTap([gripA], undefined));
    registerProducer(cc, new MultiAtomValueTap([gripA], undefined));
    addConsumer(cd, gripA);
    expect(getResolvedContextId(cd, gripA)).toBe(cc.id);
  });

  it("Scenario 5: Producer Shadowing by Key", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(ca, 0, "cb");
    const cc = grok.createContext(cb, 0, "cc");
    registerProducer(ca, new MultiAtomValueTap([gripM, gripN, gripO], undefined));
    registerProducer(cb, new MultiAtomValueTap([gripN], undefined));
    addConsumer(cc, gripN);
    addConsumer(cc, gripO);
    expect(getResolvedContextId(cc, gripN)).toBe(cb.id);
    expect(getResolvedContextId(cc, gripO)).toBe(ca.id);
  });

  it("Scenario 6: Dynamic Re-Parenting", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(grok.rootContext, 0, "cb");
    const cc = grok.createContext(undefined, 0, "cc");
    cc.addParent(ca, 1);
    registerProducer(ca, new MultiAtomValueTap([gripA], undefined));
    registerProducer(cb, new MultiAtomValueTap([gripA], undefined));
    addConsumer(cc, gripA);
    expect(getResolvedContextId(cc, gripA)).toBe(ca.id);
    cc.addParent(cb, 0); // Add higher-priority parent
    resolver.addParent(cc, cb); // Notify resolver of parent change
    expect(getResolvedContextId(cc, gripA)).toBe(cb.id);
  });

  it("Scenario 7: Parent Link Removal & Re-linking", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(grok.rootContext, 0, "cb");
    const cc = grok.createContext(ca, 0, "cc");
    cc.addParent(cb, 1);
    registerProducer(ca, new MultiAtomValueTap([gripA], undefined));
    registerProducer(cb, new MultiAtomValueTap([gripA], undefined));
    addConsumer(cc, gripA);
    expect(getResolvedContextId(cc, gripA)).toBe(ca.id);
    // Remove the parent link using grok's API (or a simulated equivalent if not directly available)
    // For testing, we can temporarily re-add the parent with a lower priority if it was removed.
    // However, the test scenario is about unlinking, so we call resolver.unlinkParent directly.
    resolver.unlinkParent(cc, ca);
    expect(getResolvedContextId(cc, gripA)).toBe(cb.id);
  });

  it("Scenario 8: Producer Removal", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(grok.rootContext, 0, "cb");
    const cc = grok.createContext(ca, 0, "cc");
    cc.addParent(cb, 1);
    const tapA = new MultiAtomValueTap([gripA], undefined);
    registerProducer(ca, tapA);
    registerProducer(cb, new MultiAtomValueTap([gripA], undefined));
    addConsumer(cc, gripA);
    expect(getResolvedContextId(cc, gripA)).toBe(ca.id);
    grok.unregisterTap(tapA); // Use the public API for unregistering tap
    // We expect removeProducer to be called internally by unregisterTap or resolver reacts.
    // resolver.removeProducer(ca, tapA); // This is now triggered by unregisterTap
    expect(getResolvedContextId(cc, gripA)).toBe(cb.id);
  });

  it("Scenario 9: Adding a Shadowing Producer", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(ca, 0, "cb");
    registerProducer(ca, new MultiAtomValueTap([gripA], undefined));
    addConsumer(cb, gripA);
    expect(getResolvedContextId(cb, gripA)).toBe(ca.id);
    const tapB = new MultiAtomValueTap([gripA], undefined);
    registerProducer(cb, tapB);
    resolver.addProducer(cb, tapB);
    expect(getResolvedContextId(cb, gripA)).toBe(cb.id);
  });

  it("Scenario 10: No Producer Available", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(ca, 0, "cb");
    addConsumer(cb, gripA);
    expect(getResolvedContextId(cb, gripA)).toBeUndefined();
  });

  it("Scenario 11: Consumer in Same Context as Producer", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    registerProducer(ca, new MultiAtomValueTap([gripA], undefined));
    addConsumer(ca, gripA);
    expect(getResolvedContextId(ca, gripA)).toBe(ca.id);
  });

  it("Scenario 12: Removing a Consumer", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(ca, 0, "cb");
    registerProducer(ca, new MultiAtomValueTap([gripA], undefined));
    addConsumer(cb, gripA);
    expect(getResolvedContextId(cb, gripA)).toBe(ca.id);
    resolver.removeConsumer(cb, gripA);
    expect(getResolvedContextId(cb, gripA)).toBeUndefined();
  });

  it("Scenario 13: Fallback to Ancestor After Self-Producer Removal", () => {
    const cb = grok.createContext(grok.rootContext, 0, "cb");
    const ca = grok.createContext(cb, 0, "ca");
    registerProducer(cb, new MultiAtomValueTap([gripA], undefined));
    const tapA = new MultiAtomValueTap([gripA], undefined);
    registerProducer(ca, tapA);
    addConsumer(ca, gripA);
    expect(getResolvedContextId(ca, gripA)).toBe(ca.id);
    grok.unregisterTap(tapA); // Use the public API for unregistering tap
    // resolver.removeProducer(ca, tapA); // This is now triggered by unregisterTap
    expect(getResolvedContextId(ca, gripA)).toBe(cb.id);
  });

  it("Scenario 14: Root Parent De-prioritization", () => {
    const rootCa = grok.rootContext; // $CA
    const cb = grok.createContext(grok.rootContext, 0, "cb");
    const cd = grok.createContext(rootCa, 0, "cd");
    cd.addParent(cb, 1);
    registerProducer(rootCa, new MultiAtomValueTap([gripA], undefined));
    registerProducer(cb, new MultiAtomValueTap([gripA], undefined));
    addConsumer(cd, gripA);
    // Even though rootCa has priority 0, the non-root cb is checked first.
    expect(getResolvedContextId(cd, gripA)).toBe(cb.id);
  });

  it("Scenario 15: Diamond Dependency Resolution", () => {
    const rootCa = grok.rootContext; // $CA
    const cb = grok.createContext(rootCa, 0, "cb");
    const cc = grok.createContext(rootCa, 0, "cc");
    const cd = grok.createContext(cb, 0, "cd");
    cd.addParent(cc);
    registerProducer(rootCa, new MultiAtomValueTap([gripA], undefined));
    registerProducer(cc, new MultiAtomValueTap([gripA], undefined));
    addConsumer(cd, gripA);
    // The producer in `cc` is found first in the BFS.
    expect(getResolvedContextId(cd, gripA)).toBe(cc.id);
  });

  it("Scenario 16: Cascading Re-linking after Producer Removal", () => {
    const ca = grok.createContext(grok.rootContext, 0, "ca");
    const cb = grok.createContext(ca, 0, "cb");
    const cc = grok.createContext(cb, 0, "cc");
    const cd = grok.createContext(cc, 0, "cd");
    const tapB = new MultiAtomValueTap([gripA], undefined);
    registerProducer(ca, new MultiAtomValueTap([gripA], undefined));
    registerProducer(cb, tapB);
    addConsumer(cc, gripA);
    addConsumer(cd, gripA);
    expect(getResolvedContextId(cc, gripA)).toBe(cb.id);
    expect(getResolvedContextId(cd, gripA)).toBe(cb.id);
    grok.unregisterTap(tapB); // Use the public API for unregistering tap
    // resolver.removeProducer(cb, tapB); // This is now triggered by unregisterTap
    expect(getResolvedContextId(cc, gripA)).toBe(ca.id);
    expect(getResolvedContextId(cd, gripA)).toBe(ca.id);
  });

  describe("applyProducerDelta", () => {
    it("should add a new tap and its grips, equivalent to addProducer", () => {
      const context = grok.createContext(grok.rootContext, 0, "ctx");
      const consumer = grok.createContext(context, 0, "consumer");

      const tapA = new MultiAtomValueTap([gripA], new Map([[gripA, "valA"]]));
      const delta: EvaluationDelta = {
        added: new Map<Tap | TapFactory, TapAttribution>([
          [
            tapA,
            { producerTap: tapA, score: 1, bindingId: "a", attributedGrips: new Set([gripA]) },
          ],
        ]),
        removed: new Map(),
      };

      resolver.applyProducerDelta(context, delta);
      grok.flush();

      addConsumer(consumer, gripA);
      expect(getResolvedContextId(consumer, gripA)).toBe(context.id);
      expect(getResolvedTap(consumer, gripA)).toBe(tapA);
    });

    it("should remove an existing tap and its grips, equivalent to removeProducer", () => {
      const context = grok.createContext(grok.rootContext, 0, "ctx");
      const consumer = grok.createContext(context, 0, "consumer");
      const tapA = new MultiAtomValueTap([gripA], new Map([[gripA, "valA"]]));

      registerProducer(context, tapA);
      addConsumer(consumer, gripA);
      expect(getResolvedContextId(consumer, gripA)).toBe(context.id);

      const delta: EvaluationDelta = {
        added: new Map(),
        removed: new Map<Tap | TapFactory, TapAttribution>([
          [
            tapA,
            { producerTap: tapA, score: 1, bindingId: "a", attributedGrips: new Set([gripA]) },
          ],
        ]),
      };

      resolver.applyProducerDelta(context, delta);
      grok.flush();
      expect(getResolvedContextId(consumer, gripA)).toBeUndefined();
    });

    it("should handle complex grip transfers between taps", () => {
      const context = grok.createContext(grok.rootContext, 0, "ctx");
      const consumer = grok.createContext(context, 0, "consumer");

      // Initial state
      const tapA = new MultiAtomValueTap(
        [gripA, gripM],
        new Map([
          [gripA, "valA"],
          [gripM, "valA"],
        ]),
      ); // provides gripA, gripM
      const tapB = new MultiAtomValueTap(
        [gripB, gripN],
        new Map([
          [gripB, "valB"],
          [gripN, "valB"],
        ]),
      ); // provides gripB, gripN
      registerProducer(context, tapA);
      registerProducer(context, tapB);

      addConsumer(consumer, gripA);
      addConsumer(consumer, gripM);
      addConsumer(consumer, gripB);
      addConsumer(consumer, gripN);

      expect(getResolvedTap(consumer, gripA)).toBe(tapA);
      expect(getResolvedTap(consumer, gripM)).toBe(tapA);
      expect(getResolvedTap(consumer, gripB)).toBe(tapB);
      expect(getResolvedTap(consumer, gripN)).toBe(tapB);

      // Delta introduces tapC which takes over gripM from tapA and gripN from tapB
      const tapC = new MultiAtomValueTap(
        [gripM, gripN],
        new Map([
          [gripM, "valC"],
          [gripN, "valC"],
        ]),
      );
      const delta: EvaluationDelta = {
        added: new Map<Tap | TapFactory, TapAttribution>([
          [
            tapC,
            {
              producerTap: tapC,
              score: 1,
              bindingId: "c",
              attributedGrips: new Set([gripM, gripN]),
            },
          ],
        ]),
        removed: new Map<Tap | TapFactory, TapAttribution>([
          [
            tapA,
            { producerTap: tapA, score: 1, bindingId: "a", attributedGrips: new Set([gripM]) },
          ],
          [
            tapB,
            { producerTap: tapB, score: 1, bindingId: "b", attributedGrips: new Set([gripN]) },
          ],
        ]),
      };

      resolver.applyProducerDelta(context, delta);
      grok.flush();

      // Verify final state
      expect(getResolvedTap(consumer, gripA)).toBe(tapA); // Unchanged
      expect(getResolvedTap(consumer, gripB)).toBe(tapB); // Unchanged
      expect(getResolvedTap(consumer, gripM)).toBe(tapC); // Transferred
      expect(getResolvedTap(consumer, gripN)).toBe(tapC); // Transferred
    });

    it("should update drip values on grip transfer", () => {
      const context = grok.createContext(grok.rootContext, 0, "ctx");
      const consumerCtx = grok.createContext(context, 0, "consumer");
      const consumerDrip = consumerCtx.getOrCreateConsumer(gripA);

      const tapA = new MultiAtomValueTap([gripA], new Map([[gripA, "valueFromA"]]));
      registerProducer(context, tapA);

      let value: any;
      consumerDrip.subscribe((v) => {
        value = v;
      });

      tapA.produce(); // Initial value
      grok.flush();
      expect(value).toBe("valueFromA");

      // Delta introduces tapB which takes over gripA
      const tapB = new MultiAtomValueTap([gripA], new Map([[gripA, "valueFromB"]]));
      const delta: EvaluationDelta = {
        added: new Map([
          [
            tapB,
            { producerTap: tapB, score: 1, bindingId: "b", attributedGrips: new Set([gripA]) },
          ],
        ]),
        removed: new Map([
          [
            tapA,
            { producerTap: tapA, score: 1, bindingId: "a", attributedGrips: new Set([gripA]) },
          ],
        ]),
      };

      resolver.applyProducerDelta(context, delta);
      tapB.produce();

      // The value should be updated after the new producer is in place and produces.
      grok.flush();
      expect(value).toBe("valueFromB");
    });

    it("should correctly process a real delta from a QueryEvaluator", () => {
      const qb = () => new QueryBuilderFactory().newQuery();
      const ctxWith = (entries: Array<[Grip<any>, any]>) => {
        const m = new Map<Grip<any>, any>(entries);
        return { getValue: (g: Grip<any>) => m.get(g) };
      };

      // Grips
      const controlGrip = new Grip<string>({ name: "control" });

      // Taps
      const tapA = new MultiAtomValueTap(
        [gripA, gripM],
        new Map([
          [gripA, "valA"],
          [gripM, "valM"],
        ]),
      );
      const tapB = new MultiAtomValueTap(
        [gripB, gripN],
        new Map([
          [gripB, "valB"],
          [gripN, "valN"],
        ]),
      );
      const tapC = new MultiAtomValueTap(
        [gripM, gripN],
        new Map([
          [gripM, "valM"],
          [gripN, "valN"],
        ]),
      );

      // Queries
      const q_base = qb().oneOf(controlGrip, "base", 10).build();
      const q_transfer = qb().oneOf(controlGrip, "transfer", 20).build();

      // Setup
      const evaluator = new QueryEvaluator();
      const context = grok.createContext(grok.rootContext, 0, "ctx");
      const consumer = grok.createContext(context, 0, "consumer");
      addConsumer(consumer, gripA);
      addConsumer(consumer, gripM);
      addConsumer(consumer, gripB);
      addConsumer(consumer, gripN);

      // 1. Establish initial state with tapA and tapB active
      evaluator.addBinding({ id: "A", query: q_base, tap: tapA, baseScore: 0 });
      evaluator.addBinding({ id: "B", query: q_base, tap: tapB, baseScore: 0 });

      const initialDelta = evaluator.onGripsChanged(
        new Set([controlGrip]),
        ctxWith([[controlGrip, "base"]]),
      );
      resolver.applyProducerDelta(context, initialDelta);
      grok.flush();

      expect(getResolvedTap(consumer, gripA)).toBe(tapA);
      expect(getResolvedTap(consumer, gripM)).toBe(tapA);
      expect(getResolvedTap(consumer, gripB)).toBe(tapB);
      expect(getResolvedTap(consumer, gripN)).toBe(tapB);

      // 2. Introduce tapC with a higher score to trigger a transfer
      evaluator.addBinding({ id: "C", query: q_transfer, tap: tapC, baseScore: 0 });
      const transferDelta = evaluator.onGripsChanged(
        new Set([controlGrip]),
        ctxWith([[controlGrip, "transfer"]]),
      );

      // This is the real test: apply the transfer delta
      resolver.applyProducerDelta(context, transferDelta);
      grok.flush();

      // 3. Assert the final state after transfer
      expect(getResolvedTap(consumer, gripA)).toBeUndefined(); // tapA is no longer active
      expect(getResolvedTap(consumer, gripB)).toBeUndefined(); // tapB is no longer active
      expect(getResolvedTap(consumer, gripM)).toBe(tapC); // Transferred
      expect(getResolvedTap(consumer, gripN)).toBe(tapC); // Transferred

      // 4. Remove binding B and re-evaluate. This should be a no-op as B is not active.
      evaluator.removeBinding("B");
      const removalDelta = evaluator.onGripsChanged(
        new Set(),
        ctxWith([[controlGrip, "transfer"]]),
      );

      // This should be an empty delta
      expect(removalDelta.added.size).toBe(0);
      expect(removalDelta.removed.size).toBe(0);

      resolver.applyProducerDelta(context, removalDelta);

      // 5. Assert the state is unchanged
      expect(getResolvedTap(consumer, gripA)).toBeUndefined();
      expect(getResolvedTap(consumer, gripB)).toBeUndefined();
      expect(getResolvedTap(consumer, gripM)).toBe(tapC);
      expect(getResolvedTap(consumer, gripN)).toBe(tapC);
    });
  });
});
