import { describe, it, expect } from "vitest";
import {
  QueryEvaluator,
  QueryBinding,
  TapAttribution,
  AddBindingResult,
  RemoveBindingResult,
} from "../src/core/query_evaluator";
import { Grip } from "../src/core/grip";
import { Query, QueryBuilderFactory } from "../src/core/query";
import type { Tap, TapFactory } from "../src/core/tap";

// Helpers
const qb = () => new QueryBuilderFactory().newQuery();
const ctxWith = (entries: Array<[Grip<any>, any]>) => {
  const m = new Map<Grip<any>, any>(entries);
  return { getValue: (g: Grip<any>) => m.get(g) };
};

function makeTap(label: string, provides: readonly Grip<any>[]): Tap {
  return {
    provides,
    produce() {},
    getHomeContext() {
      return undefined;
    },
    getParamsContext() {
      return undefined;
    },
  } as unknown as Tap;
}

function makeEvaluator(
  useHybridEvaluation: boolean = false,
  useCache: boolean = true,
  initialBindings: QueryBinding[] = [],
  precomputationThreshold: number = 1000,
) {
  return new QueryEvaluator(
    initialBindings,
    precomputationThreshold,
    useHybridEvaluation,
    useCache,
  );
}

// Run all tests under a settings matrix
const combos: Array<[boolean, boolean]> = [
  [false, false],
  [true, false],
  [false, true],
];

// Normalize outputs for value equality checks and validate attribution
function normalizeAttributedOutputs(
  m: Map<Tap | TapFactory, TapAttribution>,
): Array<{ gripKey: string; bindingId: string; score: number }> {
  const arr: Array<{ gripKey: string; bindingId: string; score: number }> = [];
  for (const tapAttribution of m.values()) {
    // --- VALIDATION LOGIC ---
    const producer = tapAttribution.producerTap;
    const provides =
      typeof (producer as any)?.build === "function"
        ? (producer as TapFactory).provides
        : (producer as Tap).provides;

    if (!provides) {
      throw new Error(
        `Tap or Factory for binding ${tapAttribution.bindingId} is missing a 'provides' property.`,
      );
    }

    const providedGrips = new Set(provides);
    for (const attributedGrip of tapAttribution.attributedGrips) {
      if (!providedGrips.has(attributedGrip)) {
        throw new Error(
          `Attribution validation failed for binding '${tapAttribution.bindingId}'. ` +
            `Attributed grip '${attributedGrip.key}' is not provided by the tap.`,
        );
      }
    }
    // --- END VALIDATION ---

    for (const grip of tapAttribution.attributedGrips) {
      arr.push({
        gripKey: grip.key,
        bindingId: tapAttribution.bindingId,
        score: tapAttribution.score,
      });
    }
  }
  arr.sort(
    (a, b) =>
      (a.gripKey || "").localeCompare(b.gripKey || "") ||
      a.bindingId.localeCompare(b.bindingId) ||
      a.score - b.score,
  );
  return arr;
}

// Helper to find the winning attribution for a specific output grip
function findAttributionForGrip(
  result: Map<Tap | TapFactory, TapAttribution>,
  grip: Grip<any>,
): TapAttribution | undefined {
  for (const attribution of result.values()) {
    if (attribution.attributedGrips.has(grip)) {
      return attribution;
    }
  }
  return undefined;
}

// Helper to find an attribution record by the Tap/Factory that won it
function findAttributionForTap(
  result: Map<Tap | TapFactory, TapAttribution>,
  tap: Tap | TapFactory,
): TapAttribution | undefined {
  return result.get(tap);
}

// Helper to compare sets of Grips by their keys for stable assertion
function expectGripsToEqual(actual: Set<Grip<any>>, expected: Grip<any>[]) {
  const actualKeys = Array.from(actual)
    .map((g) => g.key)
    .sort();
  const expectedKeys = expected.map((g) => g.key).sort();
  expect(actualKeys).toEqual(expectedKeys);
}

// Exercise both cold and hot paths and assert identical results by value
function evalAndCheckStability(ev: QueryEvaluator, grips: Set<Grip<any>>, ctx: any) {
  const firstDelta = ev.onGripsChanged(grips, ctx);
  // The second call should produce no changes, as the state is now stable
  const secondDelta = ev.onGripsChanged(grips, ctx);
  expect(secondDelta.added.size).toBe(0);
  expect(secondDelta.removed.size).toBe(0);
  return firstDelta;
}

