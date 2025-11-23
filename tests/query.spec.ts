import { describe, it, expect } from "vitest";

import { GripRegistry } from "../src/core/grip";
import { QueryBuilderFactory, withAnyOf, withOneOf } from "../src/core/query";

const registry = new GripRegistry();
const MODE = registry.defineGrip<string>("mode");
const REGION = registry.defineGrip<string>("region");
const TAGS = registry.defineGrip<string[]>("tags");

describe("QueryBuilder (fluent)", () => {
  const qb = new QueryBuilderFactory();

  it("chains oneOf/anyOf and builds conditions map", () => {
    const q = qb
      .newQuery()
      .oneOf(MODE, "live", 5)
      .anyOf(REGION, ["us", "eu"], 2)
      .oneOf(TAGS, ["featured", "new"], 10)
      .build();

    expect(q.conditions.size).toBe(3);

    const modeConditions = q.conditions.get(MODE);
    expect(modeConditions?.size).toBe(1);
    expect(modeConditions?.get("live")).toBe(5);

    const regionConditions = q.conditions.get(REGION);
    expect(regionConditions?.size).toBe(2);
    expect(regionConditions?.get("us")).toBe(2);
    expect(regionConditions?.get("eu")).toBe(2);

    const tagsConditions = q.conditions.get(TAGS);
    expect(tagsConditions?.size).toBe(1);
    const tagsKey = tagsConditions?.keys().next().value;
    expect(tagsKey).toEqual(["featured", "new"]);
    expect(tagsConditions?.get(tagsKey)).toBe(10);
  });

  it("merges conditions for the same grip value", () => {
    const q = qb.newQuery().oneOf(MODE, "live", 5).oneOf(MODE, "live", 3).build();

    expect(q.conditions.size).toBe(1);
    const modeConditions = q.conditions.get(MODE);
    expect(modeConditions?.size).toBe(1);
    expect(modeConditions?.get("live")).toBe(3);
  });

  it("defaults score to 100 when not provided", () => {
    const q = qb.newQuery().oneOf(MODE, "live").build();

    expect(q.conditions.get(MODE)?.get("live")).toBe(100);
  });

  it("uses a score of 0 when provided", () => {
    const q = qb.newQuery().oneOf(MODE, "live", 0).build();

    expect(q.conditions.get(MODE)?.get("live")).toBe(0);
  });

  it("is immutable after build (copy-on-write)", () => {
    const builder = qb.newQuery().oneOf(MODE, "live", 5);

    const q1 = builder.build();
    const q2 = builder.oneOf(REGION, "us", 2).build();

    // q1 should be unaffected by the second call
    expect(q1.conditions.size).toBe(1);
    expect(q1.conditions.has(REGION)).toBe(false);
    expect(q1.conditions.get(MODE)?.get("live")).toBe(5);

    // q2 should have both conditions
    expect(q2.conditions.size).toBe(2);
    expect(q2.conditions.get(MODE)?.get("live")).toBe(5);
    expect(q2.conditions.get(REGION)?.get("us")).toBe(2);
  });
});

describe("Query helpers", () => {
  it("withOneOf creates a query with a single condition", () => {
    const q = withOneOf(MODE, "live", 5).build();

    expect(q.conditions.get(MODE)?.get("live")).toBe(5);
  });

  it("withAnyOf creates a query with multiple conditions", () => {
    const q = withAnyOf(REGION, ["us", "eu"], 2).build();

    const regionConditions = q.conditions.get(REGION);
    expect(regionConditions?.size).toBe(2);
    expect(regionConditions?.get("us")).toBe(2);
    expect(regionConditions?.get("eu")).toBe(2);
  });
});
