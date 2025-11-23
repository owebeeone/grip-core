/**
 * @file: query_utils.spec.ts
 * @description: Unit tests for the DisjointSetPartitioner utility.
 */

import { describe, it, expect } from "vitest";
import { DisjointSetPartitioner } from "../src/core/query_utils";

// Normalization utilities to compare partitions with Vitest's native diff, ignoring order.
function normalizePartitions<T extends { id: string }>(partitions: Iterable<Set<T>>): T[][] {
  const compareItems = (a: T, b: T) => a.id.localeCompare(b.id);
  const compareSets = (a: T[], b: T[]) => {
    if (a.length === 0 || b.length === 0) return a.length - b.length;
    return a[0].id.localeCompare(b[0].id);
  };
  return Array.from(partitions)
    .map((s) => Array.from(s).sort(compareItems))
    .sort(compareSets);
}

function normalizeArrays<T extends { id: string }>(expected: T[][]): T[][] {
  const compareItems = (a: T, b: T) => a.id.localeCompare(b.id);
  const compareSets = (a: T[], b: T[]) => {
    if (a.length === 0 || b.length === 0) return a.length - b.length;
    return a[0].id.localeCompare(b[0].id);
  };
  return expected.map((arr) => [...arr].sort(compareItems)).sort(compareSets);
}