describe.each(combos)(
  "QueryEvaluator (useCache=%s, useHybridEvaluation=%s)",
  (useCache, useHybridEvaluation) => {
    describe("QueryEvaluator - attribution basics", () => {
      it("attributes a single matching binding to its outputs", () => {
        const out = new Grip<string>({ name: "out" });
        const color = new Grip<string>({ name: "color" });
        const tap = makeTap("tapA", [out]);
        const q: Query = qb().oneOf(color, "red", 10).build();

        const ev = makeEvaluator(useHybridEvaluation, useCache);
        const addResult = ev.addBinding({ id: "A", query: q, tap, baseScore: 5 });

        expectGripsToEqual(addResult.newInputs, [color]);
        expectGripsToEqual(addResult.removedInputs, []);
        expectGripsToEqual(ev.getAllInputGrips(), [color]);

        const { added, removed } = evalAndCheckStability(
          ev,
          new Set([color]),
          ctxWith([[color, "red"]]),
        );
        expect(added.size).toBe(1);
        expect(removed.size).toBe(0);
        const attr = findAttributionForGrip(added, out)!;
        expect(attr.bindingId).toBe("A");
        expect(attr.producerTap).toBe(tap);
        expect(attr.score).toBe(15);
        expectGripsToEqual(attr.attributedGrips, [out]);
      });

      it("independently attributes disjoint outputs", () => {
        const o1 = new Grip<string>({ name: "o1" });
        const o2 = new Grip<string>({ name: "o2" });
        const g = new Grip<string>({ name: "g" });
        const t1 = makeTap("t1", [o1]);
        const t2 = makeTap("t2", [o2]);
        const q1 = qb().oneOf(g, "x", 5).build();
        const q2 = qb().oneOf(g, "x", 6).build();

        const ev = makeEvaluator(useHybridEvaluation, useCache);
        const res1 = ev.addBinding({ id: "B1", query: q1, tap: t1, baseScore: 0 });
        const res2 = ev.addBinding({ id: "B2", query: q2, tap: t2, baseScore: 0 });

        expectGripsToEqual(res1.newInputs, [g]);
        expectGripsToEqual(res2.newInputs, []); // 'g' was already known
        expectGripsToEqual(ev.getAllInputGrips(), [g]);

        const { added, removed } = evalAndCheckStability(ev, new Set([g]), ctxWith([[g, "x"]]));
        expect(added.size).toBe(2);
        expect(removed.size).toBe(0);
        const attr1 = findAttributionForGrip(added, o1)!;
        const attr2 = findAttributionForGrip(added, o2)!;
        expect(attr1.bindingId).toBe("B1");
        expect(attr2.bindingId).toBe("B2");
        expectGripsToEqual(attr1.attributedGrips, [o1]);
        expectGripsToEqual(attr2.attributedGrips, [o2]);
      });
    });

    describe("QueryEvaluator - tie-breaks and partitions", () => {
      it("tie-breaks equal scores by bindingId (ascending)", () => {
        const out = new Grip<string>({ name: "out" });
        const toggle = new Grip<boolean>({ name: "toggle" });
        const t1 = makeTap("t1", [out]);
        const t2 = makeTap("t2", [out]);
        const q = qb().oneOf(toggle, true, 10).build();

        const ev = makeEvaluator(useHybridEvaluation, useCache);
        // Add B1 first to ensure order of addition doesn't determine outcome
        const res1 = ev.addBinding({ id: "B1", query: q, tap: t2, baseScore: 0 });
        const res2 = ev.addBinding({ id: "A1", query: q, tap: t1, baseScore: 0 });

        expectGripsToEqual(res1.newInputs, [toggle]);
        expectGripsToEqual(res2.newInputs, []);
        expectGripsToEqual(ev.getAllInputGrips(), [toggle]);

        const { added } = evalAndCheckStability(ev, new Set([toggle]), ctxWith([[toggle, true]]));
        const attr = findAttributionForGrip(added, out)!;
        expect(attr.bindingId).toBe("A1"); // A1 comes before B1 alphabetically
        expectGripsToEqual(attr.attributedGrips, [out]);
      });

      it("merges via overlapping outputs; removing a bridge splits and reattributes", () => {
        const o1 = new Grip<string>({ name: "o1" });
        const o2 = new Grip<string>({ name: "o2" });
        const gA = new Grip<string>({ name: "gA" });
        const gB = new Grip<string>({ name: "gB" });
        const gC = new Grip<string>({ name: "gC" });

        const tA = makeTap("A", [o1]);
        const tB = makeTap("B", [o2]);
        const tC = makeTap("C", [o1, o2]);

        const qA = qb().oneOf(gA, "yes", 10).build();
        const qB = qb().oneOf(gB, "yes", 10).build();
        const qC = qb().oneOf(gC, "yes", 15).build(); // highest

        const ev = makeEvaluator(useHybridEvaluation, useCache);
        ev.addBinding({ id: "A", query: qA, tap: tA, baseScore: 0 });
        ev.addBinding({ id: "B", query: qB, tap: tB, baseScore: 0 });
        ev.addBinding({ id: "C", query: qC, tap: tC, baseScore: 0 });

        expectGripsToEqual(ev.getAllInputGrips(), [gA, gB, gC]);

        // All match: C should win both outputs
        let { added } = evalAndCheckStability(
          ev,
          new Set([gA, gB, gC]),
          ctxWith([
            [gA, "yes"],
            [gB, "yes"],
            [gC, "yes"],
          ]),
        );
        const attrC = findAttributionForTap(added, tC)!;
        expect(attrC.bindingId).toBe("C");
        expectGripsToEqual(attrC.attributedGrips, [o1, o2]);
        expect(added.size).toBe(1); // Only one winning tap

        // Now C stops matching, expect outputs to reattribute to A and B
        const delta = evalAndCheckStability(
          ev,
          new Set([gC]),
          ctxWith([
            [gA, "yes"],
            [gB, "yes"],
            [gC, "no"],
          ]),
        );
        expect(delta.removed.size).toBe(1);
        expect(delta.added.size).toBe(2);
        const attrA = findAttributionForTap(delta.added, tA)!;
        const attrB = findAttributionForTap(delta.added, tB)!;
        expect(attrA.bindingId).toBe("A");
        expect(attrB.bindingId).toBe("B");
        expectGripsToEqual(attrA.attributedGrips, [o1]);
        expectGripsToEqual(attrB.attributedGrips, [o2]);
      });
    });

    describe("QueryEvaluator - edge cases and incremental updates", () => {
      it("does not match queries with no conditions", () => {
        const out = new Grip<string>({ name: "out" });
        const g = new Grip<string>({ name: "g" });
        const tap = makeTap("t", [out]);
        const empty = new Query(new Map());

        const ev = makeEvaluator(false);
        ev.addBinding({ id: "E", query: empty, tap, baseScore: 100 });

        expectGripsToEqual(ev.getAllInputGrips(), []);

        const { added } = evalAndCheckStability(ev, new Set([g]), ctxWith([[g, "anything"]]));
        expect(findAttributionForGrip(added, out)).toBeUndefined();
      });

      it("removeBinding on unknown id is a no-op", () => {
        const out = new Grip<string>({ name: "out" });
        const g = new Grip<string>({ name: "g" });
        const tap = makeTap("t", [out]);
        const q = qb().oneOf(g, "x", 10).build();
        const ev = makeEvaluator(false);
        ev.addBinding({ id: "ID", query: q, tap, baseScore: 0 });

        const removeResult = ev.removeBinding("UNKNOWN"); // should not throw
        expect(removeResult.removedInputs.size).toBe(0);

        expectGripsToEqual(ev.getAllInputGrips(), [g]);

        const { added } = evalAndCheckStability(ev, new Set([g]), ctxWith([[g, "x"]]));
        expect(findAttributionForGrip(added, out)?.bindingId).toBe("ID");
      });

      it("updates attribution when a matched binding score changes", () => {
        const out = new Grip<string>({ name: "out" });
        const g = new Grip<string>({ name: "g" });
        const stronger = makeTap("strong", [out]);
        const weaker = makeTap("weak", [out]);
        const qStrong = qb().oneOf(g, "a", 10).build();
        const qWeak = qb().oneOf(g, "a", 9).build();

        const ev = makeEvaluator(useHybridEvaluation, useCache);
        ev.addBinding({ id: "S", query: qStrong, tap: stronger, baseScore: 0 });
        ev.addBinding({ id: "W", query: qWeak, tap: weaker, baseScore: 0 });

        expectGripsToEqual(ev.getAllInputGrips(), [g]);

        let { added } = evalAndCheckStability(ev, new Set([g]), ctxWith([[g, "a"]]));
        expect(findAttributionForGrip(added, out)?.bindingId).toBe("S");

        // Change to make weaker become stronger
        const qWeak2 = qb().oneOf(g, "a", 11).build();
        // Replace binding by removing and re-adding with same id but different query/score
        const addResult = ev.addBinding({ id: "W", query: qWeak2, tap: weaker, baseScore: 0 });

        expectGripsToEqual(addResult.newInputs, []); // 'g' is already known
        expectGripsToEqual(addResult.removedInputs, []); // 'g' is still used by S
        expectGripsToEqual(ev.getAllInputGrips(), [g]);

        const delta = evalAndCheckStability(ev, new Set([g]), ctxWith([[g, "a"]]));
        expect(findAttributionForGrip(delta.added, out)?.bindingId).toBe("W");
      });

      it("handles partial matches where some grips are undefined", () => {
        const out = new Grip<string>({ name: "out" });
        const color = new Grip<string>({ name: "color" });
        const size = new Grip<string>({ name: "size" });
        const tap = makeTap("t", [out]);
        // Query depends on both color and size
        const q = qb().oneOf(color, "red", 10).oneOf(size, "L", 5).build();

        const ev = makeEvaluator(useHybridEvaluation, useCache);
        ev.addBinding({ id: "P", query: q, tap, baseScore: 0 });

        expectGripsToEqual(ev.getAllInputGrips(), [color, size]);

        // Context only provides color, size is undefined. The query should not match.
        let { added } = evalAndCheckStability(
          ev,
          new Set([color, size]),
          ctxWith([[color, "red"]]),
        );
        expect(findAttributionForGrip(added, out)).toBeUndefined();
      });

      it("handles a match disappearing when a grip value changes", () => {
        const out = new Grip<string>({ name: "out" });
        const color = new Grip<string>({ name: "color" });
        const tap = makeTap("t", [out]);
        const q = qb().oneOf(color, "red", 10).build();

        const ev = makeEvaluator(useHybridEvaluation, useCache);
        ev.addBinding({ id: "M", query: q, tap, baseScore: 0 });

        expectGripsToEqual(ev.getAllInputGrips(), [color]);

        // First, it matches
        let { added } = evalAndCheckStability(ev, new Set([color]), ctxWith([[color, "red"]]));
        expect(findAttributionForGrip(added, out)?.bindingId).toBe("M");

        // Then, the value changes and it no longer matches
        const delta = evalAndCheckStability(ev, new Set([color]), ctxWith([[color, "blue"]]));
        expect(delta.removed.size).toBe(1);
        expect(findAttributionForGrip(delta.removed, out)?.bindingId).toBe("M");
        expect(delta.added.size).toBe(0);
      });

      it("handles dynamic binding registration correctly", () => {
        const out = new Grip<string>({ name: "out" });
        const g = new Grip<string>({ name: "g" });
        const tapLow = makeTap("low", [out]);
        const tapHigh = makeTap("high", [out]);
        const q = qb().oneOf(g, "x", 10).build();

        const ev = makeEvaluator(useHybridEvaluation, useCache);
        // 1. Add low-scoring binding and evaluate
        ev.addBinding({ id: "LOW", query: q, tap: tapLow, baseScore: 0 });
        expectGripsToEqual(ev.getAllInputGrips(), [g]);
        let { added } = evalAndCheckStability(ev, new Set([g]), ctxWith([[g, "x"]]));
        expect(findAttributionForGrip(added, out)?.bindingId).toBe("LOW");

        // 2. Add a new, higher-scoring binding for the same query
        ev.addBinding({ id: "HIGH", query: q, tap: tapHigh, baseScore: 5 });
        expectGripsToEqual(ev.getAllInputGrips(), [g]);

        // 3. Re-evaluate
        const delta = evalAndCheckStability(ev, new Set([g]), ctxWith([[g, "x"]]));

        // 4. Assert the new binding wins
        expect(findAttributionForGrip(delta.added, out)?.bindingId).toBe("HIGH");
        expect(findAttributionForGrip(delta.removed, out)?.bindingId).toBe("LOW");
      });
    });

    describe("QueryEvaluator - Complex Partition Merging", () => {
      it("should merge partitions and re-attribute correctly when a high-scoring bridge tap is added", () => {
        const g1 = new Grip<string>({ name: "g1" });
        const g2 = new Grip<string>({ name: "g2" });
        const g3 = new Grip<string>({ name: "g3" });
        const o1 = new Grip<string>({ name: "o1" });
        const o2 = new Grip<string>({ name: "o2" });
        const o3 = new Grip<string>({ name: "o3" });

        const tA = makeTap("A", [o1]);
        const tB = makeTap("B", [o2, o3]);
        const tC_bridge = makeTap("C_Bridge", [o1, o3]); // Overlaps with A, introduces o3

        const qA = qb().oneOf(g1, "match", 10).build();
        const qB = qb().oneOf(g2, "match", 10).build();
        const qC = qb().oneOf(g3, "match", 20).build(); // Higher score for the same condition as qA

        const ev = makeEvaluator(useHybridEvaluation, useCache);
        ev.addBinding({ id: "A", query: qA, tap: tA, baseScore: 0 });
        ev.addBinding({ id: "B", query: qB, tap: tB, baseScore: 0 });

        const context = ctxWith([
          [g1, "match"],
          [g2, "match"],
          [g3, "match"],
        ]);
        const changedGrips = new Set([g1, g2, g3]);

        // 1. Initial state: A and B are in separate output partitions
        let { added } = evalAndCheckStability(ev, changedGrips, context);
        expect(findAttributionForGrip(added, o1)?.bindingId).toBe("A");
        expect(findAttributionForGrip(added, o2)?.bindingId).toBe("B");
        expect(findAttributionForGrip(added, o3)?.bindingId).toBe("B");

        // 2. Add the high-scoring bridge tap
        ev.addBinding({ id: "C", query: qC, tap: tC_bridge, baseScore: 0 });
        expectGripsToEqual(ev.getAllInputGrips(), [g1, g2, g3]);

        // 3. Re-evaluate. C should now win o1 because it has a higher score.
        //    B should still win o2 because C doesn't provide it.
        //    C should also provide o3.
        const delta = evalAndCheckStability(ev, changedGrips, context);
        expect(findAttributionForGrip(delta.added, o1)?.bindingId).toBe("C");
        expect(findAttributionForGrip(delta.added, o2)).toBeUndefined(); // B is unchanged, so not in delta
        expect(findAttributionForGrip(delta.added, o3)?.bindingId).toBe("C");
        expect(findAttributionForGrip(delta.removed, o1)?.bindingId).toBe("A");
        expect(findAttributionForGrip(delta.removed, o3)?.bindingId).toBe("B");
      });
    });

    it("reflects removal in delta even with no grip changes", () => {
      const out = new Grip<string>({ name: "out" });
      const color = new Grip<string>({ name: "color" });
      const tap = makeTap("tapA", [out]);
      const q: Query = qb().oneOf(color, "red", 10).build();

      const ev = makeEvaluator(useHybridEvaluation, useCache);
      ev.addBinding({ id: "A", query: q, tap, baseScore: 5 });

      // Initial evaluation
      const { added } = evalAndCheckStability(ev, new Set([color]), ctxWith([[color, "red"]]));
      expect(findAttributionForGrip(added, out)?.bindingId).toBe("A");

      // Remove the binding
      const removeResult = ev.removeBinding("A");
      expectGripsToEqual(removeResult.removedInputs, [color]);

      // Re-evaluate with NO grip changes
      const delta = evalAndCheckStability(ev, new Set(), ctxWith([[color, "red"]]));
      expect(delta.added.size).toBe(0);
      expect(delta.removed.size).toBe(1);
      expect(findAttributionForGrip(delta.removed, out)?.bindingId).toBe("A");
    });

    it("reflects addition in delta even with no grip changes", () => {
      const out = new Grip<string>({ name: "out" });
      const color = new Grip<string>({ name: "color" });
      const tap = makeTap("tapA", [out]);
      const q: Query = qb().oneOf(color, "red", 10).build();

      const ev = makeEvaluator(useHybridEvaluation, useCache);

      // Pre-warm the evaluator with an initial state and evaluation
      evalAndCheckStability(ev, new Set([color]), ctxWith([[color, "red"]]));

      // Add a binding that should match immediately
      ev.addBinding({ id: "A", query: q, tap, baseScore: 5 });

      // Evaluate with NO grip changes
      const delta = evalAndCheckStability(ev, new Set(), ctxWith([[color, "red"]]));
      expect(delta.removed.size).toBe(0);
      expect(delta.added.size).toBe(1);
      expect(findAttributionForGrip(delta.added, out)?.bindingId).toBe("A");
    });

    it("removing a non-attributed (overridden) binding results in a no-op delta", () => {
      const out = new Grip<string>({ name: "out" });
      const g = new Grip<string>({ name: "g" });
      const tapLow = makeTap("low", [out]);
      const tapHigh = makeTap("high", [out]);
      const q = qb().oneOf(g, "x", 10).build();

      const ev = makeEvaluator(useHybridEvaluation, useCache);

      // 1. Add low-scoring tap, confirm it wins
      ev.addBinding({ id: "LOW", query: q, tap: tapLow, baseScore: 0 });
      const { added: added1 } = evalAndCheckStability(ev, new Set([g]), ctxWith([[g, "x"]]));
      expect(findAttributionForGrip(added1, out)?.bindingId).toBe("LOW");

      // 2. Add high-scoring tap, confirm it overrides the low one
      ev.addBinding({ id: "HIGH", query: q, tap: tapHigh, baseScore: 5 });
      const delta2 = evalAndCheckStability(ev, new Set([g]), ctxWith([[g, "x"]]));
      expect(findAttributionForGrip(delta2.added, out)?.bindingId).toBe("HIGH");
      expect(findAttributionForGrip(delta2.removed, out)?.bindingId).toBe("LOW");

      // 3. Remove the low-scoring (and now non-attributed) binding
      ev.removeBinding("LOW");

      // 4. Evaluate with no grip changes. Should be a no-op.
      const delta3 = evalAndCheckStability(ev, new Set([]), ctxWith([[g, "x"]]));
      expect(delta3.added.size).toBe(0);
      expect(delta3.removed.size).toBe(0);
    });

    // Using .skip to prevent this from running on every file change during development.
    // Remove .skip to run the performance benchmark.
    describe.skip("QueryEvaluator - Performance", () => {
      const NUM_QUERIES = 15;
      const NUM_ITERATIONS = 10000;

      // Setup a complex scenario
      const grips = Array.from({ length: 5 }, (_, i) => new Grip<number>({ name: `g${i}` }));
      const outGrip = new Grip<string>({ name: "perfOut" });
      const bindings: QueryBinding[] = [];

      for (let i = 0; i < NUM_QUERIES; i++) {
        const grip1 = grips[i % grips.length];
        const grip2 = grips[(i + 1) % grips.length];
        const query = qb()
          .oneOf(grip1, i, 1)
          .oneOf(grip2, i + 1, 1)
          .build();
        const tap = makeTap(`tap${i}`, [outGrip]);
        bindings.push({ id: `perf_${i}`, query, tap, baseScore: 0 });
      }

      const context = ctxWith([
        [grips[0], 0],
        [grips[1], 1],
      ]);
      const changedGrips = new Set([grips[0], grips[1]]);

      it(`measures runtime evaluation for ${NUM_ITERATIONS} iterations`, () => {
        const ev = makeEvaluator(false, true, bindings, 10000); // Hybrid eval disabled
        const start = performance.now();
        for (let i = 0; i < NUM_ITERATIONS; i++) {
          ev.onGripsChanged(changedGrips, context);
        }
        const end = performance.now();
        const duration = end - start;
        console.log(`Runtime Evaluation (${NUM_ITERATIONS} iterations): ${duration.toFixed(2)}ms`);
        // This is a benchmark, not a functional assertion. We expect it to complete.
        expect(duration).toBeGreaterThan(0);
      });

      it(`measures hybrid evaluation for ${NUM_ITERATIONS} iterations`, () => {
        const ev = makeEvaluator(true, true, bindings, 10000); // Hybrid eval enabled
        const start = performance.now();
        for (let i = 0; i < NUM_ITERATIONS; i++) {
          ev.onGripsChanged(changedGrips, context);
        }
        const end = performance.now();
        const duration = end - start;
        console.log(`Hybrid Evaluation (${NUM_ITERATIONS} iterations): ${duration.toFixed(2)}ms`);
        // This is a benchmark, not a functional assertion. We expect it to complete.
        expect(duration).toBeGreaterThan(0);
      });
    });
  },
);