describe("DisjointSetPartitioner", () => {
  // Mock items for testing. Using simple objects with an ID.
  const itemA = { id: "A" };
  const itemB = { id: "B" };
  const itemC = { id: "C" };
  const itemD = { id: "D" };
  const itemE = { id: "E" };
  const itemF = { id: "F" };

  it("should place items with no shared characteristics into separate partitions", () => {
    const partitioner = new DisjointSetPartitioner<{ id: string }, string>();
    const pA = partitioner.add(itemA, ["red"]);
    const pB = partitioner.add(itemB, ["blue"]);
    const pC = partitioner.add(itemC, ["green"]);

    expect(pA).not.toBe(pB);
    expect(pA).not.toBe(pC);
    expect(pB).not.toBe(pC);
    expect(pA.items.has(itemA)).toBe(true);
    expect(pB.items.has(itemB)).toBe(true);
    expect(pC.items.has(itemC)).toBe(true);

    const partitions = partitioner.getPartitions();
    expect(normalizePartitions(partitions)).toEqual(normalizeArrays([[itemA], [itemB], [itemC]]));
  });

  it("should place items with shared characteristics into the same partition", () => {
    const partitioner = new DisjointSetPartitioner<{ id: string }, string>();
    const pA = partitioner.add(itemA, ["red", "circle"]);
    const pB = partitioner.add(itemB, ["blue", "square"]);
    const pC = partitioner.add(itemC, ["green", "circle"]);

    expect(pA).toBe(pC);
    expect(pB).not.toBe(pA);

    const partitions = partitioner.getPartitions();
    expect(normalizePartitions(partitions)).toEqual(normalizeArrays([[itemA, itemC], [itemB]]));
  });

  it("should merge partitions when a new item bridges them", () => {
    const partitioner = new DisjointSetPartitioner<{ id: string }, string>();
    const pA = partitioner.add(itemA, ["red"]);
    const pB = partitioner.add(itemB, ["blue"]);

    // Before bridging, they are separate
    expect(normalizePartitions(partitioner.getPartitions())).toEqual(
      normalizeArrays([[itemA], [itemB]]),
    );

    // Add itemC that shares characteristics with both A and B
    const pC = partitioner.add(itemC, ["red", "blue"]);

    expect(pA).not.toBe(pB);
    expect(pC).toBe(pA);

    const partitions = partitioner.getPartitions();
    expect(normalizePartitions(partitions)).toEqual(normalizeArrays([[itemA, itemB, itemC]]));
  });

  it("should handle removal of an item that does not split a partition", () => {
    const partitioner = new DisjointSetPartitioner<{ id: string }, string>();
    partitioner.add(itemA, ["red"]);
    partitioner.add(itemB, ["red"]);
    partitioner.add(itemC, ["red"]);

    const removed = partitioner.remove(itemB);
    expect(removed).not.toBeNull();
    expect(removed!.items.has(itemA)).toBe(true);
    expect(removed!.items.has(itemC)).toBe(true);
    const partitions = partitioner.getPartitions();
    expect(normalizePartitions(partitions)).toEqual(normalizeArrays([[itemA, itemC]]));

    const newParts = partitioner.repartitionDirtySets(); // should do nothing
    expect(newParts.size).toBe(0);

    const partitions2 = partitioner.getPartitions();
    expect(normalizePartitions(partitions2)).toEqual(normalizeArrays([[itemA, itemC]]));
  });

  it("should handle removal of an item that splits a partition", () => {
    const partitioner = new DisjointSetPartitioner<{ id: string }, string>();
    partitioner.add(itemA, ["red"]);
    partitioner.add(itemB, ["blue"]);
    partitioner.add(itemC, ["red", "blue"]); // C is the bridge

    // All are in one partition initially
    expect(normalizePartitions(partitioner.getPartitions())).toEqual(
      normalizeArrays([[itemA, itemB, itemC]]),
    );

    // Removing the bridge should split the partition
    const removed = partitioner.remove(itemC);
    expect(removed).not.toBeNull();
    const splitParts = partitioner.repartitionDirtySets();
    expect(splitParts.size).toBe(2);

    const partitions = partitioner.getPartitions();
    expect(normalizePartitions(partitions)).toEqual(normalizeArrays([[itemA], [itemB]]));
  });

  it("should handle complex splitting and merging", () => {
    const partitioner = new DisjointSetPartitioner<{ id: string }, string>();
    partitioner.add(itemA, ["1", "2"]);
    partitioner.add(itemB, ["2", "3"]);
    partitioner.add(itemC, ["3", "4"]);
    partitioner.add(itemD, ["5", "6"]);
    partitioner.add(itemE, ["6", "7"]);

    // We expect two partitions: {A, B, C} and {D, E}
    expect(normalizePartitions(partitioner.getPartitions())).toEqual(
      normalizeArrays([
        [itemA, itemB, itemC],
        [itemD, itemE],
      ]),
    );

    // Remove the central link in the first partition
    partitioner.remove(itemB);
    partitioner.repartitionDirtySets();
    expect(normalizePartitions(partitioner.getPartitions())).toEqual(
      normalizeArrays([[itemA], [itemC], [itemD, itemE]]),
    );

    // Add a new item F that links A and D
    partitioner.add(itemF, ["1", "5"]);
    expect(normalizePartitions(partitioner.getPartitions())).toEqual(
      normalizeArrays([[itemA, itemD, itemE, itemF], [itemC]]),
    );
  });

  it("should correctly re-partition after multiple removals", () => {
    const partitioner = new DisjointSetPartitioner<{ id: string }, string>();
    partitioner.add(itemA, ["1"]);
    partitioner.add(itemB, ["1", "2"]);
    partitioner.add(itemC, ["2", "3"]);
    partitioner.add(itemD, ["3"]);

    expect(normalizePartitions(partitioner.getPartitions())).toEqual(
      normalizeArrays([[itemA, itemB, itemC, itemD]]),
    );

    // Removing the two middle items should leave A and D separate
    partitioner.remove(itemB);
    partitioner.remove(itemC);

    // If the partitioner is dirty it will return the partitions that
    // the remaining items are in.
    const partitions = partitioner.getPartitions();
    expect(normalizePartitions(partitions)).toEqual(normalizeArrays([[itemA, itemD]]));

    partitioner.repartitionDirtySets();
    const partitions2 = partitioner.getPartitions();
    expect(normalizePartitions(partitions2)).toEqual(normalizeArrays([[itemA], [itemD]]));
  });

  it("should do nothing when removing an item that does not exist", () => {
    const partitioner = new DisjointSetPartitioner<{ id: string }, string>();
    partitioner.add(itemA, ["red"]);
    partitioner.remove(itemB); // itemB was never added
    partitioner.repartitionDirtySets();
    expect(normalizePartitions(partitioner.getPartitions())).toEqual(normalizeArrays([[itemA]]));
  });

  it("should handle removing the last item from a partition", () => {
    const partitioner = new DisjointSetPartitioner<{ id: string }, string>();
    partitioner.add(itemA, ["red"]);
    partitioner.add(itemB, ["blue"]);

    partitioner.remove(itemA);
    expect(normalizePartitions(partitioner.getPartitions())).toEqual(normalizeArrays([[itemB]]));
    partitioner.repartitionDirtySets();
    expect(normalizePartitions(partitioner.getPartitions())).toEqual(normalizeArrays([[itemB]]));

    partitioner.remove(itemB);
    expect(normalizePartitions(partitioner.getPartitions())).toEqual(normalizeArrays([]));
    partitioner.repartitionDirtySets();
    expect(normalizePartitions(partitioner.getPartitions())).toEqual(normalizeArrays([]));
  });
});

// -----------------------------------------------------------------------------
// TupleMap and createCompositeKey tests
// -----------------------------------------------------------------------------
import { TupleMap, createCompositeKey } from "../src/core/query_utils";

describe("TupleMap", () => {
  it("stores and retrieves mixed-type tuple keys", () => {
    const m = new TupleMap<[string, number, boolean, ...any], string>();
    const object = { id: 42 };
    const object2 = { id: 42 }; // same id, different object.
    m.set(["id", 42, true, object], "answer");
    m.set(["id", 7, false], "seven");

    expect(m.get(["id", 42, true, object])).toBe("answer");
    expect(m.get(["id", 42, true, object2])).toBeUndefined(); // different key!
    expect(m.get(["id", 7, false])).toBe("seven");
    expect(m.get(["id", 7, true])).toBeUndefined();
  });

  it("treats object identity in keys (same ref matches, different ref does not)", () => {
    const a = { x: 1 };
    const b = { x: 1 };
    const m = new TupleMap<[object, string], number>();
    m.set([a, "k"], 1);

    expect(m.get([a, "k"])).toBe(1);
    expect(m.get([b, "k"])).toBeUndefined();
  });

  it("supports has, delete, size, clear", () => {
    const m = new TupleMap<[string], number>();
    m.set(["a"], 1);
    m.set(["b"], 2);
    expect(m.size()).toBe(2);
    expect(m.has(["a"])).toBe(true);
    expect(m.delete(["a"])).toBe(true);
    expect(m.has(["a"])).toBe(false);
    expect(m.size()).toBe(1);
    m.clear();
    expect(m.size()).toBe(0);
  });

  it("iterates lazily with keys/values/entries and default iterator", () => {
    const m = new TupleMap<[string, number], string>();
    m.set(["a", 1], "A1");
    m.set(["b", 2], "B2");

    const keys = Array.from(m.keys());
    expect(keys).toEqual([
      ["a", 1],
      ["b", 2],
    ]);

    const values = Array.from(m.values());
    expect(values).toEqual(["A1", "B2"]);

    const entries = Array.from(m.entries());
    expect(entries).toEqual([
      [["a", 1], "A1"],
      [["b", 2], "B2"],
    ]);

    const spreadEntries = [...m];
    expect(spreadEntries).toEqual(entries);
  });
});

describe("createCompositeKey", () => {
  it("encodes primitives with type prefixes and length-prefixed strings", () => {
    const key = createCompositeKey(["str|pipe", 123, true, false, 0]);
    // Expect s:<len>:<raw>, n:<num>, b:<bool>
    expect(key).toBe("s:8:str|pipe|n:123|b:true|b:false|n:0");
  });

  it("represents null and undefined distinctly", () => {
    const key = createCompositeKey([null, undefined, "x"]);
    expect(key).toBe("N:|U:|s:1:x");
  });

  it("uses reference identity for objects", () => {
    const obj1 = { a: 1 };
    const obj2 = { a: 1 };
    const k1 = createCompositeKey([obj1, "x"]);
    const k2 = createCompositeKey([obj1, "x"]);
    const k3 = createCompositeKey([obj2, "x"]);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it("normalizes special numbers (-0, NaN)", () => {
    const kNegZero = createCompositeKey([-0]);
    const kPosZero = createCompositeKey([0]);
    expect(kNegZero).toBe("n:0");
    expect(kPosZero).toBe("n:0");
    const kNaN1 = createCompositeKey([NaN]);
    const kNaN2 = createCompositeKey([NaN]);
    expect(kNaN1).toBe("n:NaN");
    expect(kNaN2).toBe("n:NaN");
  });
});
